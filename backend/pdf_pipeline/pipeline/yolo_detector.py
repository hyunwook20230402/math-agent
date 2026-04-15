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


def _detect_top_line_y(img_gray, page_height: int) -> int:
  """페이지 상단 위선 y좌표 자동 감지

  상단 40% 범위 내에서 페이지 폭의 60% 이상을 가로지르는
  어두운 수평선을 위선으로 판단.

  Args:
    img_gray: grayscale numpy array
    page_height: 페이지 전체 높이 (픽셀)

  Returns:
    위선 y좌표 (없으면 fallback)
  """
  import numpy as _np
  search_height = int(page_height * 0.4)
  region = img_gray[:search_height]
  page_width = img_gray.shape[1]
  threshold = 0.6  # 픽셀 60% 이상이 어두운 행을 수평선으로 판단

  # 행별로 어두운 픽셀(128 미만) 비율 계산
  dark_ratio = (_np.array(region) < 128).mean(axis=1)
  candidates = _np.where(dark_ratio >= threshold)[0]

  if len(candidates) > 0:
    return int(candidates[0])

  # fallback: 단순히 가장 어두운 행
  row_means = region.mean(axis=1)
  return int(row_means.argmin())


def detect_problems(
  model: YOLO,
  image_path: str,
  page_width: int = 3509,
  page_height: int = 4963,
  conf: float = 0.4,
  start_number: int = 1,
  padding: int = 30,
  min_height: int = 100,
  col_margin: int = 20,
  top_margin: int = 80,
  mid_line_x: int = 1753,
  debug_dir: Optional[str] = None,
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
    top_margin: 위선에서 이만큼 내려온 곳부터 박스 허용 (픽셀)
    col_margin: 중앙선 안쪽 여백 (픽셀)
    mid_line_x: 페이지 중앙 구분선 x좌표 (픽셀, 3509x4963 기준)
    debug_dir: 디버그 이미지 저장 디렉토리 (None이면 저장 안 함)

  Returns:
    [{"number": 1, "bbox": (x1, y1, x2, y2), "confidence": 0.95}, ...]
    bbox는 픽셀 좌표 (좌상단 x, y, 우하단 x, y)
  """
  import cv2 as _cv2
  import numpy as _np

  _img_gray = _cv2.imread(image_path, _cv2.IMREAD_GRAYSCALE)
  if _img_gray is not None:
    _top_line_y = _detect_top_line_y(_img_gray, page_height)
  else:
    _top_line_y = int(page_height * 0.05)  # fallback: 5%

  results = model(image_path, conf=conf, imgsz=1280, verbose=False)

  # 디버그용 원본 이미지 로드
  if debug_dir is not None:
    _img_bgr = _cv2.imread(image_path)
    Path(debug_dir).mkdir(parents=True, exist_ok=True)
    stem = Path(image_path).stem

  if not results or len(results[0].boxes) == 0:
    if debug_dir is not None and _img_bgr is not None:
      _cv2.imwrite(str(Path(debug_dir) / f"{stem}_01_raw.png"), _img_bgr)
    return []

  boxes = results[0].boxes

  # 위선/중앙선 기준으로 유효 영역 계산
  content_top = _top_line_y + top_margin
  content_left_max = mid_line_x - col_margin
  content_right_min = mid_line_x + col_margin

  # ── 단계 1: raw 예측 시각화 ─────────────────────────
  if debug_dir is not None and _img_bgr is not None:
    _dbg_raw = _img_bgr.copy()
    # 위선/중앙선 표시
    _cv2.line(_dbg_raw, (0, _top_line_y), (page_width, _top_line_y), (255, 165, 0), 3)
    _cv2.line(_dbg_raw, (0, content_top), (page_width, content_top), (0, 165, 255), 2)
    _cv2.line(_dbg_raw, (mid_line_x, 0), (mid_line_x, page_height), (200, 200, 0), 2)
    for i in range(len(boxes)):
      rx1, ry1, rx2, ry2 = [int(v) for v in boxes.xyxy[i].cpu().numpy()]
      rc = float(boxes.conf[i].cpu().numpy())
      _cv2.rectangle(_dbg_raw, (rx1, ry1), (rx2, ry2), (0, 255, 0), 3)
      _cv2.putText(_dbg_raw, f"{rc:.2f}", (rx1, max(ry1 - 8, 20)),
                   _cv2.FONT_HERSHEY_SIMPLEX, 1.2, (0, 255, 0), 3)
    _cv2.imwrite(str(Path(debug_dir) / f"{stem}_01_raw.png"), _dbg_raw)

  # ── 후처리 ──────────────────────────────────────────
  detections = []
  filtered_out = []  # min_height 필터로 제거된 박스

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
      x2 = min(x2, content_left_max)
    else:
      x1 = max(x1, content_right_min)

    # 너무 작은 박스 필터링 (유의사항, 저작권 표시 등)
    if (y2 - y1) < min_height:
      filtered_out.append((int(x1), int(y1), int(x2), int(y2), confidence))
      continue

    detections.append({
      "bbox": (int(x1), int(y1), int(x2), int(y2)),
      "center_x": float(cx),
      "center_y": float((y1 + y2) / 2),
      "confidence": confidence,
    })

  # ── 단계 2: 필터링 결과 시각화 ──────────────────────
  if debug_dir is not None and _img_bgr is not None:
    _dbg_filt = _img_bgr.copy()
    _cv2.line(_dbg_filt, (0, content_top), (page_width, content_top), (0, 165, 255), 2)
    _cv2.line(_dbg_filt, (mid_line_x, 0), (mid_line_x, page_height), (200, 200, 0), 2)
    for (fx1, fy1, fx2, fy2, fc) in filtered_out:
      _cv2.rectangle(_dbg_filt, (fx1, fy1), (fx2, fy2), (0, 0, 255), 3)
      _cv2.putText(_dbg_filt, f"FILT {fc:.2f}", (fx1, max(fy1 - 8, 20)),
                   _cv2.FONT_HERSHEY_SIMPLEX, 1.2, (0, 0, 255), 3)
    for d in detections:
      dx1, dy1, dx2, dy2 = d["bbox"]
      _cv2.rectangle(_dbg_filt, (dx1, dy1), (dx2, dy2), (0, 255, 0), 3)
      _cv2.putText(_dbg_filt, f"{d['confidence']:.2f}", (dx1, max(dy1 - 8, 20)),
                   _cv2.FONT_HERSHEY_SIMPLEX, 1.2, (0, 255, 0), 3)
    _cv2.imwrite(str(Path(debug_dir) / f"{stem}_02_filtered.png"), _dbg_filt)

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

  # ── 단계 3: 최종 bbox + 번호 시각화 ────────────────
  if debug_dir is not None and _img_bgr is not None:
    _dbg_final = _img_bgr.copy()
    _cv2.line(_dbg_final, (0, content_top), (page_width, content_top), (0, 165, 255), 2)
    _cv2.line(_dbg_final, (mid_line_x, 0), (mid_line_x, page_height), (200, 200, 0), 2)
    for r in result:
      fx1, fy1, fx2, fy2 = r["bbox"]
      _cv2.rectangle(_dbg_final, (fx1, fy1), (fx2, fy2), (255, 100, 0), 4)
      _cv2.putText(_dbg_final, f"#{r['number']} {r['confidence']:.2f}",
                   (fx1, max(fy1 - 8, 20)),
                   _cv2.FONT_HERSHEY_SIMPLEX, 1.4, (255, 100, 0), 4)
    _cv2.imwrite(str(Path(debug_dir) / f"{stem}_03_final.png"), _dbg_final)

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
