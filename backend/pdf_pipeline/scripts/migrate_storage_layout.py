"""1회성 저장소 레이아웃 이전.

구 구조:
  yolo_training/dataset_new/              (문제 YOLO 학습 데이터)
  yolo_training/solution_dataset/         (해설 YOLO 학습 데이터)
  yolo_training/export_log.json           (문제 export 로그)
  yolo_training/solution_export_log.json  (해설 export 로그)

새 구조:
  uploads/problems/dataset/
  uploads/solutions/dataset/
  uploads/problems/export_log.json
  uploads/solutions/export_log.json

사용법:
  cd backend/pdf_pipeline
  python scripts/migrate_storage_layout.py --dry-run
  python scripts/migrate_storage_layout.py

대상이 이미 존재하면 경고 후 중단(덮어쓰지 않음).
"""
import argparse
import shutil
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PIPELINE_DIR = SCRIPT_DIR.parent
sys.path.insert(0, str(PIPELINE_DIR))

from config import (
    PROBLEM_DATASET_DIR,
    SOLUTION_DATASET_DIR,
    PROBLEM_EXPORT_LOG,
    SOLUTION_EXPORT_LOG,
)

YOLO_DIR = PIPELINE_DIR / "yolo_training"

MIGRATIONS = [
    (YOLO_DIR / "dataset_new", PROBLEM_DATASET_DIR, "문제 학습 데이터셋"),
    (YOLO_DIR / "solution_dataset", SOLUTION_DATASET_DIR, "해설 학습 데이터셋"),
    (YOLO_DIR / "export_log.json", PROBLEM_EXPORT_LOG, "문제 export 로그"),
    (YOLO_DIR / "solution_export_log.json", SOLUTION_EXPORT_LOG, "해설 export 로그"),
]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="실제 이동 없이 계획만 출력")
    args = parser.parse_args()

    has_error = False
    for src, dst, label in MIGRATIONS:
        if not src.exists():
            print(f"[SKIP] {label}: 원본 없음 ({src})")
            continue
        if dst.exists():
            print(f"[ERROR] {label}: 대상 이미 존재 → 덮어쓰기 방지. 수동 처리 필요 ({dst})")
            has_error = True
            continue
        print(f"[MOVE] {label}: {src} → {dst}")
        if not args.dry_run:
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(src), str(dst))

    if has_error:
        print("\n경고: 일부 대상이 이미 존재해 이동하지 않았습니다. 수동 확인 필요.")
        sys.exit(1)

    if args.dry_run:
        print("\n[dry-run] 실제 이동하려면 --dry-run 없이 다시 실행하세요.")
    else:
        print("\n이전 완료.")


if __name__ == "__main__":
    main()
