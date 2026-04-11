"""이미지형 PDF → 텍스트 변환 (EasyOCR)"""
import easyocr
from typing import List, Dict

_reader = None


def get_reader() -> easyocr.Reader:
    """EasyOCR Reader 싱글톤 (첫 호출 시 모델 로드)"""
    global _reader
    if _reader is None:
        _reader = easyocr.Reader(['ko', 'en'], gpu=True)
    return _reader


def release_reader():
    """VRAM 해제 (Qwen 실행 전 호출)"""
    global _reader
    if _reader is not None:
        del _reader
        _reader = None
        try:
            import torch
            torch.cuda.empty_cache()
        except ImportError:
            pass


def ocr_detect_boxes(image_path: str) -> list:
    """이미지에서 모든 텍스트의 bbox + 텍스트 + 신뢰도 반환 (문제번호 좌표 감지용)"""
    reader = get_reader()
    return reader.readtext(image_path, detail=1)


def ocr_image(image_path: str) -> str:
    """이미지 파일 → 텍스트 (EasyOCR)"""
    reader = get_reader()
    results = reader.readtext(image_path, detail=0, paragraph=True)
    return '\n'.join(results)


def ocr_pages(page_images: List[Dict]) -> List[Dict]:
    """페이지 이미지 목록 → 페이지별 텍스트 목록"""
    pages = []
    for item in page_images:
        text = ocr_image(item['image_path'])
        pages.append({
            'page': item['page'],
            'text': text,
        })
    # OCR 완료 후 VRAM 해제 (Qwen 실행 위해)
    release_reader()
    return pages
