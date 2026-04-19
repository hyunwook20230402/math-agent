# PDF 문제 자동 추출 파이프라인

수학 교재 PDF에서 문제를 자동 추출해서 검수 후 Supabase `problems` 테이블에 저장하는 백엔드.

## 환경 요구사항
- Python 3.10+
- RTX 4070 8GB VRAM
- Ollama (기본 VL 모델: Gemma3 27B — 서버 RTX 4090 24GB 기준. 로컬은 provider_selector 가 Gemini / OpenAI 로 auto-select)

## 설정

### 1. 가상환경 및 패키지 설치

```bash
cd backend/pdf_pipeline
python -m venv venv
venv\Scripts\activate   # Windows
pip install -r requirements.txt
```

### 2. 환경변수 설정

```bash
copy .env.example .env
```

`.env` 파일의 `SUPABASE_SERVICE_KEY`를 Supabase 프로젝트 설정 > API > **service_role** 키로 채우세요.

### 3. Supabase DB 마이그레이션

Supabase SQL Editor에서 실행:
```
supabase/migrations/001_fix_image_url_and_add_staging.sql
```

### 4. 서버 실행

```bash
uvicorn main:app --reload --port 8000
```

## API

| 메서드 | 경로 | 설명 |
|--------|------|------|
| POST | `/api/upload` | 파일 업로드 → job_id 반환 |
| POST | `/api/extract/{job_id}` | 추출 시작 (백그라운드) |
| GET | `/api/jobs/{job_id}` | 진행 상황 |
| GET | `/api/staging/{job_id}` | 추출된 문제 목록 |
| PATCH | `/api/staging/{staging_id}` | 개별 문제 수정/승인/거부 |
| POST | `/api/staging/{job_id}/approve-all` | 승인된 문제 → problems 테이블 등록 |

## 구조

```
pdf_pipeline/
├── main.py                    # FastAPI 서버 (포트 8000)
├── config.py                  # 환경변수
├── requirements.txt
├── pipeline/
│   ├── file_converter.py      # PDF → 텍스트/이미지 (PyMuPDF)
│   ├── text_splitter.py       # 정규식 문제 분리
│   └── structurizer.py        # VL 모델 (Ollama / Gemini / OpenAI) 구조화
└── storage/
    └── supabase_client.py     # staging 테이블 CRUD
```

## 처리 흐름

```
PDF 업로드 → 텍스트 추출 (PyMuPDF) → 문제 분리 (정규식)
          → VL 모델 구조화 (Ollama Gemma3 / Gemini / OpenAI — provider_selector) → problem_staging INSERT
          → CMS 검수 UI → problems 테이블 최종 등록
```

## 향후 추가 예정
- **3단계**: 이미지형 PDF — Surya OCR + Nougat 수식 인식
- **4단계**: HWP 지원 — pyhwp + LibreOffice headless
