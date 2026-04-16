"""problems.embedding 백필 스크립트.

유사 문제 추천 RPC(search_similar_problems) 가 동작하려면 problems.embedding
컬럼이 채워져 있어야 한다. 이 스크립트는 embedding IS NULL 인 행을 찾아
bge-m3 로 임베딩 생성 후 UPDATE 한다.

임베딩 입력 텍스트 (우선순위):
  1. solution_summary + concept_tags + skill_tags + unit  (태깅 완료된 문제)
  2. problem_text + unit                                   (구조화는 됐지만 태깅 전)
  3. unit 만                                               (fallback)

실행:
    cd backend/deeptutor
    python -m scripts.fill_embeddings --batch 50 --dry-run
    python -m scripts.fill_embeddings --batch 50

환경변수:
    EMBED_OLLAMA_URL    (기본 http://localhost:11434)
    EMBED_MODEL         (기본 bge-m3)
"""
from __future__ import annotations

import argparse
import logging
import sys
import time

import requests

# deeptutor 패키지로 실행되므로 상대 import
from ..config import EMBED_MODEL, EMBED_OLLAMA_URL
from ..storage.supabase_client import get_client

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


def generate_embedding(text: str) -> list[float]:
    """bge-m3 호출 — pdf_pipeline.pipeline.embedder 와 동일 패턴."""
    resp = requests.post(
        f"{EMBED_OLLAMA_URL}/api/embeddings",
        json={"model": EMBED_MODEL, "prompt": text},
        timeout=60,
    )
    resp.raise_for_status()
    return resp.json()["embedding"]


def build_embed_text(problem: dict, tags: list[dict]) -> str:
    """임베딩용 텍스트 구성."""
    parts: list[str] = []

    if problem.get("unit"):
        parts.append(problem["unit"])

    if problem.get("solution_summary"):
        parts.append(problem["solution_summary"])
    elif problem.get("problem_text"):
        parts.append(problem["problem_text"])

    concept = [t["tag"] for t in tags if t.get("tag_type") == "concept"]
    skill = [t["tag"] for t in tags if t.get("tag_type") == "skill"]
    if concept:
        parts.append("개념: " + ", ".join(concept))
    if skill:
        parts.append("풀이 기술: " + ", ".join(skill))

    return " | ".join(parts) if parts else "수학 문제"


def run(batch_size: int, dry_run: bool) -> None:
    client = get_client()

    # 1) embedding NULL 문제 조회
    null_problems = (
        client.table("problems")
        .select("id, unit, solution_summary, problem_text")
        .is_("embedding", None)
        .limit(batch_size)
        .execute()
    ).data or []

    total_null = len(null_problems)
    logger.info(f"embedding NULL 문제: {total_null}개 (batch_size={batch_size})")

    if total_null == 0:
        logger.info("모든 문제에 embedding 이 채워져 있습니다. 종료.")
        return

    processed = 0
    failed = 0

    for i, prob in enumerate(null_problems, 1):
        problem_id = prob["id"]

        # 태그 조회
        tags = (
            client.table("problem_tags")
            .select("tag, tag_type")
            .eq("problem_id", problem_id)
            .execute()
        ).data or []

        text = build_embed_text(prob, tags)
        logger.info(f"[{i}/{total_null}] {problem_id} → {text[:80]}...")

        if dry_run:
            continue

        try:
            embedding = generate_embedding(text)
        except Exception as exc:
            logger.error(f"  embedding 생성 실패: {exc}")
            failed += 1
            continue

        try:
            client.table("problems").update({"embedding": embedding}).eq(
                "id", problem_id
            ).execute()
            processed += 1
        except Exception as exc:
            logger.error(f"  DB UPDATE 실패: {exc}")
            failed += 1
            continue

        # 과부하 방지 — bge-m3 는 가벼우므로 sleep 짧게
        time.sleep(0.1)

    logger.info(f"완료 — 성공 {processed}건 / 실패 {failed}건")

    if not dry_run and total_null == batch_size:
        logger.info(
            "배치 크기만큼 처리됐습니다. 추가 문제가 남아있을 수 있으니 다시 실행해주세요."
        )


def main():
    parser = argparse.ArgumentParser(description="problems.embedding 백필")
    parser.add_argument("--batch", type=int, default=50, help="한 번에 처리할 문제 수")
    parser.add_argument("--dry-run", action="store_true", help="DB 업데이트 없이 텍스트만 출력")
    args = parser.parse_args()

    try:
        run(args.batch, args.dry_run)
    except KeyboardInterrupt:
        logger.info("중단됨")
        sys.exit(1)


if __name__ == "__main__":
    main()
