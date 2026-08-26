"""문제번호 앵커로 문제 영역을 나눈다 (디지털 PDF 전용).

왜 이게 필요한가:
  YOLO 는 모의고사 판형으로만 학습돼 다른 교재에서 심하게 과검출한다
  (실측 300dpi: 교육청 23문항에 100박스, 내신 21문항에 26박스).
  그런데 이 교재들은 대부분 디지털 PDF 라 **문제번호의 정확한 좌표가 텍스트에 이미 있다**.
  추론할 필요 없이 읽으면 된다.

핵심 발상 — 퍼블리셔별 설정을 손으로 만들지 않는다:
  "같은 폰트·크기로, 단의 왼쪽 가장자리에서, 번호가 증가하며 반복되는 span 군집"
  을 찾으면 문서가 자기 번호 체계를 스스로 드러낸다.
  실측: 내신 "N." x∈{41,366} 21개 / 교육청 "N." x∈{55,379} 23개
  — x 값이 곧 단 경계라 단 분리까지 공짜로 나온다.
"""
import logging
import re
from collections import defaultdict
from typing import Dict, List, Optional, Tuple

import fitz  # PyMuPDF

logger = logging.getLogger(__name__)

# 문제번호로 볼 수 있는 표기들. 캡처그룹 1 = 정렬에 쓸 번호.
_NUM_PATTERNS = [
    re.compile(r"^(\d{1,3})\.$"),        # "1."   내신·교육청
    re.compile(r"^(\d{1,3})\)$"),        # "1)"
    re.compile(r"^(\d{2})-(\d)$"),       # "01-2" 수능특강 유제
    re.compile(r"^(\d{4})$"),            # "0114" 바이블 연습문제
    re.compile(r"^(\d{1,3})$"),          # "1"    맨 숫자(가장 약한 근거)
]

_X_TOLERANCE = 12.0       # 같은 단으로 볼 x 오차(pt)
_X_TOLERANCE_OCR = 30.0   # OCR 좌표는 더 흔들려서 넉넉히 본다
# 증가부분열로 살아남아야 하는 최소 비율. 텍스트 레이어는 좌표·글꼴이 정확해 후보가
# 이미 깨끗하므로 엄격하게 본다(느슨하게 두면 쪽 머리말 숫자까지 통과했다).
# OCR 은 수식 숫자가 대량으로 섞여 들어오므로 같은 잣대를 쓸 수 없다.
_MIN_SURVIVAL = 0.70
_MIN_SURVIVAL_OCR = 0.20

# 번호가 서로 다른 높이에 있어야 하는 최소 비율 (가로로 나란한 숫자 행 배제).
# 0.6 은 쓸 수 없다 — 교육청은 2단 좌우 문제의 y 가 정확히 정렬돼 있어(둘 다 y=148)
# 정상인데도 비율이 0.55 까지 떨어진다. 여백 기준(아래 _MARGIN_BOTTOM)이 주 방어선이다.
_MIN_DISTINCT_ROWS = 0.5
_MIN_ANCHORS = 3      # 이보다 적으면 패턴이라 보기 어렵다
_MAX_COLUMNS = 4      # x 군집이 이보다 많으면 본문 잡음

# 머리말/꼬리말 여백. 쪽번호가 여기 살기 때문에 앵커 후보에서 뺀다.
# 임계값은 감이 아니라 실측으로 잡았다 —
#   교육청 쪽번호 y = 4.5~4.8% / 내신 문제번호 최솟값 y = 8.2%(단 최상단 문제)
# 그래서 6%. 10% 로 잡았더니 내신 21개 중 5개(각 단 맨 위 문제)가 같이 잘렸다.
_MARGIN_TOP = 0.06
# 아래쪽은 0.85. 문제번호가 페이지 85% 아래에 있으면 그 아래에 문제가 들어갈 자리가 없다.
# 실측 — 진짜 문제번호의 최대 y: 내신 64.8% / 교육청 21% / 수능특강 65% / 바이블 63%.
# 반면 잡음은 그 아래 산다: 바이블 쪽번호 92.5%, 바이블 숫자행 88.7%.
# (0.94 로 뒀을 때 쪽번호 "020"이 주 앵커 그룹으로 뽑혀 6개가 10개로 부풀었다.)
_MARGIN_BOTTOM = 0.85

