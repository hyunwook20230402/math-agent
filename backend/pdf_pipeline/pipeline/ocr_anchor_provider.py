"""스캔본 PDF 에서 문제번호 앵커를 OCR 로 얻는다.

왜 필요한가:
  쎈 같은 교재는 PDF 에 텍스트 레이어가 아예 없다(실측: 텍스트 0자, 벡터 도형 0개,
  전면 래스터 이미지). 그래서 `text_anchor_segmenter.spans_from_doc` 이 빈 결과를 낸다.
  하지만 지면에는 문제번호가 또렷이 찍혀 있으므로 OCR 로 읽어 주면
  **디지털 PDF 와 똑같은 분할 알고리즘을 그대로 쓸 수 있다**.

설계 — 전면 OCR 을 하지 않는다:
  이 환경엔 CUDA 가 없어(CPU 4스레드) 전면 OCR 은 페이지당 수십 초로 느리다.
  필요한 건 '번호' 뿐이고 번호는 각 단의 왼쪽 끝에 있으므로,
  ① 잉크 세로 투영으로 단 경계를 찾고 ② 각 단의 **왼쪽 좁은 띠만** OCR 한다.
  실측: 쎈 한 쪽 두 단이 각 5~6초.

실측으로 정한 값들 (쎈 p2, 200dpi, 정답 0046~0053):
  띠 폭 10% → 0개 / 14% → 4개 / **18% → 8개 전부** / 22% → 7개(배지와 병합 늘어남)
  신뢰도가 결정적 판별자였다 — 진짜 번호 conf 0.96~1.0, 수식 잡음 conf 0.26~0.63.
  '대표 문제' 배지가 번호에 붙어 '0046148' 처럼 병합되므로 **접두어 4자리도 인정**한다.
"""
import logging
import re
from typing import List, Optional, Tuple

import numpy as np

from pipeline.text_anchor_segmenter import make_span

logger = logging.getLogger(__name__)

_STRIP_RATIO = 0.18      # 단 폭에서 OCR 할 왼쪽 비율
_MIN_CONF = 0.90         # 이 아래는 수식 잡음

# 문제번호는 단 왼쪽 끝에 붙어 있고, 보기번호(①의 값)·수식 숫자는 들여쓰여 있다.
# 띠 안에서 이 비율보다 오른쪽에서 시작하는 것은 번호가 아니다.
# 실측(200dpi, 쎈): 진짜 번호는 단 시작에서 +43~47px, 보기번호 '16','19' 는 +81px.
_MAX_LEFT_OFFSET = 0.5

# OCR 은 같은 번호라도 박스 높이가 들쭉날쭉해서 크기로 묶으면 한 체계가 쪼개진다.
# 그래서 OCR span 은 전부 한 그룹으로 두고, 증가부분열·x군집이 판별하게 한다.
_OCR_GROUP_SIZE = 12.0
_INK_THRESHOLD = 160     # 이보다 어두우면 잉크로 본다
_MIN_GUTTER_PX = 8       # 단 사이 흰 띠로 인정할 최소 폭

# easyocr 의 박스 병합을 억제한다. 기본값이면 번호와 옆 배지를 한 덩어리로 읽는다.
_OCR_KWARGS = dict(width_ths=0.05, ycenter_ths=0.3, height_ths=0.3)

_reader = None


def _get_reader():
    """easyocr 리더는 로드가 비싸다(CPU 기준 수십 초) — 프로세스당 한 번만."""
    global _reader
    if _reader is None:
        import easyocr
        _reader = easyocr.Reader(["en"], gpu=False, verbose=False)
    return _reader


def detect_columns(gray: np.ndarray) -> List[Tuple[int, int]]:
    """잉크 세로 투영에서 가장 넓은 흰 띠(거터)를 찾아 단을 나눈다.

    텍스트 레이어가 없어도 되는 픽셀 기반이라 스캔본에 쓸 수 있다.
    거터가 뚜렷하지 않으면 1단으로 본다.
    """
    h, w = gray.shape[:2]
    ink = (gray < _INK_THRESHOLD).sum(axis=0)
    body = ink[int(w * 0.05):int(w * 0.95)]
    if body.size == 0 or body.max() == 0:
        return [(0, w)]
    white = ink < max(2, body.max() * 0.02)

    best_run, best_start, best_end = 0, 0, 0
    run = 0
    for x in range(int(w * 0.25), int(w * 0.75)):
        if white[x]:
            run += 1
        else:
            if run > best_run:
                best_run, best_start, best_end = run, x - run, x
            run = 0
    if run > best_run:
        best_run, best_start, best_end = run, int(w * 0.75) - run, int(w * 0.75)

    if best_run < _MIN_GUTTER_PX:
        return [(int(w * 0.03), int(w * 0.97))]

    gutter = (best_start + best_end) // 2
    return [(int(w * 0.03), gutter), (gutter, int(w * 0.97))]


