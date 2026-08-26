"""스캔본 PDF 에서 문제번호 앵커를 얻는다.

왜 필요한가:
  쎈 같은 교재는 PDF 에 텍스트 레이어가 아예 없다(실측: 텍스트 0자, 벡터 도형 0개,
  전면 래스터 이미지). 그래서 `text_anchor_segmenter.spans_from_doc` 이 빈 결과를 낸다.

설계 — **위치는 색으로 찾고, 번호는 읽히는 것만 읽는다** (2026-08-26 개편):
  옛 방식은 단 왼쪽 띠를 통째로 OCR 해 번호를 '읽어서' 위치를 찾았는데, 세 군데서 깨졌다.
    ① 짝수쪽 좌단 전멸 — 단 왼쪽을 `w*0.03` 으로 고정해 놨는데 이 책은 펼침면이라
       쪽마다 여백이 반전된다(실측: 짝수쪽 63~65pt / 홀수쪽 25~31pt). 띠가 번호를
       반으로 잘라 easyocr 가 아무것도 못 읽었다(p3·p5 좌단 결과 0건).
    ② 신뢰도로 갈라지지 않는다 — 진짜 번호 conf 0.582~1.000(0193=0.702, 0195=0.726)
       인데 수식 잡음 '3410' 은 0.893. `_MIN_CONF=0.90` 은 진짜를 떨어뜨리고 잡음을 통과시켰다.
    ③ `대표 문제` 배지(주황 바탕 흰 글씨)는 200/300/400dpi 전부 못 읽는다.
       못 읽은 번호 18개가 **전부** 배지였다.

  그런데 이 판형은 문제번호가 예외 없이 **채도 높은 색**이다(B단계 초록·대표문제 주황배지·
  C단계 파랑). 본문과 수식은 검정. 그래서 단 왼쪽 창에서 '색 덩어리'를 찾으면 위치가 정확히
  나온다 — OCR 이 못 읽는 배지까지. 번호는 그 라벨 패치만 확대해 읽어 정렬·중복제거에 쓰고,
  못 읽으면 못 읽은 채로 둔다(앞뒤 번호에 빈 자리가 있으면 채택).

  실측(쎈 17쪽, 정답 120문항): 옛 방식 70~75개 → 새 방식 120/120, 잡음 앵커 0개.

색이 전혀 없는 흑백 스캔이면 색 라벨이 안 나오므로 옛 스트립 OCR 경로로 자동 폴백한다.
"""
import logging
import re
from collections import Counter
from typing import List, Optional, Sequence, Tuple

import numpy as np

from pipeline.text_anchor_segmenter import make_span, _longest_increasing

logger = logging.getLogger(__name__)

_INK_THRESHOLD = 160     # 이보다 어두우면 잉크로 본다
_MIN_GUTTER_PX = 8       # 단 사이 흰 띠로 인정할 최소 폭
# 단의 좌우 경계로 인정할 세로 잉크량(페이지 높이 대비). 이보다 옅으면 얼룩·가장자리 잡티다.
_COL_EDGE_INK_RATIO = 0.004

