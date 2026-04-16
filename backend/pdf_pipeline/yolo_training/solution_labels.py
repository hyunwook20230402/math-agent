"""해설지 검수 완료 데이터 → YOLO 학습 라벨 역수출 (2-클래스)

solution_jobs 메모리(또는 DB page_bboxes)를 읽어
solution_dataset/{images,labels,metadata}/{train,val}/ 에 저장.

라벨 규칙:
  - 클래스: 0 = solution_block, 1 = answer_table
  - 포맷: ultralytics standard  `<cls> cx cy w h`  (normalized 0~1)
  - L자/cross-page 같은 번호: 박스 개수만큼 별개 라인, 같은 problem_number
  - 박스 0개: export 제외 (실수 방지)

사이드카 JSON (metadata/):
  {
    "solution_job_id": "...",
    "page_number": N,
    "boxes": [
      {"problem_number": 22, "group_id": "abc", "box_type": "solution", "bbox": {...}},
      {"problem_number": 0,  "group_id": null,  "box_type": "answer_table", "bbox": {...}},
      ...
    ]
  }

사용법:
  cd backend/pdf_pipeline/yolo_training
  ../venv/Scripts/python solution_labels.py --job-id <UUID> [--split-ratio 0.8] [--force]
"""
import argparse
import json
import logging
import shutil
import sys
from pathlib import Path

logger = logging.getLogger(__name__)

# 파이프라인 루트를 sys.path에 추가
SCRIPT_DIR = Path(__file__).resolve().parent
PIPELINE_DIR = SCRIPT_DIR.parent
sys.path.insert(0, str(PIPELINE_DIR))

from config import SOLUTION_DATASET_DIR as DATASET_DIR
from config import SOLUTION_EXPORT_LOG as _EXPORT_LOG_PATH


