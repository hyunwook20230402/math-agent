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
│    └─ YOLO11 로 문제 박스 검출 (쎈/모의고사 공통)                │
│                   → yolo_detector.detect()                        │
│                   (OCR 레거시 제거 — 커밋 0f633eb)                │
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
│  메타 태깅 (solution_tagger.extract_tags_from_image)             │
│    - Call A (메타): vl_providers.call_vl() → OpenAI (한 번)       │
│      (difficulty_score, correct_rate, concept_tags,               │
│       skill_tags, answer_type)                                    │
│    - tag_normalizer 로 concept/skill canonical 매칭               │
│    - unit_matcher 로 bge-m3 cosine → units leaf 매핑             │
│    - difficulty_resolver: correct_rate 있으면 난이도 구간매핑     │
│    │   (옛 Call B 단계별풀이·4필드는 4차에서 제거,                │
│    │    옛 tag_validator 2-layer 검증은 2026-06-22 폐기)          │
│    ▼                                                              │
│  problem_staging 저장                                             │
│    (unit, difficulty, difficulty_score, correct_rate)             │
│    │   (validation_* 컬럼은 DB 보존이나 항상 NULL)               │
│    ▼                                                              │
│  problem_tags 저장 (concept/skill 정규화 레코드)                  │
│    │                                                              │
│    ▼                                                              │
│  승인 → problems 테이블                                           │
└─────────────────────────────────────────────────────────────────┘

  풀이 그래프 (RAG 코퍼스, 별도 추출 — solution_tagger 와 독립):
    해설 이미지 → rag_node_extractor (1회 통합 VL, uses/whys)
                → solution_nodes → CMS 노드 편집기(routers/nodes.py)
                → 막힌 지점 도우미(routers/tutor.py)
```

---

## 2. Provider 운영 전략

### 2.1 VL = OpenAI 단일 (2026-06-19)

이미지 분석(VL) 호출은 OpenAI 하나로 통일. gemma4(ollama)/gemini 는 폐기.

| 호출 | Provider | 비고 |
|------|----------|------|
| Call A (메타) | OpenAI | `OPENAI_MODEL` (기본 gpt-4o). 해설 태깅은 이 한 번뿐(Call B 제거, 4차) |
| 검증 Layer 2 | OpenAI | 난이도 무관 항상 OpenAI |
| 막힌 지점 도우미 (튜터) | OpenAI | 막힌 지점 찾기 / 힌트 만들기 / 노드추출(1회 통합) |

- `call_vl(...)` 은 항상 OpenAI 호출. `provider` 인자는 하위호환용으로 받기만 하고 무시.
- 옛 `provider_selector.py`(시간대 분기), `_route_call_b_provider`(난이도 분기), gemma4 반복 폭주 방어 코드는 모두 제거됨.

### 2.2 임베딩은 그대로 (bge-m3 / Ollama)

VL 과 달리 임베딩은 bge-m3(Ollama, 1024차원) 유지.

- OpenAI 임베딩은 1536차원이라 바꾸면 `problems`·`solution_nodes` 전체 재임베딩이 필요 → 안 바꿈.
- 기본 ollama 고정. `EMBED_PROVIDER=openai` 로만 강제 전환 가능(차원 혼입 주의).

### 2.3 공통

- **모든 LLM 호출은 Pydantic structured output 강제** — free-form JSON 파싱 없음.
- OpenAI 응답이 토큰 한계로 잘리면(`status=incomplete`) 조용한 손상 대신 loud fail.

---

## 3. 파이프라인 모듈 책임

| 모듈 | 역할 |
|------|------|
| `file_converter.py` | PDF → 페이지 이미지 (PyMuPDF) |
| `image_cropper.py` | 문제 박스 크롭. `_imread_unicode` / `_imwrite_unicode` (한글 경로 대응) |
| `yolo_detector.py` | 모의고사 문제 박스 YOLO 추론 (conf=0.3) |
| `yolo_solution_detector.py` | 해설지 박스 YOLO 추론 |
| `solution_parser.py` | 정답표/인라인 정답·정답률 파싱 + 페이지 걸침 해설 병합 |
| `vl_providers.py` | VL 호출 (OpenAI 단일). `call_vl(image_path, prompt, schema)` |
| `embedder.py` | 텍스트 → 벡터 (bge-m3 1024d, Ollama 고정) |
| `solution_tagger.py` | Call A(메타) VL 호출 → TagResultMeta → tag_normalizer/unit_matcher 후처리 → DB 저장 |
| `difficulty_resolver.py` | correct_rate → 난이도 구간매핑 (있으면 GPT 추정보다 우선) |
| `rag_node_extractor.py` | 풀이 그래프 노드 1회 통합 추출(uses/whys) → solution_nodes (RAG 코퍼스) |
| `tag_normalizer.py` | 태그 문자열 → concepts/skills canonical 매칭 (cosine ≥ 0.65) |
| `unit_matcher.py` | 태그 문자열 → units leaf 경로 매칭 (cosine, 캐시 pkl) |
| `solution_matcher.py` | 문제 ↔ 해설 번호 매칭 + match_confidence |
| `ocr_engine.py` | EasyOCR 래퍼 (레거시 — 현재 흐름 미사용) |

---

## 4. AI 태깅 스키마 (TagResultMeta)

해설 태깅은 **Call A 한 번**(VL=OpenAI)으로 메타만 뽑는다. 옛 단계별풀이(Call B 2-Pass)와 4필드(solution_summary/pitfall/solution_steps/common_mistakes)는 **4차에서 추출·저장·검증·DB컬럼까지 전부 제거**. 풀이 그래프는 별도 추출기(`rag_node_extractor.py`)가 담당한다(§8).

```python
class TagResultMeta(BaseModel):
    difficulty_score: int                 # 1~10 정수 (정답률 우선, 없으면 구조 신호)
    correct_rate: float | None            # 해설 이미지에 "정답률 N%" 명시 시 0~100, 없으면 null(추측 금지)
    concept_tags: list[str]               # 1~3개 (빈 리스트 금지), 한국어 canonical
    skill_tags: list[str]                 # 1~3개 (빈 리스트 금지), 한국어 canonical
    answer_type: str | None               # "multiple_choice" | "short_answer"
