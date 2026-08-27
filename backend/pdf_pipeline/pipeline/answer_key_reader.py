"""빠른정답 PDF 를 읽어 (지면번호 → 정답) 표로 만든다.

왜 VL 인가:
  교재 빠른정답은 **텍스트 레이어가 없는 스캔본**이다(실측: 쎈 공통수학1 빠른정답 6쪽 전부
  0자). 그래서 `solution_parser.extract_quick_answers`(PyMuPDF 텍스트 + "N. [정답] X" 형식)
  로는 한 글자도 못 읽는다. 지면에는 또렷이 인쇄돼 있으므로 VL 로 읽는다.

  실측(200dpi, 단 하나): 27초에 164개(0115~0278)를 정확히 읽었다 — 원문자(③)·LaTeX
  (\\frac{13}{15}, 16\\sqrt{15})·소문항((1)…(2)…)·한글(정삼각형)·여러 값(31, 35, 43) 전부 보존.

왜 단(column) 단위로 자르나:
  이 판형은 한 쪽에 2단이고 한 단이 한 대단원이다. 쪽 전체를 한 번에 넣으면 항목이 빽빽해
  누락 위험이 크다. 단으로 자르면 밀도가 절반이 되고, 단 검출은 크롭 파이프라인이 이미 쓰는
  `ocr_anchor_provider.detect_columns`(잉크 세로 투영)를 그대로 재사용할 수 있다.

왜 두 번 읽나:
  정답은 틀리면 학생이 맞는 답을 쓰고도 오답이 된다. 한 번 읽고 믿는 대신 두 번 읽어
  대조하고, 다른 항목만 사람에게 보여준다. 실측: 164개 중 다른 것 4개였고 그마저 **전부
  공백 차이**였다(`(1) -1  (2) 74` vs `(1) -1 (2) 74`). 공백을 정규화하면 164/164 일치.
"""
import logging
import os
import re
import tempfile
from pathlib import Path
from typing import Callable, List, Optional

import fitz
import numpy as np
from pydantic import BaseModel, Field

from pipeline.ocr_anchor_provider import detect_columns
from pipeline.vl_providers import call_vl

logger = logging.getLogger(__name__)

CIRCLED = {'①': '1', '②': '2', '③': '3', '④': '4', '⑤': '5',
           '⑥': '6', '⑦': '7', '⑧': '8', '⑨': '9', '⑩': '10'}

_RENDER_DPI = 200
_VL_TIMEOUT = 300
_MIN_COLUMN_PX = 100      # 이보다 좁은 덩어리는 단이 아니다(장식·여백)
_INK_LEVEL = 200          # 이보다 어두우면 잉크로 본다
# 모델은 명시 주입한다(프로젝트 규칙: call_vl(model=...) — OPENAI_MODEL env 무관).
# 안 주면 튜터용 OPENAI_MODEL 을 바꿀 때 정답 읽기 모델까지 같이 바뀐다.
# gpt-5.2 로 고정한 근거(2026-08-27 실측, 같은 단 이미지 1장):
#   gpt-5.2     15.7s  입력 1,955  출력 1,557  항목 128
#   gpt-4o      30.3s  입력 1,941  출력 2,783  항목 128   ← 2배 느리고 출력 1.8배(더 비쌈)
#   gpt-4o-mini 19.3s  입력 48,665 출력 1,642  항목 109   ← 입력 25배 + \frac 이 깨지고 19개 누락
# 즉 싼 모델로 바꾸면 비용도 정확도도 나빠진다. (gpt-5.2-mini 는 존재하지 않음.)
_ANSWER_KEY_MODEL = os.environ.get("ANSWER_KEY_MODEL", "gpt-5.2")
# 정답이 한 개도 없는 단(학습플래너·빈 단)만 2차 읽기를 건너뛴다.
# 예전엔 5였는데, 그러면 **문제가 4개 이하인 작은 시험지가 대조 없이 통과**한다.
# 두 번 읽어 대조하는 것이 오답 정답표를 막는 유일한 장치라 안전 쪽으로 낮춘다.
_MIN_ITEMS_FOR_CROSS_CHECK = 1

