"""YOLO 모델 학습 — 수학 모의고사 문제 영역 detection

사용법:
  cd backend/pdf_pipeline/yolo_training
  python train.py
"""
from pathlib import Path
from ultralytics import YOLO

SCRIPT_DIR = Path(__file__).resolve().parent

def main():
  # YOLOv8n (nano) — 빠르고 RTX 4070 8GB에 충분
  model = YOLO("yolo11m.pt")

  results = model.train(
    data=str(SCRIPT_DIR / "data.yaml"),
    epochs=150,
    imgsz=1280,
    batch=4,
    device=0,           # GPU
    patience=30,         # early stopping
    save=True,
    project=str(SCRIPT_DIR / "runs"),
    name="exam_problem_detector",
    # augmentation — 문서 이미지에 맞게 조정
    hsv_h=0.0,          # 색상 변화 없음 (흑백 문서)
    hsv_s=0.0,          # 채도 변화 없음
    hsv_v=0.2,          # 밝기만 약간 변화
    degrees=0.0,         # 회전 없음 (스캔본은 정렬됨)
    translate=0.05,      # 약간의 이동
    scale=0.2,           # 스케일 변화
    flipud=0.0,          # 상하반전 없음
    fliplr=0.0,          # 좌우반전 없음
    mosaic=0.0,          # 모자이크 없음 (문서 레이아웃 깨짐)
    mixup=0.0,           # 믹스업 없음
  )

  print(f"\n학습 완료!")
  print(f"Best model: runs/exam_problem_detector/weights/best.pt")


if __name__ == "__main__":
  main()
