# Call B 라우팅 — 어려운 문제 OpenAI 분기

해설 태깅의 두 단계 호출 중 **Call B (`solution_steps` 추출)** 만 어려운 문제일 때 OpenAI gpt-5.4-mini 로 보내는 운영 정책. 4차 (2026-04-22) 도입.

---

## 배경

Call B 는 `solution_steps` (description / formula / reason 3필드 step 리스트) 만 뽑는 좁은 호출. gemma4:26b 의 한국어 prose × 중첩 JSON × 긴 출력 조합에서 폭주율 높음 (591 dump 실측 기준 parse_ok 65% / length 폭주 27% / phrase loop 35%). ollama 알려진 버그 (#15502, repeat_penalty/xgrammar 무효).

→ Call A (메타: 91% 안정) 는 그대로, **Call B 만** 어려운 문제 (`difficulty_score >= CALL_B_HARD_THRESHOLD`) 에서 OpenAI 우회.

---

## 라우팅 로직

`pipeline/solution_tagger.py:_route_call_b_provider`:

```python
def _route_call_b_provider(difficulty_score: int) -> str:
  forced = os.environ.get("CALL_B_PROVIDER", "").strip().lower()
  if forced:
    return forced  # 1) 강제 override 최우선
  threshold = int(os.environ.get("CALL_B_HARD_THRESHOLD", "7"))
  if difficulty_score >= threshold:
    return os.environ.get("CALL_B_HARD_PROVIDER", "openai").strip().lower()
  return os.environ.get("CALL_B_EASY_PROVIDER", "ollama").strip().lower()
```

### 환경변수

| env | 기본 | 의미 |
|-----|------|------|
| `CALL_B_PROVIDER` | (없음) | 비어있지 않으면 난이도 무시하고 강제 사용 |
| `CALL_B_HARD_THRESHOLD` | `7` | 이 값 이상이면 hard provider 사용 |
| `CALL_B_HARD_PROVIDER` | `openai` | 어려운 문제 provider |
| `CALL_B_EASY_PROVIDER` | `ollama` | 쉬운 문제 provider |
| `OPENAI_MODEL` | `gpt-4o` | OpenAI 호출 시 사용 모델. **운영 권장: `gpt-5.4-mini`** |

같은 `CALL_B_HARD_THRESHOLD` 가 **검증 에이전트 (Layer 2 LLM)** 에서도 분기 기준으로 사용된다 — Call B 가 OpenAI 로 갔으면 검증도 OpenAI 로 보내 일관성 유지.

---

## 코드 흐름

### `call_vl` provider override

`pipeline/vl_providers.py:call_vl` 에 `provider` 키워드 인자 추가됨 (4차):

```python
def call_vl(image_path, prompt, schema, timeout=None, *, provider: str | None = None):
  effective = (provider or provider_selector.select_vl_provider()).lower()
  if effective == "gemini":
    return _call_gemini_with_fallback(image_path, prompt, schema, timeout)
  if effective == "openai":
    return _call_openai(image_path, prompt, schema, timeout)
  return _call_ollama_with_fallback(image_path, prompt, schema, timeout)
```

기존 호출은 인자 안 넘기면 동작 동일 — Call A / problem_tag / 쉬운 문제 검증 등은 영향 없음.

### Call B 호출 분기

`pipeline/solution_tagger.py` Call B 진입부:

```python
call_b_provider = _route_call_b_provider(_d)
logger.info(f"[Call B] difficulty={_d} provider={call_b_provider} image={image_path}")

def _call_b(prompt: str) -> SolutionStepsOnly:
  if call_b_provider == "openai":
    # OpenAI 는 자체 JSON 안정 (responses.parse + Pydantic) → attempts_scope 없이 1회 호출
    return call_vl(vl_image_arg, prompt, SolutionStepsOnly, None, provider="openai")
  with attempts_scope(_CALL_B_ATTEMPTS):
    return call_vl(vl_image_arg, prompt, SolutionStepsOnly, None)
```

OpenAI 분기는 retry 스케줄 없이 1회 호출 (structured output 으로 JSON 안정). ollama 분기는 기존 3회 재시도 (`attempts_scope`) 유지.

### 검증 Layer 2 분기 (같은 임계값)

`pipeline/tag_validator.py:_layer2_llm`:

```python
d = int(tag_result.get("difficulty_score") or 5)
threshold = int(os.environ.get("CALL_B_HARD_THRESHOLD", "7"))
provider = "openai" if d >= threshold else None
logger.info(f"[validator L2] difficulty={d} provider={provider or 'default'}")
llm_result = call_vl(image_path, prompt, _LLMValidation, provider=provider)
```

상세는 `TAG_VALIDATOR.md`.

---

## step 개수 강제 폐지 (4차 동시 변경)

이전 (3차까지) 은 난이도별 step 수 min/max 를 **5군데**에서 강제했음:
- `_STEPS_ONLY_PROMPT` 상한 표
- `_min_steps_for` / `_max_steps_for` 함수
- `_dedup_and_cap` 절삭 로직
- 재시도 트리거 (`len(steps) < _min_steps_for`)
- `tag_validator._layer1_rule` 의 step_count 구간 검증

→ **4차에서 전부 제거**. 이유: 모델이 풀이 복잡도에 맞춰 자율 결정하는 게 자연스러움. step 수가 많아도 품질 자체엔 영향 없고, 후처리 다른 검증 (영어 혼입 / formula delimiter / placeholder 등) 으로 충분.

**유지 항목**:
- `_dedup_steps`: `step_no` 중복만 제거 (gemma4 자기복제 방어)
- 빈 steps 일 때 1회 재시도 (강조 프롬프트)
- 그 외 step 품질 검증 (영어 / 수식 위치 / formula delimiter / placeholder / reason "null" / 한국어 비율)

---

## 비용 (gpt-5.4-mini)

단가: input $0.75/M, output $4.50/M

### 호출당 토큰

| 호출 | input | output |
|------|-------|--------|
| Call B (steps 추출) | 이미지 2장 1,530 + 프롬프트 2,500 ≈ **4,000** | 1,500 |
| 검증 Layer 2 | 이미지 2장 1,530 + tag_json 500 + canonical 6,000 + 프롬프트 1,000 ≈ **9,000** | 500 |

### 1문제 비용 (어려운 문제, Call B + 검증 둘 다 OpenAI)

| 호출 | 비용 |
|------|------|
| Call B | (4K×$0.75 + 1.5K×$4.50)/1M = **$0.0098** |
| 검증 | (9K×$0.75 + 0.5K×$4.50)/1M = **$0.0090** |
| **합계** | **$0.019 / 문제 (₩25)** |

### 모의고사 1회분 (30문제, threshold=7 기준 어려운 6문제)

- **Call B + 검증 모두 OpenAI**: 6 × $0.019 = **$0.114 / PDF (₩152)**
- Call B 만 OpenAI / 검증 ollama: 6 × $0.010 = $0.059 / PDF (₩78)
- 30문제 전부 OpenAI: 30 × $0.019 = $0.57 / PDF (₩758)

평가원 5년치 (5 PDF) 누적해도 ₩760. 비용 부담 거의 없음.

`CALL_B_HARD_THRESHOLD` 를 5~6 으로 낮추면 더 많은 문제가 OpenAI 로 가서 비용 늘어남 — 운영하며 조정.

---

## `.env` 설정 (운영)

```env
# Call A 는 그대로 (VL_PROVIDER=ollama 유지 — Call A 91% 안정)
VL_PROVIDER=ollama
VL_MODEL=gemma4:26b

# Call B + 검증 분기
CALL_B_HARD_THRESHOLD=7
CALL_B_HARD_PROVIDER=openai
CALL_B_EASY_PROVIDER=ollama
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-5.4-mini
```

**중요**: `VL_PROVIDER=ollama` 는 그대로 — Call A / problem_tag / 쉬운 문제 Call B / 쉬운 문제 검증 의 기본값을 ollama 로 묶어둠. `provider="openai"` 로 명시한 호출만 OpenAI 로 감.

---

## 로그로 확인

uvicorn 로그에서 Call B 진입 시 다음이 찍혀야 정상:

```
[Call B] difficulty=8 provider=openai image=/path/to/solution.png
[validator L2] difficulty=8 provider=openai
```

쉬운 문제는:

```
[Call B] difficulty=4 provider=ollama image=/path/to/solution.png
[validator L2] difficulty=4 provider=default
```

`provider=default` 는 `call_vl` 의 `provider=None` → `provider_selector.select_vl_provider()` 결과를 따른다는 뜻 (보통 ollama).

---

## 관련 파일

- 라우터: `backend/pdf_pipeline/pipeline/solution_tagger.py:_route_call_b_provider`
- Call B 호출부: `backend/pdf_pipeline/pipeline/solution_tagger.py` Call B 분기
- 검증 분기: `backend/pdf_pipeline/pipeline/tag_validator.py:_layer2_llm`
- provider override: `backend/pdf_pipeline/pipeline/vl_providers.py:call_vl`
- 검증 에이전트 상세: `backend/pdf_pipeline/docs/TAG_VALIDATOR.md`
- 데이터 흐름 전체: `backend/pdf_pipeline/ARCHITECTURE.md`
