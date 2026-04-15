"""hard negative 샘플 추가 스크립트

'5지선다형', 헤더, 유의사항 이미지를 라벨 없이 dataset_new에 추가해
YOLO가 이런 영역을 문제로 오감지하지 않도록 학습.

사용법:
  1. hard_negatives_raw/ 디렉토리에 부정 샘플 이미지 넣기
     (헤더 영역 크롭, 5지선다형 안내박스 크롭, 유의사항 등)
  2. cd backend/pdf_pipeline/yolo_training
     ../venv/Scripts/python add_hard_negatives.py
  3. 이후 train_finetune.py 또는 /api/retrain 으로 재학습
"""
import random
import shutil
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PIPELINE_DIR = SCRIPT_DIR.parent
sys.path.insert(0, str(PIPELINE_DIR))

from config import PROBLEM_DATASET_DIR as DATASET_DIR

SOURCE_DIR = SCRIPT_DIR / "hard_negatives_raw"


def add_hard_negatives(
    source_dir: Path = SOURCE_DIR,
    dataset_dir: Path = DATASET_DIR,
    train_ratio: float = 0.8,
) -> dict:
    """hard negative 이미지를 dataset_new에 복사 (라벨 파일은 빈 파일)

    Args:
        source_dir: 부정 샘플 이미지가 있는 디렉토리
        dataset_dir: YOLO dataset 루트 (images/train, labels/train 등)
        train_ratio: train split 비율

    Returns:
        {"added": int, "train": int, "val": int}
    """
    if not source_dir.exists():
        print(f"[add_hard_negatives] source_dir 없음: {source_dir}")
        print("hard_negatives_raw/ 디렉토리를 만들고 부정 샘플 이미지를 넣어주세요.")
        return {"added": 0, "train": 0, "val": 0}

    images = sorted([
        p for p in source_dir.iterdir()
        if p.suffix.lower() in (".png", ".jpg", ".jpeg")
    ])
    if not images:
        print(f"[add_hard_negatives] 이미지 없음: {source_dir}")
        return {"added": 0, "train": 0, "val": 0}

    random.shuffle(images)
    split_idx = max(1, int(len(images) * train_ratio))
    train_imgs = images[:split_idx]
    val_imgs = images[split_idx:]

    added_train = 0
    added_val = 0

    for split, imgs in [("train", train_imgs), ("val", val_imgs)]:
        img_dir = dataset_dir / "images" / split
        lbl_dir = dataset_dir / "labels" / split
        img_dir.mkdir(parents=True, exist_ok=True)
        lbl_dir.mkdir(parents=True, exist_ok=True)

        for src in imgs:
            dst_img = img_dir / f"hardneg_{src.name}"
            dst_lbl = lbl_dir / f"hardneg_{src.stem}.txt"
            shutil.copy2(src, dst_img)
            # 빈 라벨 파일 = YOLO hard negative (아무 박스도 없는 배경)
            dst_lbl.write_text("")
            if split == "train":
                added_train += 1
            else:
                added_val += 1

    total = added_train + added_val
    print(f"[add_hard_negatives] 추가 완료: train={added_train}, val={added_val}, total={total}")
    return {"added": total, "train": added_train, "val": added_val}


if __name__ == "__main__":
    result = add_hard_negatives()
    print(result)
