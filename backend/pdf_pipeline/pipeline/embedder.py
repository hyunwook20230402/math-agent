"""임베딩 생성 모듈 — bge-m3 (Ollama) 단일. /api/embed 사용.

2026-06-19: VL 은 OpenAI 단일화됐으나 임베딩은 bge-m3(ollama 1024차원) 그대로 유지.
  (OpenAI 임베딩은 1536차원이라 바꾸면 problems·solution_nodes 전체 재임베딩 필요 → 안 함.)
  provider_selector(시간대 분기) 제거 — 임베딩은 항상 ollama.
  단, ollama 접속 실패 시 OPENAI_API_KEY 가 있으면 비상 fallback(차원 혼입 방지 위해
  EMBED_PROVIDER=openai 를 명시했을 때만). 기본은 ollama 고정.

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

logger = logging.getLogger(__name__)


def _select_embed_provider() -> str:
  """임베딩 provider — 기본 ollama 고정. EMBED_PROVIDER=openai 로만 강제 전환 가능."""
  forced = os.environ.get("EMBED_PROVIDER", "").strip().lower()
  if forced == "openai":
    return "openai"
  return "ollama"

# Ollama
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
EMBED_MODEL = os.environ.get("EMBED_MODEL", "bge-m3")
# 로컬 ollama fallback — 서버 터널(예: 21434)이 죽었을 때 로컬 11434 로 자동 재시도.
# 같은 bge-m3(1024차원)라 차원 호환. OLLAMA_URL 이 이미 11434 면 중복 제거.
_LOCAL_OLLAMA_URL = "http://localhost:11434"


def _ollama_urls() -> List[str]:
  urls = [OLLAMA_URL]
  if _LOCAL_OLLAMA_URL not in urls:
    urls.append(_LOCAL_OLLAMA_URL)
  return urls

# OpenAI
OPENAI_EMBED_MODEL = os.environ.get("OPENAI_EMBED_MODEL", "text-embedding-3-small")
_OPENAI_BATCH_SIZE = 100


def _sanitize(name: str) -> str:
  return name.replace(":", "_").replace("/", "_")


def get_provider_model_tag() -> Tuple[str, str]:
  """캐시 파일명에 사용할 (provider, model_tag) 튜플."""
  provider = _select_embed_provider()
  if provider == "openai":
    return "openai", _sanitize(OPENAI_EMBED_MODEL)
  return "ollama", _sanitize(EMBED_MODEL)


# ── Ollama ────────────────────────────────────────────────────────────────────

def _generate_embedding_ollama(text: str) -> List[float]:
  # 서버 터널(OLLAMA_URL) 우선 시도 → 죽었으면 로컬 11434 fallback.
  # 죽은 터널에 오래 안 매달리게 timeout 15초.
  urls = _ollama_urls()
  last_err: Exception | None = None
  for i, base in enumerate(urls):
    try:
      resp = requests.post(
        f"{base}/api/embed",
        json={"model": EMBED_MODEL, "input": text},
        timeout=15,
      )
      resp.raise_for_status()
      if i > 0:
        logger.warning(f"임베딩: {urls[0]} 실패 → 로컬 fallback {base} 성공")
      return resp.json()["embeddings"][0]
    except (requests.exceptions.ConnectionError, requests.exceptions.Timeout) as e:
      last_err = e
      if i < len(urls) - 1:
        logger.warning(f"임베딩 {base} 접속 실패 → 다음 URL 시도: {e}")
        continue
      raise
  raise last_err if last_err else RuntimeError("ollama embed failed")


_OLLAMA_BATCH_SIZE = 8
_OLLAMA_CHUNK_RETRIES = 5
_OLLAMA_RETRY_SLEEP = 1.5
_BGE_M3_DIM = 1024  # bge-m3 임베딩 차원. 특정 토큰 조합에서 NaN 실패 시 zero vector fallback 용.


def _embed_chunk_ollama(chunk: List[str]) -> List[List[float]]:
  """단일 청크 임베딩. bge-m3 NaN 500 대응으로 최대 5회 재시도 (backoff) +
  여전히 실패하면 청크를 1개씩 쪼개 개별 호출.

  NaN 500 은 직접 호출엔 안 나오고 배치 + 부하 조합에서 간헐적으로 발생.
  배치 크기를 8로 낮춰 부하 분산 + 재시도 간 sleep 으로 복구 유도."""
  import time as _time
  last_err: Exception | None = None
  for attempt in range(_OLLAMA_CHUNK_RETRIES):
    try:
      resp = requests.post(
        f"{OLLAMA_URL}/api/embed",
        json={"model": EMBED_MODEL, "input": chunk},
        timeout=120,
      )
      if not resp.ok:
        max_len = max(len(t) for t in chunk) if chunk else 0
        logger.warning(
          f"[embed] attempt={attempt+1} size={len(chunk)} "
          f"status={resp.status_code} body={resp.text[:200]} "
          f"max_len={max_len} chunk={[t[:60] for t in chunk]!r}"
        )
        resp.raise_for_status()
      return resp.json()["embeddings"]
    except requests.exceptions.HTTPError as e:
      last_err = e
      if attempt < _OLLAMA_CHUNK_RETRIES - 1:
        _time.sleep(_OLLAMA_RETRY_SLEEP * (attempt + 1))
      continue
  # 청크 단위 재시도 모두 실패 → 1개씩 개별 호출 (NaN 은 대부분 특정 1~2개 텍스트에 국한)
  if len(chunk) > 1:
    logger.warning(f"[embed] 청크 {len(chunk)}개 재시도 모두 실패 → 1개씩 개별 호출")
    out: List[List[float]] = []
    for idx, text in enumerate(chunk):
      try:
        out.extend(_embed_chunk_ollama([text]))
      except Exception as ie:
        # bge-m3 가 특정 영어 토큰 조합에서 결정적으로 NaN 을 뱉는 증상 대응.
        # 해당 텍스트만 zero vector 치환 (매칭 시 cosine 유사도 0 → 자연 탈락).
        logger.warning(
          f"[embed] 개별 실패 → zero vector 치환 [{idx}] text={text[:80]!r}: {ie}"
        )
        out.append([0.0] * _BGE_M3_DIM)
    return out
  # 청크 크기 1 에서의 실패는 상위로 전파. 여기서 zero 치환하면 재귀 호출자가 "성공"으로 오인.
  raise last_err if last_err else RuntimeError("embed chunk failed")


def _generate_embeddings_batch_ollama(texts: List[str]) -> List[List[float]]:
  if not texts:
    return []
  results: List[List[float]] = []
  for i in range(0, len(texts), _OLLAMA_BATCH_SIZE):
    chunk = texts[i : i + _OLLAMA_BATCH_SIZE]
    results.extend(_embed_chunk_ollama(chunk))
  return results


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
  # EMBED_PROVIDER=ollama 로 명시 지정됐으면 차원 혼합 방지 위해 OpenAI fallback 차단
  if os.environ.get("EMBED_PROVIDER", "").strip().lower() == "ollama":
    return False
  return bool(os.environ.get("OPENAI_API_KEY", "").strip())


# ── 공개 API ──────────────────────────────────────────────────────────────────

def generate_embedding(text: str) -> List[float]:
  provider = _select_embed_provider()
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
  provider = _select_embed_provider()
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
