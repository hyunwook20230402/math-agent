# PDF 문제 자동 추출 파이프라인

수학 교재 PDF에서 문제를 자동 추출해서 검수 후 Supabase `problems` 테이블에 저장하는 백엔드.

## 환경 요구사항
- Python 3.11+
- 서버: RTX 4090 24GB — Ollama Gemma3 27B (vision, 17GB)
- 로컬(집): Gemini API 또는 OpenAI API — provider_selector 가 시간대 기반 자동 선택
- 임베딩: 서버 bge-m3 (Ollama) / 로컬 text-embedding-3-small (OpenAI)

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
├── ARCHITECTURE.md            # AI 튜터 데이터 파이프라인 전체 구조 ← 읽어볼 것
├── requirements.txt
├── data/
│   └── concept_taxonomy.json  # concepts 375 / skills 359 / units 15 / bugs 14
├── pipeline/
│   ├── file_converter.py      # PDF → 페이지 이미지 (PyMuPDF)
│   ├── image_cropper.py       # 문제 박스 크롭 (OpenCV, 한글 경로 대응)
│   ├── ocr_engine.py          # EasyOCR 래퍼
│   ├── yolo_detector.py       # 모의고사 YOLO 추론
│   ├── solution_parser.py     # 해설 크롭 + 정답 파싱 + 페이지 걸침 병합
│   ├── vl_providers.py        # VL provider 분기 (Ollama/Gemini/OpenAI + fallback)
│   ├── provider_selector.py   # 시간대 기반 provider 자동 선택
│   ├── solution_tagger.py     # VL 태깅 + tag_normalizer/unit_matcher 후처리
│   ├── tag_normalizer.py      # 태그 → canonical 매칭 (bge-m3 cosine ≥ 0.65)
│   ├── unit_matcher.py        # 태그 → units leaf 경로 매핑 (bge-m3)
│   ├── tag_validator.py       # 3-layer 태깅 검증 에이전트
│   ├── embedder.py            # 임베딩 (Ollama bge-m3 / OpenAI 3-small)
│   └── solution_matcher.py    # 문제 ↔ 해설 번호 매칭
└── storage/
    └── supabase_client.py     # problem_staging / solution_jobs CRUD
```

## 처리 흐름

```
문제 PDF → OCR/YOLO 크롭 → problem_staging → CMS 검수 → problems 테이블

해설 PDF → 페이지 이미지 → 걸침 병합 → VL 태깅
         → tag_normalizer (canonical) → unit_matcher (단원) → tag_validator (검증)
         → problem_staging (solution_steps/common_mistakes 포함) → problem_tags
         → CMS 검수 → problems 테이블
```

상세 구조는 `ARCHITECTURE.md` 참조.

## 향후 추가 예정
- DeepTutor AI 튜터링 (`backend/deeptutor/` — 현재 스켈레톤만)
  - solution_steps 단계별 힌트, common_mistakes 오답 진단, problem_tags 유사 문제 추천