# ── 색 라벨(문제번호) 검출 ────────────────────────────────────────────
# 단 왼쪽 이 비율 안에서만 라벨을 찾는다. 35% 가 핵심 — 이 창이 유형 헤더(단 폭 전체를
# 차지)와 쪽 오른쪽 세로 탭, C단계의 우측정렬 상호참조("30쪽 유형 06")를 자동으로
# 배제한다. 창을 안 씌우면 그것들이 라벨 띠와 합쳐져 높이 필터에 걸려 번호가 통째로 사라진다
# (실측: p14 col1 이 세로 탭과 병합돼 h=354 → 0260 유실).
_LABEL_WINDOW = 0.35
_LABEL_SAT = 0.30        # 채도. 검정 본문은 0 에 가깝고 초록·주황·파랑 번호는 0.5 이상
_LABEL_MIN_VALUE = 70    # 너무 어두우면 색이 아니라 검정이다
_LABEL_ROW_MIN_PX = 3    # 한 행에서 이만큼은 색이어야 라벨 행
_LABEL_ROW_GAP = 4       # 이만큼 떨어지면 다른 띠
# 200dpi 기준 라벨 높이. 실측: 평문 번호 24~30px, 대표문제 배지 37~38px,
# 쪽 상단 로고(h=148~171)와 조건박스는 이 위로 벗어난다.
_LABEL_H_MIN, _LABEL_H_MAX = 10, 45
_LABEL_LEFT_MAX = 0.10   # 라벨은 단 왼쪽 가장자리에 붙어 있다
_LABEL_UPSCALE = 3       # 라벨 패치를 이만큼 확대해 읽는다(작은 글자 인식률)
_LABEL_PATCH_PAD = 4
_LABEL_MIN_TOTAL = 6     # 문서 전체에서 이보다 적으면 색 번호 체계가 아니다
# 문제번호 라벨 왼쪽에 남길 여백(pt). 교사가 검수한 120개 박스와 대조해 정한 값 —
# '라벨 최소 x - 교사 경계' 가 34개 단 전부에서 +4~+25px(중앙 +12px, 300dpi)였다.
_LABEL_LEFT_MARGIN = 2.9
# 앞 단의 오른쪽 경계를 다음 단 경계에서 이만큼(pt) 떼어 놓는다 = 단 사이 세로 괘선 회피.
# 실측: 괘선은 다음 단 라벨보다 44~63px(300dpi) 왼쪽에 있어 14pt(58px)면 정확히 빠지고,
# 그러면서 어느 쪽에서도 본문이 잘리지 않았다(내용 손실 0건).
_COLUMN_CLEARANCE = 14.0
# 번호를 못 읽은 라벨(☆사고의 기술 배지 등)을 '바로 아래 문제의 시작'으로 볼 최대 거리(pt).
_LABEL_MERGE_GAP = 40.0

# ── 섹션(유형) 헤더 검출 — 문제 영역의 아래 경계로 쓴다 ──────────────
_HEADER_MIN_WIDTH_RATIO = 0.60
_HEADER_H_MIN, _HEADER_H_MAX = 15, 90
_HEADER_LEFT_MAX = 0.15
_HEADER_LABEL_TOLERANCE = 8   # 번호 라벨과 이만큼 겹치면 헤더가 아니라 번호 행이다
# 쪽 옆에 세로로 길게 인쇄된 단원 색인 탭은 글자가 아니라 지면 장식이다. 마스크에 남아
# 있으면 헤더 띠가 그것과 이어져 한 덩어리가 된다(실측: 쎈 p2 col1 이 탭과 병합돼 h=355 →
# 유형 헤더를 놓쳤고, 그 결과 0170 크롭이 다음 문제 앞까지 늘어났다).
# 판별은 '연속' 길이로 한다 — 총합으로 보면 세로로 쌓인 라벨 여러 개가 같이 지워진다.
_MAX_VERTICAL_RUN_RATIO = 0.10

# 단 가장자리의 '넓은 흰 틈 너머 좁은 조각' 은 본문이 아니라 지면 장식이다
# (쎈은 쪽 옆에 세로로 쓴 단원 색인 탭이 있다). 실측(200dpi, 쪽폭 1654px):
#   본문 안쪽 흰 틈 최대 36px  /  탭 앞 흰 틈 61~69px  → 그 사이인 3% 로 가른다.
# 탭 글자는 세로쓰기라 획이 짧아 `_vertical_furniture` 로는 안 잡힌다(최장 연속 17px).
_EDGE_GAP_RATIO = 0.03          # 쪽 폭 대비 '넓은 틈'
_EDGE_FRAGMENT_RATIO = 0.15     # 단 폭 대비 이보다 좁은 끝 조각은 버린다

# 단의 본문이 끝나는 y 를 잉크로 잰다. 쪽 꼬리말은 이 아래에 따로 살기 때문에
# 여기까지만 본다. 실측(쎈): 본문 마지막 줄 최대 88.1%, 꼬리말 95.6~96.8% — 그 사이.
# 이게 필요한 이유: 분할의 기본 하단은 `_MARGIN_BOTTOM`(0.85)인데 그건 '이 아래에 있는
# 숫자는 문제번호가 아니다' 를 위한 값이라 본문 하단과 다르다. 그대로 쓰면 각 단의
# **마지막 문제**가 715pt 에서 잘린다(실측: 0165 가 35pt 손실).
_CONTENT_BOTTOM_LIMIT = 0.93

