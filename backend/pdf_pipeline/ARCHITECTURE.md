# PDF 파이프라인 아키텍처 — AI 튜터 데이터 구조

이 문서는 수학 문제/해설 PDF 에서 AI 튜터가 활용할 데이터가 어떻게 쌓이는지 설명한다.
운영 방법(실행 명령)은 `README.md` 참조.

---

## 1. 전체 흐름

```
┌─────────────────────────────────────────────────────────────────┐
│ 문제 PDF 경로                                                     │
│                                                                   │
│  PDF 업로드                                                       │
│    │                                                              │
│    ├─ [쎈 교재] EasyOCR/Surya 로 문제번호 경계 검출              │
│    │              → image_cropper.crop_and_save()                 │
│    │                                                              │
│    └─ [모의고사] YOLO 로 문제 박스 검출                           │
│                   → yolo_detector.detect()                        │
│                                                                   │
│    문제 크롭 이미지 → problem_staging (bbox, source_image_url)   │
│    CMS 검수 (bbox 편집, 번호 수정)                                │
│    승인 → problems 테이블                                         │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ 해설 PDF 경로  ← AI 튜터 데이터의 핵심                           │
│                                                                   │
│  해설 PDF 업로드                                                  │
│    │                                                              │
│    ▼                                                              │
│  solution_parser.crop_solutions()                                 │
│    - PDF → 페이지 이미지 (300 DPI)                                │
│    - 페이지 걸침 해설 조각 병합 (np.concatenate)                  │
│    │                                                              │
│    ▼                                                              │
│  정답 파싱 (solution_parser.extract_answers)                      │
│    - 정답표 OCR 또는 "N) ④" 인라인 패턴                          │
│    │                                                              │
│    ▼                                                              │
│  VL 태깅 (solution_tagger.extract_tags_from_image)               │
│    - Call A (메타): vl_providers.call_vl() → 항상 ollama gemma4   │
│    - Call B (steps): 어려움(≥THRESHOLD) → OpenAI gpt-5.4-mini     │
│                       그 외 → ollama gemma4                       │
│    - tag_normalizer 로 concept/skill canonical 매칭               │
│    - unit_matcher 로 bge-m3 cosine → units leaf 매핑             │
│    │                                                              │
│    ▼                                                              │
│  tag_validator (3-layer 검증)                                     │
│    - Layer 1: Rule 기반 (필드 누락, 영어 혼입, unit_score < 0.5)  │
│    - Layer 2: LLM 재검증 (이미지 + 태깅 결과 cross-check)         │
│                어려움(≥THRESHOLD) → OpenAI, 그 외 → ollama        │
│    - Layer 3: 임베딩 자가체크 (solution_steps ↔ concept_tags)    │
│    → 상세: docs/TAG_VALIDATOR.md, docs/CALL_B_ROUTING.md          │
│    │                                                              │
│    ▼                                                              │
│  problem_staging 저장                                             │
│    (solution_summary, pitfall, unit, difficulty,                  │
│     solution_steps, common_mistakes,                              │
│     validation_status, validation_score, validation_issues)       │
│    │                                                              │
│    ▼                                                              │
│  problem_tags 저장 (concept/skill 정규화 레코드)                  │
│    │                                                              │
│    ▼                                                              │
│  승인 → problems 테이블 (solution_steps, common_mistakes 포함)    │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. Provider 운영 전략

### 2.1 시간대 기반 (provider_selector)

| 시간대 | 위치 | VL Provider 기본 | Embed Provider |
|--------|------|------------------|----------------|
| 평일 09:00~19:00 KST | 서버 (회사) | **Ollama Gemma4 26B** | **bge-m3** (Ollama) |
| 그 외 | 집 | **OpenAI gpt-4o** (오프시간 기본) | **OpenAI** (text-embedding-3-small) |

- `pipeline/provider_selector.py` 가 시간대 감지 → `VL_PROVIDER` / `EMBED_PROVIDER` 결정
- 환경변수로 강제 override 가능: `VL_PROVIDER=ollama` (서버 Ollama 고정 운영 시)
- `VL_PROVIDER=ollama` 시 OpenAI fallback 차단 (`vl_providers._call_ollama_with_fallback`)

### 2.2 호출별 강제 분기 (4차 도입, 2026-04-22)

`call_vl(image_path, prompt, schema, *, provider="openai")` 로 시간대와 무관하게 호출별 provider 강제 가능. 운영 정책:

| 호출 | difficulty | Provider | 모델 |
|------|------------|----------|------|
| Call A (메타) | 무관 | 시간대 기본 (보통 ollama) | gemma4:26b |
| Call B (steps) | < `CALL_B_HARD_THRESHOLD` | ollama | gemma4:26b |
| **Call B (steps)** | ≥ `CALL_B_HARD_THRESHOLD` | **OpenAI 강제** | **gpt-5.4-mini** |
| 검증 Layer 2 | < `CALL_B_HARD_THRESHOLD` | 시간대 기본 | gemma4:26b |
| **검증 Layer 2** | ≥ `CALL_B_HARD_THRESHOLD` | **OpenAI 강제** | **gpt-5.4-mini** |

기본 `CALL_B_HARD_THRESHOLD=7`. Call B 와 검증이 같은 임계값을 공유 — 어려운 문제 일관성. 상세: `docs/CALL_B_ROUTING.md`.

### 2.3 공통

- Ollama 접속 실패 시 OpenAI 자동 fallback (`VL_PROVIDER=ollama` 명시 시 차단됨 — 비용 제어)
- **모든 LLM 호출은 Pydantic structured output 강제** — free-form JSON 파싱 없음
- 서버 Ollama 모델: `gemma4:26b` (19GB, vision, RTX 4090 24GB). 이전 `gemma3:27b` 는 2026-04-21 교체
- Gemini 분기는 `vl_providers.py` 에 코드 잔존하지만 **운영 스택에선 빠짐** (free tier 한도로 실용성 부족)

---

## 3. 파이프라인 모듈 책임

| 모듈 | 역할 |
|------|------|
| `file_converter.py` | PDF → 페이지 이미지 (PyMuPDF) |
| `image_cropper.py` | 문제 박스 크롭. `_imread_unicode` / `_imwrite_unicode` (한글 경로 대응) |
| `yolo_detector.py` | 모의고사 문제 박스 YOLO 추론 (conf=0.3) |
| `yolo_solution_detector.py` | 해설지 박스 YOLO 추론 |
| `solution_parser.py` | 정답표/인라인 정답 OCR 파싱 + 페이지 걸침 해설 병합 |
| `vl_providers.py` | Ollama/Gemini/OpenAI provider 분기. `call_vl(image_path, prompt, schema)` |
| `provider_selector.py` | 시간대 감지 → VL/Embed provider 자동 선택 |
| `embedder.py` | 텍스트 → 벡터 (Ollama bge-m3 1024d / OpenAI 3-small 1536d) |
| `solution_tagger.py` | VL 호출 → TagResult → tag_normalizer/unit_matcher 후처리 → DB 저장 |
| `tag_normalizer.py` | 태그 문자열 → concepts/skills canonical 매칭 (cosine ≥ 0.65) |
| `unit_matcher.py` | 태그 문자열 → units leaf 경로 매칭 (cosine, 캐시 pkl) |
| `tag_validator.py` | 3-layer 검증 에이전트 → ValidationResult |
| `solution_matcher.py` | 문제 ↔ 해설 번호 매칭 + match_confidence |
| `ocr_engine.py` | EasyOCR 래퍼 (Korean+English, GPU) |

---

## 4. AI 태깅 스키마 (TagResult)

VL 모델이 해설 이미지 1장에서 추출하는 필드:

```python
class TagResult(BaseModel):
    difficulty_score: int                 # 1~10 정수 (1-2=very_easy ... 9-10=very_hard, 구조 신호 기반)
    concept_tags: list[str]               # 최대 3개, 한국어 canonical
    skill_tags: list[str]                 # 최대 3개, 한국어 canonical
    answer_type: str | None               # "multiple_choice" | "short_answer"
    solution_summary: str | None          # 풀이 요약, 20단어 이내
    pitfall: str | None                   # 오답포인트, 20단어 이내
    solution_steps: list[SolutionStep]    # 난이도별 2~12 steps, 점진 증가
    common_mistakes: list[CommonMistake]  # 2-3개 [{text, bug_id?}]

