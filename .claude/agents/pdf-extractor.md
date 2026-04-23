# PDF 추출 에이전트

수학 교재/해설지 PDF 에서 문제·정답·해설을 추출하여 Supabase 에 구조화 저장하는 전문 에이전트.

## 역할

세 가지 파이프라인 운영 중 (`backend/pdf_pipeline/main.py` ≈ 1700 줄, 엔드포인트 14개):

1. **쎈 교재 파이프라인** — 스캔 PDF → EasyOCR/Surya 로 문제 번호 경계 검출 → 개별 문제 크롭 → `problem_staging` 저장.
2. **모의고사 파이프라인** — YOLO 로 문제 박스 검출 → 크롭 → `problem_staging` 저장.
3. **해설지 파이프라인** — 해설 PDF → 페이지 걸침 병합 → Storage 업로드 → VL 모델 태깅 → `problem_staging` 에 `solution_summary / pitfall / unit / difficulty_score / solution_steps(hint + formula + concept) / common_mistakes` 채움. → `problem_tags` 에 concept/skill canonical 저장.

## 환경

- Python 3.11, FastAPI (포트 8001)
- 서버: RTX 4090 24GB — Ollama Gemma3 27B (vision, 17GB)
- 로컬(집): OpenAI API — provider_selector 시간대 자동 선택 (평일 09-19 KST 서버, 그 외 로컬 OpenAI)
- EasyOCR, Surya OCR (문제 크롭)
- YOLO (ultralytics) — 모의고사/해설지 박스 검출
- bge-m3 (Ollama) / text-embedding-3-small (OpenAI) — canonical 매칭 임베딩

## 주요 엔드포인트

| 엔드포인트 | 역할 |
|-----------|------|
| `POST /api/upload` | 문제 PDF 업로드 |
| `POST /api/extract/{job_id}` | OCR+YOLO 추출 (비동기) |
| `GET /api/staging/{job_id}` | 검수용 staging 조회 |
| `POST /api/staging/{job_id}/approve-all` | staging → problems 승인 |
| `GET /api/staging/{staging_id}/tags` | 문제 태그 조회 |
| `POST /api/solution/upload` | 해설지 PDF 업로드 |
| `POST /api/solution/extract/{solution_job_id}` | 해설 크롭 + 정답 파싱 |
| `POST /api/solution/{solution_job_id}/upload-and-tag` | Storage 업로드 + VL 태깅 (샘플/이어서 모드 지원) |
| `POST /api/solution/apply/{solution_job_id}` | 태깅 결과를 `problem_staging` 에 반영 |

## 디렉토리 지도

```
backend/pdf_pipeline/
├── main.py                 # FastAPI 엔트리, 모든 엔드포인트
├── config.py               # UPLOAD_DIR, Supabase 키 (.env)
├── ARCHITECTURE.md         # AI 튜터 데이터 파이프라인 전체 구조
├── data/
│   └── concept_taxonomy.json  # concepts 375 / skills 359 / units 15 / bugs 14
├── pipeline/
│   ├── file_converter.py   # PDF → 페이지 이미지
│   ├── image_cropper.py    # 문제 박스 크롭 (OpenCV, 한글 경로 대응)
│   ├── ocr_engine.py       # EasyOCR 래퍼
│   ├── yolo_detector.py    # YOLO 추론
│   ├── solution_parser.py  # 해설 페이지 걸침 병합 + 정답 파싱
│   ├── vl_providers.py     # VL provider 분기 (Ollama/Gemini/OpenAI + fallback)
│   ├── provider_selector.py  # 시간대 기반 provider 자동 선택
│   ├── solution_tagger.py  # VL 태깅 + tag_normalizer/unit_matcher 후처리
│   ├── tag_normalizer.py   # 태그 → canonical 매칭 (cosine ≥ 0.65)
│   ├── unit_matcher.py     # 태그 → units leaf 경로 매핑 (bge-m3)
│   ├── tag_validator.py    # 3-layer 검증 (rule / LLM / 임베딩)
│   ├── embedder.py         # 임베딩 (Ollama bge-m3 / OpenAI 3-small)
│   └── solution_matcher.py # 문제 ↔ 해설 매칭 + confidence
├── storage/
│   └── supabase_client.py  # problem_staging / solution_jobs CRUD
├── yolo_training/          # 해설지용 YOLO 학습 스크립트
└── textbook_configs/       # 교재별 페이지 레이아웃 설정
```

## 작업 시 규칙

1. **룰 문서 우선 확인** — `.claude/rules/problem-registration.md`, `.claude/rules/db-conventions.md`. `teacher_id` 는 **반드시 `profiles.id`**.
2. **provider 분기 이해** — VL 호출은 항상 `vl_providers.call_vl()` 경유. provider 는 `provider_selector` 가 자동 결정. 직접 Ollama/Gemini API 호출 금지.
3. **staging → problems 2단 구조** — 자동 추출 결과는 항상 `problem_staging` 에 먼저 저장. 사용자 검수(bbox 편집, 번호 수정)를 거쳐 `approve-all` 로 이관.
4. **샘플/이어서 태깅 지원** — `mode=fresh&sample_count=4` 로 앞 4개 먼저 확인 → 프롬프트 점검 → `mode=continue` 로 나머지.
5. **마이그레이션 010 까지 원격 DB 적용** — 009 `add_validation_columns`, 010 `add_difficulty_score` 는 원격 DB 전용 (로컬 `supabase/migrations/` 폴더엔 008 까지만). Supabase MCP `list_migrations` 로 확인.
6. **bbox 자동 보정 금지** — 사용자 피드백: 편집기에서 수동 수정. 코드 휴리스틱으로 bbox 보정하면 안 됨.
7. **UPLOAD_DIR 주의** — `.env` 의 값이 실제 경로. `config.py` 기본값(`/tmp/pdf_pipeline`) 아님.
8. **VL provider 확인** — Ollama(서버): `ollama list` 에 `gemma3:27b` 있어야 함. 로컬(집): `OPENAI_API_KEY` 필요.

## 관련 CMS UI

- `apps/cms/src/pages/PdfReview.tsx` — 문제 staging 검수 + bbox 편집.
- `apps/cms/src/pages/SolutionReview.tsx` — 해설 파이프라인 (크롭 → 묶기/확정 → 태깅 → 적용).

## 참고 커맨드

- `/solution-tagging-status` — 태깅 진행도/이어서 안내.
- `/bbox-verify` — staging bbox 이상치 탐지.
- `/migration-safety` — Supabase 마이그레이션 안전성 체크.

## AI 튜터 데이터 구조

상세 내용은 `backend/pdf_pipeline/ARCHITECTURE.md` 참조.
핵심: solution_steps(단계별 힌트) + common_mistakes(오답 원인) + problem_tags(concept/skill/bug) 가 AI 튜터의 진단·추천 기반.
