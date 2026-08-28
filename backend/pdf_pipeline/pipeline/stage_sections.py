"""교재 PDF 를 '단계' 구간으로 나눈다 (쎈 A/B/C단계 등).

왜 필요한가:
  쎈은 한 단원 안에 단계가 이어져 있어, 단원 PDF 를 통째로 크롭하면 B단계와 C단계가
  한 폴더에 섞인다. 교재를 단계별로 쌓으려면 "B단계 폴더에는 B단계 쪽만" 잘라야 하는데,
  그러려면 몇 쪽부터 몇 쪽이 그 단계인지 알아야 한다.

  크롭 자체는 이미 쪽 범위를 지킨다(`extract_images_from_pdf` + main 의 "렌더된 페이지만
  대상"). 그러니 여기서는 **경계만 찾아 주면 된다.**

어떻게 찾나 — 배너의 '높이':
  단계가 바뀌는 쪽 맨 위에는 큰 배너가 있다(쎈: 초록 `B` 유형 익히기 / 청록 `C` 실력 굳히기).
  왼쪽 위 구석에서 채도 높은 덩어리의 세로 길이를 재면 실측(200dpi, 17쪽)으로:

      배너 쪽(1·14쪽)  149~153px  =  쪽 높이의 6.4%
      나머지 15쪽       24~48px   =  쪽 높이의 1.0~2.1%   ← 문제번호 색 라벨

  3배 차이라 3.5% 로 자르면 정확히 갈린다. 크롭이 쓰는 색 라벨 규칙
  (`ocr_anchor_provider._LABEL_H_MIN/MAX = 10/45px`)과도 겹치지 않는다.

⚠️ 배너의 글자(A/B/C)는 읽지 않는다. 입체 일러스트라 OCR 이 못 읽는다 — `대표 문제` 배지가
   200/300/400dpi 전부 실패했던 것과 같은 부류(dev-rules). 대신 배너 조각을 그림으로 돌려주고
   **사람이 보고 고르게** 한다. 화면에 초록 B, 청록 C 가 그대로 보이므로 헷갈릴 여지가 없다.

VL 을 안 부른다 → 비용 0.
"""
import base64
import io
import logging
from typing import List, Optional

import fitz
import numpy as np

logger = logging.getLogger(__name__)

_DPI = 200
# 배너를 찾는 창 — 왼쪽 위 구석. 창을 안 씌우면 본문 문제번호·오른쪽 색인 탭이 섞인다.
_WINDOW_W = 0.22
_WINDOW_H = 0.11
# 이보다 색이 뚜렷해야 '색 덩어리'로 본다(본문은 검정이라 채도가 낮다).
_SAT_MIN = 60
# 한 행을 '색이 있는 행'으로 칠 최소 픽셀 수 — 얼룩 한 점에 흔들리지 않게.
_ROW_MIN_PX = 3
# 배너로 칠 최소 높이(쪽 높이 대비). 실측 배너 6.4% / 문제번호 1.0~2.1% 사이.
_BANNER_H_RATIO = 0.035
# 썸네일은 배너보다 넓게 잘라 '유형 익히기' 같은 글자까지 보이게 한다.
_THUMB_W = 0.42
_THUMB_H = 0.12


def _banner_height(rgb: np.ndarray) -> int:
    """이 창 안에서 **끊기지 않고 이어진** 색 행의 최대 길이(px).

    '첫 색행 ~ 끝 색행' 으로 재면 안 된다 — 색 문제번호가 여러 줄 있는 지면(빠른정답표
    등)에서 줄들 사이 흰 틈까지 합쳐져 배너만큼 길어진다(실측: 쎈 수학1 답지가 6쪽 중
    4쪽이나 배너로 잡혔다). 배너는 통글자 하나라 **한 덩어리로 이어진다**.
    """
    mx = rgb.max(axis=2)
    mn = rgb.min(axis=2)
    sat = (mx - mn) > _SAT_MIN
    colored = sat.sum(axis=1) > _ROW_MIN_PX
    best = run = 0
    for c in colored:
        run = run + 1 if c else 0
        best = max(best, run)
    return best


def _thumb(page, dpi: int) -> str:
    """배너 언저리를 잘라 data URI 로. 화면에서 B/C 를 눈으로 고르게 하는 용도."""
    clip = fitz.Rect(0, 0, page.rect.width * _THUMB_W, page.rect.height * _THUMB_H)
    pix = page.get_pixmap(matrix=fitz.Matrix(dpi / 72, dpi / 72), clip=clip)
    return "data:image/png;base64," + base64.b64encode(pix.tobytes("png")).decode()


def detect_sections(pdf_path: str, *, dpi: int = _DPI,
                    thumb_dpi: int = 72) -> List[dict]:
    """단계 배너로 PDF 를 구간으로 나눈다.

    Returns:
        [{"page_start", "page_end", "banner_page", "thumb"}...] (쪽 번호는 1-기준).
        배너가 1개 이하면 **빈 목록** — 나눌 게 없으니 호출부는 지금처럼 통째로 다루면 된다.
    """
    doc = fitz.open(pdf_path)
    try:
        banner_pages: List[int] = []
        for pno in range(doc.page_count):
            page = doc[pno]
            pix = page.get_pixmap(matrix=fitz.Matrix(dpi / 72, dpi / 72))
            rgb = np.frombuffer(pix.samples, dtype=np.uint8).reshape(
                pix.height, pix.width, pix.n)[:, :, :3].astype(int)
            win = rgb[:int(pix.height * _WINDOW_H), :int(pix.width * _WINDOW_W), :]
            h = _banner_height(win)
            if h >= pix.height * _BANNER_H_RATIO:
                banner_pages.append(pno)
                logger.info("[sections] %d쪽 단계 배너 (높이 %dpx = %.1f%%)",
                            pno + 1, h, h / pix.height * 100)

        if len(banner_pages) < 2:
            logger.info("[sections] 배너 %d개 — 구간을 나누지 않는다", len(banner_pages))
            return []

        # 배너가 1쪽에 없으면 그 앞부분도 한 구간이다(중간부터 잘라 온 PDF 대응).
        starts = banner_pages if banner_pages[0] == 0 else [0] + banner_pages
        out: List[dict] = []
        for i, s in enumerate(starts):
            end = (starts[i + 1] - 1) if i + 1 < len(starts) else doc.page_count - 1
            out.append({
                "page_start": s + 1,
                "page_end": end + 1,
                "banner_page": (s + 1) if s in banner_pages else None,
                "thumb": _thumb(doc[s], thumb_dpi),
            })
        return out
    finally:
        doc.close()
