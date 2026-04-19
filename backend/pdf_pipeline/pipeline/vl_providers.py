"""VL 모델 provider 분기 — 모든 LLM 호출은 Pydantic schema 로 강제

provider 는 `provider_selector.select_vl_provider()` 로 결정:
  ollama (Gemma 3 27B)  — 평일 09~18시 default
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
from pathlib import Path
from typing import TypeVar

import requests
from pydantic import BaseModel

from . import provider_selector

logger = logging.getLogger(__name__)

VL_OLLAMA_URL = os.environ.get("VL_OLLAMA_URL", "http://localhost:11434").rstrip("/")
VL_MODEL = os.environ.get("VL_MODEL", "gemma3:27b")
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

def _call_ollama(image_path: ImagePaths, prompt: str, schema: type[T], timeout: int | None = None) -> T:
  paths = _normalize_paths(image_path)
  images_b64: list[str] = []
  for p in paths:
    with open(p, "rb") as f:
      images_b64.append(base64.b64encode(f.read()).decode("utf-8"))

  payload = {
    "model": os.environ.get("VL_MODEL", VL_MODEL),
    "prompt": prompt,
    "images": images_b64,
    "format": schema.model_json_schema(),
    "stream": False,
    "options": {
      "temperature": 0.1,
      "num_ctx": 16384,
      "num_predict": 16384,
    },
  }
  resp = requests.post(
    f"{os.environ.get('VL_OLLAMA_URL', VL_OLLAMA_URL)}/api/generate",
    json=payload,
    timeout=timeout or VL_TIMEOUT,
  )
  resp.raise_for_status()
  raw = resp.json().get("response", "")
  return schema.model_validate_json(raw)


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
