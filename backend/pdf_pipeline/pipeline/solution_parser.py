"""해설지 PDF → 정답 파싱 + 해설 크롭 + 페이지 걸침 병합

주요 함수:
  extract_answers(pdf_path) → {번호: {answer, answer_type}}
  crop_solutions(pdf_path, output_dir) → {번호: [이미지경로, ...]}
  merge_cross_page_solutions(crops) → {번호: 병합된_이미지경로}
"""
import re
import logging
from pathlib import Path
from PIL import Image

from pipeline.file_converter import extract_images_from_pdf
from pipeline.ocr_engine import ocr_detect_boxes

logger = logging.getLogger(__name__)

# 정답표 OCR 텍스트 패턴: "정답" 또는 "답" 포함 + 근처에 번호 나열
_ANSWER_TABLE_KEYWORDS = ["정답", "정 답", "답안"]

# 인라인 정답 패턴: "1) ③" "17) 25" "3) ④번" 등
_INLINE_ANSWER_RE = re.compile(
    r"(\d{1,3})\s*[)）]\s*([①②③④⑤ⓐⓑⓒⓓⓔ\d]+(?:\.\d+)?)"
)

# 객관식 기호 집합
_MC_SYMBOLS = set("①②③④⑤ⓐⓑⓒⓓⓔ")


def infer_answer_type(answer: str) -> str:
    """정답 문자열 보고 객관식/주관식 판단"""
    if any(ch in _MC_SYMBOLS for ch in answer):
        return "multiple_choice"
    return "short_answer"


def parse_answer_table(ocr_results: list) -> dict:
    """상단 정답표에서 {번호: 정답} 딕셔너리 추출

    정답표 형식 예:
      정답  1. ③  2. ①  3. ④  ...
    또는 표 형태로 여러 행에 걸쳐 번호-정답이 나열됨.

    Args:
      ocr_results: [(bbox, text, confidence), ...]

    Returns:
      {번호: 정답} — 빈 딕셔너리면 정답표 없음
    """
    answers: dict[int, str] = {}

    # "정답" 키워드가 포함된 텍스트가 있는지 확인
    has_table = any(
        any(kw in text for kw in _ANSWER_TABLE_KEYWORDS)
        for _, text, _ in ocr_results
    )
    if not has_table:
        return answers

    # 정답표는 주로 페이지 상단 20% 이내 — 아래 영역은 해설
    # 모든 텍스트에서 "N. ①" 또는 "N ①" 패턴 추출
    table_pattern = re.compile(r"(\d{1,3})\s*[.)]\s*([①②③④⑤\d]+(?:\.\d+)?)")
    for _, text, confidence in ocr_results:
        if confidence < 0.4:
            continue
        for m in table_pattern.finditer(text):
            num = int(m.group(1))
            ans = m.group(2).strip()
            if 1 <= num <= 200 and ans:
                answers[num] = ans

    return answers


def parse_inline_answers(ocr_results: list) -> dict:
    """해설 내 인라인 "N) 정답" 패턴에서 {번호: 정답} 추출

    정답표 없는 해설지에서 각 해설 시작부의 "1) ③" "17) 25" 패턴을 파싱.

    Args:
      ocr_results: [(bbox, text, confidence), ...]

    Returns:
      {번호: 정답}
    """
    answers: dict[int, str] = {}
    for _, text, confidence in ocr_results:
        if confidence < 0.4:
            continue
        for m in _INLINE_ANSWER_RE.finditer(text):
            num = int(m.group(1))
            ans = m.group(2).strip()
            if 1 <= num <= 200 and ans:
                # 이미 있으면 덮어쓰지 않음 (앞쪽 매칭 우선)
                if num not in answers:
                    answers[num] = ans

    return answers


def extract_answers(pdf_path: str, dpi: int = 200) -> dict:
    """해설지 PDF에서 정답 딕셔너리 추출

    정답표 우선 파싱 → 없거나 불충분하면 인라인 파싱으로 보완.

    Args:
      pdf_path: 해설지 PDF 경로
      dpi: PDF→이미지 변환 해상도 (정답 추출은 200 충분)

    Returns:
      {번호: {"answer": str, "answer_type": "multiple_choice"|"short_answer"}}
    """
    import tempfile
    with tempfile.TemporaryDirectory() as tmp_dir:
        page_images = extract_images_from_pdf(pdf_path, tmp_dir, dpi=dpi)

        # 전체 페이지 OCR (정답표 탐색)
        all_ocr: list[tuple[int, list]] = []
        for pi in page_images:
            ocr_results = ocr_detect_boxes(pi["image_path"])
            all_ocr.append((pi["page"], ocr_results))

        # 정답표 파싱 (전 페이지에서 시도)
        answers: dict[int, str] = {}
        for _, ocr in all_ocr:
            table = parse_answer_table(ocr)
            answers.update(table)

        # 인라인 보완 (정답표에 없는 번호)
        for _, ocr in all_ocr:
            inline = parse_inline_answers(ocr)
            for num, ans in inline.items():
                if num not in answers:
                    answers[num] = ans

    return {
        num: {
            "answer": ans,
            "answer_type": infer_answer_type(ans),
        }
        for num, ans in answers.items()
    }


