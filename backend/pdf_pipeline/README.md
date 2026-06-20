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

**baseline 리셋(2026-06-20).** 현재 원격 구조 전체를 `baseline_20260620.sql` 한 장으로 스냅샷했다. 이후 변경은 `017_` 부터 순번으로 쌓는다. 옛 001~016 은 `_archive/`(역사 보존, 새 환경 실행 금지).

신규 환경 셋업 시:
```
supabase/migrations/baseline_20260620.sql 한 장 실행 → 017_*.sql 이상 순서로 실행
```

상세는 `supabase/migrations/README.md`.

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
│   └── TAG_VALIDATOR.md       # 2-layer 검증 에이전트 상세 (Layer 1 rule / Layer 2 OpenAI)
├── requirements.txt
├── data/
│   └── concept_taxonomy.json  # concepts 375 / skills 359 / units 15 / bugs 14
├── pipeline/
│   ├── file_converter.py        # PDF → 페이지 이미지 (PyMuPDF)
│   ├── image_cropper.py         # 문제 박스 크롭 (OpenCV, 한글 경로 대응)
│   ├── ocr_engine.py            # EasyOCR 래퍼 (레거시 — 현재 흐름 미사용)
│   ├── yolo_detector.py         # 모의고사 문제 박스 YOLO 추론
│   ├── yolo_solution_detector.py # 해설 박스 YOLO 추론
│   ├── solution_parser.py       # 해설 크롭 + 정답·정답률 파싱 + 페이지 걸침 병합
│   ├── vl_providers.py          # VL 호출 (OpenAI 단일) — call_vl(image, prompt, schema)
│   ├── solution_tagger.py       # Call A(메타) + 정답률 난이도(difficulty_resolver) + _apply_suggested_fixes
│   ├── difficulty_resolver.py   # 정답률 → 난이도 구간매핑
│   ├── rag_node_extractor.py    # 풀이 그래프 노드 1회 통합 추출(uses/whys) — 막힌 지점 도우미 코퍼스
│   ├── tag_normalizer.py        # 태그 → canonical 매칭 (bge-m3 cosine ≥ 0.65)
│   ├── unit_matcher.py          # 태그 → units leaf 경로 매핑 (bge-m3)
│   ├── tag_validator.py         # 2-layer 태깅 검증 에이전트 → docs/TAG_VALIDATOR.md
│   ├── embedder.py              # 임베딩 (bge-m3, Ollama 고정)
│   └── solution_matcher.py      # 문제 ↔ 해설 번호 매칭
├── routers/
│   ├── tutor.py               # POST /api/tutor/hint (학생, 막힌 지점 도우미)
│   └── nodes.py               # 풀이 노드 CRUD (교사, CMS 노드 편집기)
├── handlers/
│   └── stuck_helper.py        # 막힌 지점 찾기 → 유사 풀이 끌어오기 → 힌트 만들기
└── storage/
    └── supabase_client.py     # problem_staging / solution_jobs CRUD
```

## 처리 흐름

```
문제 PDF → YOLO11 크롭 → problem_staging → CMS 검수 → problems 테이블

해설 PDF → 페이지 이미지 → 걸침 병합 → 메타 태깅 (Call A, OpenAI 단일)
           ├─ Call A (메타: 정답률/concept/skill/난이도/단원) — 정답률 있으면 난이도 구간매핑
           ├─ tag_normalizer (canonical) + unit_matcher (단원)
           └─ tag_validator (2-layer; Layer 2 OpenAI)
         → problem_staging → problem_tags
         → CMS 검수 (재태깅 / 전체 재태깅 버튼) → problems 테이블

풀이 그래프 (RAG 코퍼스, 별도 추출):
해설 이미지 → rag_node_extractor (1회 통합 VL, uses/whys) → solution_nodes
           → CMS 노드 편집기(routers/nodes.py) 수동 보정
           → 막힌 지점 도우미(routers/tutor.py) 막힌 지점 찾기→유사 풀이 끌어오기→힌트 만들기
```

상세는:
- 데이터 흐름 / DB 스키마: `ARCHITECTURE.md`
- 검증 에이전트 동작: `docs/TAG_VALIDATOR.md`

## 막힌 지점 도우미 (AI 튜터, 통합)

별도 백엔드 없음 — 이 파이프라인(8001) 안에 통합됐다. _구 `backend/deeptutor/`(LangGraph 다중턴 대화)는 2026-06-18 폐기·삭제._

- API: `POST /api/tutor/hint` (학생) — `routers/tutor.py`. 흐름 `handlers/stuck_helper.py` 막힌 지점 찾기→유사 풀이 끌어오기→힌트 만들기.
- 데이터: `solution_nodes`(uses/whys, bge-m3 1024) + RPC `search_solution_nodes_for_hint`. 적재 `scripts/backfill_solution_nodes.py`.
- 노드 편집(교사): `routers/nodes.py` — CMS 노드 편집기 CRUD. 수정 시 임베딩 자동 재생성.
