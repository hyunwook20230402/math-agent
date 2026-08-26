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
# 한 단에서 이보다 적게 나오면 정답표가 아니다(학습플래너 등) — 2차 읽기를 건너뛴다.
_MIN_ITEMS_FOR_CROSS_CHECK = 5

_PROMPT = r"""이 이미지는 수학 문제집의 '빠른 정답' 표다. 한 줄에 여러 개의 (문제번호, 정답) 쌍이 왼쪽에서 오른쪽으로 나열돼 있다.

규칙:
- 문제번호는 굵은 숫자(예: 0159)다. 그 바로 뒤에 오는 것이 그 번호의 정답이다.
- 'A단계' 'B단계' 'C단계' 같은 구역 표시, 대단원 제목, 쪽수는 문제번호가 아니다. 무시하라.
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


def _squash(s: str) -> str:
    """공백 차이를 지운 비교용 형태. VL 두 번 읽기의 유일한 불일치 원인이 공백이었다."""
    return re.sub(r"\s+", "", s or "")


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
    elif re.search(r"[가-힣]", raw):
        note = "한글이 섞임"
    elif "," in raw:
        note = "값이 여러 개"
    return {"answer": raw, "answer_type": "short_answer",
            "needs_review": bool(note), "note": note}


def _read_column(img_path: str) -> List[_Item]:
    try:
        return call_vl(img_path, _PROMPT, _Sheet, timeout=_VL_TIMEOUT).items
    except Exception as e:  # noqa: BLE001 — 한 단 실패로 전체를 버리지 않는다
        logger.warning("[answer-key] 단 읽기 실패: %s", e)
        return []


def read_answer_key(
    pdf_path: str,
    *,
    dpi: int = _RENDER_DPI,
    cross_check: bool = True,
    progress: Optional[Callable[[int, int, str], None]] = None,
) -> List[dict]:
    """빠른정답 PDF 에서 정답 목록을 뽑는다.

    Returns:
        [{"label","answer","answer_type","needs_review","note"}...] — label 오름차순.
        같은 번호가 여러 번 나오면 먼저 읽은 것을 남긴다.
    """
    doc = fitz.open(pdf_path)
    units: List[tuple] = []          # (page_index, column_index, crop_path)
    tmp = tempfile.TemporaryDirectory(prefix="answer_key_")
    tmp_dir = Path(tmp.name)

    for pno in range(doc.page_count):
        page = doc[pno]
        pix = page.get_pixmap(matrix=fitz.Matrix(dpi / 72, dpi / 72))
        rgb = np.frombuffer(pix.samples, dtype=np.uint8).reshape(
            pix.height, pix.width, pix.n)[:, :, :3]
        gray = np.dot(rgb[..., :3], [0.299, 0.587, 0.114]).astype(np.uint8)
        sx = page.rect.width / pix.width
        for ci, (cx0, cx1) in enumerate(detect_columns(gray)):
            if cx1 - cx0 < 100:
                continue
            # Pixmap 을 잘라내는 API 는 PyMuPDF 버전마다 달라서, 페이지를 clip 으로
            # 다시 렌더한다(느리지 않고 버전 차이를 안 탄다).
            clip = fitz.Rect(cx0 * sx, 0, cx1 * sx, page.rect.height)
            path = tmp_dir / f"p{pno + 1:02d}_c{ci}.png"
            page.get_pixmap(matrix=fitz.Matrix(dpi / 72, dpi / 72), clip=clip).save(str(path))
            units.append((pno + 1, ci, str(path)))

    logger.info("[answer-key] %d쪽 → 단 %d개", doc.page_count, len(units))
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