_PROMPT = r"""이 이미지는 수학 문제집이나 시험지의 '빠른 정답' 표다. (문제번호, 정답) 쌍이 줄줄이 나열돼 있다. 표(격자) 형태일 수도 있고, 한 줄에 여러 쌍이 왼쪽에서 오른쪽으로 놓일 수도 있다.

규칙:
- 문제번호는 대개 굵은 숫자다(예: 0159, 12). 그 바로 뒤에 오는 것이 그 번호의 정답이다.
- 다음은 문제번호가 아니다. 무시하라: 단계·구역 표시(A단계, B단계, 유형 01 등), 단원/대단원 제목,
  쪽수, 배점 표기([4점], 3점), 시험지 이름·회차, 표의 머리글(문항/정답/배점).
- 정답이 원문자(①②③④⑤)면 원문자를 그대로 적어라. 숫자로 바꾸지 마라.
- 정답이 수식이면 LaTeX 로 적어라. 예: x^2+x-1, \frac{13}{15}, 16\sqrt{15}
- 정답이 한글이면(예: 정삼각형) 한글 그대로 적어라.
- '몫: ..., 나머지: ...' 처럼 여러 값이면 보이는 대로 한 문자열로 적어라.
- '(1) ... (2) ...' 처럼 소문항이 있으면 그대로 한 문자열로 적어라.
- 번호 뒤에 정답이 없으면(빈칸·체크박스뿐이면) 그 번호는 넣지 마라.
- 이미지에 보이는 모든 번호를 빠짐없이, 번호 순서대로 넣어라. 지어내지 마라."""


class _Item(BaseModel):
    label: str = Field(description="지면에 인쇄된 문제번호 그대로. 예: 0159")
    answer: str = Field(description="그 번호의 정답")


class _Sheet(BaseModel):
    items: List[_Item]


# LaTeX 공백 명령. 화면에 찍히는 결과는 같은데 VL 이 읽을 때마다 달리 뱉는다
# (실측: 쎈 한 쪽 269개 중 9개가 `\;` vs `\ ` vs `\,` 차이뿐이었다).
# 이걸 안 지우면 '두 번 읽어 다름' 이 헛되이 쌓여 정작 봐야 할 항목이 묻힌다.
_LATEX_SPACING = re.compile(r"\\(?:[,;:!]|q?quad|\s)")


def _squash(s: str) -> str:
    """비교용 형태 — 공백과 LaTeX 공백 명령을 지운다. 저장값은 원문 그대로 둔다."""
    return re.sub(r"\s+", "", _LATEX_SPACING.sub("", s or ""))


def classify(answer: str) -> dict:
    """정답 원문 → 저장할 형태. (유형, 값, 사람이 봐야 하는지)

    객관식은 원문자를 숫자로 바꾼다 — `problems.correct_answer` 는 보기 '번호' 로
    저장하고 채점도 번호로 한다(`shared/lib/answerNormalizer`).
    """
    raw = (answer or "").strip()
    if not raw:
        return {"answer": "", "answer_type": "short_answer", "needs_review": True,
                "note": "정답을 못 읽음"}

    if raw in CIRCLED:
        return {"answer": CIRCLED[raw], "answer_type": "multiple_choice",
                "needs_review": False, "note": ""}

    # 아래는 한 칸에 담기 애매해서 사람이 봐야 한다.
    note = ""
    if raw.startswith("(1)") or re.search(r"\(\d\)", raw):
        note = "소문항이 여러 개"
    elif re.search("[가-힣\u3130-\u318f]", raw):
        # `가-힣` 은 완성형 음절만이라 **자모 ㄱㄴㄷ 은 안 걸린다**(U+3130~318F 는 별도 블록).
        # ㄱㄴㄷ 고르기 답이 그냥 통과하던 구멍 — 실측에서 VL 이 `ㄹ` 을 `ㄴ` 으로 오독했다.
        note = "한글이 섞임"
    elif "," in raw:
        note = "값이 여러 개"
    return {"answer": raw, "answer_type": "short_answer",
            "needs_review": bool(note), "note": note}


