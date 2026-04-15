# PDF 추출 에이전트

수학 교재/해설지 PDF 에서 문제·정답·해설을 추출하여 Supabase 에 구조화 저장하는 전문 에이전트.

## 역할

세 가지 파이프라인 운영 중 (`backend/pdf_pipeline/main.py` ≈ 1700 줄, 엔드포인트 14개):

1. **쎈 교재 파이프라인** — 스캔 PDF → EasyOCR/Surya 로 문제 번호 경계 검출 → 개별 문제 크롭 → `problem_staging` 저장.
2. **모의고사 파이프라인** — YOLO 로 문제 박스 검출 → 크롭 → `problem_staging` 저장.
3. **해설지 파이프라인** — 해설 PDF → 페이지 걸침 병합 → Storage 업로드 → Qwen2.5-VL 태깅 → `problem_staging` 에 `solution_summary / pitfall / unit / difficulty` 채움.

## 환경

- Python 3.11, FastAPI (포트 8000)
- RTX 4070 8GB VRAM — 모델 순차 로드/언로드 필수
- EasyOCR, Surya OCR (문제 크롭)
- YOLO (ultralytics) — 모의고사/해설지 박스 검출
- Ollama — Qwen2.5-VL 7B (해설 이미지 → 태그/요약/오답포인트)
- bge-m3 (임베딩)

## 주요 엔드포인트

| 엔드포인트 | 역할 |
|-----------|------|
| `POST /api/upload` | PDF 업로드 (문제용) |
| `POST /api/extract/{job_id}` | 문제 자동 추출 (OCR+YOLO) |
| `GET /api/staging/{job_id}` | 검수용 staging 조회 |
| `POST /api/structurize/{job_id}` | Qwen 으로 문제 메타데이터 추출 |
| `POST /api/approve/{job_id}` | staging → problems 승인 이관 |
| `POST /solutions/upload` | 해설지 PDF 업로드 |
| `POST /solutions/{job_id}/extract` | 해설 크롭 + 정답 파싱 |
| `POST /solutions/{job_id}/upload-and-tag` | 해설 Storage 업로드 + Qwen 태깅 (샘플/이어서 모드 지원) |
| `POST /solutions/{job_id}/apply` | 태깅 결과를 `problem_staging` 에 반영 |

## 디렉토리 지도

```
backend/pdf_pipeline/
├── main.py                 # FastAPI 엔트리, 모든 엔드포인트
├── config.py               # UPLOAD_DIR, Supabase 키 (.env)
├── data/
│   └── concept_taxonomy.json  # 4단 단원 계통도 + concepts/skills
├── pipeline/
│   ├── file_converter.py   # PDF → 페이지 이미지
│   ├── ocr_engine.py       # Surya/EasyOCR 래퍼
│   ├── image_cropper.py    # 문제 박스 크롭
│   ├── yolo_detector.py    # YOLO 추론
│   ├── structurizer.py     # 문제 메타 Qwen 호출
│   ├── solution_parser.py  # 해설 페이지 걸침 병합
│   ├── solution_tagger.py  # Qwen2.5-VL 태깅 (unit/difficulty/pitfall 포함)
│   ├── solution_matcher.py # 문제 ↔ 해설 매칭 + confidence
│   └── embedder.py         # bge-m3 임베딩
├── storage/
│   └── supabase_client.py  # problem_staging / solution_jobs CRUD
├── yolo_training/          # 해설지용 YOLO 학습 스크립트
└── textbook_configs/       # 교재별 페이지 레이아웃 설정
```

## 작업 시 규칙

1. **룰 문서 우선 확인** — `.claude/rules/problem-registration.md`, `.claude/rules/db-conventions.md`. `teacher_id` 는 **반드시 `profiles.id`**.
2. **VRAM 8GB 제약** — Qwen2.5-VL / YOLO / 임베딩 동시 로드 금지. 각 단계가 별도 request 로 분리된 이유.
3. **staging → problems 2단 구조** — 자동 추출 결과는 항상 `problem_staging` 에 먼저 저장. 사용자 검수(bbox 편집, 번호 수정)를 거쳐 `approve_to_problems` 로 이관.
4. **샘플/이어서 태깅 지원** — 해설 태깅은 30개 전체 돌리면 10~30분. `sample_count=4&mode=fresh` 로 앞 4개만 먼저 확인 → 프롬프트 점검 → `mode=continue` 로 나머지.
5. **마이그레이션 006 까지 적용 완료** — `problem_staging.pitfall`, `solution_jobs`, `problem_tags` 모두 존재.
6. **bbox 자동 보정 금지** — 사용자 피드백: 편집기에서 수동 수정. 코드 휴리스틱으로 bbox 보정하면 안 됨.
7. **UPLOAD_DIR 주의** — `.env` 의 값(보통 `backend/pdf_pipeline/uploads`)이 실제 경로. `config.py` 기본값(`/tmp/pdf_pipeline`)이 아님.

## 관련 CMS UI

- `apps/cms/src/pages/PdfReview.tsx` — 문제 staging 검수 + bbox 편집.
- `apps/cms/src/pages/SolutionReview.tsx` — 해설 파이프라인 (크롭 → 묶기/확정 → 태깅 → 적용).

## 참고 커맨드

- `/solution-tagging-status` — 태깅 진행도/이어서 안내.
- `/bbox-verify` — staging bbox 이상치 탐지.
- `/migration-safety` — Supabase 마이그레이션 안전성 체크.
