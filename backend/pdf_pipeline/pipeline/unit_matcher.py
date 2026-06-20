"""단원(unit) 임베딩 기반 매칭

AI 프롬프트에 4단 트리를 주입하지 않고, Python 후처리에서 임베딩 cosine 유사도로
taxonomy leaf 와 매칭해 4단 경로를 확정한다.

주요 함수:
  load_or_build_embeddings(taxonomy_path, cache_path) → leaf 임베딩 dict
  flatten_units(taxonomy) → [{"path": "...", "text": "..."}]
  match_unit(query_text, leaf_embeddings, threshold) → (unit_path, score)
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

DEFAULT_THRESHOLD = 0.55


def flatten_units(taxonomy: dict) -> list[dict]:
  """units 트리를 leaf(소단원) 단위로 평탄화.

  Returns:
    [{"path": "과목 > 대단원 > 중단원 > 소단원", "text": "임베딩용 문자열"}, ...]
  """
  units = taxonomy.get("units", {})
  leaves: list[dict] = []
  for subject, mids in units.items():
    if not isinstance(mids, dict):
      continue
    for big, middles in mids.items():
      if not isinstance(middles, dict):
        continue
      for middle, smalls in middles.items():
        if not isinstance(smalls, list):
          continue
        for small in smalls:
          path = f"{subject} > {big} > {middle} > {small}"
          text = f"{subject} {big} {middle} {small}"
          leaves.append({"path": path, "text": text})
  return leaves


def _taxonomy_hash(taxonomy: dict) -> str:
  """taxonomy units 내용 hash (캐시 무효화용)"""
  canonical = json.dumps(taxonomy.get("units", {}), ensure_ascii=False, sort_keys=True)
  return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:12]


def load_or_build_embeddings(
  taxonomy_path: Path,
  cache_dir: Path | None = None,
) -> dict:
  """leaf 임베딩 로드 or 생성. pkl 캐시.

  Returns:
    {
      "paths": [str, ...],           # 4단 경로
      "vectors": np.ndarray,         # (N, D) 정규화된 임베딩
      "hash": str,                   # taxonomy hash
    }
  """
  if cache_dir is None:
    cache_dir = taxonomy_path.parent

  with open(taxonomy_path, encoding="utf-8") as f:
    taxonomy = json.load(f)

  tax_hash = _taxonomy_hash(taxonomy)
  provider, model_tag = embedder.get_provider_model_tag()
  cache_path = cache_dir / f"unit_embeddings_{provider}_{model_tag}_{tax_hash}.pkl"

  if cache_path.exists():
    try:
      with open(cache_path, "rb") as f:
        cache = pickle.load(f)
      if cache.get("hash") == tax_hash:
        logger.info(f"unit 임베딩 캐시 로드: {cache_path.name} ({len(cache['paths'])}개 leaf)")
        return cache
    except Exception as e:
      logger.warning(f"캐시 로드 실패, 재생성: {e}")

  leaves = flatten_units(taxonomy)
  if not leaves:
    logger.warning("taxonomy units 비어 있음 — 빈 임베딩 반환")
    return {"paths": [], "vectors": np.zeros((0, 0)), "hash": tax_hash}

  t0 = time.time()
  logger.info(f"unit 임베딩 생성 시작: leaf {len(leaves)}개")
  texts = [leaf["text"] for leaf in leaves]
  vectors = np.array(embedder.generate_embeddings_batch(texts), dtype=np.float32)
  # L2 정규화 (cosine 유사도용)
  norms = np.linalg.norm(vectors, axis=1, keepdims=True)
  norms[norms == 0] = 1.0
  vectors = vectors / norms

  result = {
    "paths": [leaf["path"] for leaf in leaves],
    "vectors": vectors,
    "hash": tax_hash,
  }

  try:
    with open(cache_path, "wb") as f:
      pickle.dump(result, f)
    logger.info(f"unit 임베딩 완료: {len(leaves)}개, {time.time()-t0:.1f}s, 캐시 저장 → {cache_path.name}")
  except Exception as e:
    logger.warning(f"캐시 저장 실패: {e}")

  return result


def _degrade_path(path: str, levels: int) -> str:
  """4단 경로를 지정한 단계까지 자름. levels=0 이면 빈 문자열."""
  if levels <= 0:
    return ""
  parts = [p.strip() for p in path.split(">") if p.strip()]
  return " > ".join(parts[:levels])


def match_unit(
  query_text: str,
  leaf_embeddings: dict,
  threshold: float = DEFAULT_THRESHOLD,
) -> tuple[str, float]:
  """query 임베딩 → top-1 leaf 경로 + 유사도.

  - top-1 score >= threshold: 4단 경로 그대로
  - threshold*0.85 이상: 3단 강등 (중단원까지)
  - threshold*0.70 이상: 2단 강등 (대단원까지)
  - 그 미만: 빈 문자열

  Args:
    query_text: concept_tags + skill_tags 를 합친 한 문장
    leaf_embeddings: load_or_build_embeddings 결과
    threshold: top-1 cosine 유사도 임계값

  Returns:
    (unit_path, score). 매칭 실패 시 ("", score).
  """
  paths = leaf_embeddings.get("paths", [])
  vectors = leaf_embeddings.get("vectors")
  if not paths or vectors is None or len(paths) == 0:
    return "", 0.0

  query_text = (query_text or "").strip()
  if not query_text:
    return "", 0.0

  q_vec = np.array(embedder.generate_embedding(query_text), dtype=np.float32)
  q_norm = np.linalg.norm(q_vec)
  if q_norm == 0:
    return "", 0.0
  q_vec = q_vec / q_norm

  sims = vectors @ q_vec  # (N,) cosine (이미 정규화됨)
  top_idx = int(np.argmax(sims))
  top_score = float(sims[top_idx])
  top_path = paths[top_idx]

  if top_score >= threshold:
    return top_path, top_score
  if top_score >= threshold * 0.85:
    return _degrade_path(top_path, 3), top_score
  if top_score >= threshold * 0.70:
    return _degrade_path(top_path, 2), top_score
  return "", top_score
