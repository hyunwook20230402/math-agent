"""1회성: 기존 solution_jobs.progress.tag_results 의 step 들에
`_wrap_formula` + `_sanitize_step` 후처리 재적용.

배경 (2026-04-22):
  30개 재태깅 전수 분석 결과 범주 A-1 / A-2 / A-3 / B-2 / B-3 / D-2 (formula delimiter
  누락, description raw 수식, placeholder 잔존, `description:` prefix, reason="null" 등)
  다수 확인됨. 프롬프트/스키마만 고쳐서는 이미 DB 에 저장된 과거 엔트리를 고치지 못하므로
  후처리 함수를 한 번 재적용하여 소급 정규화한다.

사용법 (반드시 `dry-run` 먼저 돌려 변경 규모 확인):
  cd backend/pdf_pipeline
  python scripts/refix_solution_steps.py --dry-run
  python scripts/refix_solution_steps.py --dry-run --job-id <UUID>
  python scripts/refix_solution_steps.py --apply
  python scripts/refix_solution_steps.py --apply --job-id <UUID>

동작:
  1. status='done' 또는 'reviewing' 인 solution_jobs 조회 (또는 --job-id 단일)
  2. progress.tag_results[num].solution_steps 각 step 에 _sanitize_step 적용
  3. --apply 일 때 Supabase update. dry-run 은 변경 리포트만 출력
  4. --apply 시 백업 JSON 을 `scripts/refix_backups/<job_id>.json` 에 자동 저장
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PIPELINE_DIR = SCRIPT_DIR.parent
sys.path.insert(0, str(PIPELINE_DIR))

from pipeline.solution_tagger import _sanitize_step, _wrap_formula  # noqa: E402
from storage.supabase_client import (  # noqa: E402
    get_client,
    get_solution_job,
    update_solution_job,
)

BACKUP_DIR = SCRIPT_DIR / "refix_backups"


def _refix_step(step: dict) -> tuple[dict, list[str]]:
  """한 step 후처리 + 변경 내역 문자열 리스트 반환."""
  before = json.dumps(step, ensure_ascii=False, sort_keys=True)
  new_step = _sanitize_step(dict(step))
  after = json.dumps(new_step, ensure_ascii=False, sort_keys=True)
  changes: list[str] = []
  if before != after:
    for key in ("hint", "formula", "concept"):
      b = step.get(key)
      a = new_step.get(key)
      if b != a:
        changes.append(f"  [{key}] {b!r} → {a!r}")
  return new_step, changes


def refix_job(job: dict, dry_run: bool) -> dict:
  """solution_job 하나의 progress.tag_results 재정규화.

  반환: {"job_id": ..., "changed_steps": int, "changed_problems": int, "lines": [...]}
  """
  job_id = job.get("id")
  progress = job.get("progress") or {}
  tag_results = progress.get("tag_results") or {}
  if not isinstance(tag_results, dict):
    return {"job_id": job_id, "changed_steps": 0, "changed_problems": 0, "lines": []}

  changed_problems = 0
  changed_steps = 0
  lines: list[str] = []
  new_tag_results: dict = {}

  for num, tr in tag_results.items():
    if not isinstance(tr, dict):
      new_tag_results[num] = tr
      continue
    steps = tr.get("solution_steps")
    if not isinstance(steps, list) or not steps:
      new_tag_results[num] = tr
      continue
    new_steps: list[dict] = []
    problem_changed = False
    for step in steps:
      if not isinstance(step, dict):
        new_steps.append(step)
        continue
      new_step, changes = _refix_step(step)
      new_steps.append(new_step)
      if changes:
        problem_changed = True
        changed_steps += 1
        lines.append(f"[{job_id}] 문제 {num} step {step.get('step')}:")
        lines.extend(changes)
    if problem_changed:
      changed_problems += 1
    new_tr = dict(tr)
    new_tr["solution_steps"] = new_steps
    new_tag_results[num] = new_tr

  if changed_steps > 0 and not dry_run:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_path = BACKUP_DIR / f"{job_id}__{ts}.json"
    with open(backup_path, "w", encoding="utf-8") as f:
      json.dump({"job_id": job_id, "progress": progress}, f, ensure_ascii=False, indent=2)
    lines.append(f"[{job_id}] 백업 저장: {backup_path}")

    new_progress = dict(progress)
    new_progress["tag_results"] = new_tag_results
    update_solution_job(
      solution_job_id=job_id,
      status=job.get("status") or "reviewing",
      progress=new_progress,
    )
    lines.append(f"[{job_id}] Supabase update 완료 (changed_steps={changed_steps})")

  return {
    "job_id": job_id,
    "changed_steps": changed_steps,
    "changed_problems": changed_problems,
    "lines": lines,
  }


def _list_target_jobs(job_id: str | None) -> list[dict]:
  if job_id:
    j = get_solution_job(job_id)
    return [j] if j else []
  client = get_client()
  result = (
    client.table("solution_jobs")
    .select("id,status,progress")
    .in_("status", ["done", "reviewing"])
    .execute()
  )
  return result.data or []


def main() -> int:
  p = argparse.ArgumentParser()
  p.add_argument("--dry-run", action="store_true", help="변경 리포트만 출력")
  p.add_argument("--apply", action="store_true", help="실제 DB 업데이트")
  p.add_argument("--job-id", type=str, default=None, help="단일 job 대상")
  args = p.parse_args()

  if not args.dry_run and not args.apply:
    print("--dry-run 또는 --apply 중 하나 필수")
    return 2
  if args.dry_run and args.apply:
    print("--dry-run 과 --apply 동시 지정 불가")
    return 2

  jobs = _list_target_jobs(args.job_id)
  print(f"대상 solution_jobs: {len(jobs)}개 (dry_run={args.dry_run})")

  total_steps = 0
  total_problems = 0
  total_jobs_touched = 0
  for job in jobs:
    report = refix_job(job, dry_run=args.dry_run)
    if report["changed_steps"] > 0:
      total_jobs_touched += 1
      total_steps += report["changed_steps"]
      total_problems += report["changed_problems"]
      for line in report["lines"]:
        print(line)

  print("---")
  print(f"변경된 job 수: {total_jobs_touched}")
  print(f"변경된 문제 수: {total_problems}")
  print(f"변경된 step 수: {total_steps}")
  if args.dry_run:
    print("(dry-run - 실제 적용은 --apply)")
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
