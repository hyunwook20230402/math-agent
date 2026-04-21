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
│    - vl_providers.call_vl() → Pydantic structured output         │
│    - tag_normalizer 로 concept/skill canonical 매칭               │
│    - unit_matcher 로 bge-m3 cosine → units leaf 매핑             │
│    │                                                              │
│    ▼                                                              │
│  tag_validator (3-layer 검증)                                     │
│    - Layer 1: Rule 기반 (필드 누락, 영어 혼입, unit_score < 0.5)  │
│    - Layer 2: LLM 재검증 (이미지 + 태깅 결과 cross-check)        │
│    - Layer 3: 임베딩 자가체크 (solution_steps ↔ concept_tags)    │
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

| 시간대 | 위치 | VL Provider | Embed Provider |
|--------|------|-------------|----------------|
| 평일 09:00~19:00 KST | 서버 (회사) | **Ollama Gemma4 26B** | **bge-m3** (Ollama) |
| 그 외 | 집 | **OpenAI gpt-4o** (오프시간 기본) | **OpenAI** (text-embedding-3-small) |

- `pipeline/provider_selector.py` 가 시간대 감지 → `VL_PROVIDER` / `EMBED_PROVIDER` 결정
- 환경변수로 강제 override 가능: `VL_PROVIDER=openai`, `EMBED_PROVIDER=openai`
- Ollama 접속 실패 시 OpenAI 자동 fallback (집에서 서버 OFF 대응)
- 근무시간 범위 조정 이력: 09~18 → **09~19 KST** (커밋 `dd436d6`)

**모든 LLM 호출은 Pydantic structured output 강제** — free-form JSON 파싱 없음.

서버 Ollama 모델 현황: `gemma4:26b` (19GB, vision, RTX 4090 24GB). 이전 `gemma3:27b` 는 2026-04-21 gemma4 로 교체.

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
    difficulty: str                       # "easy" | "medium" | "hard"
    concept_tags: list[str]               # 최대 3개, 한국어 canonical
    skill_tags: list[str]                 # 최대 3개, 한국어 canonical
    solution_summary: str | None          # 풀이 요약, 20단어 이내
    pitfall: str | None                   # 오답포인트, 20단어 이내
    solution_steps: list[SolutionStep]    # 최대 5단계 [{step, description}]
    common_mistakes: list[CommonMistake]  # 2-3개 [{text, bug_id?}]
```

후처리:
- `tag_normalizer` 가 concept/skill 을 `concept_taxonomy.json` canonical 로 정규화 (cosine ≥ 0.65)
- `unit_matcher` 가 태그 조합으로 단원 경로 결정 (예: `"대수 > 삼각함수"`)
- `tag_validator` 3-layer 검증 → `validation_status` (ok/warning/reject) + `validation_score`
- `suggested_fixes` 가 있으면 canonical 매칭 성공 시 자동 반영 (`applied: true` 플래그)

---

## 5. DB 스키마 (AI 튜터 관점)

### `problems` (최종 등록)

| 컬럼 | 타입 | 설명 |
|------|------|------|
| `id` | uuid | PK |
| `teacher_id` | uuid | → profiles.id |
| `unit` | text | `"과목 > 대단원 > 중단원"` |
| `difficulty` | text | easy/medium/hard |
| `answer_type` | text | multiple_choice/short_answer |
| `correct_answer` | text | 정답 |
| `solution_summary` | text | AI 추출 풀이 요약 |
| `pitfall` | text | AI 추출 오답포인트 |
| `solution_steps` | jsonb | `[{step, description}, ...]` — 단계별 힌트용 |
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

## 8. AI 튜터 활용 포인트 (DeepTutor)

`backend/deeptutor/` 는 **운영 중** (LangGraph 다중턴 대화, ~800 LOC).
API: `POST /api/tutor/start`, `POST /api/tutor/chat/{conversation_id}` (`routers/tutor.py`)
대화 상태 저장: `student_conversations` 테이블 (마이그레이션 007)
유사 문제 검색: `handlers/similar_problems.py`

아래 쿼리는 DeepTutor 가 실제로 참조하는 데이터 패턴.

### 단계별 힌트 (solution_steps)
```sql
SELECT solution_steps FROM problems WHERE id = $problem_id;
-- [{step: 1, description: "주어진 조건 정리"}, ...]
-- 학생이 막혔을 때 step 1 → step 2 순서로 공개
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

### 임베딩 기반 유사 문제
- `problem_tags.canonical` 벡터 + unit_matcher 임베딩 캐시 활용
- `embedder.generate_embedding(concept_text)` 로 실시간 cosine 검색
- 구현: `backend/deeptutor/handlers/similar_problems.py`

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
| 007 | `007_deeptutor_conversation.sql` | DeepTutor `student_conversations` 테이블 |
| 008 | `008_add_ontology_columns.sql` | solution_steps, common_mistakes JSONB |
| 009 | `add_validation_columns` (원격 DB 전용) | validation_status/score/issues 컬럼 |
| **010** | `add_difficulty_score` (원격 DB 전용) | **difficulty_score INT 1~10 + 5단계 GENERATED 라벨** ← 현재 |

⚠️ 009·010 은 로컬 `supabase/migrations/` 폴더엔 파일 없음. 원격 DB 에만 적용된 상태(Supabase MCP `list_migrations` 확인). 로컬 SQL 파일 역추출 필요.