# 최고점 대비 이 비율을 넘는 번호체계는 보조로 함께 채택한다(예제 + 유제 동시 수집).
_SECONDARY_SCORE_RATIO = 0.35

# 사람이 읽을 수 없는 크기의 글자는 문제번호가 아니다.
# 실측: 내신·교육청(HWP 변환본)에 size 0.7pt 짜리 "1)" 숨은 텍스트 레이어가 깔려 있어
# 문제마다 앵커가 하나씩 더 잡혔다(21→42, 23→46). 이 필터로 걸러진다.
_MIN_FONT_SIZE = 5.0

# 보조 체계를 병합할 때, 이미 채택된 앵커와 같은 자리(같은 쪽·비슷한 y)면 중복으로 본다.
_DUP_Y_TOLERANCE = 6.0


def _parse_number(text: str) -> Optional[Tuple[int, int]]:
    """앵커 표기에서 정렬용 번호를 뽑는다. (주번호, 부번호) 또는 None."""
    for pat in _NUM_PATTERNS:
        m = pat.match(text)
        if m:
            g = m.groups()
            main = int(g[0])
            sub = int(g[1]) if len(g) > 1 and g[1] is not None else 0
            return main, sub
    return None


def _cluster_x(values: List[float], tol: float = _X_TOLERANCE) -> List[float]:
    """x 값들을 tol 이내로 묶어 각 군집의 대표값(최솟값)을 돌려준다."""
    if not values:
        return []
    out, cur = [], [sorted(values)[0]]
    for v in sorted(values)[1:]:
        if v - cur[-1] <= tol:
            cur.append(v)
        else:
            out.append(min(cur))
            cur = [v]
    out.append(min(cur))
    return out


def make_span(page: int, text: str, x: float, y: float,
              size: float, font: str = "") -> Optional[dict]:
    """번호 후보 span 을 만든다. 번호로 안 읽히면 None.

    텍스트 레이어 경로와 OCR 경로가 같은 모양의 span 을 만들어 쓰기 위한 공용 생성자다.
    """
    parsed = _parse_number(text.strip())
    if parsed is None:
        return None
    return {"page": page, "text": text.strip(), "num": parsed,
            "x": x, "y": y, "size": size, "font": font}


def spans_from_doc(doc: fitz.Document) -> List[dict]:
    """텍스트 레이어에서 번호 후보 span 을 뽑는다 (디지털 PDF)."""
    out: List[dict] = []
    for pno in range(doc.page_count):
        page = doc[pno]
        top = page.rect.height * _MARGIN_TOP
        bottom = page.rect.height * _MARGIN_BOTTOM
        for blk in page.get_text("dict")["blocks"]:
            for ln in blk.get("lines", []):
                for sp in ln.get("spans", []):
                    text = sp["text"].strip()
                    if not text or len(text) > 6:
                        continue
                    if not (top <= sp["bbox"][1] <= bottom):
                        continue  # 머리말/꼬리말의 쪽번호
                    if sp["size"] < _MIN_FONT_SIZE:
                        continue  # 숨은 텍스트 레이어
                    span = make_span(pno, text, sp["bbox"][0], sp["bbox"][1],
                                     round(sp["size"], 1), sp.get("font", ""))
                    if span:
                        out.append(span)
    return out


def _group_spans(spans: List[dict]) -> Dict[Tuple[str, float], List[dict]]:
    """(폰트, 크기)별로 묶는다 — 같은 번호 체계는 같은 글꼴·크기를 쓴다."""
    groups: Dict[Tuple[str, float], List[dict]] = defaultdict(list)
    for sp in spans:
        groups[(sp.get("font", ""), sp["size"])].append(sp)
    return groups


