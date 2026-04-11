"""YOLO 기반 문제 영역 detection — 수학 모의고사 특화

모의고사 페이지 이미지에서 문제 영역을 바운딩 박스로 감지.
감지된 영역은 2단 레이아웃(좌열 → 우열) 순서로 번호를 부여.

사용법:
  from pipeline.yolo_detector import load_model, detect_problems, release_model
  model = load_model()
  detections = detect_problems(model, "page_001.png", page_width=3509)
  release_model(model)
"""
import os
from pathlib import Path
from typing import List, Dict, Optional

from ultralytics import YOLO

# 기본 모델 경로
_DEFAULT_MODEL_PATH = str(Path(__file__).parent.parent / "models" / "exam_problem_detector.pt")


def load_model(model_path: str = None) -> YOLO:
  """YOLO 모델 로드

  Args:
    model_path: 모델 가중치 경로. None이면 기본 경로 사용.

  Returns:
    YOLO 모델 인스턴스
  """
  path = model_path or os.getenv("YOLO_MODEL_PATH", _DEFAULT_MODEL_PATH)
  if not Path(path).exists():
    raise FileNotFoundError(f"YOLO 모델을 찾을 수 없습니다: {path}")
  return YOLO(path)


def detect_problems(
  model: YOLO,
  image_path: str,
  page_width: int = 3509,
  page_height: int = 4963,
  conf: float = 0.4,
  start_number: int = 1,
  padding: int = 30,
  min_height: int = 300,
  col_margin: int = 50,
  top_margin: int = 80,
  mid_line_x: int = 1753,
) -> List[Dict]:
  """이미지에서 문제 영역 감지 + 번호 자동 부여

  모의고사 2단 레이아웃: 좌열(위→아래) → 우열(위→아래) 순서로 번호 부여.

  Args:
    model: load_model()로 로드한 YOLO 모델
    image_path: 페이지 이미지 경로
    page_width: 페이지 너비 (2단 구분용, 기본 3509)
    page_height: 페이지 높이 (클리핑용, 기본 4963)
    conf: 최소 confidence 임계값
    start_number: 이 페이지의 시작 문제 번호
    padding: bbox 상하좌우 여백 (픽셀)
    min_height: 이 높이 미만 박스는 필터링 (유의사항 등 제거)
    top_margin: 페이지 상단 헤더 영역 높이 — 박스가 이 위로 못 올라감 (픽셀)
    col_margin: 중앙선 안쪽 여백 (픽셀)
    top_margin: 위선 아래 여백 (픽셀) — 위선에서 이만큼 내려온 곳부터 박스 허용
    mid_line_x: 페이지 중앙 구분선 x좌표 (픽셀, 3509x4963 기준)

  Returns:
    [{"number": 1, "bbox": (x1, y1, x2, y2), "confidence": 0.95}, ...]
    bbox는 픽셀 좌표 (좌상단 x, y, 우하단 x, y)
  """
  # 이미지에서 위선 y좌표 자동 감지 (상단 600px 내 가장 어두운 수평선)
  import cv2 as _cv2
  import numpy as _np
  _img = _cv2.imread(image_path, _cv2.IMREAD_GRAYSCALE)
  if _img is not None:
    _row_means = _img[:600].mean(axis=1)
    _top_line_y = int(_row_means.argmin())
  else:
    _top_line_y = 100  # fallback

  results = model(image_path, conf=conf, imgsz=1280, verbose=False)

  if not results or len(results[0].boxes) == 0:
    return []

  boxes = results[0].boxes
  detections = []

  # 위선/중앙선 기준으로 유효 영역 계산
  content_top = _top_line_y + top_margin       # 위선 아래 top_margin만큼 여백
  content_left_max = mid_line_x - col_margin   # 좌열 우측 한계
  content_right_min = mid_line_x + col_margin  # 우열 좌측 한계

  for i in range(len(boxes)):
    x1, y1, x2, y2 = boxes.xyxy[i].cpu().numpy()
    confidence = float(boxes.conf[i].cpu().numpy())
    cx = (x1 + x2) / 2

    # padding 적용
    x1 = max(0, x1 - padding)
    y1 = max(0, y1 - padding)
    x2 = min(page_width, x2 + padding)
    y2 = min(page_height, y2 + padding)

    # 위선 아래로 클리핑
    y1 = max(y1, content_top)

    # 중앙선 기준 컬럼 클리핑
    if cx < mid_line_x:
      x2 = min(x2, content_left_max)   # 좌열: 중앙선 왼쪽만
    else:
      x1 = max(x1, content_right_min)  # 우열: 중앙선 오른쪽만

    # 너무 작은 박스 필터링 (유의사항, 저작권 표시 등)
    if (y2 - y1) < min_height:
      continue

    detections.append({
      "bbox": (int(x1), int(y1), int(x2), int(y2)),
      "center_x": float(cx),
      "center_y": float((y1 + y2) / 2),
      "confidence": confidence,
    })

  # 2단 레이아웃 정렬: 좌열(위→아래) → 우열(위→아래)
  left_col = sorted(
    [d for d in detections if d["center_x"] < mid_line_x],
    key=lambda d: d["center_y"]
  )
  right_col = sorted(
    [d for d in detections if d["center_x"] >= mid_line_x],
    key=lambda d: d["center_y"]
  )

  ordered = left_col + right_col

  # 순서대로 번호 부여
  result = []
  for i, det in enumerate(ordered):
    result.append({
      "number": start_number + i,
      "bbox": det["bbox"],
      "confidence": det["confidence"],
    })

  return result


def release_model(model: YOLO = None):
  """YOLO 모델 VRAM 해제"""
  if model is not None:
    del model
  try:
    import torch
    torch.cuda.empty_cache()
  except ImportError:
    pass


def model_exists(model_path: str = None) -> bool:
  """YOLO 모델 파일이 존재하는지 확인"""
  path = model_path or os.getenv("YOLO_MODEL_PATH", _DEFAULT_MODEL_PATH)
  return Path(path).exists()
