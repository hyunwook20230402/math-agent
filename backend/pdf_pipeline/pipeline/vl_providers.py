"""VL 모델 호출 — OpenAI 단일. 모든 LLM 호출은 Pydantic schema 로 강제.

2026-06-19: gemma4(ollama)/gemini 분기 제거. VL 은 OpenAI 하나로 통일.
  (gemma4 폐기로 반복 폭주 방어 코드 일체 불필요 → 제거.)
  임베딩(bge-m3 ollama)은 별도 모듈(embedder.py)에서 그대로 유지.

공통 인터페이스:
  call_vl(image_path, prompt, schema) → schema 인스턴스
    image_path 는 단일 경로(str) 또는 경로 리스트(list[str]) 모두 허용.
    리스트일 경우 멀티 이미지로 전달되며, 프롬프트에서 순서를 명시해야 한다.

schema 를 직접 전달받아 structured output 을 강제한다.
free-form JSON 파싱 / 정규식 추출은 이 모듈에서 사용하지 않는다.
"""
import base64
import logging
import os
import re
from pathlib import Path
from typing import TypeVar

from pydantic import BaseModel

logger = logging.getLogger(__name__)


# 이미 파싱된 LaTeX 문자열(예: solution_nodes.output_formula)의 아래첨자 앞 잘못된 백슬래시 보정.
# OpenAI 가 조합/순열 기호에서 `\_2H_3` (정상은 `{}_2H_3` 또는 `_2H_3`) 처럼 `_` 앞에
# 불필요한 백슬래시를 붙이는 케이스. KaTeX 가 `\_` 를 못 읽어 렌더 깨짐.
# `(?<!\\)` 로 이미 이스케이프된 `\\_` 는 건너뛰고, `(?=[0-9a-zA-Z])` 로 아래첨자 시작(영숫자)
# 앞의 `\_` 만 좁게 매칭. 정상 `a_1`(백슬래시 없음)은 매칭 안 됨.
_LATEX_SUBSCRIPT_ESCAPE = re.compile(r'(?<!\\)\\_(?=[0-9a-zA-Z])')

# 깨진 수식 여는 구분자 복원. OpenAI 가 인라인 `\(` / 블록 `\[` 를 `\w(` / `\w[` 또는
# 대문자 `\W(` / `\W[` 로 깨뜨려 출력하는 케이스(존재하지 않는 `\w`/`\W` 명령).
# 프론트 renderMath 가 `\(...\)` 매칭에 실패해 전체가 raw 노출되며 `\w`/`\W` 의 백슬래시가
# 안 보여 'w'/'W' 만 남는 버그(2026-06-23. 9차에서 대문자 `\W` 변형까지 확대).
# 구분자 `(`/`[` 바로 앞 `\w`/`\W` 만 좁게 매칭 — 정상 텍스트·정상 명령(\frac 등 뒤에 괄호 없음)은
# lookahead 때문에 안 건드림.
_LATEX_BROKEN_DELIM = re.compile(r'\\[wW](?=[\(\[])')


def _fix_latex_broken_delimiters(s: str) -> str:
  """깨진 여는 구분자 `\\w(`/`\\W(`→`\\(`, `\\w[`/`\\W[`→`\\[` 복원."""
  if not s:
    return s
  fixed = _LATEX_BROKEN_DELIM.sub(r'\\', s)
  if fixed != s:
    logger.warning("[latex] 깨진 구분자 복원(\\w/\\W → \\): %r → %r", s[:60], fixed[:60])
  return fixed


# 제어문자(\x00-\x08,\x0b,\x0c,\x0e-\x1f,\x7f). \t\n\r 은 보존.
_CONTROL_CHARS = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]')

