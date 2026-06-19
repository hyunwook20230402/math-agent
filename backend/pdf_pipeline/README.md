# PDF 문제 자동 추출 파이프라인

수학 교재 PDF에서 문제를 자동 추출해서 검수 후 Supabase `problems` 테이블에 저장하는 백엔드.

## 환경 요구사항
- Python 3.11+
- **VL=OpenAI 단일** (2026-06-19 gemma4/gemini 폐기). `OPENAI_API_KEY` 필수, `OPENAI_MODEL`(기본 gpt-4o).
- 임베딩=bge-m3 (Ollama, 1024차원 고정). `EMBED_PROVIDER=openai` 로만 강제 전환 가능.
- 난이도: 해설 PDF 정답률 우선(구간매핑), 없으면 GPT 추정.

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

원격 DB 기준 **010 까지 적용** (Supabase MCP `list_migrations` 로 확인). 로컬 `supabase/migrations/` 폴더에는 008 까지만 SQL 파일 존재 — 009/010 은 원격 DB 직접 적용 (드리프트 상태).

신규 환경 셋업 시:
```
supabase/migrations/001_fix_image_url_and_add_staging.sql ... 008_*.sql 순서로 실행
009/010 은 Supabase MCP 또는 SQL Editor 에서 별도 적용 필요
```

마이그레이션 이력은 `ARCHITECTURE.md` §10 참조.

### 4. 서버 실행

```bash
uvicorn main:app --reload --port 8001
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
├── main.py                    # FastAPI 서버 (포트 8001)
├── config.py                  # 환경변수
├── ARCHITECTURE.md            # AI 튜터 데이터 파이프라인 전체 구조 ← 읽어볼 것
├── docs/
│   └── TAG_VALIDATOR.md       # 3-layer 검증 에이전트 상세 (Layer 1/2/3, OpenAI)
├── requirements.txt
├── data/
│   └── concept_taxonomy.json  # concepts 375 / skills 359 / units 15 / bugs 14
├── pipeline/
│   ├── file_converter.py        # PDF → 페이지 이미지 (PyMuPDF)
│   ├── image_cropper.py         # 문제 박스 크롭 (OpenCV, 한글 경로 대응)
│   ├── ocr_engine.py            # EasyOCR 래퍼
│   ├── yolo_detector.py         # 모의고사 문제 박스 YOLO 추론
│   ├── yolo_solution_detector.py # 해설 박스 YOLO 추론
│   ├── solution_parser.py       # 해설 크롭 + 정답 파싱 + 페이지 걸침 병합
│   ├── vl_providers.py          # VL 호출 (OpenAI 단일) — call_vl(image, prompt, schema)
│   ├── solution_tagger.py       # Call A/B + 정답률 난이도(difficulty_resolver) + _apply_suggested_fixes
│   ├── difficulty_resolver.py   # 정답률 → 난이도 구간매핑
│   ├── tag_normalizer.py        # 태그 → canonical 매칭 (bge-m3 cosine ≥ 0.65)
│   ├── unit_matcher.py          # 태그 → units leaf 경로 매핑 (bge-m3)
│   ├── tag_validator.py         # 3-layer 태깅 검증 에이전트 → docs/TAG_VALIDATOR.md
│   ├── embedder.py              # 임베딩 (bge-m3, Ollama 고정)
│   └── solution_matcher.py      # 문제 ↔ 해설 번호 매칭
└── storage/
    └── supabase_client.py     # problem_staging / solution_jobs CRUD
```

## 처리 흐름

```
문제 PDF → OCR/YOLO 크롭 → problem_staging → CMS 검수 → problems 테이블

해설 PDF → 페이지 이미지 → 걸침 병합 → VL 태깅 (OpenAI 단일)
           ├─ Call A (메타: 정답률/concept/skill/...) — 정답률 있으면 난이도 구간매핑
           ├─ Call B (steps): 2-Pass(스켈레톤 + per-step)
           ├─ tag_normalizer (canonical) + unit_matcher (단원)
           └─ tag_validator (3-layer; Layer 2 OpenAI)
         → problem_staging (solution_steps/common_mistakes 포함) → problem_tags
         → CMS 검수 (재태깅 / 전체 재태깅 버튼) → problems 테이블
```

상세는:
- 데이터 흐름 / DB 스키마: `ARCHITECTURE.md`
- 검증 에이전트 동작: `docs/TAG_VALIDATOR.md`

## 연관 백엔드

- `backend/deeptutor/` — AI 튜터링 (운영 중, LangGraph 다중턴 대화)
  - `problem_tags` + `solution_steps` + `common_mistakes` 를 활용해 학생 답안 진단 및 단계별 힌트 생성
  - API: `POST /api/tutor/start`, `POST /api/tutor/chat/{conversation_id}`
  - 상세: `backend/deeptutor/routers/tutor.py`, `graph/`, `handlers/`