# ── 옛 스트립 OCR 경로(흑백 스캔 폴백) ────────────────────────────────
_STRIP_RATIO = 0.18      # 단 폭에서 OCR 할 왼쪽 비율
# 0.90 은 진짜 번호를 떨어뜨렸다(0193=0.702). 잡음은 신뢰도가 아니라 증가부분열이 거른다.
_MIN_CONF = 0.40
# 문제번호는 단 왼쪽 끝에 붙어 있고, 보기번호·수식 숫자는 들여쓰여 있다.
# 실측(200dpi, 쎈): 진짜 번호는 단 시작에서 +43~47px, 보기번호 '16','19' 는 +81px.
_MAX_LEFT_OFFSET = 0.5
# OCR 은 같은 번호라도 박스 높이가 들쭉날쭉해서 크기로 묶으면 한 체계가 쪼개진다.
_OCR_GROUP_SIZE = 12.0

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


# ══════════════════════════════════════════════════════════════════════
# 단 경계
# ══════════════════════════════════════════════════════════════════════

def _longest_run(col: np.ndarray) -> int:
    """불리언 1차원 배열에서 True 가 연속으로 이어지는 최대 길이."""
    best = run = 0
    for v in col:
        run = run + 1 if v else 0
        if run > best:
            best = run
    return best


def _vertical_furniture(mask: np.ndarray) -> np.ndarray:
    """세로로 길게 이어지는 줄인 x 열 마스크 — 단 사이 괘선, 쪽 옆 단원 색인 탭.

    글자는 아무리 붙여 써도 한 열이 쪽 높이의 10% 를 연속으로 채우지 못한다.
    판별을 '총합' 이 아니라 '연속' 으로 하는 이유: 세로로 쌓인 라벨 여러 개의 합이
    임계를 넘어 멀쩡한 글자 열까지 지워지는 것을 막기 위해서다.
    """
    limit = max(20, int(mask.shape[0] * _MAX_VERTICAL_RUN_RATIO))
    out = np.zeros(mask.shape[1], dtype=bool)
    for x in np.where(mask.sum(axis=0) > limit)[0]:
        out[x] = _longest_run(mask[:, x]) > limit
    return out


def _drop_vertical_furniture(mask: np.ndarray) -> np.ndarray:
    """세로로 길게 이어지는 색 줄을 마스크에서 지운다."""
    furniture = _vertical_furniture(mask)
    if not furniture.any():
        return mask
    out = mask.copy()
    out[:, furniture] = False
    return out


def _trim_edge_furniture(has_ink: np.ndarray, page_width: int) -> Optional[Tuple[int, int]]:
    """잉크가 있는 x 범위에서 양 끝의 '넓은 틈 너머 좁은 조각' 을 떼어낸다."""
    idx = np.where(has_ink)[0]
    if not idx.size:
        return None
    lo, hi = int(idx[0]), int(idx[-1])
    gap_limit = max(20, int(page_width * _EDGE_GAP_RATIO))
    frag_limit = (hi - lo + 1) * _EDGE_FRAGMENT_RATIO

    # 넓은 틈의 위치들
    gaps, run = [], 0
    for i in range(lo, hi + 2):
        if i <= hi and not has_ink[i]:
            run += 1
            continue
        if run >= gap_limit:
            gaps.append((i - run, i - 1))
        run = 0

    for g0, g1 in reversed(gaps):           # 오른쪽 끝 조각
        if hi - g1 <= frag_limit:
            hi = g0 - 1
            break
    for g0, g1 in gaps:                     # 왼쪽 끝 조각
        if g0 - lo <= frag_limit:
            lo = g1 + 1
            break
    return (lo, hi) if hi > lo else (int(idx[0]), int(idx[-1]))


def _find_gutter(gray: np.ndarray) -> Optional[int]:
    """잉크 세로 투영에서 가장 넓은 흰 띠(단 사이 거터)의 중앙 x. 없으면 None."""
    h, w = gray.shape[:2]
    ink = (gray < _INK_THRESHOLD).sum(axis=0)
    body = ink[int(w * 0.05):int(w * 0.95)]
    if body.size == 0 or body.max() == 0:
        return None
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
        return None
    return (best_start + best_end) // 2