```

**난이도 (difficulty_score)** — 정답률 우선, 없으면 구조 신호:
- 정답률 있으면 `difficulty_resolver` 구간매핑(80%↑=2 / 60~80=4 / 40~60=6 / 20~40=8 / 20%↓=10).
- 정답률 없으면 구조 신호(경우분리 개수·중첩 깊이·개념 복합도)로 1~10. 하한 규칙: 경우분리 3+ → 최소 8, 신호 2+ → 최소 9. 문제 번호는 참고만(시대 무관).

후처리:
- `tag_normalizer` 가 concept/skill 을 `concept_taxonomy.json` canonical 로 정규화 (cosine ≥ 0.65)
- `unit_matcher` 가 태그 조합으로 단원 경로 결정 (예: `"대수 > 삼각함수"`)
- `difficulty_resolver` 가 correct_rate 있으면 난이도를 구간매핑으로 덮어씀

> ℹ️ 옛 2-layer 태깅 검증(`tag_validator.py`, suggested_fixes 자동 반영)은 2026-06-22 폐기. Call A 결과를 그대로 저장한다. `validation_*` 컬럼은 DB 보존이나 항상 NULL.

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
| `correct_rate` | float | 해설 정답률(0~100), 난이도 구간매핑 입력 |
| `image_url` | text | Supabase Storage 문제 이미지 |

> 옛 `solution_summary`·`pitfall`·`solution_steps`·`common_mistakes` 컬럼은 4차(2026-06-20)에 DROP. 풀이는 별도 `solution_nodes` 테이블(§8)로 이전.

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
| POST | `/api/extract/{job_id}` | YOLO11 추출 (비동기) |
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

API: `POST /api/tutor/hint` (학생, `routers/tutor.py`, `main.py include_router(prefix=/api/tutor)`)
흐름: 막힌 지점 찾기 → 유사 풀이 끌어오기 → 힌트 만들기 (`handlers/stuck_helper.py`). 서버 무상태.
노드 코퍼스: `solution_nodes` 테이블 (uses/whys 포함, baseline 에 반영) + RPC `search_solution_nodes_for_hint`
노드 추출: `pipeline/rag_node_extractor.py` (해설 이미지 **1회 통합** VL 분해 — 전체 노드 배열 1회 structured output, 각 노드에 uses(전이 DAG)+whys(논리 근거) 포함 → `backfill_solution_nodes.py` 로 적재). VL=OpenAI 단일.
노드 편집(교사): `routers/nodes.py` — CMS 노드 편집기 CRUD(조회·수정·추가·삭제·재추출). 수정 시 임베딩 자동 재생성, uses DAG acyclic 정제, node_index 순번 재매김.

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

### 오답 원인 진단 (problem_tags.bug_id)
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

## 10. 마이그레이션 (baseline 리셋, 2026-06-20)

엉킨 001~016 드리프트를 해소하고 **현재 원격 DB 구조 전체를 `baseline_20260620.sql` 한 장으로 스냅샷**했다. 이후 변경은 `017_` 부터 순번. 옛 001~016 은 `_archive/`(역사 보존, 새 환경 실행 금지).

| 파일 | 내용 |
|------|------|
| `baseline_20260620.sql` | 원격 구조 전체 — 테이블 18(problems, problem_staging, problem_tags, solution_jobs, solution_nodes(uses/whys), problem_sets, …) + FK·UNIQUE·인덱스·트리거 + RPC 2개(recalc_set_difficulty, search_solution_nodes_for_hint) |
| `017_fix_recalc_set_difficulty_column.sql` | baseline 이후 첫 변경(세트 난이도 함수 버그 수정) |

신규 환경: baseline 한 장 → 017 이상 순서로 실행. 상세 `supabase/migrations/README.md`.

> 4차 정리(015/016, `_archive/`): 옛 해설 4컬럼(solution_summary/pitfall/solution_steps/common_mistakes) DROP + `tags`·`problem_sets_new` 테이블 DROP — 결과는 baseline 에 반영됨.