def _read_column(img_path: str) -> List[_Item]:
    try:
        return call_vl(img_path, _PROMPT, _Sheet, timeout=_VL_TIMEOUT,
                       model=_ANSWER_KEY_MODEL).items
    except Exception as e:  # noqa: BLE001 — 한 단 실패로 전체를 버리지 않는다
        logger.warning("[answer-key] 단 읽기 실패: %s", e)
        return []


def _column_clips(doc, dpi: int, pages: Optional[List[int]] = None) -> List[tuple]:
    """읽어야 할 단들의 위치. (page_index0, col_index, clip_rect) — 렌더/저장은 안 한다.

    pages 는 0-기준 쪽 번호 목록. None 이면 전 쪽. 잉크 세로 투영으로 단을 가르는
    `detect_columns` 를 그대로 쓴다(크롭 파이프라인과 같은 기준).
    """
    out: List[tuple] = []
    targets = range(doc.page_count) if pages is None else [
        p for p in pages if 0 <= p < doc.page_count]
    for pno in targets:
        page = doc[pno]
        pix = page.get_pixmap(matrix=fitz.Matrix(dpi / 72, dpi / 72))
        rgb = np.frombuffer(pix.samples, dtype=np.uint8).reshape(
            pix.height, pix.width, pix.n)[:, :, :3]
        gray = np.dot(rgb[..., :3], [0.299, 0.587, 0.114]).astype(np.uint8)
        sx = page.rect.width / pix.width

        cols = [c for c in detect_columns(gray) if c[1] - c[0] >= _MIN_COLUMN_PX]
        if not cols:
            continue

        # 바깥쪽 경계는 잉크 끝까지 늘린다.
        #
        # detect_columns 는 잉크 세로 투영으로 단을 가르는데, 그 경계가 **본문 끝과 딱
        # 겹치는** 판형이 있다. 실측(야탑고 내신): 본문 잉크 x117~1208 인데 단 경계가
        # 118~1207 이라 오른쪽 단(20·21번) 답의 끝 5px 이 이미 잘려 나갔다. 이번엔 답이
        # 두 자리라 살았지만 세 자리(154)나 분수였으면 통째로 날아간다.
        # 여백이 좀 붙는 건 VL 이 무시하지만, 잘린 정답은 되살릴 수 없다.
        ink = np.nonzero((gray < _INK_LEVEL).sum(axis=0) > 0)[0]
        if ink.size:
            ink_x0, ink_x1 = int(ink.min()), int(ink.max()) + 1
            cols[0] = (min(cols[0][0], ink_x0), cols[0][1])
            cols[-1] = (cols[-1][0], max(cols[-1][1], ink_x1))

        # 단 사이 틈도 남기지 않는다 — 각 단을 다음 단 시작까지 붙인다.
        # 틈에는 단원 배지 테두리·세로 구분선 같은 장식이 걸치는데(실측: 쎈 수학1 6쪽에서
        # 860px), 장식이라도 잘라 내면 배지 안 번호가 깎일 수 있다. 크롭이 10% 남짓
        # 넓어질 뿐이고, 잘린 정답은 되살릴 수 없다.
        cols = [(a, cols[i + 1][0] if i + 1 < len(cols) else b)
                for i, (a, b) in enumerate(cols)]

        for ci, (cx0, cx1) in enumerate(cols):
            out.append((pno, ci, fitz.Rect(cx0 * sx, 0, cx1 * sx, page.rect.height)))
    return out


