"""VL 모델 provider 분기 — 모든 LLM 호출은 Pydantic schema 로 강제

provider 는 `provider_selector.select_vl_provider()` 로 결정:
  ollama (Gemma 4 26B)  — 평일 09~18시 default
  gemini                — 집 시간 default
  openai                — fallback (Gemini quota 소진 / Ollama 실패 시)

환경변수 VL_PROVIDER 로 강제 override 가능.

공통 인터페이스:
  call_vl(image_path, prompt, schema) → schema 인스턴스
    image_path 는 단일 경로(str) 또는 경로 리스트(list[str]) 모두 허용.
    리스트일 경우 각 provider 에 멀티 이미지로 전달되며, 프롬프트에서 순서를 명시해야 한다.

각 provider 는 schema 를 직접 전달받아 structured output 을 강제한다.
free-form JSON 파싱 / 정규식 추출은 이 모듈에서 사용하지 않는다.
"""
import base64
import logging
import os
import re
from pathlib import Path
from typing import TypeVar

import requests
from pydantic import BaseModel

from . import provider_selector

logger = logging.getLogger(__name__)

# gemma4 가 JSON 안에서 LaTeX 백슬래시를 단일로 뱉어 \t(tab) / \f(FF) / \r / \n / \b / \u 등
# JSON escape sequence 로 오해석되는 증상 보정. `\text{`, `\to`, `\times`, `\frac` 등
# 수식에서 쓰이는 명령어는 JSON 디코딩 전에 `\\` 로 이스케이프해 복구한다.
# 적용 대상: tab(\t) / form feed(\f) / carriage return(\r) / newline(\n) / backspace(\b) 로
# 해석되는 첫 글자를 가진 LaTeX 명령어만. {\sum, \frac, \lim, \int, ...} 처럼 JSON escape 와
# 충돌 안 하는 것들은 raw 에서 \\sum 으로 정상 출력되고 있어 건드릴 필요 없음.
# LaTeX 명령어는 알파벳만으로 구성되며 다음 문자가 알파벳이면 같은 명령어의 연장이다.
# `\to` 뒤에 `e` 오면 `\toe` 라는 (존재하지 않는) 별개 명령어 — 섣불리 `\to` 로 매치하면 안 됨.
# 따라서 negative lookahead `(?![a-zA-Z])` 로 명령어 경계를 엄격히 잡는다.
# 또한 이미 이중 이스케이프된 `\\xxx` 는 lookbehind `(?<!\\)` 로 건너뛴다.
_LATEX_ESCAPE_FIX_PATTERNS = [
  # \text{ ... \textit, \textbf, \textrm, \textstyle 등 — { 또는 공백/non-alpha 경계로 명확히 끝남
  (re.compile(r'(?<!\\)\\(text[a-z]*)(?=\{|[^a-zA-Z])'), r'\\\\\1'),
  # \t 시작
  (re.compile(r'(?<!\\)\\(to|times|top|tan|theta|triangle|tilde|tau)(?![a-zA-Z])'), r'\\\\\1'),
  # \f 시작
  (re.compile(r'(?<!\\)\\(frac|forall|floor|flat)(?![a-zA-Z])'), r'\\\\\1'),
  # \r 시작
  (re.compile(r'(?<!\\)\\(rightarrow|Rightarrow|rho|rfloor|rceil|right)(?![a-zA-Z])'), r'\\\\\1'),
  # \n 시작
  (re.compile(r'(?<!\\)\\(nabla|neq|notin|not|nu|ne)(?![a-zA-Z])'), r'\\\\\1'),
  # \b 시작
  (re.compile(r'(?<!\\)\\(binom|biggl|biggr|bigg|bigl|bigr|big|bigcup|bigcap|bigoplus|bar|beta|bullet|bot)(?![a-zA-Z])'), r'\\\\\1'),
  # \s 시작 — sum/sqrt/sigma 등
  (re.compile(r'(?<!\\)\\(sum|sqrt|sigma|sin|subset|subseteq|supset|supseteq|setminus|substack|sec|star|succ|succeq)(?![a-zA-Z])'), r'\\\\\1'),
  # \l 시작
  (re.compile(r'(?<!\\)\\(lim|log|leq|langle|lambda|Lambda|left|ldots|leftrightarrow|ln|lfloor|lceil|le|ll)(?![a-zA-Z])'), r'\\\\\1'),
  # \c 시작
  (re.compile(r'(?<!\\)\\(cdot|cdots|cos|cup|cap|circ|colon|cong|chi|coth|csc)(?![a-zA-Z])'), r'\\\\\1'),
  # \e 시작
  (re.compile(r'(?<!\\)\\(exp|epsilon|equiv|ell|emptyset|eta|eq)(?![a-zA-Z])'), r'\\\\\1'),
  # \i 시작
  (re.compile(r'(?<!\\)\\(int|infty|iff|imath|iota|Im|in)(?![a-zA-Z])'), r'\\\\\1'),
  # \m, \p, \q, \u, \v, \w, \x 계열
  (re.compile(r'(?<!\\)\\(max|min|mod|mu|mapsto|mathbb|mathrm|mathcal|mathsf|mathbf|mathit)(?![a-zA-Z])'), r'\\\\\1'),
  (re.compile(r'(?<!\\)\\(partial|pi|Pi|phi|Phi|psi|Psi|prod|prec|preceq|pm|perp|parallel|prime)(?![a-zA-Z])'), r'\\\\\1'),
  (re.compile(r'(?<!\\)\\(quad|qquad)(?![a-zA-Z])'), r'\\\\\1'),
  (re.compile(r'(?<!\\)\\(underline|underbrace|uparrow|Uparrow|upsilon|Upsilon|uplus)(?![a-zA-Z])'), r'\\\\\1'),
  (re.compile(r'(?<!\\)\\(varphi|vec|vee|vdots|varepsilon|varsigma|vartheta|varrho)(?![a-zA-Z])'), r'\\\\\1'),
  (re.compile(r'(?<!\\)\\(wedge|widetilde|widehat)(?![a-zA-Z])'), r'\\\\\1'),
  (re.compile(r'(?<!\\)\\(xi|Xi)(?![a-zA-Z])'), r'\\\\\1'),
  # \a, \d, \g, \h, \k, \o — 희소 명령
  (re.compile(r'(?<!\\)\\(alpha|approx|angle|arcsin|arccos|arctan|ast|aleph)(?![a-zA-Z])'), r'\\\\\1'),
  (re.compile(r'(?<!\\)\\(delta|Delta|div|ddots|dagger|dashv|det|dim|dots)(?![a-zA-Z])'), r'\\\\\1'),
  (re.compile(r'(?<!\\)\\(gamma|Gamma|gcd|geq|gg|ge|grave|hat)(?![a-zA-Z])'), r'\\\\\1'),
  (re.compile(r'(?<!\\)\\(hbar|hookrightarrow|hookleftarrow|hom)(?![a-zA-Z])'), r'\\\\\1'),
  (re.compile(r'(?<!\\)\\(kappa|ker)(?![a-zA-Z])'), r'\\\\\1'),
  (re.compile(r'(?<!\\)\\(omega|Omega|overbrace|overline|oplus|otimes|ominus|odot|oint|oslash|oint)(?![a-zA-Z])'), r'\\\\\1'),
  (re.compile(r'(?<!\\)\\(zeta)(?![a-zA-Z])'), r'\\\\\1'),
  # \to 뒤에 소문자 알파벳 붙은 경우 — \top 은 이미 위 \t 패턴에서 처리됨.
  #   \toe, \tof 등은 원래 `\to e` 인데 공백 빠진 케이스로 가정 → `\\to ` + 문자.
  #   문자 클래스 `[a-oq-z]` 는 p 만 제외 (p 는 \top, \pi 등과 혼동 방지).
  (re.compile(r'(?<!\\)\\to(?=[a-oq-z])'), r'\\\\to '),
]

