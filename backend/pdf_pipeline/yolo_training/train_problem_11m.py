"""문제 감지 YOLO11m full train — Optuna best HP 고정.

HP 기준: 2026-04-21 Optuna search (yolo11m_problem_search.db) 결과.
데이터 분포 크게 바뀌면 `optuna_search_problem.py` 재실행 후 여기 HP 갱신.

사용법:
  cd backend/pdf_pipeline/yolo_training
  python3 train_problem_11m.py

완료 후 metric 확인하고 만족하면 수동 복사:
  cp runs/problem_11m_final/weights/best.pt models/problem_detector.pt
"""
import os
from pathlib import Path
from ultralytics import YOLO

SCRIPT_DIR = Path(__file__).resolve().parent
os.chdir(SCRIPT_DIR)

RUN_NAME = "problem_11m_final"

model = YOLO("yolo11m.pt")
model.train(
    data="data_new.yaml",
    epochs=100,
    imgsz=1280,
    batch=8,
    device=0,
    patience=50,
    save=True,
    project=str(SCRIPT_DIR / "runs"),
    name=RUN_NAME,
    exist_ok=True,
    optimizer="AdamW",
    lr0=1.0e-5,
    lrf=0.01,
    weight_decay=0.04,
    warmup_epochs=7,
    warmup_momentum=0.8,
    warmup_bias_lr=0.05,
    cos_lr=True,
    amp=True,
    hsv_h=0.0, hsv_s=0.0, hsv_v=0.2,
    degrees=0.0, translate=0.05, scale=0.2,
    flipud=0.0, fliplr=0.0, mosaic=0.0, mixup=0.0,
)

best_pt = SCRIPT_DIR / "runs" / RUN_NAME / "weights" / "best.pt"
print(f"\nBEST_MODEL_PATH={best_pt}")
print("만족 시: cp runs/problem_11m_final/weights/best.pt models/problem_detector.pt")