# NBSP(\xa0)·제로폭·방향제어문자. gpt-5.2 가 자유텍스트에서 일반 공백 대신 NBSP 를 내거나
# 제로폭/방향문자를 섞어 화면에 깨진 기호로 보이는 것 방지(2026-06-23, 10차).
# NBSP 는 공백으로 치환(아래 별도 처리), 나머지는 제거.
_NBSP = re.compile(r'\xa0')  # → 일반 공백으로(제거하면 단어 붙음)
_ZERO_WIDTH_DIRECTIONAL = re.compile(
  r'[​-‏‪-‮⁠-⁤⁦-⁩﻿؜]'
  # 200b-200f: 제로폭/방향 마크, 202a-202e: 방향 임베딩/오버라이드,
  # 2060-2064: word joiner 등, 2066-2069: 방향 isolate, feff: BOM, 061c: 아랍 마크
)
# 화살표는 매우 보수적으로 ↑↓←→ 4개만 제거(정상 수식은 \rightarrow 등 LaTeX 명령으로 표현).
# gpt-5.2 가 지수/곱 표기를 화살표(▲↑)로 깨뜨리는 케이스. 재발 시 로그로 실제 문자 확인 후 확대.
_STRAY_ARROWS = re.compile(r'[←↑→↓]')


def _strip_control_chars(s: str) -> str:
  """LLM 이 간헐적으로 뱉는 제어문자·특수공백(NBSP)·제로폭·방향문자·화살표 제거.

  화면에 깨진 기호(▲, ` `, 제로폭)로 보이는 것 방지(2026-06-23, 10차 확장).
  NBSP 는 공백으로(단어 붙음 방지), 제로폭/방향/화살표는 제거. \\t\\n\\r·한글·정상 LaTeX 보존.
  """
  if not s:
    return s
  orig = s
  s = _CONTROL_CHARS.sub('', s)
  s = _NBSP.sub(' ', s)
  s = _ZERO_WIDTH_DIRECTIONAL.sub('', s)
  s = _STRAY_ARROWS.sub('', s)
  if s != orig:
    logger.warning("[latex] 제어/특수문자 제거·정규화: %r → %r", orig[:60], s[:60])
  return s


def _fix_latex_subscript_escapes(s: str) -> str:
  """LaTeX 최종 문자열 보정 — 제어문자 제거 + 깨진 구분자 복원 + 아래첨자 백슬래시(`\\_`→`_`) + 닫는 짝 누락 채우기.

  추출·편집·힌트 생성이 저장/반환 직전 이 함수를 거치므로, 여기서 다 보정하면 모든 경로 커버.
  """
  if not s:
    return s
  s = _strip_control_chars(s)
  s = _fix_latex_broken_delimiters(s)
  s = _LATEX_SUBSCRIPT_ESCAPE.sub('_', s)
  s = _balance_latex_delimiters(s)
  return s


# 인라인 수식 구분자 `\( ... \)` 패턴. 닫는 `\)` 가 없으면 못 잡힌다(그래서 별도 카운트로 보충).
_INLINE_MATH = re.compile(r'\\\((.*?)\\\)', re.DOTALL)


def _balance_braces(expr: str) -> tuple[str, bool]:
  """수식 한 조각의 중괄호 균형을 맞춘다. 닫는 `}` 가 모자라면 끝에 채운다.

  `\\text{...` 처럼 LLM 이 닫는 중괄호를 빠뜨린 케이스 대응(에스케이프된 `\\{`/`\\}` 는 제외).
  반환: (보정된 식, 보정했는지 여부). 여는 게 더 적은(닫는 `}` 가 더 많은) 비정상은 손대지 않음.
  """
  depth = 0
  i = 0
  n = len(expr)
  while i < n:
    c = expr[i]
    if c == '\\':       # 이스케이프된 문자(\{, \}, \\ 등)는 건너뜀
      i += 2
      continue
    if c == '{':
      depth += 1
    elif c == '}':
      depth = max(0, depth - 1)
    i += 1
  if depth > 0:
    return expr + ('}' * depth), True
  return expr, False