def _longest_increasing(items: List[dict]) -> List[dict]:
    """읽기 순서에서 번호가 증가하는 최장 부분열만 남긴다.

    문제번호는 반드시 증가하지만 잡음은 그렇지 않다는 성질을 쓴다.
    OCR 경로에서 특히 중요하다 — 수식의 숫자('434','224' 등)가 번호와
    같은 크기·비슷한 x 로 섞여 들어오는데, 이 필터가 그것들을 떨어뜨린다.
    """
    n = len(items)
    if n == 0:
        return []
    best = [1] * n
    prev = [-1] * n
    for i in range(n):
        for j in range(i):
            if items[j]["num"] < items[i]["num"] and best[j] + 1 > best[i]:
                best[i] = best[j] + 1
                prev[i] = j
    k = max(range(n), key=lambda i: best[i])
    out: List[dict] = []
    while k != -1:
        out.append(items[k])
        k = prev[k]
    return out[::-1]


def _score_group(items: List[dict], page_width: float) -> Tuple[float, List[float], List[dict]]:
    """앵커 군집으로서의 점수·단 x경계·정제된 앵커를 돌려준다. 점수 0 이면 탈락."""
    if len(items) < _MIN_ANCHORS:
        return 0.0, [], []

    # 쪽번호 2차 방어: 여백 필터를 통과했더라도, 쪽마다 딱 하나씩 있으면서
    # 번호가 쪽 순번과 맞아떨어지면 그건 문제번호가 아니라 쪽번호다.
    pages = {it["page"] for it in items}
    if len(items) == len(pages):
        page_matches = sum(1 for it in items if it["num"][0] == it["page"] + 1)
        if page_matches / len(items) >= 0.8:
            return 0.0, [], []

    # OCR 좌표는 텍스트 레이어보다 흔들려서 같은 단인데도 x 가 더 벌어진다.
    tol = _X_TOLERANCE_OCR if items[0].get("font") == "ocr" else _X_TOLERANCE
    cols = _cluster_x([it["x"] for it in items], tol)
    if not cols or len(cols) > _MAX_COLUMNS:
        return 0.0, [], []

    # 읽기 순서(페이지 → 단 → y)로 정렬했을 때 번호가 증가해야 진짜 번호다.
    def col_index(x: float) -> int:
        return min(range(len(cols)), key=lambda i: abs(cols[i] - x))

    ordered = sorted(items, key=lambda it: (it["page"], col_index(it["x"]), it["y"]))
    # 증가 판정은 **페이지 단위**로 한다. 쪽마다 번호를 1부터 다시 매기는 교재가 있어
    # (실측: 바이블은 쪽마다 1,2,3) 문서 전체로 보면 멀쩡한 번호가 잘려나간다.
    kept: List[dict] = []
    for pno in sorted({it["page"] for it in ordered}):
        kept.extend(_longest_increasing([it for it in ordered if it["page"] == pno]))
    if len(kept) < _MIN_ANCHORS:
        return 0.0, [], []

    # 살아남은 비율이 너무 낮으면 애초에 번호 체계가 아니라 본문 숫자 더미다.
    is_ocr = items[0].get("font") == "ocr"
    survival = len(kept) / len(ordered)
    if survival < (_MIN_SURVIVAL_OCR if is_ocr else _MIN_SURVIVAL):
        return 0.0, [], []

    # 문제는 세로로 쌓인다. 번호들이 죄다 같은 높이에 가로로 늘어서 있으면
    # 그건 문제 목록이 아니라 표·보기 한 줄이다
    # (실측: 바이블에서 y=614 에 나란한 '1 2 3' 이 문제로 잡혀 6개가 10개로 부풀었다).
    distinct_rows = len({(it["page"], round(it["y"] / 10)) for it in kept})
    if distinct_rows < len(kept) * _MIN_DISTINCT_ROWS:
        return 0.0, [], []

    # 잡음을 떨어낸 뒤의 x 로 단을 다시 잡는다.
    cols = _cluster_x([it["x"] for it in kept], tol)
    if not cols or len(cols) > _MAX_COLUMNS:
        return 0.0, [], []

    # 단의 왼쪽 가장자리에 붙어 있을수록 가산.
    left_bias = 1.0 - (min(cols) / page_width)
    return len(kept) * (0.5 + left_bias), cols, kept