class SolutionStep(BaseModel):
    step: int
    hint: str                             # 학생에게 공개하는 힌트 문장 (한국어, 수식 인라인 허용)
    formula: str                          # 이 힌트의 핵심 식 \( ... \) — 필수, null 금지
    concept: str                          # 이 힌트가 짚는 개념/정리 이름 (한국어 1~3단어, 필수)
```

**난이도 (difficulty_score)** 구조 신호 기반 판정:
- 1-2 (very_easy): 공식 1개 직접 대입
- 3-4 (easy): 2~3단 계산, 개념 1개 내
- 5-6 (medium): 조건 2~3개 조합, 개념 1~2개
- 7-8 (hard): 경우분리 2개 / 그래프+대수 / 합성·역·절댓값 1개 / 개념 2~3개 복합 중 1개
- 9-10 (killer): 위 신호 2개 이상 해당 (경우분리 3+, 중첩 2+, 미지수 2+, 스텝 7+ 등)

**solution_steps 개수**: 모델 자율 결정 (4차에서 난이도별 강제 폐지). 빈 리스트만 금지. `CALL_B_MAX_STEPS` (기본 15) 가 상한 안전장치로만 작동. 자세한 step 품질 검증은 `docs/TAG_VALIDATOR.md` Layer 1 참조.

**Call B 구조 (5차, 2026-04-23)**: 한 번에 전체 steps 리스트를 뽑는 한방 호출에서 **per-step loop** 로 전환. 매 호출마다 이미지(문제+해설) + 누적된 이전 steps 요약을 프롬프트에 넣고 "다음 step 하나만" 생성. 모델이 `{"done": true}` 반환하면 루프 종료. 출력 토큰이 짧아 gemma4 repetition 폭주 확률 급감. 상세: `docs/CALL_B_ROUTING.md`.

**필드명 이력 (2026-04-23)**: `description / formula / reason` → `hint / formula / concept` 로 통일 (4차 리팩터 연장). 학생에게 공개되는 힌트 의미를 필드명에 직접 반영 + 3필드 모두 필수로 강화.

후처리:
- `tag_normalizer` 가 concept/skill 을 `concept_taxonomy.json` canonical 로 정규화 (cosine ≥ 0.65)
- `unit_matcher` 가 태그 조합으로 단원 경로 결정 (예: `"대수 > 삼각함수"`)
- `tag_validator` 3-layer 검증 → `validation_status` (ok/warning/reject) + `validation_score` — `docs/TAG_VALIDATOR.md`
- `suggested_fixes` 가 있으면 canonical 매칭 성공 시 자동 반영 (`applied: true` 플래그)

---

## 5. DB 스키마 (AI 튜터 관점)

### `problems` (최종 등록)

| 컬럼 | 타입 | 설명 |
|------|------|------|
| `id` | uuid | PK |
| `teacher_id` | uuid | → profiles.id |
| `unit` | text | `"과목 > 대단원 > 중단원"` |
| `difficulty_score` | int | 1~10 (쓰기 컬럼) |
| `difficulty` | text | very_easy/easy/medium/hard/very_hard (GENERATED from difficulty_score) |
| `answer_type` | text | multiple_choice/short_answer |
| `correct_answer` | text | 정답 |
| `solution_summary` | text | AI 추출 풀이 요약 |
| `pitfall` | text | AI 추출 오답포인트 |
| `solution_steps` | jsonb | `[{step, hint, formula, concept}, ...]` — 단계별 힌트용 (3필드 모두 필수, null 금지) |
| `common_mistakes` | jsonb | `[{text, bug_id}, ...]` — 오답 원인 진단용 |
| `image_url` | text | Supabase Storage 문제 이미지 |

### `problem_staging` (검수 중간 저장)

problems 와 동일 구조 + 검수용 컬럼:

| 추가 컬럼 | 타입 | 설명 |
|-----------|------|------|
| `source_image_url` | text | 원본 페이지 이미지 URL |
| `bbox` | jsonb | `{x, y, width, height}` — 크롭 좌표 |
| `source_page` | int | 원본 PDF 페이지 번호 |
| `match_confidence` | float | 문제↔해설 매칭 신뢰도 |
| `solution_job_id` | uuid | → solution_jobs.id |
| `validation_status` | text | ok/warning/reject |
| `validation_score` | float | 0.0~1.0 |
| `validation_issues` | jsonb | `[{field, reason, severity, applied}, ...]` |

### `problem_tags` (concept/skill 정규화)

| 컬럼 | 타입 | 설명 |
|------|------|------|
| `problem_id` | uuid | → problems.id or staging.id |
| `tag_type` | text | "concept" / "skill" / "bug" |
| `canonical` | text | 정규화된 태그명 |
| `raw_tag` | text | VL 모델 원본 출력 |
| `score` | float | cosine 매칭 점수 |
| `bug_id` | text | bugs taxonomy key (오답 원인 분류) |

### `solution_jobs` (백그라운드 잡)

| 컬럼 | 타입 | 설명 |
|------|------|------|
| `id` | uuid | PK |
| `problem_job_id` | uuid | 대응 문제 job |
| `status` | text | pending/tagging/done/failed |
| `progress` | jsonb | `{fragments, tag_results}` — 번호별 진행 상황 |
| `error` | text | 실패 시 에러 메시지 |

---

## 6. Taxonomy (`data/concept_taxonomy.json`)

AI 튜터 온톨로지의 기반. 이 파일을 기준으로 모든 태깅이 정규화된다.

| 카테고리 | canonical 수 | 설명 |
|----------|-------------|------|
| `concepts` | **375** | 수학 개념 (예: "삼각함수 방정식과 부등식", "판별식") |
| `skills` | **359** | 풀이 기법 (예: "인수분해", "치환", "그래프 해석") |
| `bugs` | **14** | 오답 원인 유형 (예: "부호 오류", "조건 누락") |
| `units` | **15** | 소단원 — 5개 과목 × 3개 단원 구조 |

**units 구조** (AI 튜터 단원 추천 기준):
```
공통수학1 > 다항식
공통수학1 > 방정식과 부등식
공통수학1 > 도형의 방정식
공통수학2 > 집합과 명제
공통수학2 > 함수와 그래프
공통수학2 > 경우의 수
대수 > 지수함수와 로그함수
대수 > 삼각함수
대수 > 수열
미적분I > 함수의 극한과 연속
미적분I > 다항함수의 미분법
미적분I > 다항함수의 적분법
확률과 통계 > 경우의 수
확률과 통계 > 확률
확률과 통계 > 통계
```

각 canonical 에는 `synonyms` 배열(약 2,300+ 개)이 있어 태그 정규화 품질을 높임.
`scripts/expand_taxonomy.py` 로 동의어 추가, `scripts/generate_canonicals_from_units.py` 로 canonical 확장.

---

## 7. API 엔드포인트 요약

### 문제 파이프라인

| 메서드 | 경로 | 설명 |
|--------|------|------|
| POST | `/api/upload` | 문제 PDF 업로드 |
| POST | `/api/extract/{job_id}` | OCR/YOLO 추출 (비동기) |
| GET | `/api/jobs/{job_id}` | 추출 진행 상황 |
| GET | `/api/staging/{job_id}` | 검수용 staging 목록 |
| PATCH | `/api/staging/{staging_id}` | bbox/번호 수정 |
| POST | `/api/staging/{job_id}/approve-all` | staging → problems 승인 |
| GET | `/api/staging/{staging_id}/tags` | 문제 태그 조회 |

### 해설 파이프라인

| 메서드 | 경로 | 설명 |
|--------|------|------|
| POST | `/api/solution/upload` | 해설 PDF 업로드 |
| POST | `/api/solution/extract/{solution_job_id}` | 해설 크롭 + 정답 파싱 |
| POST | `/api/solution/{solution_job_id}/upload-and-tag` | 해설 Storage 업로드 + VL 태깅 |
| GET | `/api/solution/status/{solution_job_id}` | 태깅 진행 상황 |
| POST | `/api/solution/match/{solution_job_id}` | 문제↔해설 매칭 |
| POST | `/api/solution/apply/{solution_job_id}` | 태깅 결과 → staging 반영 |

**태깅 모드** (`upload-and-tag` 쿼리 파라미터):
- `mode=fresh&sample_count=4` — 앞 4개만 (프롬프트/taxonomy 검증용)
- `mode=continue` — 이미 태그된 번호 건너뛰고 나머지
- `mode=fresh` (기본) — 전체 재태깅

---

## 8. AI 튜터 활용 포인트 (막힌 지점 도우미 — 풀이 그래프 위치추적 RAG)

> 구 deeptutor(LangGraph 다중턴 대화)는 **폐기됨 (2026-06-18)**. 막힌 지점 도우미만 이 파이프라인으로 이전·개선.

API: `POST /api/tutor/hint` (`routers/tutor.py`, `main.py include_router(prefix=/api/tutor)`)
흐름: localize → retrieve → generate (`handlers/stuck_helper.py`). 서버 무상태.
노드 코퍼스: `solution_nodes` 테이블 (마이그레이션 `add_solution_nodes`) + RPC `search_solution_nodes_for_hint`
노드 추출: `pipeline/rag_node_extractor.py` (해설 이미지 2-pass VL 분해 → `backfill_solution_nodes.py` 로 적재)

### 풀이 노드 검색 (solution_nodes — 위치추적 RAG 핵심)
```sql
-- 학생 막힌 서술 임베딩(bge-m3 1024)으로 다음 노드 + 유사 기출 노드 검색
SELECT * FROM search_solution_nodes_for_hint(
  query_embedding := $emb,        -- embedder.generate_embedding(막힌 서술 + 다음 개념)
  current_problem_id := $pid,
  current_node_index := $idx,     -- 위치추적된 현재 인덱스
  match_limit := 5
);
-- 현재 문제의 다음 노드 우선 + 같은 개념 타 기출 노드 보조. is_same_problem 플래그로 구분.
-- node: {role, key_concept, output_formula(LaTeX), figure_description, figure_image_crop_url}
```

아래 쿼리는 튜터가 보조로 참조하는 데이터 패턴.

### 단계별 힌트 (solution_steps)
```sql
SELECT solution_steps FROM problems WHERE id = $problem_id;
-- [{step: 1, hint: "시그마를 두 항으로 분리해볼까?",
--   formula: "\\(\\sum (a_k+1) = \\sum a_k + \\sum 1\\)", concept: "시그마 분배"}, ...]
-- 학생이 막혔을 때 step 1 → step 2 순서로 공개.
-- hint (학생에게 보여주는 힌트) → formula (식) → concept (개념명) 3단 구조.
```

### 오답 원인 진단 (common_mistakes + bug_id)
```sql
SELECT cm.text, cm.bug_id
FROM problem_tags pt
JOIN problems p ON pt.problem_id = p.id
WHERE pt.bug_id IS NOT NULL AND p.unit = $unit;
-- bug_id 로 taxonomy bugs 카테고리 참조 → "부호 오류", "조건 누락" 등
```

### 유사 문제 추천 (problem_tags + unit)
```sql
SELECT p.*
FROM problems p
JOIN problem_tags pt ON pt.problem_id = p.id
WHERE pt.canonical = $concept_canonical
  AND p.unit = $unit
  AND p.difficulty = $difficulty
  AND p.id != $current_problem_id
