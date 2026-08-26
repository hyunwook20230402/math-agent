"""문항 영역의 보기기호(①~⑤)를 실제로 읽어 객관식/주관식을 판정한다.

번호 규칙(모의고사 = 1~15 객관식, 16~30 단답)은 수능 형식이라 안정적이지만,
내신은 학교마다 문항 구성이 달라 번호로는 못 맞춘다. 실측 예: 야탑고 고1 기말은
객관식이 1~17·21번, 주관식이 18~20번이라 번호 규칙으로는 3문항이 어긋났다.

그래서 지면에 보기기호가 찍혀 있는지를 직접 보고 정한다. YOLO 가 잡은 문항 bbox 는
렌더된 페이지 이미지의 픽셀 좌표이므로, PDF 좌표로 환산해 그 영역의 텍스트만 읽는다.
"""
import logging
from typing import Dict, List, Optional

import fitz  # PyMuPDF

logger = logging.getLogger(__name__)

_CHOICE_MARKS = ("①", "②", "③", "④", "⑤")

# 5지선다인데 일부 기호가 이미지로 박혀 텍스트 레이어에서 빠질 수 있어 5개를 요구하지 않는다.
# 반대로 문두가 다른 문항의 보기를 인용하는 경우가 있어 1~2개는 근거로 삼지 않는다.
_MIN_DISTINCT_MARKS = 3


def detect_answer_types(pdf_path: str, items: List[Dict]) -> Optional[Dict[int, str]]:
    """문항별 answer_type 을 판정한다.

    Args:
        pdf_path: 원본 PDF 경로
        items: 크롭 결과. 각 원소는 최소한
            {"number": int, "page": int(1-indexed),
             "bbox": {"x1","y1","x2","y2","page_width","page_height"}} 를 가진다.

    Returns:
        {문제번호: 'multiple_choice' | 'short_answer'}.
        텍스트 레이어가 없는 스캔 PDF 등 판정 근거를 못 얻으면 **None** —
        호출부가 자기 폴백을 쓰도록 빈 dict 가 아니라 None 을 돌려준다.
    """
    try:
        doc = fitz.open(pdf_path)
    except Exception as e:  # 손상 PDF 등
        logger.warning("[answer_type] PDF 열기 실패 → 폴백: %s", e)
        return None

    try:
        # 스캔본이면 clip 으로 읽어도 전부 빈 문자열이라 판정 자체가 불가능하다.
        if not any(page.get_text("text").strip() for page in doc):
            logger.info("[answer_type] 텍스트 레이어 없음(스캔 PDF) → 폴백")
            return None

        result: Dict[int, str] = {}
        for item in items:
            num = item.get("number")
            page_no = item.get("page")
            bbox = item.get("bbox") or {}
            if num is None or page_no is None or not bbox:
                continue

            idx = page_no - 1  # bbox 의 page 는 원본 PDF 기준 1-indexed
            if not (0 <= idx < doc.page_count):
                continue

            pw = bbox.get("page_width") or 0
            ph = bbox.get("page_height") or 0
            if not pw or not ph:
                continue

            page = doc[idx]
            # 렌더 DPI 를 몰라도 되게 페이지 크기 비율로 환산한다(현재 200dpi 지만 바뀔 수 있음).
            sx = page.rect.width / pw
            sy = page.rect.height / ph
            rect = fitz.Rect(
                bbox["x1"] * sx, bbox["y1"] * sy,
                bbox["x2"] * sx, bbox["y2"] * sy,
            )

            text = page.get_text("text", clip=rect) or ""
            distinct = sum(1 for mark in _CHOICE_MARKS if mark in text)
            result[num] = (
                "multiple_choice" if distinct >= _MIN_DISTINCT_MARKS else "short_answer"
            )

        return result or None
    finally:
        doc.close()
