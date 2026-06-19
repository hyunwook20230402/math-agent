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


def _fix_latex_subscript_escapes(s: str) -> str:
  """LaTeX 문자열의 아래첨자 앞 잘못된 백슬래시(`\\_` → `_`) 보정. 최종 문자열용."""
  if not s:
    return s
  return _LATEX_SUBSCRIPT_ESCAPE.sub('_', s)


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


def call_vl(
  image_path: ImagePaths,
  prompt: str,
  schema: type[T],
  timeout: int | None = None,
  *,
  provider: str | None = None,
  max_tokens: int | None = None,
) -> T:
  """VL 모델(OpenAI) 호출. 반환값은 항상 schema 인스턴스 (Pydantic 검증 완료).

  image_path 에 리스트를 넘기면 멀티 이미지 모드로 호출된다.
  provider 인자는 하위호환용으로 받기만 하고 무시한다(항상 OpenAI).
  max_tokens 는 출력 잘림 방어용(list[Node] 1회 통합 등 긴 출력).
  """
  return _call_openai(image_path, prompt, schema, timeout, max_tokens=max_tokens)


def _call_openai(image_path: ImagePaths, prompt: str, schema: type[T],
                 timeout: int | None = None, max_tokens: int | None = None) -> T:
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

  kwargs: dict = {
    "model": model,
    "input": [{"role": "user", "content": content}],
    "text_format": schema,
  }
  # 출력 잘림 방어 — max_tokens 명시 시 전달. None 이면 모델 기본(제한 안 둠).
  if max_tokens is not None:
    kwargs["max_output_tokens"] = max_tokens

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