LIMIT 5;
```

### 임베딩 기반 유사 문제 (후속 — 현재 미구현)
- `problem_tags.canonical` 벡터 + unit_matcher 임베딩 캐시 활용
- `embedder.generate_embedding(concept_text)` 로 실시간 cosine 검색
- 구 `deeptutor/handlers/similar_problems.py` 는 폐기됨. 필요 시 `solution_nodes` 검색(위 RPC)으로 유사 기출 노드가 이미 제공되므로 별도 문제-단위 추천은 후속 판단.

---

## 9. 스토리지 구조

```
uploads/                             ← UPLOAD_DIR (.env 로 설정)
├── problems/
│   ├── <job_id>/                    ← 문제 크롭 이미지
│   └── dataset/                    ← YOLO 학습 데이터
│       ├── images/{train,val}/
│       └── labels/{train,val}/
└── solutions/
    ├── <job_id>/
    │   ├── _pages/                  ← PDF 페이지 이미지
    │   └── solution_crops/          ← 해설 크롭 이미지 (AI 태깅 입력)
    └── dataset/                    ← 해설지 YOLO 학습 데이터
```

Supabase Storage (`problem-images` 버킷) 에는 CMS 검수 완료 후 승인된 이미지만 업로드됨.

---

## 10. 마이그레이션 이력

| 번호 | 파일 | 주요 변경 |
|------|------|-----------|
| 001 | `001_fix_image_url_and_add_staging.sql` | image_url 수정 + problem_staging 추가 |
| 002 | `002_add_structuring_columns.sql` | 구조화 컬럼 추가 |
| 003 | `003_add_textbook_relations.sql` | 교재 관계 테이블 |
| 004 | `004_add_bbox_columns.sql` | bbox JSONB 컬럼 |
| 005 | `005_add_solution_and_tags.sql` | solution_jobs, problem_tags 테이블 |
| 006 | `006_problem_staging_pitfall.sql` | pitfall, match_confidence 컬럼 |
| 007 | `007_deeptutor_conversation.sql` | ~~DeepTutor student_conversations~~ — **폐기(원격 미적용)**. 로컬 파일 deprecated |
| 008 | `008_add_ontology_columns.sql` | solution_steps, common_mistakes JSONB |
| 009 | `add_validation_columns` (원격 DB 전용) | validation_status/score/issues 컬럼 |
| 010 | `add_difficulty_score` (원격 DB 전용) | difficulty_score INT 1~10 + 5단계 GENERATED 라벨 |
| **011** | `011_add_solution_nodes.sql` | **solution_nodes 테이블 + RPC search_solution_nodes_for_hint (튜터 RAG)** ← 현재 |

⚠️ 009·010 은 로컬 `supabase/migrations/` 폴더엔 파일 없음(원격 전용). 011 은 로컬 파일 존재(원격 `add_solution_nodes` 로 적용됨). Supabase MCP `list_migrations` 로 확인.