def _balance_latex_delimiters(s: str) -> str:
  """저장 직전 LaTeX 안전 보정 — 닫는 짝(중괄호 `}`, 인라인 구분자 `\\)`) 누락을 채운다.

  명백히 안전한 '닫는 짝 채우기'만 한다(여는 쪽은 건드리지 않음). 두 가지 깨짐 케이스:
    1) `\\text{...` 처럼 중괄호 안 닫힘 → 닫는 `}` 보충
    2) `\\(...식...` 처럼 닫는 `\\)` 누락 → 끝에 `\\)` 보충
  추출(rag_node_extractor)·편집(nodes.py) 양쪽이 공유하는 _fix_latex_subscript_escapes 에서 호출.
  보정 후에도 구분자 수가 안 맞으면(비정상 구조) 원본 유지 + 경고 로그(잘못 고쳐 악화 방지).
  """
  if not s:
    return s

  open_cnt = s.count(r'\(')
  close_cnt = s.count(r'\)')

  # (A) 닫는 `\)` 가 부족: 각 인라인 조각의 중괄호를 닫고, 모자란 `\)` 만큼 끝에 보충.
  if open_cnt > close_cnt:
    # 닫힌 조각들은 정상 보정(중괄호만), 마지막 안 닫힌 조각은 중괄호 닫고 `\)` 추가.
    last_open = s.rfind(r'\(')
    head, tail = s[:last_open], s[last_open + 2:]  # tail = 마지막 `\(` 이후(닫힘 없음)
    balanced_tail, _ = _balance_braces(tail)
    fixed = head + r'\(' + balanced_tail + r'\)'
    # head 안의 닫힌 조각들도 중괄호 보정
    fixed = _INLINE_MATH.sub(lambda m: r'\(' + _balance_braces(m.group(1))[0] + r'\)', fixed)
    logger.warning("[latex] 닫는 \\) 누락 보정: %r → %r", s[:60], fixed[:60])
    return fixed

  # (B) 구분자 균형은 맞음 → 각 인라인 조각의 중괄호만 점검/보충.
  changed = {"v": False}

  def _fix_seg(m):
    bal, did = _balance_braces(m.group(1))
    if did:
      changed["v"] = True
    return r'\(' + bal + r'\)'

  fixed = _INLINE_MATH.sub(_fix_seg, s)
  if changed["v"]:
    logger.warning("[latex] \\text 등 중괄호 누락 보정: %r → %r", s[:60], fixed[:60])

  # 보정 후에도 구분자 불균형이면(닫는 게 더 많은 비정상 등) 더 손대지 않고 경고만.
  if fixed.count(r'\(') != fixed.count(r'\)'):
    logger.warning("[latex] 구분자 불균형 — 자동보정 불가, 수동 확인 필요: %r", s[:80])
  return fixed


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


def _build_content(image_path: ImagePaths, prompt: str) -> list[dict]:
  """이미지(들) base64 + 프롬프트 → responses API content 블록."""
  content: list[dict] = []
  for p in _normalize_paths(image_path):
    with open(p, "rb") as f:
      img_b64 = base64.b64encode(f.read()).decode("utf-8")
    content.append({"type": "input_image", "image_url": f"data:{_mime_for(p)};base64,{img_b64}"})
  content.append({"type": "input_text", "text": prompt})
  return content


def call_vl(
  image_path: ImagePaths,
  prompt: str,
  schema: type[T],
  timeout: int | None = None,
  *,
  provider: str | None = None,
  max_tokens: int | None = None,
  model: str | None = None,
  reasoning_effort: str | None = None,
  verbosity: str | None = None,
) -> T:
  """VL 모델(OpenAI) 호출. 반환값은 항상 schema 인스턴스 (Pydantic 검증 완료).

  image_path 에 리스트를 넘기면 멀티 이미지 모드로 호출된다.
  provider 인자는 하위호환용으로 받기만 하고 무시한다(항상 OpenAI).
  max_tokens 는 출력 잘림 방어용(list[Node] 1회 통합 등 긴 출력).
  model 을 지정하면 그 모델로 호출(예: 메타 분석은 gpt-4o). 없으면 OPENAI_MODEL env.
  reasoning_effort("minimal"/"low"/"medium"/"high") 는 추론 모델(gpt-5 계열)의 thinking 토큰 제어 —
    힌트처럼 짧은 출력엔 low, 위치 판단엔 medium. None 이면 미적용.
  verbosity("low"/"medium"/"high") 는 출력 장황도. None 이면 미적용.
  """
  return _call_openai(image_path, prompt, schema, timeout, max_tokens=max_tokens,
                      model=model, reasoning_effort=reasoning_effort, verbosity=verbosity)