# JSON escape 가 이미 소실되어 첫 글자가 사라진 `\text{` 잔재 복구.
# 예: "\\text{x}" (raw) → JSON decode → "\text{x}" → 여기까진 정상.
#     하지만 gemma4 가 "\\\\text{x}" 를 "text{x}" 또는 "\\term{x}" 로 뱉는 변종이 관찰됨.
#     - `term{`, `erm{`, `rm{` 앞에 백슬래시도 알파벳도 없으면 lost `\text` 로 간주해 복구.
# 이 패턴은 _fix_gemma4_latex_escapes 후 "raw escape 복구" 단계에서 별도 적용 (JSON decode 전엔 판별 어려움).
_POST_DECODE_STRAY_TEXT_PATTERNS = [
  (re.compile(r'(?<![\\a-zA-Z])term\{'), r'\\text{'),
  (re.compile(r'(?<![\\a-zA-Z])erm\{'), r'\\text{'),
  (re.compile(r'(?<![\\a-zA-Z\\])ext\{'), r'\\text{'),
]


def _fix_gemma4_latex_escapes(raw: str) -> str:
  """gemma4 JSON 출력에서 단일 백슬래시로 뱉은 LaTeX 명령어를 이중으로 복구."""
  fixed = raw
  for pat, repl in _LATEX_ESCAPE_FIX_PATTERNS:
    fixed = pat.sub(repl, fixed)
  return fixed