def detect_columns(gray: np.ndarray) -> List[Tuple[int, int]]:
    """단을 나누고 각 단의 **실제 잉크 좌우 경계**를 돌려준다.

    옛 구현은 거터만 찾고 단의 좌우를 `w*0.03` / `w*0.97` 로 고정했는데, 펼침면 교재는
    쪽마다 여백이 좌우 반전돼 그 상수가 최대 47pt 씩 어긋난다. 그러면 왼쪽 띠 OCR 이
    번호를 반으로 잘라 한 단이 통째로 검출되지 않는다(짝수쪽 좌단 전멸의 원인).
    실제 잉크가 시작/끝나는 x 를 쓰면 판형·쪽에 상관없이 맞는다.
    """
    h, w = gray.shape[:2]
    gutter = _find_gutter(gray)
    spans = [(0, gutter), (gutter, w)] if gutter else [(0, w)]

    # 세로로 이만큼은 찍혀야 '단의 내용' 으로 본다 — 스캔 가장자리 얼룩 방어.
    min_rows = max(3, int(h * _COL_EDGE_INK_RATIO))
    out: List[Tuple[int, int]] = []
    for s, e in spans:
        ink = gray[:, s:e] < _INK_THRESHOLD
        # 단 사이 세로 괘선과 쪽 옆 색인 탭은 본문이 아니다 — 이걸 안 빼면 단 경계가
        # 거기까지 벌어져 크롭 가장자리에 선·탭 조각이 딸려 들어온다
        # (실측: 쎈 p2 우단이 279pt 에서 시작해 사용자 수정본 289pt 보다 넓었고,
        #  오른쪽은 주황 탭까지 물어 35pt 넓었다).
        body = ink & ~_vertical_furniture(ink)
        has = body.sum(axis=0) >= min_rows
        span = _trim_edge_furniture(has, w)
        if span is not None:
            out.append((s + span[0], s + span[1] + 1))
        else:
            out.append((s, e))
    return out


# ══════════════════════════════════════════════════════════════════════
# 색 라벨
# ══════════════════════════════════════════════════════════════════════

def _color_mask(rgb: np.ndarray) -> np.ndarray:
    """채도 높은 픽셀 마스크. 검정 본문·회색 괘선은 채도가 0 에 가까워 빠진다."""
    sub = rgb.astype(np.int16)
    r, g, b = sub[..., 0], sub[..., 1], sub[..., 2]
    mx = np.maximum(np.maximum(r, g), b)
    mn = np.minimum(np.minimum(r, g), b)
    sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1), 0)
    return (sat > _LABEL_SAT) & (mx > _LABEL_MIN_VALUE)


def _row_bands(mask: np.ndarray, min_px: int, gap: int) -> List[Tuple[int, int]]:
    """세로로 이어지는 행 덩어리를 (y0, y1) 목록으로."""
    rows = np.where(mask.sum(axis=1) >= min_px)[0]
    if not rows.size:
        return []
    bands, start, prev = [], rows[0], rows[0]
    for y in rows[1:]:
        if y - prev > gap:
            bands.append((int(start), int(prev)))
            start = y
        prev = y
    bands.append((int(start), int(prev)))
    return bands


def color_label_bands(rgb: np.ndarray, cx0: int, cx1: int) -> List[Tuple[int, int, int, int]]:
    """한 단에서 문제번호 라벨 띠를 찾는다. [(y0, y1, x_start, x_end)] (모두 픽셀).

    x_start 는 라벨의 **왼쪽 끝** — 이게 곧 그 단의 텍스트 시작이라 단 경계로 쓴다.
    x_end 는 오른쪽 끝 — 번호를 읽을 패치 폭으로 쓴다.
    """
    col_w = cx1 - cx0
    if col_w <= 0:
        return []
    win = cx0 + max(1, int(col_w * _LABEL_WINDOW))
    mask = _color_mask(rgb[:, cx0:win])

    out: List[Tuple[int, int, int]] = []
    for y0, y1 in _row_bands(mask, _LABEL_ROW_MIN_PX, _LABEL_ROW_GAP):
        height = y1 - y0 + 1
        if not (_LABEL_H_MIN <= height <= _LABEL_H_MAX):
            continue
        xs = np.where(mask[y0:y1 + 1].any(axis=0))[0]
        if not xs.size or xs.min() / col_w > _LABEL_LEFT_MAX:
            continue
        out.append((y0, y1, cx0 + int(xs.min()), cx0 + int(xs.max()) + 1))
    return out