def call_vl_text(
  image_path: ImagePaths,
  prompt: str,
  timeout: int | None = None,
  *,
  max_tokens: int | None = None,
  model: str | None = None,
  reasoning_effort: str | None = None,
) -> str:
  """VL 모델(OpenAI) 자유 텍스트 호출 — structured output 없이 평문 반환.

  gpt-5.2(추론 모델)는 structured output(JSON 강제)에서 같은 문자를 반복하는 디코딩 루프에
  빠져 출력이 깨지는 경우가 잦다. 짧은 자연어 힌트는 자유 텍스트가 훨씬 안정적이라 별도 경로로 둔다.
  반환 후 호출부가 LaTeX 보정(_fix_latex_subscript_escapes) 등 후처리를 한다.
  """
  try:
    import openai
  except ImportError as e:
    raise ImportError("openai 패키지 필요: pip install openai") from e
  api_key = os.environ.get("OPENAI_API_KEY", "")
  if not api_key:
    raise ValueError("OPENAI_API_KEY 환경변수 없음")

  client = openai.OpenAI(api_key=api_key)
  model = model or os.environ.get("OPENAI_MODEL", OPENAI_MODEL)
  kwargs: dict = {"model": model, "input": [{"role": "user", "content": _build_content(image_path, prompt)}]}
  if max_tokens is not None:
    kwargs["max_output_tokens"] = max_tokens
  if reasoning_effort is not None:
    kwargs["reasoning"] = {"effort": reasoning_effort}

  client = client.with_options(timeout=timeout if timeout is not None else 45)
  response = client.responses.create(**kwargs)

  status = getattr(response, "status", None)
  if status == "incomplete":
    reason = getattr(getattr(response, "incomplete_details", None), "reason", "unknown")
    raise RuntimeError(f"OpenAI 응답 미완(잘림): reason={reason} — max_tokens 상향 필요")
  return (getattr(response, "output_text", None) or "").strip()


def _call_openai(image_path: ImagePaths, prompt: str, schema: type[T],
                 timeout: int | None = None, max_tokens: int | None = None,
                 model: str | None = None, reasoning_effort: str | None = None,
                 verbosity: str | None = None) -> T:
  try:
    import openai
  except ImportError as e:
    raise ImportError("openai 패키지 필요: pip install openai") from e

  api_key = os.environ.get("OPENAI_API_KEY", "")
  if not api_key:
    raise ValueError("OPENAI_API_KEY 환경변수 없음")

  client = openai.OpenAI(api_key=api_key)
  model = model or os.environ.get("OPENAI_MODEL", OPENAI_MODEL)

  content = _build_content(image_path, prompt)

  kwargs: dict = {
    "model": model,
    "input": [{"role": "user", "content": content}],
    "text_format": schema,
  }
  # 출력 잘림 방어 — max_tokens 명시 시 전달. None 이면 모델 기본(제한 안 둠).
  if max_tokens is not None:
    kwargs["max_output_tokens"] = max_tokens
  # 추론 모델(gpt-5 계열) 제어 — thinking 토큰 제어가 핵심. None 이면 미적용(하위호환).
  if reasoning_effort is not None:
    kwargs["reasoning"] = {"effort": reasoning_effort}
  # verbosity 는 Responses API 에서 text.verbosity 로 받는데, 우리는 text_format(structured output)을
  # 쓰므로 text 객체 병합이 까다로움 → 적용 안 함(프롬프트의 "1~2문장만" 으로 출력 길이 제어로 충분).
  # (인자는 받아두되 무시 — 호출부 수정 없이 안전.)
  _ = verbosity

  # timeout 실제 적용 — 미지정 시 45초(무한 대기 방지). 호출별로 with_options 로 주입.
  client = client.with_options(timeout=timeout if timeout is not None else 45)
  response = client.responses.parse(**kwargs)

  # truncation 감지 — incomplete(토큰 한계) 면 조용한 JSON 손상 대신 loud fail.
  status = getattr(response, "status", None)
  if status == "incomplete":
    reason = getattr(getattr(response, "incomplete_details", None), "reason", "unknown")
    raise RuntimeError(f"OpenAI 응답 미완(잘림): status=incomplete reason={reason} — max_tokens 상향 필요")
  parsed = response.output_parsed
  if parsed is None:
    raise RuntimeError("OpenAI structured output 파싱 실패(output_parsed=None) — 스키마/출력 불일치 의심")
  return parsed