VL_OLLAMA_URL = os.environ.get("VL_OLLAMA_URL", "http://localhost:11434").rstrip("/")
VL_MODEL = os.environ.get("VL_MODEL", "gemma4:26b")
VL_TIMEOUT = int(os.environ.get("VL_TIMEOUT", "180"))
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3-flash-preview")
OPENAI_MODEL = os.environ.get("OPENAI_MODEL", "gpt-4o")

T = TypeVar("T", bound=BaseModel)

ImagePaths = str | list[str]


def _normalize_paths(image_path: ImagePaths) -> list[str]:
  if isinstance(image_path, str):
    return [image_path]
  return list(image_path)


def _mime_for(path: str) -> str:
  suffix = Path(path).suffix.lower()
  return "image/jpeg" if suffix in (".jpg", ".jpeg") else "image/png"


def call_vl(image_path: ImagePaths, prompt: str, schema: type[T], timeout: int | None = None) -> T:
  """provider 에 관계없이 동일한 인터페이스로 VL 모델 호출.

  반환값은 항상 schema 인스턴스 (Pydantic 검증 완료).
  image_path 에 리스트를 넘기면 멀티 이미지 모드로 호출된다.
  """
  provider = provider_selector.select_vl_provider()
  if provider == "gemini":
    return _call_gemini_with_fallback(image_path, prompt, schema, timeout)
  if provider == "openai":
    return _call_openai(image_path, prompt, schema, timeout)
  return _call_ollama_with_fallback(image_path, prompt, schema, timeout)


# ── Fallback 판단 ─────────────────────────────────────────────────────────────

def _openai_fallback_available() -> bool:
  return bool(os.environ.get("OPENAI_API_KEY", "").strip())


def _is_gemini_quota_exhausted(exc: Exception) -> bool:
  msg = str(exc).lower()
  if "resource_exhausted" in msg or "quota" in msg or "rate" in msg:
    return True
  status = getattr(exc, "status_code", None)
  if status in (429,):
    return True
  return False


def _is_ollama_unavailable(exc: Exception) -> bool:
  if isinstance(exc, requests.exceptions.ConnectionError):
    return True
  if isinstance(exc, requests.exceptions.Timeout):
    return True
  if isinstance(exc, requests.exceptions.HTTPError):
    resp = getattr(exc, "response", None)
    if resp is not None and resp.status_code in (404, 500, 502, 503, 504):
      return True
  return False


def _call_gemini_with_fallback(image_path, prompt, schema, timeout):
  try:
    return _call_gemini(image_path, prompt, schema, timeout)
  except Exception as e:
    if _is_gemini_quota_exhausted(e) and _openai_fallback_available():
      logger.warning(f"Gemini quota 소진 → OpenAI fallback: {e}")
      return _call_openai(image_path, prompt, schema, timeout)
    raise


def _call_ollama_with_fallback(image_path, prompt, schema, timeout):
  try:
    return _call_ollama(image_path, prompt, schema, timeout)
  except Exception as e:
    if _is_ollama_unavailable(e) and _openai_fallback_available():
      logger.warning(f"Ollama 접속 실패 → OpenAI fallback: {e}")
      return _call_openai(image_path, prompt, schema, timeout)
    raise


# ── Ollama ────────────────────────────────────────────────────────────────────

