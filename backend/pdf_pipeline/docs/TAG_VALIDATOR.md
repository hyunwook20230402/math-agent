# 태깅 검증 에이전트 (`tag_validator.py`)

해설 태깅 결과 (`TagResult`) 의 품질을 3-layer 로 자동 검증하는 모듈. `solution_tagger.extract_tags_from_image` 직후 호출되어 `validation_status` / `validation_score` / `validation_issues` / `suggested_fixes` 를 산출한다. 일부 issue 는 `_apply_suggested_fixes` 에서 자동 반영된다.

운영 흐름 / DB 스키마 전반은 `ARCHITECTURE.md`. 이 문서는 검증 에이전트 한정 상세.

---

## 진입점

```python
from pipeline import tag_validator
result: ValidationResult = tag_validator.validate(tag_result_dict, image_path)
```

`image_path` 는 단일 경로 또는 `[문제경로, 해설경로]` 리스트 (멀티 이미지 검증 시).

### 환경변수

| env | 기본 | 의미 |
|-----|------|------|
| `TAG_VALIDATOR_ENABLED` | `true` | `false` 면 호출 측에서 검증 자체 스킵 |
| `TAG_VALIDATOR_LAYERS` | `"123"` | 활성화할 layer 조합. `"1"` / `"13"` / `"23"` 등 가능 |
| `CALL_B_HARD_THRESHOLD` | `7` | Layer 2 LLM 호출 provider 분기 임계값 (Call B 와 공유) |

---

## 3-Layer 구조

```
validate(tag_result, image_path)
  ├─ Layer 1 — Rule (비용 0)
  ├─ Layer 3 — Embedding (비용 0)   ← 순서상 먼저
  └─ Layer 2 — LLM (호출 1회, 가장 비쌈)
       ├─ 기본: VL_PROVIDER (ollama=gemma4:26b)
       └─ difficulty_score >= CALL_B_HARD_THRESHOLD → OpenAI gpt-5.4-mini

→ ValidationResult { status, score, issues[], suggested_fixes? }
```

### Layer 1 — Rule (`_layer1_rule`)

Pydantic 검증을 통과한 `tag_result` 에 대해 **순수 파이썬 규칙**으로 품질 검사. 비용 0, 항상 빠름.

| 검사 항목 | severity | 비고 |
|-----------|----------|------|
| `concept_tags` 비어있음 | **high** | reject 직행 |
| `skill_tags` 비어있음 | medium | warning |
| `solution_steps` 비어있음 | medium | |
| `common_mistakes` 비어있음 | low | |
| `difficulty_score` 1~10 범위 밖 | **high** | |
| `unit_score < 0.5` | medium | bge-m3 단원 매칭 신뢰도 낮음 |
| `common_mistakes.bug_id` null 비율 ≥ 70% | medium | bugs taxonomy 동의어 부족 신호 |
| `solution_summary` / `pitfall` 영어 혼입 | **high** | `_has_english` (4자+ 영단어 비율 > 30%) |
| step `hint` 영어 혼입 | **high** | |
| step `hint` 안에 수식 (`\(`, `\[`, `$`) | medium | formula 필드 분리 위반 |
| step `formula` delimiter 없음 (`\(`/`\[` 시작 안 함) | **high** | |
| step `hint` placeholder 잔존 (`description_error`, `final_result`, `implying`) | **high** | gemma4 폭주 잔존 |
| step `concept` 이 `"null"`/`"none"` 문자열 | medium | |
| `step_no` 중복 | **high** | gemma4 자기복제 사고 (`solution_tagger._dedup_steps` 가 1차 차단, 잔존 시 발급) |
| step `hint` 한국어 비율 < 50% | **high** | |
| `concept_tags` / `skill_tags` 태그가 영어 (≥80%) | **high** | |
| `common_mistakes.text` 영어 혼입 | **high** | 학생 UI 노출 |

**제거된 검사 (4차)**: 난이도별 step 개수 구간 (1-2: 2~3 / ... / 9-10: 8~12) 검증은 step 개수 강제 폐지와 함께 제거됨. step 개수 자체로는 issue 발급 안 함.

### Layer 3 — Embedding 자가체크 (`_layer3_embedding`)

`solution_steps` 의 hint 들을 한 문자열로 합친 임베딩 ↔ `concept_tags` 합친 문자열 임베딩의 cosine 유사도 검사.

- 사용 임베더: `pipeline.embedder.generate_embedding` (`EMBED_PROVIDER` 따라감 — bge-m3 / OpenAI 3-small)
- 임계값: `cosine < 0.4` 면 medium issue 발급 (`solution_steps 와 concept_tags 임베딩 유사도 낮음`)
- 임베더 실패 시 silent skip (debug 로그만)

비용 0 (bge-m3 로컬) ~ 미미 (OpenAI 3-small 1문제당 $0.0001 미만).

### Layer 2 — LLM cross-check (`_layer2_llm`)

이미지 + 태깅 결과 JSON + canonical 목록을 LLM 에 보내 **사람 검수자처럼** cross-check.

- **Provider 분기**:
  - `difficulty_score < CALL_B_HARD_THRESHOLD` → `call_vl()` 기본 = `VL_PROVIDER` (보통 ollama gemma4:26b)
  - `difficulty_score >= CALL_B_HARD_THRESHOLD` → `call_vl(..., provider=CALL_B_HARD_PROVIDER)` (기본 openai gpt-5.4-mini)
  - `CALL_B_HARD_PROVIDER=ollama` 로 세팅하면 OpenAI 분기 비활성화 → 모든 난이도 ollama gemma4:26b 고정
  - 같은 임계값·env (`CALL_B_HARD_THRESHOLD`, `CALL_B_HARD_PROVIDER`) 를 Call B 와 공유 — 어려운 문제 일관성