def find_anchors(doc: fitz.Document) -> Optional[dict]:
    """문서에서 문제번호 앵커 체계를 찾아낸다.

    Returns:
        {"font","size","columns":[x...], "anchors":[{page,num,x,y,text}...]} 또는 None
    """
    return find_anchors_from_spans(spans_from_doc(doc), doc[0].rect.width)


def find_anchors_from_spans(spans: List[dict], page_width: float) -> Optional[dict]:
    """span 목록에서 문제번호 앵커 체계를 골라낸다.

    span 이 텍스트 레이어에서 왔든 OCR 에서 왔든 이 함수는 똑같이 동작한다 —
    스캔본(쎈)도 OCR 로 span 만 만들어 주면 같은 알고리즘을 그대로 탄다.
    """
    scored = []
    for (font, size), items in _group_spans(spans).items():
        score, cols, kept = _score_group(items, page_width)
        if score > 0:
            scored.append({"score": score, "font": font, "size": size,
                           "columns": cols, "anchors": kept})

    if not scored:
        logger.info("[anchor] 앵커 후보 없음")
        return None

    scored.sort(key=lambda g: -g["score"])
    best = scored[0]

    # 한 교재가 번호 체계를 여러 개 쓰는 경우가 있다 — 수능특강은 '예제'와 '유제'가
    # 서로 다른 폰트/크기로 매겨진다. 사용자가 "예제든 유제든 연습문제든 다" 를 원하므로
    # 최고점의 일정 비율을 넘는 체계는 같이 채택한다.
    merged = list(best["anchors"])
    extra_cols = list(best["columns"])
    def is_duplicate(a: dict) -> bool:
        """같은 쪽 거의 같은 y 에 이미 앵커가 있으면 같은 문제를 가리키는 중복이다."""
        return any(m["page"] == a["page"] and abs(m["y"] - a["y"]) <= _DUP_Y_TOLERANCE
                   for m in merged)

    for g in scored[1:]:
        if g["score"] < best["score"] * _SECONDARY_SCORE_RATIO:
            continue
        fresh = [a for a in g["anchors"] if not is_duplicate(a)]
        if not fresh:
            continue
        merged.extend(fresh)
        extra_cols.extend(g["columns"])
        logger.info("[anchor] 보조 번호체계 채택 — font=%s size=%.1f 앵커 %d개",
                    g["font"], g["size"], len(fresh))

    columns = _cluster_x(extra_cols)
    result = {"font": best["font"], "size": best["size"],
              "columns": columns, "anchors": merged}

    logger.info(
        "[anchor] 앵커 체계 발견 — 주 font=%s size=%.1f / 단 %d개(x=%s) / 앵커 총 %d개",
        best["font"], best["size"], len(columns),
        [round(c) for c in columns], len(merged),
    )
    return result


def _column_of(x: float, columns: List[float]) -> int:
    return min(range(len(columns)), key=lambda i: abs(columns[i] - x))


# 쪽 높이의 이 비율을 넘는 이미지는 한 문제의 그림일 수 없다 — 배경 래스터/전면 스캔이다.
# 실측: 스캔본(쎈)은 쪽마다 595x842pt 전면 이미지가 깔려 있어 이걸 내용으로 세면
# 크롭이 단 전체로 부풀고 x0=-4, x1=597(쪽 밖)까지 나갔다.
# 디지털 PDF 4종에는 이런 이미지가 하나도 없다(수능특강 0/11, 바이블 0/184, 교육청 0/28).
_MAX_FIGURE_HEIGHT_RATIO = 0.5


def _has_vector_content(page: fitz.Page) -> bool:
    """이 쪽에 좌표를 믿을 수 있는 텍스트·도형이 있는가.

    `_content_rect` 는 벡터 좌표로 크롭을 조이는 도구다. 스캔본은 그게 하나도 없어
    우연히 걸린 장식 이미지 하나가 크롭을 통째로 지배해 버린다
    (실측: 쎈 0171 이 15pt×52pt 조각으로 붕괴). 그런 쪽은 조이지 말고
    호출부의 `tighten_by_ink`(실제 잉크 기준)에 맡긴다.
    """
    if page.get_text().strip():
        return True
    try:
        return bool(page.get_drawings())
    except Exception:       # noqa: BLE001 — 도형 파싱 실패는 '없음' 으로 본다
        return False