# gemma4 가 동일 토큰을 4회 이상 연속 반복하면 생성 루프에 빠진 것으로 간주.
# raw 단계에서 단일 백슬래시 상태라 패턴은 `\text{\text{\text{\text{`.
_LOOP_DETECTION_PATTERN = re.compile(r'(\\text\{){4,}')


def _is_raw_looped_or_truncated(raw: str, done_reason: str | None) -> bool:
  if done_reason == "length":
    return True
  if _LOOP_DETECTION_PATTERN.search(raw):
    return True
  return False


def _ollama_post(
  images_b64: list[str],
  prompt: str,
  schema_json: dict,
  temperature: float,
  num_predict: int,
  timeout: int,
) -> dict:
  # stop 토큰 사용 금지: 정상 생성 초반에도 필드값이 \text{ 로 시작하면 오작동.
  # 루프는 num_predict 한계에 걸려 done_reason=length 로 감지 → 재시도로 탈출.
  payload = {
    "model": os.environ.get("VL_MODEL", VL_MODEL),
    "prompt": prompt,
    "images": images_b64,
    "format": schema_json,
    "stream": False,
    "options": {
      "temperature": temperature,
      "num_ctx": 16384,
      "num_predict": num_predict,
    },
  }
  resp = requests.post(
    f"{os.environ.get('VL_OLLAMA_URL', VL_OLLAMA_URL)}/api/generate",
    json=payload,
    timeout=timeout,
  )
  resp.raise_for_status()
  return resp.json()


def _call_ollama(image_path: ImagePaths, prompt: str, schema: type[T], timeout: int | None = None) -> T:
  paths = _normalize_paths(image_path)
  images_b64: list[str] = []
  for p in paths:
    with open(p, "rb") as f:
      images_b64.append(base64.b64encode(f.read()).decode("utf-8"))

  schema_json = schema.model_json_schema()
  eff_timeout = timeout or VL_TIMEOUT

  # 재시도 스케줄: (temperature, num_predict). 1차 실패 시 다른 샘플링으로 루프 탈출 유도.
  attempts = [
    (0.1, 4096),
    (0.1, 6144),
    (0.5, 6144),
  ]

  last_err: Exception | None = None
  for attempt_idx, (temp, npred) in enumerate(attempts):
    try:
      body = _ollama_post(images_b64, prompt, schema_json, temp, npred, eff_timeout)
    except Exception as e:
      last_err = e
      logger.warning(f"[ollama VL] attempt={attempt_idx+1} HTTP 오류: {e}")
      continue

    raw = body.get("response", "")
    done_reason = body.get("done_reason")
    looped = _is_raw_looped_or_truncated(raw, done_reason)
    raw_fixed = _fix_gemma4_latex_escapes(raw)

    if os.environ.get("VL_DUMP_RAW", "").strip() == "1":
      try:
        import time as _t
        dump_dir = Path(os.environ.get("VL_DUMP_DIR", "./vl_raw_dumps"))
        dump_dir.mkdir(parents=True, exist_ok=True)
        ts = int(_t.time() * 1000)
        suffix = f"_a{attempt_idx+1}"
        with open(dump_dir / f"ollama_raw_{ts}{suffix}.txt", "w", encoding="utf-8") as f:
          f.write(f"=== attempt={attempt_idx+1} temp={temp} npred={npred} done_reason={done_reason} raw_len={len(raw)} looped={looped} ===\n")
          f.write(raw)
        if raw_fixed != raw:
          with open(dump_dir / f"ollama_raw_{ts}{suffix}_fixed.txt", "w", encoding="utf-8") as f:
            f.write(f"=== fixed / len={len(raw_fixed)} ===\n")
            f.write(raw_fixed)
      except Exception as de:
        logger.warning(f"[ollama VL] raw dump 실패: {de}")

    if looped:
      logger.warning(
        f"[ollama VL] attempt={attempt_idx+1} 루프/잘림 감지 "
        f"(done_reason={done_reason}, raw_len={len(raw)}) → 재시도"
      )
      last_err = RuntimeError(f"gemma4 생성 루프 (attempt={attempt_idx+1})")
      continue

    try:
      parsed = schema.model_validate_json(raw_fixed)
    except Exception as e:
      last_err = e
      logger.warning(
        f"[ollama VL] attempt={attempt_idx+1} JSON 파싱 실패: {e}\n"
        f"done_reason={done_reason} raw_len={len(raw)} fixed_len={len(raw_fixed)}"
      )
      continue

    # 파싱 성공했지만 핵심 필드가 모두 비어있으면 재시도 (빈 응답 / refusal 감지)
    if _is_empty_payload(parsed):
      if attempt_idx < len(attempts) - 1:
        logger.warning(
          f"[ollama VL] attempt={attempt_idx+1} 파싱은 성공했으나 핵심 필드 empty → 재시도"
        )
        last_err = RuntimeError(f"gemma4 empty payload (attempt={attempt_idx+1})")
        continue
      logger.warning(
        f"[ollama VL] 모든 attempt 에서 empty payload — 마지막 결과 그대로 반환"
      )
    return parsed

  logger.error(
    f"[ollama VL] 재시도 {len(attempts)}회 모두 실패: {last_err}"
  )
  raise last_err if last_err else RuntimeError("ollama VL 재시도 모두 실패")