def section_header_bands(rgb: np.ndarray, cx0: int, cx1: int,
                         labels: Sequence[Tuple[int, ...]]) -> List[int]:
    """섹션(유형) 헤더 띠의 y0 목록 — 문제 영역의 아래 경계로 쓴다.

    헤더는 단 폭의 대부분을 차지하는 색 띠다. 다만 **번호 라벨과 y 가 겹치면 헤더가 아니다** —
    C단계는 번호 오른쪽에 "30쪽 유형 06" 상호참조가 우측정렬로 붙어 있어 그 행 전체가
    단 폭을 채운다(실측: p14 의 0256·0257·0258 이 전부 헤더로 오인됐다).
    """
    col_w = cx1 - cx0
    if col_w <= 0:
        return []
    mask = _drop_vertical_furniture(_color_mask(rgb[:, cx0:cx1]))
    label_spans = [(b[0], b[1]) for b in labels]

    out: List[int] = []
    for y0, y1 in _row_bands(mask, _LABEL_ROW_MIN_PX, _LABEL_ROW_GAP):
        height = y1 - y0 + 1
        if not (_HEADER_H_MIN <= height <= _HEADER_H_MAX):
            continue
        xs = np.where(mask[y0:y1 + 1].any(axis=0))[0]
        if not xs.size:
            continue
        if xs.min() / col_w > _HEADER_LEFT_MAX:
            continue
        if (xs.max() - xs.min() + 1) / col_w < _HEADER_MIN_WIDTH_RATIO:
            continue
        if any(y0 <= ly1 + _HEADER_LABEL_TOLERANCE and ly0 <= y1 + _HEADER_LABEL_TOLERANCE
               for ly0, ly1 in label_spans):
            continue          # 번호 행이지 헤더가 아니다
        out.append(y0)
    return out


def column_ink_bottom(gray: np.ndarray, cx0: int, cx1: int) -> Optional[int]:
    """이 단의 본문이 끝나는 y(픽셀). 쪽 꼬리말은 제외한다."""
    h = gray.shape[0]
    limit = int(h * _CONTENT_BOTTOM_LIMIT)
    sub = gray[:limit, cx0:cx1] < _INK_THRESHOLD
    if sub.size == 0:
        return None
    # 0.5% 는 얼룩 몇 픽셀도 통과시킨다(실측: p1 좌단의 1px 자국 때문에 크롭이 25pt
    # 늘어났다). 짧은 마지막 글줄("구하시오.")도 이보다는 훨씬 길다.
    min_px = max(5, int((cx1 - cx0) * 0.015))
    rows = np.where(sub.sum(axis=1) >= min_px)[0]
    return int(rows[-1]) if rows.size else None


def _read_patch(reader, rgb: np.ndarray, y0: int, y1: int,
                x0: int, x1: int) -> Tuple[str, float]:
    """라벨 패치 하나를 확대해 숫자만 읽는다. (텍스트, 신뢰도)."""
    patch = rgb[max(0, y0 - _LABEL_PATCH_PAD):y1 + 1 + _LABEL_PATCH_PAD, x0:x1]
    if patch.size == 0:
        return "", 0.0
    k = _LABEL_UPSCALE
    patch = np.kron(patch, np.ones((k, k, 1), dtype=np.uint8))
    try:
        results = reader.readtext(patch, allowlist="0123456789", **_OCR_KWARGS)
    except Exception as e:      # noqa: BLE001 — 패치 하나 실패로 전체를 멈추지 않는다
        logger.debug("[ocr] 라벨 패치 읽기 실패: %s", e)
        return "", 0.0
    if not results:
        return "", 0.0
    _, text, conf = max(results, key=lambda r: r[2])
    return text.strip(), float(conf)