def _load_log() -> dict:
    if _EXPORT_LOG_PATH.exists():
        try:
            return json.loads(_EXPORT_LOG_PATH.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def _save_log(log: dict):
    _EXPORT_LOG_PATH.write_text(json.dumps(log, ensure_ascii=False, indent=2), encoding="utf-8")


def _normalize_bbox(bbox: dict, img_w: int, img_h: int) -> tuple[float, float, float, float]:
    """픽셀 bbox → YOLO normalized (cx, cy, w, h)"""
    x1, y1, x2, y2 = bbox["x1"], bbox["y1"], bbox["x2"], bbox["y2"]
    cx = ((x1 + x2) / 2) / img_w
    cy = ((y1 + y2) / 2) / img_h
    w = (x2 - x1) / img_w
    h = (y2 - y1) / img_h
    # 범위 클리핑
    cx = max(0.0, min(1.0, cx))
    cy = max(0.0, min(1.0, cy))
    w = max(0.0, min(1.0, w))
    h = max(0.0, min(1.0, h))
    return cx, cy, w, h


def export_solution_labels(
    solution_job_id: str,
    page_bboxes: dict,
    pages_tmp_dir: Path,
    split_ratio: float = 0.8,
    force: bool = False,
) -> dict:
    """page_bboxes 딕셔너리에서 YOLO 라벨 파일 생성.

    Args:
        solution_job_id: solution_jobs 키 (중복 체크용)
        page_bboxes: {page_number: {items: [...], is_negative_page: bool}} 구조
        pages_tmp_dir: 페이지 원본 이미지 디렉토리 (solution_crops/_pages/)
        split_ratio: train 비율 (0~1)
        force: True면 기존 export 덮어쓰기

    Returns:
        {"total_pages": N, "exported": M, "skipped": K, "train": T, "val": V}
    """
    from PIL import Image as PILImage
    from datetime import datetime

    log = _load_log()
    if not force and solution_job_id in log:
        entry = log[solution_job_id]
        return {
            "already_exported": True,
            "exported_at": entry.get("exported_at"),
            "message": "이미 export됨. force=True로 재export 가능.",
        }

    # 페이지 이미지 목록 (정렬)
    page_imgs = sorted(pages_tmp_dir.glob("*.png"))
    if not page_imgs:
        raise FileNotFoundError(f"페이지 이미지 없음: {pages_tmp_dir}")

    exported = 0
    skipped = 0
    train_count = 0
    val_count = 0
    warnings: list[str] = []

    # 전역 누적 train/val 현황 — 매 export 시 이미 쌓인 비율을 보고
    # 목표 비율(split_ratio)에 근접하도록 결정론적으로 배정한다.
    # 페이지 단위 random 샘플링은 3~4페이지 PDF가 반복되면 편차가 누적됨.
    existing_train = len(list((DATASET_DIR / "images" / "train").glob("*.png")))
    existing_val = len(list((DATASET_DIR / "images" / "val").glob("*.png")))

    def _pick_split() -> str:
        """현재까지 누적된 train 비율이 목표보다 낮으면 train, 높으면 val."""
        total = existing_train + train_count + existing_val + val_count
        if total == 0:
            return "train"
        current_ratio = (existing_train + train_count) / total
        return "train" if current_ratio < split_ratio else "val"

    # 페이지 키 정규화 (int/str 모두 처리)
    normalized: dict[int, dict] = {}
    for k, v in page_bboxes.items():
        try:
            normalized[int(k)] = v
        except (ValueError, TypeError):
            pass

    for page_img_path in page_imgs:
        # 파일명에서 페이지 번호 추출 (0-indexed → 1-indexed)
        idx = page_imgs.index(page_img_path)  # 0-based
        page_num = idx + 1

        page_data = normalized.get(page_num)
        if page_data is None:
            msg = f"page {page_num}: page_bboxes 에 페이지 키 없음 — 박스 저장 누락 의심"
            logger.warning(msg)
            warnings.append(msg)
            skipped += 1
            continue

        items = page_data.get("items", [])

        # 박스 0개 → export 제외
        if not items:
            msg = f"page {page_num}: 박스 0개 — export 제외"
            logger.warning(msg)
            warnings.append(msg)
            skipped += 1
            continue

        # train/val 분리 — 전역 누적 비율 기준 결정론적 배정
        split = _pick_split()

        # 이미지 크기 — ultralytics 가 PIL.Image.open 을 monkey-patch 해서
        # 한글 경로를 cp949 로 해석하다 실패하므로, 바이트로 읽어 BytesIO 경유.
        import io
        with open(page_img_path, "rb") as f:
            _buf = f.read()
        with PILImage.open(io.BytesIO(_buf)) as im:
            img_w, img_h = im.size

        # 파일명 (solution_job_id 앞 8자 + 페이지번호)
        stem = f"sol_{solution_job_id[:8]}_page_{page_num:03d}"
        dst_img = DATASET_DIR / "images" / split / f"{stem}.png"
        dst_lbl = DATASET_DIR / "labels" / split / f"{stem}.txt"
        dst_meta = DATASET_DIR / "metadata" / split / f"{stem}.json"

        # 이미지 복사
        shutil.copy2(page_img_path, dst_img)

        # YOLO 라벨 작성 (2-클래스: 0=solution, 1=answer_table)
        label_lines = []
        meta_boxes = []
        for it in items:
            bbox = it.get("bbox") if isinstance(it, dict) else None
            if not bbox:
                continue
            num = it.get("number")
            group_id = it.get("group_id")
            box_type = it.get("box_type", "solution")
            cls_id = 1 if box_type == "answer_table" else 0
            cx, cy, w, h = _normalize_bbox(bbox, img_w, img_h)
            if w > 0 and h > 0:
                label_lines.append(f"{cls_id} {cx:.6f} {cy:.6f} {w:.6f} {h:.6f}")
                meta_boxes.append({
                    "problem_number": num,
                    "group_id": group_id,
                    "box_type": box_type,
                    "bbox": bbox,
                })

        dst_lbl.write_text("\n".join(label_lines), encoding="utf-8")

        # 사이드카 JSON
        meta = {
            "solution_job_id": solution_job_id,
            "page_number": page_num,
            "image_size": {"width": img_w, "height": img_h},
            "boxes": meta_boxes,
        }
        dst_meta.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

        exported += 1
        if split == "train":
            train_count += 1
        else:
            val_count += 1

    # export 기록
    log[solution_job_id] = {
        "exported_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "exported_pages": exported,
        "train": train_count,
        "val": val_count,
    }
    _save_log(log)

    return {
        "total_pages": len(page_imgs),
        "exported": exported,
        "skipped": skipped,
        "train": train_count,
        "val": val_count,
        "warnings": warnings,
    }


def main():
    parser = argparse.ArgumentParser(description="해설지 검수 데이터 → YOLO 라벨 역수출")
    parser.add_argument("--job-id", required=True, help="solution_jobs UUID")
    parser.add_argument("--split-ratio", type=float, default=0.8, help="train 비율 (기본 0.8)")
    parser.add_argument("--force", action="store_true", help="기존 export 덮어쓰기")
    args = parser.parse_args()

    from storage.supabase_client import get_solution_job

    job = get_solution_job(args.job_id)
    if not job:
        print(f"[ERROR] solution_job {args.job_id} 없음")
        sys.exit(1)

    page_bboxes = job.get("progress", {}).get("page_bboxes") or {}
    if not page_bboxes:
        print("[ERROR] page_bboxes 데이터 없음. 검수 완료 후 실행하세요.")
        sys.exit(1)

    pdf_path = Path(job.get("pdf_path", ""))
    pages_tmp_dir = pdf_path.parent / "solution_crops" / "_pages"
    if not pages_tmp_dir.exists():
        print(f"[ERROR] 페이지 이미지 디렉토리 없음: {pages_tmp_dir}")
        sys.exit(1)

    result = export_solution_labels(
        args.job_id, page_bboxes, pages_tmp_dir,
        split_ratio=args.split_ratio, force=args.force,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
