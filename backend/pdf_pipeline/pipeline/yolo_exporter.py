"""승인된 staging bbox → YOLO 학습 데이터 변환

사용법:
  POST /api/export-training-data  {"job_id": "uuid"}
  → uploads/problems/dataset/ 에 images/train, images/val, labels/train, labels/val 생성
"""
import io
import random
import urllib.request
from pathlib import Path
from typing import List

from storage.supabase_client import get_client
from config import PROBLEM_DATASET_DIR as DATASET_DIR


def export_to_yolo(job_id: str, split_ratio: float = 0.8, page_numbers: list | None = None) -> dict:
    """승인된 staging 문제 → YOLO 학습 형식 변환

    Args:
      job_id: 추출 작업 ID
      split_ratio: train 비율 (기본 80%)
      page_numbers: 내보낼 페이지 번호 목록 (None이면 전체)

    Returns:
      {"exported_count": int, "train": int, "val": int, "output_dir": str}
    """
    client = get_client()

    # bbox + source_page_image_url이 있는 staging 조회
    result = (
        client.table("problem_staging")
        .select("id, problem_number, page_number, bbox, source_page_image_url, status")
        .eq("job_id", job_id)
        .not_.is_("bbox", "null")
        .not_.is_("source_page_image_url", "null")
        .execute()
    )
    all_items = result.data or []

    # 수정된 페이지만 필터링
    if page_numbers is not None:
        page_set = set(page_numbers)
        all_items = [item for item in all_items if item.get("page_number") in page_set]

    if not all_items:
        return {"exported_count": 0, "train": 0, "val": 0, "output_dir": str(DATASET_DIR)}

    # 페이지별로 그룹핑 (한 페이지 이미지에 여러 bbox)
    pages: dict = {}
    for item in all_items:
        url = item["source_page_image_url"]
        pnum = item["page_number"]
        key = (url, pnum)
        if key not in pages:
            pages[key] = []
        pages[key].append(item)

    page_list = list(pages.items())
    random.shuffle(page_list)
    split_idx = max(1, int(len(page_list) * split_ratio))
    train_pages = page_list[:split_idx]
    val_pages = page_list[split_idx:]

    total = 0
    train_count = 0
    val_count = 0

    def _export_pages(page_items: list, split: str):
        nonlocal total, train_count, val_count

        img_dir = DATASET_DIR / "images" / split
        lbl_dir = DATASET_DIR / "labels" / split
        img_dir.mkdir(parents=True, exist_ok=True)
        lbl_dir.mkdir(parents=True, exist_ok=True)

        for (url, pnum), items in page_items:
            # 이미지 다운로드
            try:
                with urllib.request.urlopen(url) as resp:
                    img_bytes = resp.read()
            except Exception as e:
                print(f"[yolo_exporter] 이미지 다운로드 실패: {url} — {e}")
                continue

            # 이미지 크기 확인
            from PIL import Image as PILImage
            try:
                with PILImage.open(io.BytesIO(img_bytes)) as img:
                    iw, ih = img.size
            except Exception:
                continue

            # 파일명 결정 (job_id + page_number)
            stem = f"{job_id[:8]}_p{pnum:03d}"
            img_path = img_dir / f"{stem}.png"
            lbl_path = lbl_dir / f"{stem}.txt"

            # 이미지 저장
            with open(img_path, "wb") as f:
                f.write(img_bytes)

            # bbox → YOLO 정규화 좌표 변환
            lines = []
            for item in items:
                bbox = item["bbox"]
                x1, y1, x2, y2 = bbox["x1"], bbox["y1"], bbox["x2"], bbox["y2"]
                pw = bbox.get("page_width", iw)
                ph = bbox.get("page_height", ih)
                cx = (x1 + x2) / 2 / pw
                cy = (y1 + y2) / 2 / ph
                w = (x2 - x1) / pw
                h = (y2 - y1) / ph
                lines.append(f"0 {cx:.6f} {cy:.6f} {w:.6f} {h:.6f}")

            with open(lbl_path, "w") as f:
                f.write("\n".join(lines))

            total += 1
            if split == "train":
                train_count += 1
            else:
                val_count += 1

    _export_pages(train_pages, "train")
    _export_pages(val_pages, "val")

    return {
        "exported_count": total,
        "train": train_count,
        "val": val_count,
        "output_dir": str(DATASET_DIR),
    }