def _content_rect(page: fitz.Page, region: fitz.Rect, bounds: fitz.Rect) -> Optional[fitz.Rect]:
    """region 안의 실제 내용(텍스트·도형·이미지)만 감싸는 사각형.

    앵커 사이를 그냥 자르면 문제가 짧을 때 빈 공간이 잔뜩 남는다
    (실측: 교육청 고난도는 한 단에 문제 1개뿐이라 크롭의 80%가 여백이었다).
    반대로 가로는 번호 배지나 그림이 단 경계 밖으로 나가기도 해서
    bounds(그 단에 허용된 범위) 안에서는 **넓어지는 것도 허용**한다.

    이웃 문제를 빨아들이지 않도록, 세로 중심이 region 안에 있는 요소만 센다.
    """
    parts: List[fitz.Rect] = []

    def consider(r: fitz.Rect, contained: bool = False) -> None:
        """contained=True 면 세로로 영역 안에 '완전히' 들어와야 센다."""
        if r.is_empty or r.is_infinite:
            return
        if contained:
            if not (region.y0 - 2 <= r.y0 and r.y1 <= region.y1 + 2):
                return
        else:
            cy = (r.y0 + r.y1) / 2
            if not (region.y0 <= cy <= region.y1):
                return
        clipped = r & bounds
        if not clipped.is_empty:
            parts.append(clipped)

    for blk in page.get_text("dict")["blocks"]:
        for ln in blk.get("lines", []):
            consider(fitz.Rect(ln["bbox"]))
    try:
        # 도형은 완전 포함만 인정한다. 단 경계 괘선이 페이지를 세로로 가로질러서,
        # 중심만 보면 그게 영역에 걸려 크롭을 페이지 바닥까지 늘려버린다
        # (실측: 교육청 1pt×774pt 세로선 때문에 크롭 높이가 730pt, 실내용은 220pt).
        # 문제 안의 조건박스 테두리는 완전히 들어오므로 그대로 살아남는다.
        for dr in page.get_drawings():
            consider(fitz.Rect(dr["rect"]), contained=True)
    except Exception:  # 일부 PDF 는 도형 파싱이 실패한다 — 텍스트만으로 진행
        pass
    max_fig_h = page.rect.height * _MAX_FIGURE_HEIGHT_RATIO
    for im in page.get_image_info():
        r = fitz.Rect(im["bbox"])
        if r.height > max_fig_h:
            continue      # 배경 래스터 — 문제의 그림이 아니다
        consider(r)

    if not parts:
        return None
    out = parts[0]
    for r in parts[1:]:
        out |= r
    return out