def crop_solutions(
    pdf_path: str,
    output_dir: str,
    dpi: int = 300,
) -> dict:
    """해설지 PDF에서 페이지 이미지 추출 (초기 자동 크롭 없음)

    OCR 기반 자동 크롭은 누락이 심해 사용하지 않음.
    각 페이지의 이미지만 추출하고, items는 빈 리스트로 반환.
    사용자가 CMS UI에서 직접 박스를 그려 검수한다.

    Args:
      pdf_path: 해설지 PDF 경로
      output_dir: 페이지 이미지 저장 디렉토리
      dpi: PDF→이미지 변환 해상도

    Returns:
      {
        "pages": {
          page_num: {
            "page_image_path": str,
            "page_width": int, "page_height": int,
            "items": []   # 항상 빈 리스트 — UI에서 직접 그리기
          }
        },
        "fragments": {}   # 항상 빈 dict
      }
    """
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    pages_tmp_dir = out_dir / "_pages"
    pages_tmp_dir.mkdir(parents=True, exist_ok=True)

    page_images = extract_images_from_pdf(pdf_path, str(pages_tmp_dir), dpi=dpi)

    pages_data: dict = {}

    for pi in page_images:
        img_path = pi["image_path"]
        page_num = pi["page"]

        img = Image.open(img_path)
        w, h = img.size
        img.close()

        pages_data[page_num] = {
            "page_image_path": img_path,
            "page_width": w,
            "page_height": h,
            "items": [],
        }

    return {"pages": pages_data, "fragments": {}}


def merge_cross_page_solutions(
    crops: dict,
    output_dir: str,
    gap_px: int = 10,
    pdf_path_hint: str | None = None,
) -> dict:
    """페이지 걸침 해설 조각들을 세로 병합

    같은 번호의 이미지 조각들을 너비 통일 후 세로로 concat.
    조각이 1개면 그대로 반환.

    Args:
      crops: {번호: [이미지경로, ...]} — 상대 or 절대 or legacy 경로 모두 허용
      output_dir: 병합 이미지 저장 디렉토리
      gap_px: 조각 사이 여백 (px)
      pdf_path_hint: 경로 resolver 힌트 (legacy 절대경로 재매핑용)

    Returns:
      {번호: 병합된_이미지경로(절대)}
    """
    import sys
    from pathlib import Path as _Path
    _pipeline_parent = str(_Path(__file__).resolve().parent.parent)
    if _pipeline_parent not in sys.path:
        sys.path.insert(0, _pipeline_parent)
    from config import resolve_upload_path
    from pipeline.image_cropper import _trim_whitespace

    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    merged: dict[int, str] = {}

    for num, paths in crops.items():
        if not paths:
            continue
        if not isinstance(num, int):
            # 숫자 아닌 key (예: '__page2_idx0' 임시키) 는 병합 대상 아님
            logger.warning(f"merge_cross_page_solutions: non-int key skip: {num}")
            continue

        resolved_paths = [str(resolve_upload_path(p, pdf_path_hint)) for p in paths]

        if len(resolved_paths) == 1:
            # 조각 1개 — 그대로
            merged[num] = resolved_paths[0]
            continue

        # 여러 조각: 너비 통일 후 세로 병합
        images = [Image.open(p) for p in resolved_paths]
        images = [_trim_whitespace(img) for img in images]

        # 최대 너비 기준으로 모든 조각 너비 통일 (우측 패딩)
        max_w = max(img.width for img in images)
        padded = []
        for img in images:
            if img.width < max_w:
                canvas = Image.new("RGB", (max_w, img.height), (255, 255, 255))
                canvas.paste(img, (0, 0))
                padded.append(canvas)
            else:
                padded.append(img.convert("RGB"))

        # 세로 병합
        gap = Image.new("RGB", (max_w, gap_px), (255, 255, 255))
        total_h = sum(img.height for img in padded) + gap_px * (len(padded) - 1)
        result = Image.new("RGB", (max_w, total_h), (255, 255, 255))
        y = 0
        for i, img in enumerate(padded):
            result.paste(img, (0, y))
            y += img.height
            if i < len(padded) - 1:
                result.paste(gap, (0, y))
                y += gap_px

        save_path = str(out_dir / f"merged_{num:04d}.png")
        result.save(save_path)
        merged[num] = save_path

        for img in images:
            img.close()

    return merged
