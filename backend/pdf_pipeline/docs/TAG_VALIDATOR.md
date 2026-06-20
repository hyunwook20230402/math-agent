# 태깅 검증 에이전트 (`tag_validator.py`)

해설 메타 태깅 결과 (`TagResultMeta`) 의 품질을 2-layer 로 자동 검증하는 모듈. `solution_tagger.extract_tags_from_image` 직후 호출되어 `validation_status` / `validation_score` / `validation_issues` / `suggested_fixes` 를 산출한다. 일부 issue 는 `_apply_suggested_fixes` 에서 자동 반영된다.

> 검증 대상은 **메타 필드(concept_tags / skill_tags / difficulty_score / unit)** 뿐이다. 옛 단계별풀이(solution_steps)·4필드 검증과 임베딩 자가체크(구 Layer 3)는 4차(2026-06-20)에 함께 제거됐다.

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
| `TAG_VALIDATOR_LAYERS` | `"12"` | 활성화할 layer 조합. `"1"`(rule만) / `"2"`(LLM만) 가능 |

---

## 2-Layer 구조

```
validate(tag_result, image_path)
  ├─ Layer 1 — Rule (비용 0)
  └─ Layer 2 — LLM (호출 1회, 가장 비쌈) — OpenAI 단일

→ ValidationResult { status, score, issues[], suggested_fixes? }
```

(구 Layer 3 임베딩 자가체크는 solution_steps 폐기와 함께 제거 — 4차.)

### Layer 1 — Rule (`_layer1_rule`)

Pydantic 검증을 통과한 `tag_result` 에 대해 **순수 파이썬 규칙**으로 메타 품질 검사. 비용 0, 항상 빠름. (코드 `pipeline/tag_validator.py:_layer1_rule` 기준 — 아래가 전부다.)

| 검사 항목 | severity | 비고 |
|-----------|----------|------|
| `concept_tags` 비어있음 | **high** | reject 직행 |
| `skill_tags` 비어있음 | medium | warning |
| `difficulty_score` 1~10 범위 밖 | **high** | |
| `unit_score < 0.5` | medium | bge-m3 단원 매칭 신뢰도 낮음 |
| `concept_tags` / `skill_tags` 태그가 영어 (≥80%) | **high** | `_has_english` — 한 개라도 걸리면 발급 후 중단 |

### Layer 2 — LLM cross-check (`_layer2_llm`)

이미지 + 태깅 결과 JSON + canonical 목록을 LLM 에 보내 **사람 검수자처럼** cross-check.

- **Provider**: OpenAI 단일 (2026-06-19 gemma4 폐기). 난이도 무관 항상 `call_vl()` = OpenAI.
- **입력 토큰**: 이미지 2장 (~1,530) + tag_json (~500) + canonical 목록 (concepts 375 + skills 359 + units leaf 모두 ≈ 6,000) + 프롬프트 (~1,000) ≈ **9,000 input tok**
- **출력**: `_LLMValidation { status, issues, suggested_fixes }` ≈ **500 tok**
- **검증 항목** (프롬프트 명시):
  1. `concept_tags` / `skill_tags` 누락 / 오태깅
  2. `unit` (단원 경로) 와 이미지 일치
  3. `difficulty_score` 가 문제 난이도와 맞는지 (구조 신호 기반)
  4. 모든 text 필드 한국어 강제 (영어 혼입 지적)
- **suggested_fixes 제약**: canonical 목록 안에서만 고르도록 강제 (목록 밖 용어는 후처리 매칭 실패)
- **실패 처리**: 호출 실패 시 silent (`return [], None`) — 검증 모듈이 파이프라인 자체를 막진 않음

**비용**: input ~9K + output ~0.5K tok × `OPENAI_MODEL` 단가 — 문제당 1원 안팎.

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
  field: str                      # "concept_tags", "skill_tags", "difficulty_score", "unit"
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

- **빠른 디버깅 / 비용 0**: `TAG_VALIDATOR_LAYERS=1` 로 두면 LLM 호출 없이 rule 검증만 → 빠르게 회귀 확인 (OpenAI 비용 0)
- **canonical 목록 캐시**: `_canonical_cache` 가 module-level → uvicorn reload 가 아니면 갱신 안 됨. taxonomy 갱신 후 서버 재기동 필수

---

## 관련 파일

- 본체: `backend/pdf_pipeline/pipeline/tag_validator.py`
- 자동 반영: `backend/pdf_pipeline/pipeline/solution_tagger.py:_apply_suggested_fixes`
- Layer 2 VL: `backend/pdf_pipeline/pipeline/vl_providers.py:call_vl` (OpenAI 단일)
- 데이터 흐름 전체: `backend/pdf_pipeline/ARCHITECTURE.md`
- Taxonomy: `backend/pdf_pipeline/data/concept_taxonomy.json`
