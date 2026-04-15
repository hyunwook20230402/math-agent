"""YOLO fine-tune — 해설지 solution_block detection

기존 best.pt(또는 pretrained yolov8n.pt)를 시작점으로 해설지 데이터 학습.

사용법:
  cd backend/pdf_pipeline/yolo_training
  ../venv/Scripts/python train_solution_finetune.py
  ../venv/Scripts/python train_solution_finetune.py \\
      --base-weights models/yolov8n.pt \\
      --epochs 100 \\
      --run-name solution_finetune_v1
"""
import argparse
from pathlib import Path
from ultralytics import YOLO

SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_WEIGHTS = str(SCRIPT_DIR / "models" / "yolov8n.pt")


def main():
    parser = argparse.ArgumentParser(description="해설지 YOLO fine-tune")
    parser.add_argument("--base-weights", default=DEFAULT_WEIGHTS,
                        help="시작점 가중치 경로 (기본: models/yolov8n.pt)")
    parser.add_argument("--epochs", type=int, default=100,
                        help="학습 epoch 수 (기본 100)")
    parser.add_argument("--run-name", default="solution_finetune_v1",
                        help="결과 저장 디렉토리 이름 (runs/ 하위)")
    args = parser.parse_args()

    base_weights = Path(args.base_weights)
    if not base_weights.exists():
        print(f"[ERROR] 가중치 파일 없음: {base_weights}")
        raise SystemExit(1)

    model = YOLO(str(base_weights))

    model.train(
        data=str(SCRIPT_DIR / "solution_data.yaml"),
        epochs=args.epochs,
        imgsz=1280,
        batch=4,
        device=0,           # RTX 4070
        patience=20,        # early stopping
        save=True,
        project=str(SCRIPT_DIR / "runs"),
        name=args.run_name,
        lr0=0.001,
        lrf=0.01,
        # 문서 이미지 augmentation (흑백 스캔본 특화)
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

    best_pt = SCRIPT_DIR / "runs" / args.run_name / "weights" / "best.pt"
    print(f"BEST_MODEL_PATH={best_pt}")
    print(f"\n학습 완료! Best model: {best_pt}")

    # 학습 직후 추론용 models/ 로 자동 복사
    from promote_model import promote
    promote(SCRIPT_DIR / "runs" / args.run_name, "solution")


if __name__ == "__main__":
    main()