def segment_problems(
    doc: fitz.Document,
    anchors: dict,
    x_pad: float = 8.0,
    y_pad: float = 8.0,
    bottom_ratio: float = _MARGIN_BOTTOM,
) -> List[dict]:
    """앵커 사이를 잘라 문제 영역을 만든다.

    한 문제 = 자기 앵커 y 부터 **같은 단의 다음 앵커 y** 까지(없으면 단 하단까지).
    가로는 그 단의 x 범위.

    앵커가 `col_x0`/`col_x1`(그 쪽 그 단의 실제 x 범위)을 들고 오면 그것을 우선한다 —
    펼침면 교재는 쪽마다 좌우 여백이 반전돼 문서 전체를 하나의 단 모델로 자를 수 없다
    (실측: 쎈 짝수쪽 좌단 65pt / 홀수쪽 28pt). 안 들고 오면 기존 전역 `columns` 를 쓰므로
    디지털 PDF 의 동작은 그대로다.

    `anchors["cuts"]`(섹션 헤더 y 목록)이 있으면 그 위에서도 영역을 끊는다 — 안 그러면
    유형 헤더가 바로 앞 문제의 크롭에 딸려 들어간다(사용자가 손으로 잘라낸 부분).

    Returns:
        [{"number","page","rect":fitz.Rect,"anchor_text"}...] — 읽기 순서(좌단 위→아래, 우단 위→아래)
    """
    cols = anchors["columns"]
    page_w = doc[0].rect.width
    # 각 단의 오른쪽 경계 = 다음 단의 시작(마지막 단은 페이지 끝)
    col_right = [(cols[i + 1] if i + 1 < len(cols) else page_w) for i in range(len(cols))]

    cuts: Dict[Tuple[int, int], List[float]] = defaultdict(list)
    for c in anchors.get("cuts", []):
        cuts[(c["page"], c["col"])].append(c["y"])

    buckets: Dict[Tuple[int, int], List[dict]] = defaultdict(list)
    for a in anchors["anchors"]:
        # 앵커가 자기 단 번호를 알고 있으면(색 라벨 경로) 그것을 쓴다.
        ci = a.get("col")
        buckets[(a["page"], ci if ci is not None else _column_of(a["x"], cols))].append(a)

    regions: List[dict] = []
    for (pno, ci), items in buckets.items():
        page = doc[pno]
        page_h = page.rect.height
        tighten = _has_vector_content(page)
        col_bottom = page_h * bottom_ratio
        # 이 단에 허용된 가로 범위 — 앞 단 끝 ~ 이 단 끝. 번호 배지·그림이
        # 단 왼쪽 밖으로 삐져나오는 판형(바이블)이 있어 여유를 준다.
        measured = [a for a in items if a.get("col_x0") is not None]
        # 단의 본문 하단을 실측해서 온 경우 그것을 쓴다 — 기본값(_MARGIN_BOTTOM)은
        # '이 아래 숫자는 문제번호가 아니다' 를 위한 값이라 본문 하단보다 짧아서,
        # 각 단의 마지막 문제가 잘린다.
        bottoms = [a["col_y1"] for a in items if a.get("col_y1") is not None]
        if bottoms:
            col_bottom = min(page_h, max(bottoms))
        if measured:
            # 이 쪽 이 단의 실측 범위 — 문제번호 라벨에서 나온 값이라 이미 여백이 들어 있다.
            # 여기에 x_pad 를 더 벌리면 안 된다: 8pt 를 더 나가면 단 사이 세로 괘선이
            # 다시 범위 안에 들어와 `tighten_by_ink` 가 거기에 고정된다(실측 p9 #64).
            left_bound = max(0.0, min(a["col_x0"] for a in measured))
            right_bound = min(page_w, max(a["col_x1"] for a in measured))
            rect_x0 = left_bound
        else:
            left_bound = col_right[ci - 1] if ci > 0 else 0.0
            right_bound = min(page_w, col_right[ci] - 2)
            rect_x0 = max(left_bound, (cols[ci] if ci < len(cols) else left_bound) - x_pad)
        bounds = fitz.Rect(left_bound, 0, right_bound, page_h)
        headers = sorted(cuts.get((pno, ci), []))

        items.sort(key=lambda a: a["y"])
        for j, a in enumerate(items):
            y0 = max(0.0, a["y"] - y_pad)
            y1 = (items[j + 1]["y"] - y_pad) if j + 1 < len(items) else col_bottom
            # 이 문제와 다음 앵커 사이에 섹션 헤더가 있으면 거기서 끊는다.
            nxt_header = next((h for h in headers if h > a["y"] + y_pad), None)
            if nxt_header is not None and nxt_header < y1:
                y1 = nxt_header - y_pad
            if y1 - y0 < 20:      # 너무 얇으면 문제가 아니다
                continue
            rect = fitz.Rect(rect_x0, y0, bounds.x1, y1)
            tight = _content_rect(page, rect, bounds) if tighten else None
            if tight is not None:
                rect = fitz.Rect(tight.x0 - 4, max(y0, tight.y0 - 4),
                                 tight.x1 + 4, min(y1, tight.y1 + 6))
            regions.append({
                "page": pno,
                "column": ci,
                "anchor_text": a["text"],
                "anchor_y": a["y"],
                "rect": rect,
            })

    regions.sort(key=lambda r: (r["page"], r["column"], r["anchor_y"]))
    for i, r in enumerate(regions, start=1):
        r["number"] = i
    return regions
