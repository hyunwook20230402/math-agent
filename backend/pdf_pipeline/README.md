# PDF 문제 추출 파이프라인

수학 교재 스캔 PDF에서 문제를 자동 추출하여 Supabase에 저장하는 백엔드.

## 상태: 구현 예정

## 환경 요구사항
- Python 3.10+
- CUDA 12.x (RTX 4070)
- Ollama (Qwen2.5-7B)

## 예정 구조

```
pdf_pipeline/
├── main.py                    # FastAPI 서버 (포트 8000)
├── config.py                  # 환경 변수 (Supabase URL/Key)
├── requirements.txt
├── pipeline/
│   ├── pdf_splitter.py        # PDF → 페이지 이미지
│   ├── layout_detector.py     # 문제 영역 분할
│   ├── ocr_engine.py          # Surya OCR
│   ├── math_recognizer.py     # Nougat 수식 인식
│   ├── figure_analyzer.py     # Qwen2.5-VL-7B 도형 분석
│   ├── structurizer.py        # Qwen2.5-7B 구조화
│   └── model_manager.py       # GPU 메모리 관리
├── storage/
│   ├── supabase_client.py
│   └── image_uploader.py
└── textbook_configs/
    └── ssen_math1.json        # 쎈 수학1 교재 설정
```

## 처리 흐름

```
스캔 PDF → pdf2image → Surya OCR → 문제 분할
       → Nougat 수식 → Qwen2.5-VL 도형 → Qwen2.5-7B 구조화
       → problem_staging 테이블 → CMS 검수 → problems 테이블
```

## VRAM 관리 (8GB 제약)
모델을 순차적으로 로드/언로드한다:
1. Surya + Nougat (~5GB) → 언로드
2. Qwen2.5-VL-7B 4bit (~5GB) → 언로드  
3. Qwen2.5-7B 4bit via Ollama (~5GB)
