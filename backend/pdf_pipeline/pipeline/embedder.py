"""임베딩 생성 모듈 — Ollama / OpenAI provider 분기

provider 는 `provider_selector.select_embed_provider()` 로 결정:
  ollama  (bge-m3, 1024차원)           — 서버 근무시간 default
  openai  (text-embedding-3-small,     — 집 / 서버 OFF 시 default
          1536차원)

Ollama 접속 실패 시 OPENAI_API_KEY 가 있으면 자동 fallback.
캐시 파일명이 provider 를 포함하므로 차원 불일치 걱정 없음.

공개 API (시그니처 불변 — 호출처 무변경):
  generate_embedding(text) -> list[float]
  generate_embeddings_batch(texts) -> list[list[float]]
  get_provider_model_tag() -> (provider, model_tag)  # 캐시 파일명용
  release_model()                                    # no-op
"""
import logging
import os
from typing import List, Tuple

import requests

from . import provider_selector

logger = logging.getLogger(__name__)

# Ollama
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
EMBED_MODEL = os.environ.get("EMBED_MODEL", "bge-m3")

# OpenAI
OPENAI_EMBED_MODEL = os.environ.get("OPENAI_EMBED_MODEL", "text-embedding-3-small")
_OPENAI_BATCH_SIZE = 100


def _sanitize(name: str) -> str:
  return name.replace(":", "_").replace("/", "_")


def get_provider_model_tag() -> Tuple[str, str]:
  """캐시 파일명에 사용할 (provider, model_tag) 튜플."""
  provider = provider_selector.select_embed_provider()
  if provider == "openai":
    return "openai", _sanitize(OPENAI_EMBED_MODEL)
  return "ollama", _sanitize(EMBED_MODEL)


# ── Ollama ────────────────────────────────────────────────────────────────────

def _generate_embedding_ollama(text: str) -> List[float]:
  resp = requests.post(
    f"{OLLAMA_URL}/api/embeddings",
    json={"model": EMBED_MODEL, "prompt": text},
    timeout=60,
  )
  resp.raise_for_status()
  return resp.json()["embedding"]


def _generate_embeddings_batch_ollama(texts: List[str]) -> List[List[float]]:
  return [_generate_embedding_ollama(t) for t in texts]


# ── OpenAI ────────────────────────────────────────────────────────────────────

_openai_client = None


def _get_openai_client():
  global _openai_client
  if _openai_client is None:
    try:
      import openai
    except ImportError as e:
      raise ImportError("openai 패키지 필요: pip install openai") from e
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key:
      raise ValueError("OPENAI_API_KEY 환경변수 없음")
    _openai_client = openai.OpenAI(api_key=api_key)
  return _openai_client


def _generate_embedding_openai(text: str) -> List[float]:
  client = _get_openai_client()
  resp = client.embeddings.create(input=text, model=OPENAI_EMBED_MODEL)
  return resp.data[0].embedding


def _generate_embeddings_batch_openai(texts: List[str]) -> List[List[float]]:
  if not texts:
    return []
  client = _get_openai_client()
  results: List[List[float]] = [None] * len(texts)  # type: ignore[list-item]
  for i in range(0, len(texts), _OPENAI_BATCH_SIZE):
    batch = texts[i : i + _OPENAI_BATCH_SIZE]
    resp = client.embeddings.create(input=batch, model=OPENAI_EMBED_MODEL)
    for j, item in enumerate(resp.data):
      results[i + j] = item.embedding
  return results  # type: ignore[return-value]


# ── Fallback 판단 ─────────────────────────────────────────────────────────────

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


def _openai_fallback_available() -> bool:
  return bool(os.environ.get("OPENAI_API_KEY", "").strip())


# ── 공개 API ──────────────────────────────────────────────────────────────────

def generate_embedding(text: str) -> List[float]:
  provider = provider_selector.select_embed_provider()
  if provider == "openai":
    return _generate_embedding_openai(text)
  try:
    return _generate_embedding_ollama(text)
  except Exception as e:
    if _is_ollama_unavailable(e) and _openai_fallback_available():
      logger.warning(f"Ollama 접속 실패 → OpenAI fallback: {e}")
      return _generate_embedding_openai(text)
    raise


def generate_embeddings_batch(texts: List[str]) -> List[List[float]]:
  provider = provider_selector.select_embed_provider()
  if provider == "openai":
    return _generate_embeddings_batch_openai(texts)
  try:
    return _generate_embeddings_batch_ollama(texts)
  except Exception as e:
    if _is_ollama_unavailable(e) and _openai_fallback_available():
      logger.warning(f"Ollama 접속 실패 → OpenAI fallback (batch): {e}")
      return _generate_embeddings_batch_openai(texts)
    raise


def release_model():
  """Ollama/OpenAI 모두 자체 관리 → no-op"""
  pass
