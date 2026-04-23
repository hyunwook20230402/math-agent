# Call B 라우팅 — per-step loop + 난이도별 provider 분기

해설 태깅의 두 단계 호출 중 **Call B (`solution_steps` 추출)** 을 per-step loop 구조로 운영하는 정책. 4차 (2026-04-22) 에서 provider 분기 도입, 5차 (2026-04-23) 에서 per-step loop 로 재설계.

---

## 배경

Call B 는 해설 이미지에서 단계별 힌트 (hint / formula / concept 3필드) 를 뽑는 호출. gemma4:26b 의 한국어 prose × 중첩 JSON × 긴 출력 조합에서 repetition 폭주가 발생 (591 dump 실측 기준 parse_ok 65% / length 폭주 27% / phrase loop 35%). ollama 알려진 버그 (#15502, repeat_penalty/xgrammar 무효) 로 서버 측 억제 불가.

→ **5차 (2026-04-23) 에서 Call B 를 per-step loop 로 재설계**. 한 호출당 step 하나만 생성하여 출력 토큰을 짧게 유지 (~100 tok) — 폭주 원인인 "긴 한국어 structured JSON" 조합 자체를 제거.

→ Call A (메타: 91% 안정) 는 그대로. Call B 는 모든 난이도에서 per-step loop 로 동작하며, 선택적으로 어려운 문제는 OpenAI 로 provider 분기 가능 (`CALL_B_HARD_PROVIDER`).

---

## per-step loop 동작 (5차, 2026-04-23)

### 스키마

```python
class _SingleStepPayload(BaseModel):
  hint: str
  formula: str
  concept: str

class SingleStepResult(BaseModel):
  done: bool                                 # true 면 루프 종료 신호
  step: Optional[_SingleStepPayload] = None  # done=false 일 때 다음 step
```

### 루프 구조

```
for step_idx in 1..MAX_STEPS:
  prompt = 공통 지시문 + 이미지(문제+해설) + 누적된 steps 요약 블록
  res = call_vl(prompt, SingleStepResult)

  if res.done:           # 모델이 해설 끝났다고 판단
    break
  if res.step is None:   # 이상 응답 방어
    break
  if res.step.hint in seen_hints:  # 중복 생성 방어
    break

  accumulated.append(res.step)
```

- 공통 지시문: `_STEPS_LOOP_PROMPT_TEMPLATE` (MATH_RULES + progressive difficulty + 종료 조건)
- 누적 블록: `_format_previous_steps_block()` 이 이전 steps 를 `step N: hint=..., formula=..., concept=...` 형태 한 줄씩 변환
- MAX_STEPS 안전장치: `CALL_B_MAX_STEPS` env (기본 15). 해설이 20+ step 넘는 경우는 거의 없음.
- 각 호출 재시도: `_PER_STEP_ATTEMPTS = [(0.1, 512), (0.25, 768)]` — 짧은 출력이라 2회면 충분

### 폭주 억제 원리

| 지표 | 한 번에 전체 (이전) | per-step loop (현재) |
|------|---------------------|----------------------|
| 호출당 출력 토큰 | 300~2000+ | ~100 |
| 루프 기회 | 많음 (긴 생성에 substitution_substitution 박힐 여지) | 거의 없음 (num_predict=512 내 정상 종료) |
| 실패 단위 | 전체 재시도 | 해당 step 만 재시도 (앞 step 보존) |
| 이미지 재전송 | 1회 | N회 (매 호출 재전송 — vision encoder 재계산 비용 있음) |

---

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
if d >= threshold:
  hard_provider = os.environ.get("CALL_B_HARD_PROVIDER", "openai").strip().lower()
  provider = hard_provider if hard_provider and hard_provider != "ollama" else None
else:
  provider = None
logger.info(f"[validator L2] difficulty={d} provider={provider or 'default'}")
llm_result = call_vl(image_path, prompt, _LLMValidation, provider=provider)
```

`CALL_B_HARD_PROVIDER=ollama` 로 두면 어려운 문제도 기본 VL_PROVIDER (ollama) 로 가서 OpenAI 분기 비활성화 — Call B 와 정책 일관. 상세는 `TAG_VALIDATOR.md`.

---

## step 개수 강제 폐지 (4차 동시 변경)

이전 (3차까지) 은 난이도별 step 수 min/max 를 **5군데**에서 강제했음:
- `_STEPS_ONLY_PROMPT` 상한 표
- `_min_steps_for` / `_max_steps_for` 함수
- `_dedup_and_cap` 절삭 로직
- 재시도 트리거 (`len(steps) < _min_steps_for`)
- `tag_validator._layer1_rule` 의 step_count 구간 검증

→ **4차에서 전부 제거**. 이유: 모델이 풀이 복잡도에 맞춰 자율 결정하는 게 자연스러움. step 수가 많아도 품질 자체엔 영향 없고, 후처리 다른 검증 (영어 혼입 / formula delimiter / placeholder 등) 으로 충분.

**5차 (per-step loop) 에서의 상한**: `CALL_B_MAX_STEPS` env (기본 15) 로 루프 안전장치 유지. 해설이 15 step 을 넘는 경우는 희귀하므로 실질적으로 모델 자율. done=true 또는 hint 중복 감지 시 조기 종료.

**유지 항목**:
- `_dedup_steps`: `step_no` 중복만 제거 (gemma4 자기복제 방어)
- 빈 steps 일 때 1회 재시도 (강조 프롬프트)
- 그 외 step 품질 검증 (영어 / 수식 위치 / formula delimiter / placeholder / reason "null" / 한국어 비율)

---

## 비용 (gpt-5.4-mini)

단가: input $0.75/M, output $4.50/M

### 호출당 토큰 (per-step loop 기준)

| 호출 | input | output |
|------|-------|--------|
| Call B 단일 step (N번 반복) | 이미지 2장 1,530 + 프롬프트 2,500 + 누적 steps (~100씩 증가) ≈ **4,000~4,800** | ~150 |
| 검증 Layer 2 | 이미지 2장 1,530 + tag_json 500 + canonical 6,000 + 프롬프트 1,000 ≈ **9,000** | 500 |

### 1문제 비용 (어려운 문제, Call B + 검증 둘 다 OpenAI 가정, steps 5개)

| 호출 | 비용 |
|------|------|
| Call B × 5회 + done 1회 (총 6호출) | ~(4.4K×6 × $0.75 + 0.15K×6 × $4.50)/1M = **$0.024** |
| 검증 | (9K×$0.75 + 0.5K×$4.50)/1M = **$0.0090** |
| **합계** | **$0.033 / 문제 (₩45)** |

※ per-step loop 는 호출 수가 늘어나 비용이 한방 호출 대비 1.7배 증가. 대신 폭주로 인한 재시도 비용이 사실상 0 이라 실제 총액은 비슷하거나 낮을 수 있음. **현재 운영은 `CALL_B_HARD_PROVIDER=ollama` 라 OpenAI 비용 0.**

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