def plan_read(pdf_path: str, *, dpi: int = _RENDER_DPI) -> dict:
    """읽기 전에 '얼마나 드는지' 를 미리 알려준다. VL 을 안 부르므로 공짜다.

    호출 수가 곧 비용이다 — 단 하나당 입력 ~2k / 출력 ~1.5k 토큰이고, 정답표인 단은
    대조를 위해 두 번 읽는다. 처음 보는 판형에 통째로 쓰기 전에 이 숫자를 보여준다.
    """
    doc = fitz.open(pdf_path)
    try:
        clips = _column_clips(doc, dpi)
        per_page: dict = {}
        for pno, _ci, _r in clips:
            per_page[pno + 1] = per_page.get(pno + 1, 0) + 1
        return {
            "pages": doc.page_count,
            "columns": len(clips),
            "columns_per_page": per_page,
            # 정답이 있는 단은 2회, 없는 단(학습플래너 등)은 1회 — 위쪽이 최대치다.
            "calls_max": len(clips) * 2,
        }
    finally:
        doc.close()


def read_answer_key(
    pdf_path: str,
    *,
    dpi: int = _RENDER_DPI,
    cross_check: bool = True,
    pages: Optional[List[int]] = None,
    progress: Optional[Callable[[int, int, str], None]] = None,
) -> List[dict]:
    """빠른정답 PDF 에서 정답 목록을 뽑는다.

    pages 는 0-기준 쪽 번호 목록. None(기본)이면 전 쪽 — 기존 호출부는 그대로 전 쪽을 읽는다.
    첫 쪽만 시험 삼아 읽을 때 `pages=[0], cross_check=False` 로 부른다(비용 1~2회).

    Returns:
        [{"label","answer","answer_type","needs_review","note","page","column"}...] — label 오름차순.
        같은 번호가 여러 번 나오면 먼저 읽은 것을 남긴다.
    """
    doc = fitz.open(pdf_path)
    units: List[tuple] = []          # (page_number1, column_index, crop_path)
    tmp = tempfile.TemporaryDirectory(prefix="answer_key_")
    tmp_dir = Path(tmp.name)

    for pno, ci, clip in _column_clips(doc, dpi, pages):
        # Pixmap 을 잘라내는 API 는 PyMuPDF 버전마다 달라서, 페이지를 clip 으로
        # 다시 렌더한다(느리지 않고 버전 차이를 안 탄다).
        path = tmp_dir / f"p{pno + 1:02d}_c{ci}.png"
        doc[pno].get_pixmap(matrix=fitz.Matrix(dpi / 72, dpi / 72), clip=clip).save(str(path))
        units.append((pno + 1, ci, str(path)))

    logger.info("[answer-key] %d쪽 중 %s → 단 %d개",
                doc.page_count, "전부" if pages is None else f"{len(pages)}쪽", len(units))
    doc.close()

    merged: dict = {}
    try:
        for idx, (pnum, ci, path) in enumerate(units, start=1):
            if progress:
                progress(idx, len(units), f"{pnum}쪽 {ci + 1}번째 단")
            first = _read_column(path)
            # 정답표가 아닌 단(학습플래너 등)은 2차를 돌리지 않는다.
            second = (_read_column(path)
                      if cross_check and len(first) >= _MIN_ITEMS_FOR_CROSS_CHECK else [])
            by_label_2 = {it.label.strip(): it.answer for it in second}

            for it in first:
                label = it.label.strip()
                if not label or not re.fullmatch(r"\d{1,4}", label):
                    continue
                if not (it.answer or "").strip():
                    continue        # 번호만 있고 정답이 없는 칸(플래너 체크박스 등)
                if label in merged:
                    continue        # 먼저 읽은 것 우선
                info = classify(it.answer)
                if second:
                    other = by_label_2.get(label)
                    if other is None or _squash(other) != _squash(it.answer):
                        info["needs_review"] = True
                        info["note"] = (info["note"] + " / 두 번 읽어 다름").strip(" /")
                merged[label] = {"label": label, **info,
                                 "page": pnum, "column": ci + 1}
    finally:
        tmp.cleanup()

    out = sorted(merged.values(), key=lambda r: (len(r["label"]), r["label"]))
    review = sum(1 for r in out if r["needs_review"])
    logger.info("[answer-key] 정답 %d개 (사람 확인 필요 %d개)", len(out), review)
    return out