def tighten_by_ink(gray: np.ndarray, rect, pdf_width: float, pdf_height: float,
                   pad: float = 4.0):
    """렌더 이미지의 잉크 분포로 크롭 영역을 조인다 (스캔본 전용).

    디지털 PDF 는 `text_anchor_segmenter._content_rect` 가 텍스트·도형 좌표로 조이지만,
    스캔본은 그 좌표가 없어 앵커 사이 여백이 그대로 남는다.

    한 줄에 잉크가 몇 픽셀 이상 있어야 '내용'으로 친다 — 단 경계 세로 괘선이
    행마다 1~2픽셀씩 찍혀 있어서, 단순히 '잉크가 있으면' 으로 보면
    페이지 전체가 내용으로 잡혀 트림이 무력화된다.
    """
    import fitz

    h, w = gray.shape[:2]
    sx, sy = w / pdf_width, h / pdf_height
    x0, y0 = max(0, int(rect.x0 * sx)), max(0, int(rect.y0 * sy))
    x1, y1 = min(w, int(rect.x1 * sx)), min(h, int(rect.y1 * sy))
    if x1 - x0 < 5 or y1 - y0 < 5:
        return rect

    sub = gray[y0:y1, x0:x1] < _INK_THRESHOLD
    min_px = max(3, int(sub.shape[1] * 0.005))     # 괘선(1~2px)은 내용이 아니다
    rows = np.where(sub.sum(axis=1) >= min_px)[0]
    cols = np.where(sub.sum(axis=0) >= max(2, int(sub.shape[0] * 0.005)))[0]
    if rows.size == 0 or cols.size == 0:
        return rect

    return fitz.Rect(
        max(rect.x0, (x0 + cols[0]) / sx - pad),
        max(rect.y0, (y0 + rows[0]) / sy - pad),
        min(rect.x1, (x0 + cols[-1]) / sx + pad),
        min(rect.y1, (y0 + rows[-1]) / sy + pad),
    )


def ocr_number_spans(
    page_index: int,
    rgb: np.ndarray,
    pdf_width: float,
    pdf_height: float,
    strip_ratio: float = _STRIP_RATIO,
    min_conf: float = _MIN_CONF,
) -> List[dict]:
    """한 페이지 이미지에서 번호 앵커 span 을 뽑는다 (좌표는 PDF 포인트).

    Args:
        page_index: 0-indexed 페이지 번호
        rgb: 렌더된 페이지 이미지 (H, W, 3)
        pdf_width/pdf_height: 그 페이지의 PDF 크기 — 픽셀→포인트 환산용
    """
    gray = np.dot(rgb[..., :3], [0.299, 0.587, 0.114]).astype(np.uint8)
    h, w = gray.shape[:2]
    sx, sy = pdf_width / w, pdf_height / h

    reader = _get_reader()
    spans: List[dict] = []

    for cx0, cx1 in detect_columns(gray):
        strip_x1 = cx0 + int((cx1 - cx0) * strip_ratio)
        if strip_x1 - cx0 < 20:
            continue
        try:
            results = reader.readtext(rgb[:, cx0:strip_x1], allowlist="0123456789",
                                      **_OCR_KWARGS)
        except Exception as e:
            logger.warning("[ocr] 페이지 %d 단 OCR 실패: %s", page_index + 1, e)
            continue

        strip_w = strip_x1 - cx0
        for box, text, conf in results:
            if conf < min_conf:
                continue          # 수식에서 나온 숫자 잡음
            t = text.strip()
            # 번호 옆 배지와 병합돼 '0046148' 처럼 나오므로 **앞부분 숫자**를 취한다.
            m = re.match(r"^(\d{1,4})", t)
            if not m:
                continue
            local_x = min(p[0] for p in box)
            if local_x > strip_w * _MAX_LEFT_OFFSET:
                continue          # 들여쓰인 것 = 보기번호·수식
            y_px = min(p[1] for p in box)
            span = make_span(
                page_index, m.group(1),
                x=(local_x + cx0) * sx, y=y_px * sy,
                size=_OCR_GROUP_SIZE, font="ocr",
            )
            if span:
                spans.append(span)

    return spans