- **입력 토큰**: 이미지 2장 (~1,530) + tag_json (~500) + canonical 목록 (concepts 375 + skills 359 + units leaf 모두 ≈ 6,000) + 프롬프트 (~1,000) ≈ **9,000 input tok**
- **출력**: `_LLMValidation { status, issues, suggested_fixes }` ≈ **500 tok**
- **검증 항목** (프롬프트 명시):
  1. `concept_tags` / `skill_tags` 누락 / 오태깅
  2. `unit` (단원 경로) 와 이미지 일치
  3. `solution_steps` 가 실제 풀이 흐름과 맞는지 (누락 / 순서 / 내용 / 세분화)
  4. `difficulty_score` 가 문제 난이도와 맞는지 (구조 신호 기반)
- **suggested_fixes 제약**: canonical 목록 안에서만 고르도록 강제 (목록 밖 용어는 후처리 매칭 실패)
- **실패 처리**: 호출 실패 시 silent (`return [], None`) — 검증 모듈이 파이프라인 자체를 막진 않음

**비용 (gpt-5.4-mini, 어려운 문제 1건)**: input 9K × $0.75/M + output 0.5K × $4.50/M ≈ **$0.009 (₩12)**

---

## ValidationResult 산출

### `status` 결정 (severity 우선순위)

```
high issue 1개 이상  → reject
medium issue 1개 이상 → warning
low only            → warning
issue 없음          → ok
```

### `score` 계산

```
score = 1.0
  - high   issue 1개당 -0.20
  - medium issue 1개당 -0.10
  - low    issue 1개당 -0.05
score = max(0.0, round(score, 2))
```

### Pydantic 스키마

```python
class ValidationIssue(BaseModel):
  field: str                      # "concept_tags", "solution_steps", ...
  reason: str                     # 한국어 사람이 읽는 메시지
  severity: Literal["low", "medium", "high"]
  applied: bool = False           # _apply_suggested_fixes 가 자동 반영 시 True

class SuggestedFixes(BaseModel):
  concept_tags: list[str] | None = None
  skill_tags: list[str] | None = None
  unit: str | None = None
  difficulty_score: int | None = None

class ValidationResult(BaseModel):
  status: Literal["ok", "warning", "reject"]
  score: float                    # 0.0 ~ 1.0
  issues: list[ValidationIssue]
  suggested_fixes: SuggestedFixes | None
```

### DB 저장 컬럼 (`problem_staging`)

| 컬럼 | 타입 | 의미 |
|------|------|------|
| `validation_status` | text | ok / warning / reject |
| `validation_score` | float | 0.0 ~ 1.0 |
| `validation_issues` | jsonb | `[{field, reason, severity, applied}, ...]` |

`suggested_fixes` 는 별도 컬럼 없음 — 자동 반영 후 `tag_result` 본체에 적용되거나, `validation["original_values"]` 에 변경 전 값이 보존된다.

---

## suggested_fixes 자동 반영 (`_apply_suggested_fixes`)

검증이 끝나면 `solution_tagger._apply_suggested_fixes` (L491) 가 다음 정책으로 자동 반영:

| 필드 | 반영 조건 |
|------|----------|
| `concept_tags` | suggested_fixes 있으면 **severity 무관** 교체 (low 포함). canonical 매칭 통과한 것만 |
| `skill_tags` | 동일 |
| `difficulty_score` | medium/high issue + suggested_fixes 있을 때 1~10 정수면 직접 교체. 없으면 issue reason 텍스트 fallback 파싱 |
| `unit` | 1) suggested_fixes.unit 매칭 후 신규 score 가 기존보다 높으면 교체. 2) concept/skill 이 교체됐으면 새 태그로 unit 재매칭 시도 |

**원본 보존**: 변경된 필드들의 변경 전 값은 `validation["original_values"]` 에 기록. 반영된 issue 들은 `applied=true` 플래그 세팅.

```python
# 호출 흐름 (solution_tagger.py:869~)
validation = tag_validator.validate(tag_result, vl_image_arg)
validation_dict = validation.model_dump()
_apply_suggested_fixes(tag_result, validation_dict, ...)
# 이 시점에 tag_result 의 일부 필드가 자동 갱신됨
```

CMS UI 는 `validation_issues` 에서 `applied=true` 인 항목을 **자동 반영됨** 으로 표시, `applied=false` 는 사용자에게 수동 조정 알림으로 노출.

---

## 운영 팁

- **빠른 디버깅**: `TAG_VALIDATOR_LAYERS=1` 로 두면 LLM 호출 없이 rule 검증만 → 빠르게 회귀 확인
- **비용 줄이기**: `TAG_VALIDATOR_LAYERS=13` 으로 Layer 2 끄기 (rule + embedding 만)
- **Layer 2 만 끄고 OpenAI 비용 0**: 위와 동일
- **canonical 목록 캐시**: `_canonical_cache` 가 module-level → uvicorn reload 가 아니면 갱신 안 됨. taxonomy 갱신 후 서버 재기동 필수

---

## 관련 파일

- 본체: `backend/pdf_pipeline/pipeline/tag_validator.py`
- 자동 반영: `backend/pdf_pipeline/pipeline/solution_tagger.py:_apply_suggested_fixes` (L491)
- Provider 분기 (Layer 2): `backend/pdf_pipeline/pipeline/vl_providers.py:call_vl(..., provider=)`
- Call B 라우팅 (같은 임계값 공유): `backend/pdf_pipeline/docs/CALL_B_ROUTING.md`
- 데이터 흐름 전체: `backend/pdf_pipeline/ARCHITECTURE.md`
- Taxonomy: `backend/pdf_pipeline/data/concept_taxonomy.json`