def collect_color_labels(page_index: int, rgb: np.ndarray,
                         pdf_width: float, pdf_height: float):
    """한 페이지의 색 라벨(문제번호)과 섹션 헤더를 뽑는다.

    Returns:
        (labels, header_cuts) — 좌표는 PDF 포인트.
        labels 항목: {page, col, y, x, col_x0, col_x1, text, conf}
        header_cuts 항목: {page, col, y}
    """
    gray = np.dot(rgb[..., :3], [0.299, 0.587, 0.114]).astype(np.uint8)
    h, w = gray.shape[:2]
    sx, sy = pdf_width / w, pdf_height / h
    reader = _get_reader()

    # 1단계: 단마다 라벨 띠를 찾고, **라벨 위치에서** 단의 왼쪽 경계를 만든다.
    # 잉크 투영으로 잡으면 단 사이 세로 괘선·쪽 옆 색인 탭이 경계를 밀어내는데,
    # 문제번호는 정의상 그 단 텍스트의 왼쪽 끝이라 장식에 흔들리지 않는다
    # (실측: 교사 검수 경계와 34개 단 전부 +4~+25px 일치).
    cols: List[dict] = []
    for ci, (cx0, cx1) in enumerate(detect_columns(gray)):
        bands = color_label_bands(rgb, cx0, cx1)
        bottom_px = column_ink_bottom(gray, cx0, cx1)
        lefts = [b[2] for b in bands]
        cols.append({
            "ci": ci, "cx0": cx0, "cx1": cx1, "bands": bands,
            "x0": (min(lefts) * sx - _LABEL_LEFT_MARGIN) if lefts else cx0 * sx,
            "x1": cx1 * sx,
            "y1": (bottom_px + 4) * sy if bottom_px is not None else None,
        })

    # 2단계: 앞 단의 오른쪽 경계는 다음 단 경계 바로 앞에서 끊는다 — 그 사이에 괘선이 산다.
    for i, c in enumerate(cols[:-1]):
        c["x1"] = min(c["x1"], cols[i + 1]["x0"] - _COLUMN_CLEARANCE)

    labels: List[dict] = []
    cuts: List[dict] = []
    for c in cols:
        for y0, y1, _x_start, x_end in c["bands"]:
            text, conf = _read_patch(reader, rgb, y0, y1, c["cx0"], x_end)
            labels.append({
                "page": page_index, "col": c["ci"],
                "y": y0 * sy, "x": c["x0"],
                "col_x0": c["x0"], "col_x1": c["x1"],
                "col_y1": c["y1"],
                "text": text, "conf": conf,
            })
        for y0 in section_header_bands(rgb, c["cx0"], c["cx1"], c["bands"]):
            cuts.append({"page": page_index, "col": c["ci"], "y": y0 * sy})
    return labels, cuts


# ══════════════════════════════════════════════════════════════════════
# 번호 해석 — 형식 학습 + 증가 검증 + 빈 자리 규칙
# ══════════════════════════════════════════════════════════════════════

def _learn_number_format(labels: Sequence[dict]) -> Optional[Tuple[int, bool]]:
    """읽힌 라벨들에서 이 교재의 번호 형식 (자릿수, 선행0 여부) 을 학습한다.

    번호 체계는 문서 안에서 균일하다("0159, 0160, …"). 그 형식을 알면
    OCR 이 배지 글자와 섞어 뱉은 '10162'·'0159411' 에서도 '0162'·'0159' 를 집어낼 수 있다.
    """
    votes: Counter = Counter()
    for lb in labels:
        for m in re.finditer(r"\d+", lb["text"]):
            tok = m.group()
            if len(tok) < 2:
                continue
            votes[(len(tok), tok[0] == "0")] += 1
    if not votes:
        return None
    (digits, zero_pad), count = votes.most_common(1)[0]
    if count < 3:
        return None
    return digits, zero_pad


def _extract_number(text: str, fmt: Tuple[int, bool]) -> Optional[str]:
    """학습한 형식에 맞는 부분문자열을 뽑는다. 없으면 None."""
    digits, zero_pad = fmt
    pattern = (r"0\d{%d}" % (digits - 1)) if zero_pad else (r"\d{%d}" % digits)
    m = re.search(pattern, text)
    return m.group() if m else None


def _attach_to_next(ordered: List[dict], i: int) -> None:
    """번호를 못 읽어 버리는 라벨을, 바로 아래 같은 단 문제의 '시작' 으로 넘겨준다."""
    src = ordered[i]
    for j in range(i + 1, len(ordered)):
        nxt = ordered[j]
        if nxt["page"] != src["page"] or nxt["col"] != src["col"]:
            return          # 단이 바뀌면 이 라벨 아래엔 문제가 없다
        if nxt["number"] is None:
            continue
        if nxt["y"] - src["y"] <= _LABEL_MERGE_GAP:
            nxt["y"] = src["y"]
        return


