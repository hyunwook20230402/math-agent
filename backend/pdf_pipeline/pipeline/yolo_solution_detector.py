"""YOLO 기반 해설지 solution_block detection

학습된 solution_detector.pt 로 해설 박스를 감지하고,
박스 내부 상단 20% 영역에서만 OCR을 수행해 문제 번호를 추출.
박스 밖 영역(정답표 등)은 무시 → 오감지 원천 차단.

사용법:
  from pipeline.yolo_solution_detector import load_model, detect_solutions, release_model
  model = load_model()
  detections = detect_solutions(model, "page_001.png")
  release_model(model)
"""
import os
import re
from pathlib import Path
from typing import List, Dict, Optional

from ultralytics import YOLO

_DEFAULT_MODEL_PATH = str(Path(__file__).parent.parent / "models" / "solution_detector.pt")


def load_model(model_path: str = None) -> YOLO:
    """해설지 YOLO 모델 로드"""
    path = model_path or os.getenv("YOLO_SOLUTION_MODEL_PATH", _DEFAULT_MODEL_PATH)
    if not Path(path).exists():
        raise FileNotFoundError(f"solution_detector 모델 없음: {path}")
    return YOLO(path)


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
    """모델 파일 존재 여부"""
    path = model_path or os.getenv("YOLO_SOLUTION_MODEL_PATH", _DEFAULT_MODEL_PATH)
    return Path(path).exists()


def _ocr_number_in_header(img_crop) -> Optional[int]:
    """박스 상단 20% 영역에서만 OCR로 'N)' 또는 'N.' 패턴의 번호 추출.

    박스 밖 영역을 완전히 무시하므로 정답표/헤더 오인식이 없음.
    번호를 찾지 못하면 None 반환.
    """
    import numpy as np
    import cv2

    h, w = img_crop.shape[:2]
    header_h = max(1, int(h * 0.20))
    header_region = img_crop[:header_h, :]

    # OCR 로드 (싱글톤)
    try:
        from pipeline.ocr_engine import get_reader
        reader = get_reader()
        results = reader.readtext(header_region, detail=1)
    except Exception:
        return None

    # 'N)' / 'N.' / 'N ' 패턴 매칭 (1~45 범위)
    for (_bbox, text, _conf) in results:
        text = text.strip()
        m = re.match(r'^(\d{1,2})[.)]\s*', text)
        if m:
            n = int(m.group(1))
            if 1 <= n <= 45:
                return n
        # 숫자만 있는 경우도 허용 (신뢰도 높은 경우)
        m2 = re.fullmatch(r'(\d{1,2})', text)
        if m2:
            n = int(m2.group(1))
            if 1 <= n <= 45:
                return n

    return None


def detect_solutions(
    model: YOLO,
    image_path: str,
    page_width: int = None,
    page_height: int = None,
    conf: float = 0.3,
    padding: int = 20,
    min_height: int = 80,
    use_ocr: bool = True,
) -> List[Dict]:
    """해설지 페이지 이미지에서 solution_block 감지.

    Args:
        model: load_model()로 로드한 YOLO 모델
        image_path: 페이지 이미지 경로
        page_width: 페이지 너비 (None이면 이미지에서 자동)
        page_height: 페이지 높이 (None이면 이미지에서 자동)
        conf: 최소 confidence
        padding: bbox 여백 (픽셀)
        min_height: 이 높이 미만 박스 제거
        use_ocr: True면 박스 상단 OCR로 번호 추출

    Returns:
        [
          {
            "bbox": {"x1": int, "y1": int, "x2": int, "y2": int},
            "confidence": float,
            "number": int | None,   # OCR 추출 번호, 실패 시 None
            "group_id": None,       # 후처리에서 채움
          },
          ...
        ]
        번호순(오름차순)으로 정렬. 번호 없는 박스는 뒤에 배치.
    """
    import cv2
    import numpy as np

    img = cv2.imread(image_path)
    if img is None:
        return []

    h_img, w_img = img.shape[:2]
    pw = page_width or w_img
    ph = page_height or h_img

    results = model(image_path, conf=conf, imgsz=1280, verbose=False)
    if not results or len(results[0].boxes) == 0:
        return []

    boxes = results[0].boxes
    detections = []

    for i in range(len(boxes)):
        # 2-클래스 모델: 0=solution_block, 1=answer_table → 정답표는 무시
        cls_id = int(boxes.cls[i].cpu().numpy()) if hasattr(boxes, "cls") else 0
        if cls_id != 0:
            continue

        x1, y1, x2, y2 = [float(v) for v in boxes.xyxy[i].cpu().numpy()]
        confidence = float(boxes.conf[i].cpu().numpy())

        # padding + 클리핑
        x1 = max(0, int(x1) - padding)
        y1 = max(0, int(y1) - padding)
        x2 = min(pw, int(x2) + padding)
        y2 = min(ph, int(y2) + padding)

        if (y2 - y1) < min_height:
            continue

        number = None
        if use_ocr:
            crop = img[y1:y2, x1:x2]
            if crop.size > 0:
                number = _ocr_number_in_header(crop)

        detections.append({
            "bbox": {"x1": x1, "y1": y1, "x2": x2, "y2": y2},
            "confidence": confidence,
            "number": number,
            "group_id": None,
        })

    # 번호 있는 박스를 번호순, 없는 박스는 y1 순서대로 뒤에 배치
    with_num = sorted([d for d in detections if d["number"] is not None], key=lambda d: d["number"])
    without_num = sorted([d for d in detections if d["number"] is None], key=lambda d: d["bbox"]["y1"])

    return with_num + without_num
