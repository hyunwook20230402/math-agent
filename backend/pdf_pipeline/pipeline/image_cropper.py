"""이미지형 PDF → 문제 영역 크롭 유틸"""
import cv2
import numpy as np
from pathlib import Path
from typing import List, Dict, Optional


def _imread_unicode(path: str) -> Optional[np.ndarray]:
  """Windows 한글 경로 대응 cv2 로드 (BGR ndarray)."""
  try:
    arr = np.fromfile(path, dtype=np.uint8)
    return cv2.imdecode(arr, cv2.IMREAD_COLOR)
  except Exception:
    return None


def _imwrite_unicode(path: str, img: np.ndarray, ext: str = ".png") -> bool:
  """Windows 한글 경로 대응 cv2 저장."""
  ok, buf = cv2.imencode(ext, img)
  if not ok:
    return False
  try:
    buf.tofile(path)
    return True
  except Exception:
    return False


def _remove_color_sidebar(img: np.ndarray, sat_threshold: float = 0.25, val_threshold: int = 100, edge_ratio: float = 0.12) -> np.ndarray:
  """노란/주황 등 컬러 사이드바를 이미지 좌우 가장자리에서 감지하여 제거

  쎈 교재 우측의 노란 탭, 또는 좌측 컬러 바 등을 제거.
  HSV에서 채도(S) > sat_threshold 이고 명도(V) > val_threshold인 열이
  이미지 edge_ratio 범위 내에 연속적으로 존재하면 해당 열 범위를 잘라냄.

  Args:
    img: 크롭된 BGR ndarray
    sat_threshold: 채도 임계값 (0~1)
    val_threshold: 명도 임계값 (0~255)
    edge_ratio: 가장자리로 간주할 이미지 너비 비율
  """
  arr_rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB).astype(np.float32)
  h, w, _ = arr_rgb.shape
  edge_px = max(5, int(w * edge_ratio))

  # RGB → HSV 수동 변환 (scipy 없이)
  r, g, b = arr_rgb[:, :, 0] / 255.0, arr_rgb[:, :, 1] / 255.0, arr_rgb[:, :, 2] / 255.0
  cmax = np.maximum(np.maximum(r, g), b)
  cmin = np.minimum(np.minimum(r, g), b)
  delta = cmax - cmin
  # V (명도): 0~255 스케일
  v = cmax * 255.0
  # S (채도): 0~1 스케일
  s = np.where(cmax > 0, delta / cmax, 0.0)

  # 컬러 픽셀: 채도 > threshold AND 명도 > threshold (너무 어두운 건 제외)
  is_colored = (s > sat_threshold) & (v > val_threshold)

  # 각 열에서 컬러 픽셀 비율 계산
  col_color_ratio = is_colored.mean(axis=0)  # shape: (w,)
  # 컬러가 많은 열: 20% 이상의 행이 컬러
  col_is_sidebar = col_color_ratio > 0.20

  left_crop = 0
  right_crop = w

  # 왼쪽 사이드바: edge_px 내에서 연속적인 컬러 열 제거
  for x in range(edge_px):
    if col_is_sidebar[x]:
      left_crop = x + 1
    else:
      break

  # 오른쪽 사이드바: edge_px 내에서 연속적인 컬러 열 제거
  for x in range(w - 1, w - 1 - edge_px, -1):
    if col_is_sidebar[x]:
      right_crop = x
    else:
      break

  if left_crop > 0 or right_crop < w:
    if left_crop < right_crop:
      img = img[:, left_crop:right_crop]
  return img


def _trim_whitespace(img: np.ndarray, threshold: int = 235, padding: int = 5) -> np.ndarray:
  """크롭된 이미지의 빈 여백 제거 (상하좌우)

  크롭 후 호출되므로 이미 열 단위로 분리된 상태.
  2단 구분선(이미지 가장자리의 얇은 수직선)을 제외하기 위해
  열 콘텐츠 감지 시 이미지 가장자리 2% 범위는 무시.

  Args:
    img: 크롭된 BGR ndarray
    threshold: 이 값 미만이면 콘텐츠 픽셀로 간주 (235 = 약간 더 엄격)
    padding: 내용 주변에 남길 여백 (px)
  """
  # 컬러 사이드바 먼저 제거
  img = _remove_color_sidebar(img)
  if img.size == 0:
    return img

  arr = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
  h, w = arr.shape

  # 열(세로줄): 어두운 픽셀이 하나라도 있는 열 (가장자리 2% 제외 — 2단 구분선 무시)
  edge_margin = max(5, int(w * 0.02))
  col_has_content = np.any(arr < threshold, axis=0)
  col_has_content[:edge_margin] = False
  col_has_content[-edge_margin:] = False
  content_cols = np.where(col_has_content)[0]

  if len(content_cols) == 0:
    return img

  left = max(0, int(content_cols[0]) - padding)
  right = min(w, int(content_cols[-1]) + padding)

  # 행(가로줄): 좌우 범위 내에서만 어두운 픽셀이 있는 행 — 구분선 열 제외 후 판단
  arr_inner = arr[:, left:right]
  row_has_content = np.any(arr_inner < threshold, axis=1)
  content_rows = np.where(row_has_content)[0]

  if len(content_rows) == 0:
    return img

  top = max(0, int(content_rows[0]) - padding)
  bottom = min(h, int(content_rows[-1]) + padding)

  if top < bottom and left < right:
    return img[top:bottom, left:right]
  return img


def crop_and_save(
  image_path: str,
  regions: List[Dict],
  output_dir: str,
  page_num: int = 1,
) -> List[Dict]:
  """이미지에서 문제 영역을 크롭하여 저장

  Args:
    image_path: 원본 페이지 이미지 경로
    regions: compute_crop_regions() 결과
    output_dir: 크롭 이미지 저장 디렉토리
    page_num: 페이지 번호

  Returns:
    [{"number": 38, "cropped_path": "...", "page": 1}]
  """
  out = Path(output_dir)
  out.mkdir(parents=True, exist_ok=True)

  img = _imread_unicode(image_path)
  if img is None:
    raise ValueError(f"이미지 읽기 실패: {image_path}")
  results = []

  for region in regions:
    x1, y1, x2, y2 = region["crop_box"]
    if x2 <= x1 or y2 <= y1:
      continue
    cropped = img[y1:y2, x1:x2]
    if cropped.size == 0:
      continue
    cropped = _trim_whitespace(cropped)
    if cropped.size == 0:
      continue
    filename = f"page_{page_num:03d}_{region['number']:04d}.png"
    save_path = str(out / filename)
    if not _imwrite_unicode(save_path, cropped):
      continue
    results.append({
      "number": region["number"],
      "cropped_path": save_path,
      "page": page_num,
    })

  return results
