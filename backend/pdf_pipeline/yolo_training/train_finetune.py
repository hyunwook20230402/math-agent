"""YOLO fine-tune — 수능 가형+나형 2018~2021 (96장 추가 데이터)

기존 best.pt를 시작점으로 새 데이터만 학습.

사용법:
  cd backend/pdf_pipeline/yolo_training
  ../venv/Scripts/python train_finetune.py
  ../venv/Scripts/python train_finetune.py --base-weights runs/exam_finetune_v2/weights/best.pt --epochs 50 --run-name exam_finetune_v3
"""
import argparse
from pathlib import Path
from ultralytics import YOLO

SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_WEIGHTS = str(SCRIPT_DIR / "runs/exam_problem_detector/weights/best.pt")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-weights", default=DEFAULT_WEIGHTS,
                        help="시작점 가중치 경로")
    parser.add_argument("--epochs", type=int, default=100,
                        help="학습 epoch 수")
    parser.add_argument("--run-name", default="exam_finetune_v2",
                        help="결과 저장 디렉토리 이름 (runs/ 하위)")
    args = parser.parse_args()

    model = YOLO(args.base_weights)

    results = model.train(
        data=str(SCRIPT_DIR / "data_new.yaml"),
        epochs=args.epochs,
        imgsz=1280,
        batch=4,
        device=0,
        patience=20,
        save=True,
        project=str(SCRIPT_DIR / "runs"),
        name=args.run_name,
        lr0=0.001,
        lrf=0.01,
        # 문서 이미지 augmentation
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

    best_pt = str(SCRIPT_DIR / "runs" / args.run_name / "weights" / "best.pt")
    print(f"BEST_MODEL_PATH={best_pt}")
    print(f"\n학습 완료! Best model: {best_pt}")

    # 학습 직후 추론용 models/ 로 자동 복사
    from promote_model import promote
    promote(SCRIPT_DIR / "runs" / args.run_name, "problem")


if __name__ == "__main__":
    main()
