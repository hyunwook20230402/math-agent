"""유사 문제 검색 — pgvector cosine 거리 기반.

007 마이그레이션의 search_similar_problems RPC 호출.
problems.embedding 이 NULL 인 문제는 자동 제외.
"""
from __future__ import annotations

import logging
from typing import Optional

from ..storage.supabase_client import get_client

logger = logging.getLogger(__name__)


def find_similar(problem_id: str, limit: int = 3) -> list[dict]:
    """현재 문제의 embedding 을 기준으로 유사 문제 top-k 조회.

    Returns:
      [{"id", "image_url", "unit", "difficulty", "similarity"}, ...]
      embedding 이 없는 문제면 [] 반환 (graceful degradation).
    """
    client = get_client()

    # 1) 현재 문제의 embedding 조회
    current = (
        client.table("problems")
        .select("embedding")
        .eq("id", problem_id)
        .maybe_single()
        .execute()
    ).data

    if not current or current.get("embedding") is None:
        logger.info(f"문제 {problem_id} embedding 없음 — 유사 문제 추천 스킵")
        return []

    # 2) RPC 호출
    try:
        result = client.rpc(
            "search_similar_problems",
            {
                "query_embedding": current["embedding"],
                "exclude_id": problem_id,
                "match_limit": limit,
            },
        ).execute()
    except Exception as exc:
        logger.warning(f"search_similar_problems RPC 실패: {exc}")
        return []

    return result.data or []
