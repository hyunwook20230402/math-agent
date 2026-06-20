"""solution_nodes 백필 — 해설 있는 문제를 추론 노드로 분해해 적재.

실전 파이프라인 코드(rag_node_extractor)를 그대로 import 해서 호출한다
(손코딩 smoke 금지 — feedback_smoke_must_match_production).

사용법 (backend/pdf_pipeline 에서, venv 활성화 후):
  python -m scripts.backfill_solution_nodes --limit 4      # smoke (앞 4개)
  python -m scripts.backfill_solution_nodes                # 해설 있는 전체
  python -m scripts.backfill_solution_nodes --problem-id <uuid>

EMBED_PROVIDER=ollama 권장 (problems.embedding 과 동일 1024 차원 유지).
VLM 은 GPT-4o 강제(provider="openai") 이므로 OPENAI_API_KEY 필요.
"""
from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

from dotenv import load_dotenv

SCRIPT_DIR = Path(__file__).resolve().parent
PIPELINE_DIR = SCRIPT_DIR.parent
sys.path.insert(0, str(PIPELINE_DIR))
load_dotenv(PIPELINE_DIR / ".env")

from pipeline import rag_node_extractor  # noqa: E402
from storage.supabase_client import get_client  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("backfill_solution_nodes")


def _load_target_problems(client, limit: int | None, problem_id: str | None) -> list[dict]:
  q = client.table("problems").select(
    "id, image_url, solution_image_url, unit, difficulty_score"
  ).not_.is_("solution_image_url", "null").order("created_at")
  if problem_id:
    q = q.eq("id", problem_id)
  elif limit:
    q = q.limit(limit)
  return q.execute().data or []


def main() -> int:
  ap = argparse.ArgumentParser()
  ap.add_argument("--limit", type=int, default=None, help="처리할 문제 수 (smoke 용)")
  ap.add_argument("--problem-id", type=str, default=None, help="특정 문제만")
  args = ap.parse_args()

  client = get_client()
  problems = _load_target_problems(client, args.limit, args.problem_id)
  if not problems:
    logger.warning("대상 문제 없음 (solution_image_url 채워진 문제가 없거나 필터 불일치)")
    return 0

  logger.info(f"대상 {len(problems)}개 처리 시작")
  ok = skipped = err = total_nodes = 0
  for i, prob in enumerate(problems, 1):
    logger.info(f"[{i}/{len(problems)}] problem_id={prob['id']} unit={prob.get('unit')}")
    res = rag_node_extractor.build_and_store(prob, client)
    if res.status == "success":
      ok += 1
      total_nodes += len(res.nodes)
      logger.info(f"  ✓ nodes={len(res.nodes)}")
    elif res.status == "skipped":
      skipped += 1
      logger.info(f"  - skip: {res.error}")
    else:
      err += 1
      logger.error(f"  ✗ error: {res.error}")

  logger.info(
    f"완료 — success={ok} skipped={skipped} error={err} "
    f"total_nodes={total_nodes} avg_nodes={total_nodes / ok:.1f}" if ok else
    f"완료 — success={ok} skipped={skipped} error={err}"
  )
  return 0 if err == 0 else 1


if __name__ == "__main__":
  sys.exit(main())