def _is_empty_payload(parsed: BaseModel) -> bool:
  """TagResult 의 핵심 필드 (solution_summary + solution_steps) 가 모두 비었으면 True.
  해설 없는 경로 (solution_summary 가 None 허용) 는 concept_tags 까지 함께 봐서 판단."""
  if not hasattr(parsed, "solution_summary"):
    return False
  summary = getattr(parsed, "solution_summary", None) or ""
  steps = getattr(parsed, "solution_steps", None) or []
  concepts = getattr(parsed, "concept_tags", None) or []
  # 요약 비었고 단계 비었으면 empty. concept_tags 까지 비었으면 확실히 empty.
  if not summary.strip() and not steps:
    return True
  if not concepts:
    return True
  return False


# ── Gemini ────────────────────────────────────────────────────────────────────

def _call_gemini(image_path: ImagePaths, prompt: str, schema: type[T], timeout: int | None = None) -> T:
  try:
    from google import genai
    from google.genai import types as genai_types
  except ImportError as e:
    raise ImportError("google-genai 패키지 필요: pip install google-genai") from e

  api_key = (
    os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY") or ""
  ).strip()
  if not api_key:
    raise ValueError("GEMINI_API_KEY / GOOGLE_API_KEY 환경변수 없음")

  client = genai.Client(api_key=api_key)
  model = os.environ.get("GEMINI_MODEL", GEMINI_MODEL)

  paths = _normalize_paths(image_path)
  parts = []
  for p in paths:
    with open(p, "rb") as f:
      img_bytes = f.read()
    parts.append(genai_types.Part.from_bytes(data=img_bytes, mime_type=_mime_for(p)))
  parts.append(genai_types.Part.from_text(text=prompt))

  response = client.models.generate_content(
    model=model,
    contents=[genai_types.Content(parts=parts, role="user")],
    config=genai_types.GenerateContentConfig(
      response_mime_type="application/json",
      response_schema=schema,
      temperature=0.1,
    ),
  )
  return schema.model_validate_json(response.text)


# ── OpenAI ────────────────────────────────────────────────────────────────────

def _call_openai(image_path: ImagePaths, prompt: str, schema: type[T], timeout: int | None = None) -> T:
  try:
    import openai
  except ImportError as e:
    raise ImportError("openai 패키지 필요: pip install openai") from e

  api_key = os.environ.get("OPENAI_API_KEY", "")
  if not api_key:
    raise ValueError("OPENAI_API_KEY 환경변수 없음")

  client = openai.OpenAI(api_key=api_key)
  model = os.environ.get("OPENAI_MODEL", OPENAI_MODEL)

  paths = _normalize_paths(image_path)
  content: list[dict] = []
  for p in paths:
    with open(p, "rb") as f:
      img_b64 = base64.b64encode(f.read()).decode("utf-8")
    content.append({
      "type": "input_image",
      "image_url": f"data:{_mime_for(p)};base64,{img_b64}",
    })
  content.append({"type": "input_text", "text": prompt})

  response = client.responses.parse(
    model=model,
    input=[{"role": "user", "content": content}],
    text_format=schema,
  )
  return response.output_parsed
