"""PDF → 텍스트/이미지 추출 (PyMuPDF)"""
import fitz  # PyMuPDF
from pathlib import Path
from typing import List, Dict


def extract_text_from_pdf(pdf_path: str) -> List[Dict]:
    """텍스트형 PDF에서 페이지별 텍스트 추출"""
    doc = fitz.open(pdf_path)
    pages = []
    for i, page in enumerate(doc):
        text = page.get_text("text")
        pages.append({
            "page": i + 1,
            "text": text.strip(),
        })
    doc.close()
    return pages


def extract_images_from_pdf(
    pdf_path: str,
    output_dir: str,
    dpi: int = 200,
    page_start: int = None,
    page_end: int = None,
) -> List[Dict]:
    """이미지형 PDF(스캔본)에서 페이지별 이미지 저장

    Args:
        page_start: 시작 페이지 (1-indexed, None이면 처음부터)
        page_end: 끝 페이지 (1-indexed, None이면 마지막까지)
    """
    doc = fitz.open(pdf_path)
    total = len(doc)
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    # 0-indexed 범위 계산
    start_idx = (page_start - 1) if page_start else 0
    end_idx = page_end if page_end else total
    start_idx = max(0, min(start_idx, total - 1))
    end_idx = max(start_idx + 1, min(end_idx, total))

    pages = []
    for i in range(start_idx, end_idx):
        page = doc[i]
        mat = fitz.Matrix(dpi / 72, dpi / 72)
        pix = page.get_pixmap(matrix=mat)
        img_path = str(output_path / f"page_{i + 1:03d}.png")
        pix.save(img_path)
        pages.append({
            "page": i + 1,
            "image_path": img_path,
        })
    doc.close()
    return pages


def is_text_pdf(pdf_path: str, min_chars_per_page: int = 100) -> bool:
    """텍스트형 PDF 여부 판별 (페이지당 평균 글자 수로 판단)"""
    doc = fitz.open(pdf_path)
    total_chars = sum(len(page.get_text("text")) for page in doc)
    avg = total_chars / max(len(doc), 1)
    doc.close()
    return avg >= min_chars_per_page
