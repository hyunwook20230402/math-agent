"""평가원 6월달 PDF를 문제 / 빠른정답 / 해설 3개로 분리.

기존 '평가원 6월/split_pdf.py' 와 동일 로직(경계 자동 감지 + 공백 페이지 제거).
출력은 이 폴더의 split/ 하위.
"""
import fitz
from pathlib import Path

BASE_DIR = Path(__file__).parent
OUTPUT_DIR = BASE_DIR / "split"
OUTPUT_DIR.mkdir(exist_ok=True)


def detect_boundaries(doc):
    """빠른정답 / 해설 시작 페이지 자동 감지 (0-indexed)"""
    quick_start = None
    solution_start = None
    for i, page in enumerate(doc):
        text = page.get_text()
        if quick_start is None and "빠른정답" in text:
            quick_start = i
        if solution_start is None and "해설" in text and "빠른정답" not in text and i > 0:
            # 빠른정답 이후에 나오는 해설 페이지
            if quick_start is not None and i > quick_start:
                solution_start = i
    return quick_start, solution_start


def is_blank_page(page, threshold=50):
    """텍스트가 거의 없고 이미지도 없으면 공백 페이지"""
    text = page.get_text().strip()
    images = page.get_images()
    return len(text) < threshold and len(images) == 0


def save_pdf_excluding_blanks(doc, from_page, to_page, out_path):
    """from_page~to_page 범위에서 공백 페이지 제외 후 저장"""
    out = fitz.open()
    skipped = 0
    for i in range(from_page, to_page):
        if is_blank_page(doc[i]):
            skipped += 1
            continue
        out.insert_pdf(doc, from_page=i, to_page=i)
    out.save(str(out_path))
    out.close()
    return (to_page - from_page) - skipped, skipped


def split_pdf(filename: str):
    src_path = BASE_DIR / filename
    doc = fitz.open(src_path)

    quick_start, solution_start = detect_boundaries(doc)
    if quick_start is None or solution_start is None:
        print(f"  [오류] 경계 감지 실패: quick={quick_start}, solution={solution_start}")
        doc.close()
        return

    print(f"  {filename}: 문제 p1-{quick_start} | 빠른정답 p{quick_start+1}-{solution_start} | 해설 p{solution_start+1}-{len(doc)}")

    stem = src_path.stem
    ranges = {
        "문제":     (0, quick_start),
        "빠른정답": (quick_start, solution_start),
        "해설":     (solution_start, len(doc)),
    }

    for label, (start, end) in ranges.items():
        out_path = OUTPUT_DIR / f"{stem}_{label}.pdf"
        pages, skipped = save_pdf_excluding_blanks(doc, start, end, out_path)
        skip_note = f" (공백 {skipped}p 제거)" if skipped else ""
        print(f"    -> {out_path.name} ({pages}p){skip_note}")

    doc.close()


def main():
    pdfs = sorted(BASE_DIR.glob("평가원 6월 *.pdf"))
    if not pdfs:
        print("PDF 파일을 찾지 못했습니다.")
        return
    for pdf in pdfs:
        print(f"\n[처리] {pdf.name}")
        split_pdf(pdf.name)
    print("\n완료!")


if __name__ == "__main__":
    main()
