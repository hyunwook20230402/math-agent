"""태그 정규화 — bge-m3 임베딩 cosine 유사도 기반

AI가 내보낸 raw 태그(예: "trigonometric equations")를 taxonomy의 canonical 태그
(예: "삼각함수")로 매핑한다. character-level Jaccard의 오매칭 문제를 해결.

주요 함수:
  load_or_build_section_embeddings(taxonomy_path, section) → {canonical: vector, ...}
  match_tag(raw_tag, section_embeddings, threshold) → (canonical | raw_tag, score)
"""
import hashlib
import json
import logging
import pickle
import time
from pathlib import Path

import numpy as np

from . import embedder

logger = logging.getLogger(__name__)

# 태그 문자열은 짧으므로 unit 매칭(0.55)보다 살짝 높게
DEFAULT_THRESHOLD = 0.6


_EMBED_BUILD_VERSION = "v2-per-synonym"


def _section_hash(section: dict) -> str:
  """section 내용 + 빌드 로직 버전 hash (캐시 무효화용)"""
  canonical = json.dumps(section, ensure_ascii=False, sort_keys=True)
  payload = f"{_EMBED_BUILD_VERSION}|{canonical}"
  return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:12]


def _build_embeddings(section: dict) -> dict:
  """canonical과 동의어를 각각 개별 임베딩 후 canonical 인덱스로 매핑.

  canonical+동의어를 한 문자열로 합치면 벡터가 분산돼 단일 영어 raw 태그와의
  cosine 유사도가 낮아진다. 각 문자열을 개별 벡터로 두고, 매칭 시 canonical별
  최대 유사도를 취하는 방식으로 이 문제를 우회한다.

  Returns:
    {
      "canonicals": [str, ...],       # canonical 목록 (길이 M)
      "vectors": np.ndarray,          # (N, D) L2 정규화됨 (N = canonical + 동의어 총 개수)
      "owner_idx": np.ndarray,        # (N,) 각 벡터가 속한 canonical 인덱스 (0..M-1)
    }
  """
  canonicals: list[str] = []
  texts: list[str] = []
  owner_idx: list[int] = []
  for ci, (canonical, synonyms) in enumerate(section.items()):
    canonicals.append(canonical)
    # canonical 자체 + 각 동의어를 모두 독립 벡터로 추가
    variants = [canonical] + list(synonyms or [])
    for v in variants:
      if not v:
        continue
      texts.append(v)
      owner_idx.append(ci)

  if not canonicals or not texts:
    return {
      "canonicals": canonicals,
      "vectors": np.zeros((0, 0), dtype=np.float32),
      "owner_idx": np.zeros((0,), dtype=np.int32),
    }

  vectors = np.array(embedder.generate_embeddings_batch(texts), dtype=np.float32)
  norms = np.linalg.norm(vectors, axis=1, keepdims=True)
  norms[norms == 0] = 1.0
  vectors = vectors / norms

  return {
    "canonicals": canonicals,
    "vectors": vectors,
    "owner_idx": np.array(owner_idx, dtype=np.int32),
  }


def load_or_build_section_embeddings(
  taxonomy_path: Path,
  section_name: str,
  cache_dir: Path | None = None,
) -> dict:
  """section(concepts/skills/bugs) 임베딩 로드 or 생성. pkl 캐시.

  Args:
    taxonomy_path: concept_taxonomy.json 경로
    section_name: "concepts" | "skills" | "bugs"
  """
  if cache_dir is None:
    cache_dir = taxonomy_path.parent

  with open(taxonomy_path, encoding="utf-8") as f:
    taxonomy = json.load(f)

  section = taxonomy.get(section_name, {})
  sec_hash = _section_hash(section)
  provider, model_tag = embedder.get_provider_model_tag()
  cache_path = cache_dir / f"tag_embeddings_{section_name}_{provider}_{model_tag}_{sec_hash}.pkl"

  if cache_path.exists():
    try:
      with open(cache_path, "rb") as f:
        cache = pickle.load(f)
      if cache.get("hash") == sec_hash:
        logger.info(f"태그 임베딩 캐시 로드: {cache_path.name} ({len(cache['canonicals'])}개)")
        return cache
    except Exception as e:
      logger.warning(f"태그 임베딩 캐시 로드 실패, 재생성: {e}")

  t0 = time.time()
  logger.info(f"태그 임베딩 생성: section={section_name}, {len(section)}개")
  result = _build_embeddings(section)
  result["hash"] = sec_hash

  try:
    with open(cache_path, "wb") as f:
      pickle.dump(result, f)
    logger.info(f"태그 임베딩 완료: {len(result['canonicals'])}개, {time.time()-t0:.1f}s → {cache_path.name}")
  except Exception as e:
    logger.warning(f"캐시 저장 실패: {e}")

  return result


def match_tag(
  raw_tag: str,
  section_embeddings: dict,
  threshold: float = DEFAULT_THRESHOLD,
) -> tuple[str, float]:
  """raw 태그를 canonical 태그로 매핑.

  Returns:
    (canonical, score) 매칭 성공 시.
    (raw_tag, score) 임계값 미만일 때는 원본 유지.
  """
  raw_tag = (raw_tag or "").strip()
  if not raw_tag:
    return "", 0.0

  canonicals = section_embeddings.get("canonicals", [])
  vectors = section_embeddings.get("vectors")
  owner_idx = section_embeddings.get("owner_idx")
  if not canonicals or vectors is None or len(canonicals) == 0 or owner_idx is None:
    return raw_tag, 0.0

  # 완전 일치 먼저 (임베딩 호출 절약)
  if raw_tag in canonicals:
    return raw_tag, 1.0

  q_vec = np.array(embedder.generate_embedding(raw_tag), dtype=np.float32)
  q_norm = np.linalg.norm(q_vec)
  if q_norm == 0:
    return raw_tag, 0.0
  q_vec = q_vec / q_norm

  sims = vectors @ q_vec
  # canonical별 최대 유사도로 집계 (동의어 중 가장 잘 맞는 벡터 기준)
  per_canonical = np.full(len(canonicals), -np.inf, dtype=np.float32)
  np.maximum.at(per_canonical, owner_idx, sims)

  top_idx = int(np.argmax(per_canonical))
  top_score = float(per_canonical[top_idx])

  if top_score >= threshold:
    return canonicals[top_idx], top_score
  return raw_tag, top_score
