"""YOLO11 fine-tune — 해설지 solution_block detection

YOLO11n pretrained → 해설지 데이터 파인튜닝.
weights 파일이 없으면 ultralytics가 자동 다운로드함.

사용법:
  cd backend/pdf_pipeline/yolo_training
  ../venv/Scripts/python train_solution_finetune.py
  ../venv/Scripts/python train_solution_finetune.py \\
      --base-weights yolo11n.pt \\
      --epochs 100 \\
      --run-name solution_finetune_v1
"""
import argparse
from pathlib import Path
from ultralytics import YOLO

SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_WEIGHTS = "yolo11n.pt"  # ultralytics 자동 다운로드


def main():
    parser = argparse.ArgumentParser(description="해설지 YOLO fine-tune")
    parser.add_argument("--base-weights", default=DEFAULT_WEIGHTS,
                        help="시작점 가중치 경로 (기본: models/yolov8n.pt)")
    parser.add_argument("--epochs", type=int, default=100,
                        help="학습 epoch 수 (기본 100)")
    parser.add_argument("--run-name", default="solution_finetune_v1",
                        help="결과 저장 디렉토리 이름 (runs/ 하위)")
    args = parser.parse_args()

    # 로컬 파일이면 존재 체크, ultralytics 모델명(yolo11n.pt 등)이면 자동 다운로드
    base_weights_path = Path(args.base_weights)
    if base_weights_path.is_absolute() or len(base_weights_path.parts) > 1:
        if not base_weights_path.exists():
            print(f"[ERROR] 가중치 파일 없음: {base_weights_path}")
            raise SystemExit(1)

    model = YOLO(args.base_weights)

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

    # 학습 완료 모델을 추론용 경로로 복사
    import shutil
    dest = SCRIPT_DIR / "models" / "solution_detector.pt"
    dest.parent.mkdir(parents=True, exist_ok=True)
    if best_pt.exists():
        shutil.copy2(best_pt, dest)
        print(f"모델 복사 완료: {dest}")


if __name__ == "__main__":
    main()
