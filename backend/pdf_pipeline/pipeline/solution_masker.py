"""크롭 영역에서 풀이·해설을 잘라낸다.

사용자 요구: "예제든 연습문제든 유제든 다 크롭하되 **풀이는 없이 문제만**".
학생에게 배포될 이미지라 정답이 섞이면 안 된다.

두 층위로 막는다:
  1) 해설 전용 페이지 — 문제번호 앵커가 없으면 애초에 영역이 안 생긴다.
     (실측: 내신 p5 '빠른정답', 교육청 p13~24 해설 섹션이 이 방식으로 자동 제외됐다.)
  2) 문제 바로 아래 붙은 풀이 — 이 모듈이 마커 y 위에서 잘라낸다.
     (실측: 수능특강 '길잡이' y=211·'풀이' y=312, 바이블 '접근방법' y=227·'보충설명' y=567)
"""
import logging
import re
from typing import List, Optional

import fitz  # PyMuPDF

logger = logging.getLogger(__name__)

# 이 말이 나오면 그 아래는 문제가 아니다.
_MARKERS = (
    "풀이", "길잡이", "해설", "접근방법", "보충설명",
    "정답과 풀이", "다른풀이", "다른 풀이", "채점기준", "채점 기준",
    "Solution", "정답",
)

# 마커로 인정할 최대 글자수 — 본문에 '풀이' 가 섞인 긴 문장을 마커로 오인하지 않기 위해.
_MAX_MARKER_LEN = 12

_MARKER_RE = re.compile("|".join(re.escape(m) for m in _MARKERS))


def _is_marker(text: str) -> bool:
    t = text.strip()
    if not t or len(t) > _MAX_MARKER_LEN:
        return False
    return bool(_MARKER_RE.search(t))


def find_solution_cut(page: fitz.Page, rect: fitz.Rect, min_keep: float = 24.0) -> Optional[float]:
    """rect 안에서 풀이가 시작되는 y 를 찾는다. 없으면 None.

    Args:
        min_keep: 잘라낸 뒤 남는 높이가 이보다 작으면 컷을 포기한다
                  (마커가 영역 맨 위면 통째로 사라져 버리므로).
    """
    best: Optional[float] = None
    for blk in page.get_text("dict")["blocks"]:
        for ln in blk.get("lines", []):
            lb = fitz.Rect(ln["bbox"])
            if not lb.intersects(rect):
                continue
            for sp in ln.get("spans", []):
                if not _is_marker(sp["text"]):
                    continue
                y = sp["bbox"][1]
                if y - rect.y0 < min_keep:
                    continue  # 영역 맨 위 = 이 문제의 것이 아니거나 자를 게 없다
                if best is None or y < best:
                    best = y
    return best


def strip_solutions(doc: fitz.Document, regions: List[dict]) -> List[dict]:
    """각 영역에서 풀이 부분을 잘라낸다. regions 는 제자리 수정된다."""
    cut_count = 0
    for r in regions:
        page = doc[r["page"]]
        rect: fitz.Rect = r["rect"]
        cut_y = find_solution_cut(page, rect)
        if cut_y is None or cut_y >= rect.y1:
            continue
        r["rect"] = fitz.Rect(rect.x0, rect.y0, rect.x1, cut_y - 3)
        r["solution_trimmed"] = True
        cut_count += 1

    if cut_count:
        logger.info("[solution] 풀이 영역 잘라냄 — %d개 문제", cut_count)
    return regions
