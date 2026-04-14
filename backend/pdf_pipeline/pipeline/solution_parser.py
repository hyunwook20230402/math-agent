"""해설지 PDF → 정답 파싱 + 해설 크롭 + 페이지 걸침 병합

주요 함수:
  extract_answers(pdf_path) → {번호: {answer, answer_type}}
  crop_solutions(pdf_path, output_dir) → {번호: [이미지경로, ...]}
  merge_cross_page_solutions(crops) → {번호: 병합된_이미지경로}
"""
import re
import logging
from pathlib import Path
from typing import Optional

from PIL import Image

from pipeline.file_converter import extract_images_from_pdf
from pipeline.ocr_engine import ocr_detect_boxes
from pipeline.image_cropper import (
    detect_problem_numbers,
    compute_crop_regions,
    crop_and_save,
    detect_footer_y,
    _trim_whitespace,
)

logger = logging.getLogger(__name__)

# 해설지 문제 번호 패턴: "1)", "17)", "100)" 등
# 해설지는 N) 형식 — 교재(0038 형식)와 다름
_SOLUTION_NUMBER_PATTERN = r"^\d{1,3}$"

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
    """해설지 PDF에서 문제번호별 해설 이미지 크롭

    해설지는 "N)" 형식 번호 사용. 기존 detect_problem_numbers 재사용.
    페이지 걸침(cross-page)이 있으므로 같은 번호의 조각을 모두 수집.

    Args:
      pdf_path: 해설지 PDF 경로
      output_dir: 크롭 이미지 저장 디렉토리
      dpi: PDF→이미지 변환 해상도

    Returns:
      {번호: ["page001_0001.png", "page002_0001.png", ...]} (조각 목록)
    """
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    import tempfile
    with tempfile.TemporaryDirectory() as tmp_dir:
        page_images = extract_images_from_pdf(pdf_path, tmp_dir, dpi=dpi)

        crops_by_number: dict[int, list[str]] = {}
        seen_numbers: set[int] = set()

        for pi in page_images:
            img_path = pi["image_path"]
            page_num = pi["page"]

            ocr_results = ocr_detect_boxes(img_path)

            from PIL import Image as PILImage
            img = PILImage.open(img_path)
            w, h = img.size
            img.close()

            # 해설지 번호 패턴: 1~3자리 숫자 (페이지 걸침이 있어 skip_numbers 사용 안 함)
            # 단, 이미 완전히 추출한 번호와 동일한 페이지에서 재등장하는 건 같은 번호의 연속
            detections = detect_problem_numbers(
                ocr_results,
                pattern=_SOLUTION_NUMBER_PATTERN,
                page_height=h,
                page_width=w,
                layout="auto",
                # skip_numbers 사용 안 함 — 걸침 번호가 다음 페이지 첫 번호로 재등장
            )

            if not detections:
                # 번호 감지 실패 시 — 이전 페이지 마지막 번호의 연속으로 간주
                # 이미지 전체를 마지막 번호의 추가 조각으로 저장
                if crops_by_number:
                    last_num = max(crops_by_number.keys())
                    frag_path = str(out_dir / f"page_{page_num:03d}_{last_num:04d}_frag.png")
                    whole_img = PILImage.open(img_path)
                    trimmed = _trim_whitespace(whole_img)
                    trimmed.save(frag_path)
                    whole_img.close()
                    crops_by_number[last_num].append(frag_path)
                continue

            footer = detect_footer_y(ocr_results, h)
            regions = compute_crop_regions(
                detections, w, h,
                layout="auto",
                footer_y=footer,
                ocr_results=ocr_results,
            )
            cropped = crop_and_save(img_path, regions, str(out_dir), page_num)

            for item in cropped:
                num = item["number"]
                path = item["cropped_path"]
                if num not in crops_by_number:
                    crops_by_number[num] = []
                crops_by_number[num].append(path)

        return crops_by_number


def merge_cross_page_solutions(
    crops: dict,
    output_dir: str,
    gap_px: int = 10,
) -> dict:
    """페이지 걸침 해설 조각들을 세로 병합

    같은 번호의 이미지 조각들을 너비 통일 후 세로로 concat.
    조각이 1개면 그대로 반환.

    Args:
      crops: {번호: [이미지경로, ...]}
      output_dir: 병합 이미지 저장 디렉토리
      gap_px: 조각 사이 여백 (px)

    Returns:
      {번호: 병합된_이미지경로}
    """
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    merged: dict[int, str] = {}

    for num, paths in crops.items():
        if not paths:
            continue

        if len(paths) == 1:
            # 조각 1개 — 그대로
            merged[num] = paths[0]
            continue

        # 여러 조각: 너비 통일 후 세로 병합
        images = [Image.open(p) for p in paths]
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
