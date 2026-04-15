"""1회성: solution_jobs.progress 안의 legacy 절대경로를 UPLOAD_DIR 상대경로로 치환.

대상:
  progress.fragments: {번호or키: [경로, ...]}
  progress.page_bboxes: {page: {items: [{cropped_path: 경로, ...}, ...]}}

치환 규칙 (config.resolve_upload_path + to_upload_relative 조합):
  1. 이미 상대경로 → 정규화만 (백슬래시 → 슬래시)
  2. 현재 UPLOAD_DIR 하위 절대경로 → UPLOAD_DIR 기준 상대경로로
  3. legacy `C:\\tmp\\pdf_pipeline\\solution_<id>\\solution_crops\\<file>` →
     pdf_path 의 parent 기반으로 현 위치 재매핑 후 상대경로로

사용법:
  cd backend/pdf_pipeline
  python scripts/migrate_solution_paths.py --dry-run
  python scripts/migrate_solution_paths.py
  python scripts/migrate_solution_paths.py --job-id <UUID>
"""
import argparse
import json
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PIPELINE_DIR = SCRIPT_DIR.parent
sys.path.insert(0, str(PIPELINE_DIR))

from config import resolve_upload_path, to_upload_relative  # noqa: E402
from storage.supabase_client import (  # noqa: E402
    get_client,
    get_solution_job,
    update_solution_job,
)


def _convert_path(path_str: str, pdf_path_hint: str | None) -> str:
    """경로 문자열 하나를 UPLOAD_DIR 상대 POSIX 문자열로."""
    if not path_str:
        return path_str
    resolved = resolve_upload_path(path_str, pdf_path_hint)
    return to_upload_relative(resolved)


def migrate_job(job: dict, dry_run: bool) -> dict:
    """단일 solution_job 의 progress 경로 치환. 변경 내역 반환."""
    job_id = job.get("id")
    pdf_path = job.get("pdf_path") or None
    progress = job.get("progress") or {}

    changes: list[tuple[str, str, str]] = []  # (location, before, after)

    # fragments
    fragments = progress.get("fragments") or {}
    new_fragments: dict = {}
    for key, paths in fragments.items():
        if not isinstance(paths, list):
            new_fragments[key] = paths
            continue
        new_paths = []
        for p in paths:
            np_ = _convert_path(p, pdf_path)
            if np_ != p:
                changes.append((f"fragments[{key}]", p, np_))
            new_paths.append(np_)
        new_fragments[key] = new_paths

    # page_bboxes
    page_bboxes = progress.get("page_bboxes") or {}
    new_page_bboxes: dict = {}
    for pnum, pdata in page_bboxes.items():
        if not isinstance(pdata, dict):
            new_page_bboxes[pnum] = pdata
            continue
        new_pdata = dict(pdata)
        items = pdata.get("items") or []
        new_items = []
        for it in items:
            if not isinstance(it, dict):
                new_items.append(it)
                continue
            new_it = dict(it)
            cp = it.get("cropped_path")
            if cp:
                new_cp = _convert_path(cp, pdf_path)
                if new_cp != cp:
                    changes.append(
                        (f"page_bboxes[{pnum}].items[n={it.get('number')}].cropped_path",
                         cp, new_cp)
                    )
                new_it["cropped_path"] = new_cp
            new_items.append(new_it)
        new_pdata["items"] = new_items
        new_page_bboxes[pnum] = new_pdata

    if not changes:
        return {"job_id": job_id, "changes": [], "updated": False}

    if not dry_run:
        new_progress = dict(progress)
        new_progress["fragments"] = new_fragments
        new_progress["page_bboxes"] = new_page_bboxes
        update_solution_job(
            job_id,
            status=job.get("status", "completed"),
            progress=new_progress,
        )

    return {"job_id": job_id, "changes": changes, "updated": not dry_run}


def list_all_solution_jobs() -> list[dict]:
    client = get_client()
    result = (
        client.table("solution_jobs")
        .select("id, pdf_path, status, progress")
        .execute()
    )
    return result.data or []


def main():
    parser = argparse.ArgumentParser(description="solution_jobs 경로 1회성 마이그레이션")
    parser.add_argument("--dry-run", action="store_true", help="변경 없이 미리보기")
    parser.add_argument("--job-id", help="특정 job 만 처리")
    args = parser.parse_args()

    if args.job_id:
        job = get_solution_job(args.job_id)
        if not job:
            print(f"[ERROR] job {args.job_id} 없음")
            sys.exit(1)
        jobs = [job]
    else:
        jobs = list_all_solution_jobs()

    print(f"대상 job: {len(jobs)}개 (dry_run={args.dry_run})")
    print("-" * 60)

    total_changes = 0
    updated = 0
    skipped_no_pdf = 0

    for job in jobs:
        if not job.get("pdf_path"):
            skipped_no_pdf += 1
            print(f"[SKIP] {job.get('id')} — pdf_path 없음")
            continue

        result = migrate_job(job, dry_run=args.dry_run)
        ch = result["changes"]
        if not ch:
            continue
        total_changes += len(ch)
        if result["updated"]:
            updated += 1

        print(f"\n[{'DRY' if args.dry_run else 'UPDATE'}] {result['job_id']}  ({len(ch)} changes)")
        for loc, before, after in ch[:5]:
            print(f"  {loc}")
            print(f"    - {before}")
            print(f"    + {after}")
        if len(ch) > 5:
            print(f"  ... {len(ch) - 5} more")

    print("-" * 60)
    print(json.dumps({
        "total_jobs": len(jobs),
        "total_changes": total_changes,
        "updated_jobs": updated,
        "skipped_no_pdf": skipped_no_pdf,
        "dry_run": args.dry_run,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