def resolve_label_anchors(labels: List[dict]) -> List[dict]:
    """색 라벨을 앵커 span 으로 확정한다 (읽기 순서: 쪽 → 단 → y).

    ① 형식을 학습해 번호를 뽑고 ② 증가부분열로 오독을 떨어내고
    ③ 번호를 못 읽은 라벨(대표문제 배지 등)은 **앞뒤 번호 사이에 빈 자리가 있을 때만** 채택한다.
    실측(쎈 17쪽): 진짜 배지 19개 전부 통과, 오검출 2개 전부 탈락 → 120/120.

    ④ 그렇게 **탈락시킨 라벨도 그냥 버리지 않는다.** 바로 아래에 문제가 붙어 있으면
       그 문제의 시작을 라벨 위치로 끌어올린다. ☆사고의 기술 배지처럼 번호 위에 얹힌
       표식이 여기 해당한다 — 안 그러면 그 배지가 **앞 문제의 크롭에 딸려 들어가서**
       앞 문제가 세 배로 길어진다(실측: 0276 이 82pt → 233pt). 교사도 배지를
       다음 문제 쪽에 포함시켰다(0277 위변 291→280pt).
    """
    if len(labels) < _LABEL_MIN_TOTAL:
        return []
    ordered = sorted(labels, key=lambda a: (a["page"], a["col"], a["y"]))

    fmt = _learn_number_format(ordered)
    if fmt is None:
        logger.info("[label] 번호 형식을 학습하지 못함 — 색 라벨 경로 포기")
        return []

    for lb in ordered:
        lb["number"] = _extract_number(lb["text"], fmt)

    # 오독 방어: 번호가 붙은 라벨만 모아 증가부분열을 남긴다.
    numbered = [lb for lb in ordered if lb["number"] is not None]
    for lb in numbered:
        lb["num"] = (int(lb["number"]), 0)
    kept = _longest_increasing(numbered)
    kept_ids = {id(lb) for lb in kept}
    dropped = len(numbered) - len(kept_ids)
    for lb in numbered:
        if id(lb) not in kept_ids:
            lb["number"] = None

    out: List[dict] = []
    for i, lb in enumerate(ordered):
        if lb["number"] is None:
            prv = next((ordered[j]["number"] for j in range(i - 1, -1, -1)
                        if ordered[j]["number"]), None)
            nxt = next((ordered[j]["number"] for j in range(i + 1, len(ordered))
                        if ordered[j]["number"]), None)
            # 문서 처음·끝은 비교 대상이 없으니 인정한다. 가운데는 빈 번호가 있어야 인정.
            if prv is not None and nxt is not None and int(nxt) - int(prv) <= 1:
                _attach_to_next(ordered, i)
                continue
            text, num = "", (0, 0)
        else:
            text, num = lb["number"], (int(lb["number"]), 0)
        out.append({
            "page": lb["page"], "col": lb["col"], "text": text, "num": num,
            "x": lb["x"], "y": lb["y"], "size": _OCR_GROUP_SIZE, "font": "ocr",
            "col_x0": lb["col_x0"], "col_x1": lb["col_x1"],
            "col_y1": lb.get("col_y1"),
        })

    logger.info(
        "[label] 색 라벨 %d개 → 앵커 %d개 (번호 판독 %d / 배지·미판독 %d / 증가위반 탈락 %d)",
        len(ordered), len(out), sum(1 for a in out if a["text"]),
        sum(1 for a in out if not a["text"]), dropped,
    )
    return out


# ══════════════════════════════════════════════════════════════════════
# 크롭 여백 정리
# ══════════════════════════════════════════════════════════════════════

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


# ══════════════════════════════════════════════════════════════════════
# 폴백 — 옛 스트립 OCR (색이 전혀 없는 흑백 스캔용)
# ══════════════════════════════════════════════════════════════════════

def ocr_number_spans(
    page_index: int,
    rgb: np.ndarray,
    pdf_width: float,
    pdf_height: float,
    strip_ratio: float = _STRIP_RATIO,
    min_conf: float = _MIN_CONF,
) -> List[dict]:
    """단 왼쪽 띠를 통째로 OCR 해 번호 span 을 뽑는다 (좌표는 PDF 포인트).

    색 라벨이 없는 흑백 스캔용 폴백. 단 경계는 개선된 `detect_columns` 를 쓰므로
    펼침면 여백 반전에는 이 경로도 대응된다.
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
