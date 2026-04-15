"""YOLO fine-tune — 수능 가형+나형 2018~2021 (96장 추가 데이터)

기존 best.pt를 시작점으로 새 데이터만 학습.

사용법:
  cd backend/pdf_pipeline/yolo_training
  ../venv/Scripts/python train_finetune.py
"""
from pathlib import Path
from ultralytics import YOLO

SCRIPT_DIR = Path(__file__).resolve().parent

def main():
    model = YOLO(str(SCRIPT_DIR / "runs/exam_problem_detector/weights/best.pt"))

    results = model.train(
        data=str(SCRIPT_DIR / "data_new.yaml"),
        epochs=100,
        imgsz=1280,
        batch=4,
        device=0,
        patience=20,
        save=True,
        project=str(SCRIPT_DIR / "runs"),
        name="exam_finetune_v2",
        lr0=0.001,       # fine-tune은 작은 학습률
        lrf=0.01,
        # 문서 이미지 augmentation (기존과 동일)
        hsv_h=0.0,
        hsv_s=0.0,
        hsv_v=0.2,
        degrees=0.0,
        translate=0.05,
        scale=0.2,
        flipud=0.0,
        fliplr=0.0,
        mosaic=0.0,
        mixup=0.0,
    )

    print(f"\n학습 완료!")
    print(f"Best model: runs/exam_finetune_v2/weights/best.pt")


if __name__ == "__main__":
    main()
