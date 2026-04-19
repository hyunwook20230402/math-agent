"""이미지형 PDF → 문제 번호 감지 + 영역 크롭"""
import re
import cv2
import numpy as np
from pathlib import Path
from typing import List, Dict, Optional

from pipeline.ocr_engine import ocr_detect_boxes

# 섹션 구분 헤더 키워드 (유형, 개념, 단원 등) — 문제 아래에 이게 오면 거기서 잘라야 함
_SECTION_HEADER_KEYWORDS = ["유형", "개념", "도전", "코너", "단원", "보기", "Review", "확인 학습"]


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


def detect_problem_numbers(
  ocr_results: list,
  pattern: str = r"^\d{4}$",
  page_height: int = 0,
  page_width: int = 0,
  layout: str = "auto",
  skip_numbers: set = None,
) -> List[Dict]:
  """EasyOCR detail=1 결과에서 문제 번호 bbox만 필터링

  Args:
    ocr_results: [(bbox, text, confidence), ...] from EasyOCR detail=1
    pattern: 문제 번호 정규식 (교재별로 다름)
    page_height: 페이지 높이 (상/하단 극단 좌표 제외용)
    page_width: 페이지 너비 (좌측 영역 필터링용)
    layout: "auto" | "single" | "double" — 레이아웃 힌트 (위치 필터 강도 결정)
    skip_numbers: 이미 이전 페이지에서 추출된 번호 집합 (페이지 간 중복 방지)

  Returns:
    [{"number": 38, "bbox": (x1,y1,x2,y2), "center_x": float, "center_y": float}]
  """
  regex = re.compile(pattern)
  candidates = []

  for bbox, text, confidence in ocr_results:
    text = text.strip()
    # 마침표로 끝나는 번호 허용: "5." → "5" (모의고사 등)
    has_period = text.endswith(".")
    text_clean = text.rstrip(".")
    if not regex.match(text_clean):
      continue
    text = text_clean

    # 낮은 신뢰도 사전 제거 (명백한 OCR 오탐)
    if confidence < 0.3:
      continue

    # bbox: [[x1,y1],[x2,y2],[x3,y3],[x4,y4]] → (min_x, min_y, max_x, max_y)
    xs = [pt[0] for pt in bbox]
    ys = [pt[1] for pt in bbox]
    x1, y1, x2, y2 = min(xs), min(ys), max(xs), max(ys)
    center_x = (x1 + x2) / 2
    center_y = (y1 + y2) / 2
    box_width = x2 - x1
    box_height = y2 - y1

    # 1) 페이지 상/하단 제외 (페이지 번호, 단원명 제거)
    if page_height > 0:
      # 상단 13%: 모의고사 헤더(교시, 시간, 시험지 번호 등)
      margin_top = page_height * 0.13
      margin_bottom = page_height * 0.08
      if center_y < margin_top or center_y > page_height - margin_bottom:
        continue

    # 2) 문제 번호는 페이지 좌측 또는 중앙 좌측에 위치
    if page_width > 0:
      mid = page_width / 2
      if layout == "single":
        # 1단: 문제번호는 좌측 15% 이내에만 존재 (모의고사 번호는 최좌측)
        if center_x > page_width * 0.15:
          continue
      else:
        # auto/double: 좌열(40% 이내) 또는 우열(50~80%)
        if center_x > page_width * 0.40 and center_x < mid:
          continue  # 좌열도 우열도 아닌 애매한 위치
        if center_x > page_width * 0.85:
          continue  # 너무 오른쪽

    # 3) bbox 크기 필터: 너무 크거나 너무 작으면 문제 번호가 아님
    if page_height > 0:
      # 문제 번호 bbox는 페이지 높이의 0.5~3% 정도
      if box_height < page_height * 0.005 or box_height > page_height * 0.04:
        continue
    # bbox 너비 필터: 너무 좁으면 수식 속 숫자 (문제 번호는 페이지 너비의 0.5% 이상)
    if page_width > 0:
      if box_width < page_width * 0.005:
        continue

    # 4) 이전 페이지에서 이미 추출된 번호면 skip
    if skip_numbers and int(text) in skip_numbers:
      continue

    candidates.append({
      "number": int(text),
      "bbox": (x1, y1, x2, y2),
      "center_x": center_x,
      "center_y": center_y,
      "confidence": confidence,
      "has_period": has_period,  # 마침표 여부 (문제 번호 신뢰도 향상)
    })

  # 4-a) 보기 행 제거: 같은 y±tolerance 에 숫자가 3개 이상 → 보기/분수 행
  #       단, "N." 형태(마침표 포함)로 인식된 항목은 확실한 문제 번호이므로 보존
  #       분수(3/8)는 분자/분모가 세로로 배열 → y_tolerance를 충분히 크게 (페이지 높이 2%)
  if page_height > 0 and len(candidates) > 1:
    y_tolerance = max(80, page_height * 0.02)
    sorted_by_y = sorted(candidates, key=lambda d: d["center_y"])
    filtered = []
    for c in sorted_by_y:
      # 마침표 있는 번호는 확실한 문제 번호 — 클러스터 필터 예외 처리
      if c["has_period"]:
        filtered.append(c)
        continue
      cluster = [
        other for other in sorted_by_y
        if abs(other["center_y"] - c["center_y"]) <= y_tolerance
      ]
      if len(cluster) < 3:
        filtered.append(c)
      # 클러스터에 3개 이상 → 보기 행으로 간주, 전부 제거
    candidates = filtered

  # 4-b) 중복 번호 제거: 같은 번호가 여러 개면 가장 왼쪽(center_x 최소)이 실제 문제 번호
  #       단, 마침표 있는 번호가 있으면 그것을 우선 선택
  seen: Dict[int, Dict] = {}
  for c in candidates:
    num = c["number"]
    if num not in seen:
      seen[num] = c
    elif c["has_period"] and not seen[num]["has_period"]:
      seen[num] = c  # 마침표 있는 것 우선
    elif not seen[num]["has_period"] and not c["has_period"]:
      if c["center_x"] < seen[num]["center_x"]:
        seen[num] = c  # 마침표 없으면 cx 최소
  candidates = list(seen.values())

  # 5) 번호 연속성 검증: 단독 아웃라이어만 제거 (앞뒤 모두 큰 gap인 경우)
  #    기존: 앞에서부터만 검사 → 중간에 OCR 누락 있으면 이후 전체 버림
  #    변경: 앞뒤 양방향 gap 검사, 양쪽 모두 max_gap 초과인 후보만 제거
  if len(candidates) >= 3:
    candidates.sort(key=lambda d: d["number"])
    diffs = [candidates[i+1]["number"] - candidates[i]["number"]
             for i in range(len(candidates) - 1)]
    median_diff = sorted(diffs)[len(diffs) // 2]
    # 완화된 임계값: 중간값의 3배 이상 OR 최소 20 (쎈 교재 유형 간 간격 허용)
    max_gap = max(median_diff * 3, 20)
    filtered = []
    for i, c in enumerate(candidates):
      gap_before = candidates[i]["number"] - candidates[i-1]["number"] if i > 0 else 0
      gap_after = candidates[i+1]["number"] - candidates[i]["number"] if i + 1 < len(candidates) else 0
      # 첫/마지막 후보: 한쪽만 비교
      if i == 0:
        outlier = (gap_after > max_gap * 3)  # 첫 번째는 매우 큰 gap일 때만 제거
      elif i == len(candidates) - 1:
        outlier = (gap_before > max_gap * 3)  # 마지막도 동일
      else:
        # 양쪽 모두 큰 gap일 때만 단독 아웃라이어로 제거
        outlier = (gap_before > max_gap) and (gap_after > max_gap)
      if not outlier:
        filtered.append(c)
    candidates = filtered

  # 번호순 정렬, 내부 처리용 has_period 필드 제거
  candidates.sort(key=lambda d: d["number"])
  for c in candidates:
    c.pop("has_period", None)
  return candidates


def detect_footer_y(ocr_results: list, page_height: int) -> int:
  """OCR 결과에서 페이지 하단 고정 텍스트(확인사항 등)의 y좌표 감지

  Args:
    ocr_results: [(bbox, text, confidence), ...] from EasyOCR detail=1
    page_height: 페이지 높이 (px)

  Returns:
    footer 시작 y좌표 (없으면 page_height * 0.92)
  """
  footer_patterns = ["확인", "이어서", "선택과목", "답안지"]
  threshold_y = page_height * 0.75  # 이 y 이상에 있어야 footer로 간주
  footer_y = int(page_height * 0.92)  # 기본값 높임 (85% → 92%: 마지막 문제 잘림 방지)
  for bbox, text, _ in ocr_results:
    ys = [pt[1] for pt in bbox]
    min_y = min(ys)
    if min_y > threshold_y:
      for pat in footer_patterns:
        if pat in text:
          footer_y = min(footer_y, int(min_y))
          break
  return footer_y


def _find_section_header_y(
  ocr_results: list,
  y_from: float,
  y_to: float,
) -> Optional[int]:
  """두 문제 사이 구간에서 섹션 헤더 텍스트의 y좌표 반환

  유형/개념/도전 등 섹션 구분 박스가 현재 문제 y_end 후보와 다음 문제 사이에 있으면
  그 헤더 위쪽에서 잘라야 함.

  Args:
    ocr_results: 페이지 OCR 결과
    y_from: 탐색 시작 y (현재 문제 center_y)
    y_to: 탐색 종료 y (다음 문제 bbox_top)

  Returns:
    섹션 헤더 텍스트의 min_y, 없으면 None
  """
  for bbox, text, _ in ocr_results:
    ys = [pt[1] for pt in bbox]
    min_y = min(ys)
    if y_from < min_y < y_to:
      for kw in _SECTION_HEADER_KEYWORDS:
        if kw in text:
          return int(min_y)
  return None


def compute_crop_regions(
  detections: List[Dict],
  page_width: int,
  page_height: int,
  margin_px: int = 10,
  layout: str = "auto",
  footer_y: int = None,
  ocr_results: list = None,
) -> List[Dict]:
  """감지된 문제 번호 좌표로 크롭 영역 계산

  Args:
    detections: detect_problem_numbers() 결과
    page_width: 페이지 이미지 너비 (px)
    page_height: 페이지 이미지 높이 (px)
    margin_px: 크롭 하단 여백 (px). 상단은 별도로 더 크게 적용
    layout: "auto" (자동 감지), "single" (1단 강제), "double" (2단 강제)
    footer_y: 페이지 하단 고정 영역 시작 y (detect_footer_y 결과)
    ocr_results: 섹션 헤더 감지용 (없으면 헤더 감지 건너뜀)

  Returns:
    [{"number": 38, "crop_box": (x1,y1,x2,y2)}]
  """
  if not detections:
    return []

  mid_x = page_width / 2

  if layout == "single":
    # 1단 강제: 모든 번호를 좌열로 처리
    left_col = sorted(detections, key=lambda d: d["center_y"])
    right_col = []
    col_ranges = [(0, page_width)]
  elif layout == "double":
    # 2단 강제
    left_col = [d for d in detections if d["center_x"] < mid_x]
    right_col = [d for d in detections if d["center_x"] >= mid_x]
    col_ranges = [(0, mid_x), (mid_x, page_width)]
  else:
    # auto: 좌열/우열 자동 분류
    left_col = [d for d in detections if d["center_x"] < mid_x]
    right_col = [d for d in detections if d["center_x"] >= mid_x]

    # 한쪽에만 몰려있으면 1열 처리
    if not left_col:
      left_col = right_col
      right_col = []
      col_ranges = [(0, page_width)]
    elif not right_col:
      col_ranges = [(0, page_width)]
    else:
      col_ranges = [(0, mid_x), (mid_x, page_width)]

  # 각 열 내에서 y 정렬
  left_col.sort(key=lambda d: d["center_y"])
  right_col.sort(key=lambda d: d["center_y"])

  regions = []

  # 페이지 하단 제한: footer_y가 있으면 그것을 사용, 없으면 기본 92%
  content_bottom = footer_y if footer_y else int(page_height * 0.92)

  def process_column(col_detections: List[Dict], x_start: int, x_end: int):
    for i, det in enumerate(col_detections):
      # 상단 여백: 문제 번호 bbox 높이의 절반 (태그/아이콘 포함용 최소 여백)
      bbox_height = det["bbox"][3] - det["bbox"][1]
      top_margin = max(15, int(bbox_height * 0.5))

      # y 시작: 항상 현재 문제 번호 bbox top에서 top_margin만큼 위
      y_start = max(0, int(det["bbox"][1]) - top_margin)

      # y 끝 계산
      if i + 1 < len(col_detections):
        next_det = col_detections[i + 1]
        next_bbox_top = int(next_det["bbox"][1])
        next_top_margin = max(15, int((next_det["bbox"][3] - next_det["bbox"][1]) * 0.5))
        # 기본 y_end: 다음 문제 y_start와 맞닿음
        y_end_default = max(int(det["center_y"]) + 10, next_bbox_top - next_top_margin)

        # 섹션 헤더가 중간에 있으면 헤더 바로 위에서 자름
        if ocr_results:
          header_y = _find_section_header_y(
            ocr_results,
            y_from=det["center_y"],
            y_to=next_bbox_top,
          )
          if header_y is not None:
            y_end = min(y_end_default, header_y - 5)
          else:
            y_end = y_end_default
        else:
          y_end = y_end_default
      else:
        # 마지막 문제: 섹션 헤더 또는 content_bottom까지
        if ocr_results:
          header_y = _find_section_header_y(
            ocr_results,
            y_from=det["center_y"],
            y_to=content_bottom,
          )
          y_end = header_y - 5 if header_y is not None else content_bottom
        else:
          y_end = content_bottom

      crop_box = (
        max(0, int(x_start)),
        int(y_start),
        min(page_width, int(x_end)),
        int(y_end),
      )
      regions.append({
        "number": det["number"],
        "crop_box": crop_box,
      })

  if len(col_ranges) == 1:
    process_column(left_col, col_ranges[0][0], col_ranges[0][1])
  else:
    process_column(left_col, col_ranges[0][0], col_ranges[0][1])
    process_column(right_col, col_ranges[1][0], col_ranges[1][1])

  # 번호순 정렬
  regions.sort(key=lambda r: r["number"])
  return regions


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
