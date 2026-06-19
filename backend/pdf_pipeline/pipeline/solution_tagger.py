"""VL 모델 기반 온톨로지 데이터 추출

VL 은 OpenAI 단일(2026-06-19 gemma4 폐기). 환경변수:
  OPENAI_MODEL   — OpenAI 모델 ID (기본 gpt-4o)

주요 함수:
  extract_tags_from_image(image_path, has_solution) → dict
  tag_all_solutions(solution_images, ...)            → {번호: dict}
"""
import logging
import os
from collections import Counter
from pathlib import Path
from typing import Literal, Optional

RoleType = Literal["condition_analysis", "equation_setup", "case_split", "computation", "conclusion"]

import requests
from pydantic import BaseModel, Field, ValidationError

from . import difficulty_resolver, tag_normalizer, unit_matcher
from .vl_providers import call_vl

logger = logging.getLogger(__name__)


SCHEMA_VERSION = 2  # solution_steps DAG 구조 (produces/uses/whys) 도입 시점


# ── Pydantic 응답 스키마 ──────────────────────────────────────────────────────

class SolutionStep(BaseModel):
  step: int
  hint: str                            # 학생에게 공개하는 힌트 텍스트 (한국어, 수식 인라인 허용)
  formula: str                         # 이 힌트의 핵심 식 \( ... \) — 필수, null 금지
  concept: str                         # 이 힌트가 짚는 개념/정리 이름 (한국어 1~3단어, 필수)


# ── Schema v2 (DAG 구조) ─────────────────────────────────────────────────────
# 2-Pass 파이프라인용. Pass 1 에서 라벨 관계(produces/uses) 확정, Pass 2 에서 내용 채움.
# 소비자는 DeepTutor LLM — 튜터가 막힌 step 의 uses 를 역추적해 학생에게 복기시킴.

class ProducesEntry(BaseModel):
  label: str = Field(..., max_length=8)   # 기계 id: r1, r2, ... (CMS 에서 ㉠/㉡ 로 번역 가능)
  value: str = Field(..., max_length=200) # 짧은 식/조건 문자열 (튜터가 "이 조건이 나왔었죠?" 복기용)


class WhyEntry(BaseModel):
  question: str = Field(..., max_length=60)  # "왜 X?" 형태 물음표 포함
  reason: str = Field(..., max_length=140)   # 짧은 한국어 이유


class SkeletonStep(BaseModel):
  """Pass 1 출력 — step 의 라벨 관계 구조만. 내용(hint/formula/concept) 은 비어있다."""
  id: str = Field(..., max_length=6)           # s1, s2, ...
  step: int
  role: RoleType                                # 수학 풀이 논리 역할 5종 (condition_analysis/equation_setup/case_split/computation/conclusion)
  produces: list[str] = Field(default_factory=list, max_length=2)  # 이 step 이 도출하는 라벨 (0~2)
  uses: list[str] = Field(default_factory=list, max_length=3)      # 이 step 이 참조하는 이전 라벨 (0~3)


class Skeleton(BaseModel):
  """Pass 1 전체 응답 — DAG 구조."""
  steps: list[SkeletonStep] = Field(default_factory=list, min_length=1, max_length=15)


class FilledStep(BaseModel):
  """Pass 2 한 호출의 응답 — 한 step 의 내용 채움.

  Pass 1 에서 id/role/produces 라벨이 이미 고정되어 있으므로,
  Pass 2 는 라벨에 value 채우기 + 힌트 문장 작성 + whys 추가만 수행. role 은 echo-back.
  """
  id: str = Field(..., max_length=6)
  role: RoleType
  hint: str = Field(..., max_length=120)
  formula: str = Field(..., max_length=200)
  concept: str = Field(..., max_length=40)
  produces_values: list[ProducesEntry] = Field(default_factory=list, max_length=2)
  whys: list[WhyEntry] = Field(default_factory=list, max_length=2)


class SolutionStepV2(BaseModel):
  """Pass 1 + Pass 2 병합 결과 — DB 저장용 step.

  `schema_version: 2` 와 함께 저장된다. 기존 SolutionStep (v1) 과 공존 가능 —
  DeepTutor/CMS 는 필드 유무로 분기.
  """
  id: str = Field(..., max_length=6)
  step: int
  role: Optional[RoleType] = None
  hint: str
  formula: str
  concept: str
  produces: list[ProducesEntry] = Field(default_factory=list)
  uses: list[str] = Field(default_factory=list)
  whys: list[WhyEntry] = Field(default_factory=list)


class CommonMistake(BaseModel):
  text: str         # 한국어, 학생 UI 노출

class TagResult(BaseModel):
  """최종 병합 결과 타입 (Call A + Call B 합친 뒤). 하위호환용."""
  difficulty_score: int = Field(ge=1, le=10)  # 1~10 정수 (1-2=very_easy, 3-4=easy, 5-6=medium, 7-8=hard, 9-10=very_hard)
  concept_tags: list[str] = Field(default_factory=list, min_length=1)
  skill_tags: list[str] = Field(default_factory=list, min_length=1)
  answer_type: Optional[str] = None  # "multiple_choice" or "short_answer"
  solution_summary: Optional[str] = None
  pitfall: Optional[str] = None
  solution_steps: list[SolutionStep] = Field(default_factory=list)
  common_mistakes: list[CommonMistake] = Field(default_factory=list)


class TagResultMeta(BaseModel):
  """Call A 전용 — solution_steps 제외한 메타 정보."""
  difficulty_score: int = Field(ge=1, le=10)
  correct_rate: Optional[float] = Field(
    default=None, ge=0, le=100,
    description="해설에 적힌 정답률(%). 이미지에 정답률이 보이면 그 숫자, 없으면 null."
  )
  concept_tags: list[str] = Field(default_factory=list, min_length=1)
  skill_tags: list[str] = Field(default_factory=list, min_length=1)
  answer_type: Optional[str] = None
  solution_summary: Optional[str] = None
  pitfall: Optional[str] = None
  common_mistakes: list[CommonMistake] = Field(default_factory=list)


class SolutionStepsOnly(BaseModel):
  """Call B 전용 — solution_steps 만 뽑는 좁은 스키마 (레거시 한방 호출용, 현재 미사용)."""
  solution_steps: list[SolutionStep] = Field(default_factory=list)


class _SingleStepPayload(BaseModel):
  """per-step loop 한 호출의 출력 — step 하나 (필드명 _ 접두사로 단일용 구분).

  max_length 는 ollama format=schema_json 에서 **생성 단계 강제** 로 작동 —
  모델이 길게 쓰려다 끊기는 게 아니라 애초에 짧게 맞춰 쓴다.
  gemma4 의 한국어 BPE 반복·풀이 장황화 억제 효과.
  """
  hint: str = Field(..., max_length=80)
  formula: str = Field(..., max_length=200)
  concept: str = Field(..., max_length=40)


class SingleStepResult(BaseModel):
  """per-step loop 한 호출의 응답.

  done=true 면 더 이상 step 없음 → 루프 종료.
  done=false 면 step 필드에 다음 단계 하나가 채워져 있어야 함.
  """
  done: bool
  step: Optional[_SingleStepPayload] = None


# ── 프롬프트 ──────────────────────────────────────────────────────────────────

_MATH_RULES_BLOCK = """MATH NOTATION (STRICT — violations make output invalid):
1. NEVER use \\text{...}. Korean prose is plain text (no wrapper). Math goes in \\( ... \\).
2. Wrap every math expression in \\( ... \\). Even a single variable: \\(x\\), \\(2\\), \\(f(2)\\), \\(x^2\\), \\(\\sum a_k\\), \\(\\lim_{x \\to 0} f(x)\\).
3. Every backslash must be DOUBLE-escaped in JSON: write "\\\\sum", "\\\\frac", "\\\\lim", "\\\\to", "\\\\times", "\\\\cdot", "\\\\int".
4. ONLY these commands are allowed inside \\( \\): \\sum \\frac \\sqrt \\lim \\int \\to \\times \\cdot \\infty \\log \\ln \\sin \\cos \\tan \\alpha \\beta \\gamma \\theta \\pi \\mu \\sigma \\delta \\epsilon. NEVER invent \\textascript, \\textstyle, or similar.
5. If you cannot express cleanly, write plain Korean words. Example: write "좌극한" as plain text, NEVER "\\text{좌극한}".
6. LaTeX commands live ONLY inside \\( \\). Outside, they are literal characters and must not appear.

GOOD vs BAD (study these 4 pairs carefully):

BAD:  "\\\\text{\\\\sum (a_k+1)=9}에서 \\\\text{\\\\sum a_k}를 구한다"
GOOD: "\\\\(\\\\sum (a_k+1)=9\\\\) 에서 \\\\(\\\\sum a_k\\\\) 를 구한다"

BAD:  "\\\\text{\\\\lim_{x \\\\to 0^+} f(x) = 2}"
GOOD: "\\\\(\\\\lim_{x \\\\to 0^+} f(x) = 2\\\\)"

BAD:  "좌극한과우극한을혼동"         (spaces collapsed — symptom of hidden \\text{})
GOOD: "좌극한과 우극한을 혼동"

BAD:  "함수 \\\\toe f(x)의 미분계수"   (invented \\toe fused with next letter)
GOOD: "함수 \\\\(f(x)\\\\) 의 미분계수"

LANGUAGE (absolute — Korean only for prose):
- Every description, summary, pitfall, mistake text MUST be Korean sentences.
- NEVER write English words like "final result", "therefore", "step", "description_error", "error" in any prose field.
- If you are uncertain of the Korean word, use 한국어 synonyms (예: "최종 결과" 대신 "따라서", "정리하면" 사용).
- NEVER repeat a phrase more than twice in one field. If you find yourself repeating "description_error:" or similar, STOP and rewrite.

추가 규칙(한국어): 모든 description/summary/pitfall/mistakes 는 반드시 한국어 문장으로만 작성한다. 영어 단어 금지. 같은 어구 반복 금지. "description_error" 같은 placeholder 문자열 절대 출력 금지. formula 는 반드시 \\\\( ... \\\\) 로 감싼다. reason 은 "null" 문자열 대신 null 값 또는 한국어 1~3단어.

PIECEWISE FUNCTIONS (구간별 함수):
- 구간별 정의 함수는 반드시 \\\\begin{cases}...\\\\end{cases} 로 표기한다.
- 각 구간은 & 로 식과 조건을 구분하고 \\\\\\\\ 로 줄바꿈한다.
- 예시: \\\\( f(x) = \\\\begin{cases} 2x-k & (x < k) \\\\\\\\ f(x) & (x > k) \\\\end{cases} \\\\)
- "for", "when", "if" 같은 영어 단어를 조건 구분자로 쓰지 마라. 반드시 & 사용.
- 공백으로만 구간을 나열하는 것은 절대 금지: \\\\(t(t-1) \\\\; t<0 \\\\; t(t+2) \\\\; t>0\\\\) → 이런 표기 금지.
"""


_TAGGING_PROMPT_WITH_SOLUTION = """You are analyzing a Korean high school math solution image.

Rules:
- correct_rate: 해설 이미지에 "정답률"(예: "정답률 34.5%", "정답률: 72%") 이 적혀 있으면 그 숫자(0~100)를 그대로. 없으면 null. 추측하지 말 것 — 이미지에 명시된 경우만.
- difficulty_score: integer 1-10. 문제 번호는 참고만 할 것. 구조적 특징으로 판단한다.
    1-2 (very_easy): 공식 1개 직접 대입으로 즉시 답. (예: 로그 성질 1번 적용, 이차함수 꼭짓점)
    3-4 (easy): 2~3단 계산. 개념 1개 안에서 해결. (예: 인수분해 후 해, 미분 1회 후 극값)
    5-6 (medium): 조건 2~3개 조합, 개념 1~2개. 중간 식 세움 필요.
    7-8 (hard): 아이디어 1개 필요. 다음 중 1개 해당 → 경우 분리 2개 / 그래프 해석+대수 조작 동시 / 합성함수·역함수·절댓값 중 1개 / 개념 2~3개 복합.
    9-10 (killer): 다음 중 2개 이상 해당 → 경우 분리 3개 이상 / 합성·역·절댓값 중첩 2개 이상 / 미지수 2개 이상을 여러 조건으로 동시 결정 / solution_steps 7단계 이상 / 그래프 해석+경우분리+대수 조작 모두 / 개념 3개 이상 복합.
    시대 무관 (2012 수능 30번, 2021 수능 30번, 최근 평가원 22/30 급 모두 9-10).
    하한 규칙 (엄수): 경우 분리가 3개 이상이면 difficulty_score 최소 8 (7 이하 절대 금지). 위 구조 신호 중 2개 이상 동시 해당이면 최소 9 (8 이하 절대 금지). 보수적으로 8 에 몰리지 말고, 신호 카운트가 2+ 면 망설이지 말고 9~10 을 줘라.
- answer_type: "multiple_choice" if the problem has numbered options (①②③④⑤), otherwise "short_answer"
- concept_tags: MUST contain 1~3 tags IN KOREAN (empty list forbidden). Use Korean high-school math unit-level terms (e.g. "삼각함수", "이차방정식", "미분", "수열", "함수의 극한")
- skill_tags: MUST contain 1~3 tags IN KOREAN (empty list forbidden). Techniques actually used in the solution (e.g. "인수분해", "치환", "그래프 해석", "시그마 분배")
- solution_summary: max 20 words IN KOREAN, MUST NOT be empty or null
- pitfall: max 20 words IN KOREAN
- common_mistakes: 2-3 items, each text max 10 words IN KOREAN

NOTE: solution_steps 는 이 호출에서 뽑지 않는다. 별도 호출에서 다룬다. JSON 에 solution_steps 키 자체 포함 금지.

All text fields MUST be in Korean (prose) with math isolated in \\( ... \\).

""" + _MATH_RULES_BLOCK + """
Reference output (well-formed):
{
  "difficulty_score": 4,
  "concept_tags": ["수열", "시그마"],
  "skill_tags": ["시그마 분배 법칙", "수열의 합 계산"],
  "answer_type": "short_answer",
  "solution_summary": "\\\\(\\\\sum_{k=1}^{5}(a_k+1)=9\\\\) 에서 \\\\(\\\\sum a_k\\\\) 를 구한 뒤 \\\\(a_6\\\\) 을 더한다.",
  "pitfall": "\\\\(\\\\sum_{k=1}^{5} 1\\\\) 을 1로 착각",
  "common_mistakes": [{"text":"\\\\(\\\\sum 1\\\\) 을 1로 계산"}]
}

Output valid JSON only. No prose, no markdown fences."""

_TAGGING_PROMPT_WITH_PROBLEM_AND_SOLUTION = """You are analyzing a Korean high school math problem and its solution.

You are given TWO images in order:
- Image 1 = Problem (문제)
- Image 2 = Solution (해설)

Use BOTH images together: the problem tells you what is being asked and which given conditions matter; the solution tells you which techniques were actually used. Tags must reflect both the problem's intent and the solution's method.

Rules:
- correct_rate: 해설 이미지에 "정답률"(예: "정답률 34.5%", "정답률: 72%") 이 적혀 있으면 그 숫자(0~100)를 그대로. 없으면 null. 추측하지 말 것 — 이미지에 명시된 경우만.
- difficulty_score: integer 1-10. 문제 번호는 참고만 할 것. 구조적 특징으로 판단한다.
    1-2 (very_easy): 공식 1개 직접 대입으로 즉시 답. (예: 로그 성질 1번 적용, 이차함수 꼭짓점)
    3-4 (easy): 2~3단 계산. 개념 1개 안에서 해결. (예: 인수분해 후 해, 미분 1회 후 극값)
    5-6 (medium): 조건 2~3개 조합, 개념 1~2개. 중간 식 세움 필요.
    7-8 (hard): 아이디어 1개 필요. 다음 중 1개 해당 → 경우 분리 2개 / 그래프 해석+대수 조작 동시 / 합성함수·역함수·절댓값 중 1개 / 개념 2~3개 복합.
    9-10 (killer): 다음 중 2개 이상 해당 → 경우 분리 3개 이상 / 합성·역·절댓값 중첩 2개 이상 / 미지수 2개 이상을 여러 조건으로 동시 결정 / solution_steps 7단계 이상 / 그래프 해석+경우분리+대수 조작 모두 / 개념 3개 이상 복합.
    시대 무관 (2012 수능 30번, 2021 수능 30번, 최근 평가원 22/30 급 모두 9-10).
    하한 규칙 (엄수): 경우 분리가 3개 이상이면 difficulty_score 최소 8 (7 이하 절대 금지). 위 구조 신호 중 2개 이상 동시 해당이면 최소 9 (8 이하 절대 금지). 보수적으로 8 에 몰리지 말고, 신호 카운트가 2+ 면 망설이지 말고 9~10 을 줘라.
- answer_type: "multiple_choice" if the problem image shows numbered options (①②③④⑤), otherwise "short_answer"
- concept_tags: MUST contain 1~3 tags IN KOREAN (empty list forbidden). Cross-check problem and solution (e.g. "삼각함수", "이차방정식", "미분", "수열", "함수의 극한")
- skill_tags: MUST contain 1~3 tags IN KOREAN (empty list forbidden). Techniques actually used (e.g. "인수분해", "치환", "그래프 해석", "시그마 분배")
- solution_summary: max 20 words IN KOREAN, MUST NOT be empty or null — describe the core approach
- pitfall: max 20 words IN KOREAN — the most likely mistake given the problem's trap
- common_mistakes: 2-3 items, each text max 10 words IN KOREAN

NOTE: solution_steps 는 이 호출에서 뽑지 않는다. 별도 호출에서 다룬다. JSON 에 solution_steps 키 자체 포함 금지.

All text fields MUST be in Korean (prose) with math isolated in \\( ... \\).

""" + _MATH_RULES_BLOCK + """
Reference output (well-formed):
{
  "difficulty_score": 4,
  "concept_tags": ["수열", "시그마"],
  "skill_tags": ["시그마 분배 법칙", "수열의 합 계산"],
  "answer_type": "short_answer",
  "solution_summary": "\\\\(\\\\sum (a_k+1)=9\\\\) 에서 \\\\(\\\\sum a_k\\\\) 를 구한 뒤 \\\\(a_6\\\\) 을 더한다.",
  "pitfall": "\\\\(\\\\sum 1\\\\) 을 1로 착각",
  "common_mistakes": [{"text":"\\\\(\\\\sum 1\\\\) 을 1로 계산"}]
}
Output valid JSON only. No prose, no markdown fences."""

_TAGGING_PROMPT_NO_SOLUTION = """You are analyzing a Korean high school math problem image (no solution shown).

Rules:
- difficulty_score: integer 1-10. 문제 번호는 참고만 할 것. 구조적 특징으로 판단한다.
    1-2 (very_easy): 공식 1개 직접 대입으로 즉시 답.
    3-4 (easy): 2~3단 계산. 개념 1개 안에서 해결.
    5-6 (medium): 조건 2~3개 조합, 개념 1~2개.
    7-8 (hard): 아이디어 1개 필요 (경우 분리 2개 / 그래프+대수 / 합성·역·절댓값 1개 / 개념 2~3개 복합 중 1개).
    9-10 (killer): 경우 분리 3+ / 합성·역·절댓값 중첩 2+ / 미지수 2+ 동시 결정 / 그래프+경우분리+대수 모두 / 개념 3+ 복합 중 2개 이상 해당. 시대 무관.
    하한 규칙 (엄수): 경우 분리 3+ 면 최소 8 (7 이하 금지). 구조 신호 2+ 면 최소 9 (8 이하 금지). 신호 카운트 2+ 면 망설이지 말고 9~10.
- answer_type: "multiple_choice" if the problem image shows numbered options (①②③④⑤), otherwise "short_answer"
- concept_tags: MUST contain 1~3 tags IN KOREAN (empty list forbidden). (e.g. "삼각함수", "이차방정식", "미분", "수열", "함수의 극한")
- skill_tags: MUST contain 1~3 tags IN KOREAN (empty list forbidden). (e.g. "인수분해", "치환", "그래프 해석", "시그마 분배")
- solution_summary: null
- pitfall: max 20 words IN KOREAN
- common_mistakes: 2-3 items, each text max 10 words IN KOREAN

NOTE: solution_steps 필드는 이 호출에서 출력하지 않는다. JSON 에 solution_steps 키 포함 금지.

All text fields MUST be in Korean (prose) with math isolated in \\( ... \\).

""" + _MATH_RULES_BLOCK + """
Output valid JSON only. No prose, no markdown fences."""


_STEPS_ONLY_PROMPT = """You are a math tutor assistant analyzing a Korean high school math problem and its solution.

Your ONLY task: generate `solution_steps` — a sequence of HINTS that guide a student to solve the problem on their own, step by step.

PURPOSE (critical): These hints will be shown to students one by one. The student reads hint 1, tries to proceed, if stuck reads hint 2, and so on. Do NOT just transcribe the solution — generate hints that LEAD the student toward the answer progressively.

PROGRESSIVE DIFFICULTY (STRICT):
- step 1: Most abstract — "어떤 개념/조건에 주목해야 할까?" 수준. 답이나 식을 직접 주지 않는다.
- step 2~N-1: 점점 구체적. 방향을 제시하거나 핵심 관계식 하나를 보여준다.
- step N (마지막): 가장 구체적 — 핵심 계산식 또는 최종 결론을 직접 제시한다.
- 앞 step 보다 뒤 step 이 반드시 더 구체적이어야 한다. 순서를 거꾸로 배치 금지.

CRITICAL — ORDER: solution_steps 의 순서는 반드시 해설 이미지에 등장하는 순서 그대로 따라야 한다. 위에서 아래로, 이미지에 나타난 식과 설명의 흐름을 그대로 옮긴다. 논리적으로 더 자연스러워 보여도 순서를 재배열하거나 앞당기거나 뒤로 미루지 마라.

STEP COUNT: 해설 이미지에 등장하는 논리 단위를 빠짐없이 각각 step 으로 만들어라. 개수 제한 없음.
- 해설에서 새로운 식이 등장하거나, 새로운 조건을 적용하거나, 결론이 바뀌는 순간마다 별도 step 으로 분리한다.
- 여러 논리 단계를 하나의 step 으로 뭉치지 마라. 학생이 막힐 수 있는 지점마다 step 을 만들어라.
- 같은 내용을 의미 없이 반복하거나 trivial 한 대입만 있는 step 은 금지.
- MUST NOT be empty.

세 필드 — 모두 반드시 채워야 한다 (null 절대 금지):
  hint: 학생에게 직접 보여주는 힌트 문장. 한국어 서술. 수식은 \\( ... \\) 인라인으로 포함 가능.
        영어 단어 단독 금지. "case 1:" / "step:" / "final result" 같은 메타 라벨 시작 금지.
        step 1 은 추상적 질문/방향, 마지막 step 은 핵심 식이나 결론을 직접 담아라.
  formula: 이 힌트 단계의 핵심 식. 반드시 \\( 로 시작하고 \\) 로 끝나야 한다. null 절대 금지.
           ✅ 올바름: "\\\\(f(k) = k\\\\)"  ❌ 금지: "f(k) = k" (래퍼 없음)
           핵심 식이 여러 개면 모두 포함 가능. 수식이 없는 step 이라도 핵심 조건·결론을 식으로 반드시 채운다.
           구간별 함수(piecewise)는 반드시 \\\\begin{cases}...\\\\end{cases} 로 표기한다.
  concept: 이 힌트가 짚는 개념/정리 이름. 한국어 명사구 1~3단어 ("함수의 연속", "인수분해", "적분 부호 조건").
           영어 금지. null 절대 금지. "null" 문자열 금지.

""" + _MATH_RULES_BLOCK + """
Reference output (well-formed — 점층 힌트 예시):
{
  "solution_steps": [
    {"step":1,"hint":"\\\\(g(x)\\\\) 가 실수 전체에서 미분가능하려면 \\\\(x = k\\\\) 에서 어떤 조건이 필요할까?","formula":"\\\\(\\\\lim_{x \\\\to k^-} g(x) = \\\\lim_{x \\\\to k^+} g(x) = g(k)\\\\)","concept":"함수의 연속과 미분가능"},
    {"step":2,"hint":"연속 조건과 미분계수 조건을 각각 식으로 세워 \\\\(f(k)\\\\) 와 \\\\(f'(k)\\\\) 값을 구해봐.","formula":"\\\\(f(k) = k, \\\\; f'(k) = 2\\\\)","concept":"연속·미분가능 조건 연립"},
    {"step":3,"hint":"\\\\(f(x)\\\\) 를 \\\\((x-k)\\\\) 에 관한 삼차식으로 쓰면 \\\\(f(k)\\\\), \\\\(f'(k)\\\\) 조건을 바로 반영할 수 있어.","formula":"\\\\(f(x) = (x-k)^3 + a(x-k)^2 + 2(x-k) + k\\\\)","concept":"삼차함수 일반형"}
  ]
}

구간별 함수(piecewise) 표기 — CRITICAL:
  ✅ 올바름: {"formula":"\\\\(h(t) = \\\\begin{cases} t(t-1) & (t < 0) \\\\\\\\ t(t+2) & (0 \\\\le t \\\\le 1) \\\\end{cases}\\\\)"}
  ❌ 금지: 공백/세미콜론 나열, "for"/"when"/"if" 영어 조건 구분자 사용

부정 예시 (절대 금지):
  ❌ {"hint":"factorization을 이용하여 ...","concept":"product rule"}
  ❌ {"hint":"case 1: a<0 인 경우 ...","concept":"case 2 calculation"}
  ❌ {"hint":"final result를 도출한다","concept":"conclusion"}

Output valid JSON only — JSON 은 오직 `solution_steps` 키 하나만 포함. 다른 키 금지. No prose, no markdown fences."""


# ── per-step loop 프롬프트 (옵션 C, 2026-04-23) ─────────────────────────────
#
# 루프 구조:
#   매 호출마다 이미지(문제+해설) + 공통 지시문 + 지금까지 생성된 steps 요약 전달.
#   모델은 "다음 step 하나" 만 생성하거나, 더 이상 없으면 done=true.
#
# 폭주 억제 원리:
#   한 호출당 출력 ~100 토큰 (필드 3개짜리 오브젝트 1개) → num_predict 소진 전 stop 도달.
#   긴 한국어 × structured JSON × 긴 생성 조합이 깨져서 repetition 루프 확률 급감.

_STEPS_LOOP_PROMPT_TEMPLATE = """You are a math tutor assistant analyzing a Korean high school math problem and its solution image.

Your task: generate EXACTLY ONE next step of the solution hints, OR signal that no more steps are needed.

세 필드 역할 (삼분할 엄수 — 절대 섞지 마라):
  hint    = "무엇을 할지" 한 문장 질문 or 지시. **식 포함 금지** (식은 formula 로).
            ✅ "두 점의 좌표를 어떻게 표현할 수 있을까?"
            ✅ "조건 AB = CD 를 이용해 k 와 m 의 관계를 찾아보자."
            ❌ "\\\\(a = 2^k\\\\) 를 대입하여 \\\\(a + \\\\frac{1}{a} = ...\\\\) 로 정리하자" (식이 hint 에 섞임)
            최대 60자. 풀이 과정 서술·계산 결과 나열 금지.
  formula = 이 step 에서 **새로 세운 핵심 식 1개**. 반드시 \\( 로 시작 \\) 로 끝.
            여러 식을 이어붙이지 마라. 중간 계산 나열 금지.
            ✅ "\\\\(a + \\\\frac{1}{a} = 2 + \\\\frac{1}{a}\\\\)"
            ❌ "\\\\(a = 2^k, a + \\\\frac{1}{a} = 2^m + 2^{-m}, a = 3\\\\)" (3개 식 병렬 금지)
  concept = 이 step 이 짚는 개념 이름 **1~3단어 명사구만**. 풀이 동작 설명 금지.
            ✅ "함수의 연속", "인수분해", "로그의 밑 변환"
            ❌ "방정식의 변수 변환과 대입입력" (너무 서술적)
            ❌ "점의 좌표와 조건식의 활용" (동작 설명)
            영어 금지, "null" 문자열 금지.

STEP 진행 원칙 (STRICT):
- 한 step = 해설 이미지의 **한 논리 단위**. 같은 조작을 두 번 쪼개지 마라.
- 이번 step 의 concept 는 **이전 step 들과 달라야 한다**. 같은 개념을 다른 식으로 반복 금지.
- 이번 step 의 hint 가 이전 hint 의 유사 재진술이면 done=true 로 끝내라.
- 권장 step 수는 3~6개. 한국 고등수학은 보통 이 범위에서 끝난다. 7개 넘어가면 조작을 쪼개고 있다는 신호.

STOP CONDITION (done=true 반환):
- 최종 답·결론이 이미 직전 step 에 등장했을 때
- 해설 이미지의 논리 단위를 모두 소화했을 때
- 이번에 만들 step 이 이전과 동일 관점의 반복일 때 (억지로 새 step 만들지 마라)
done=true 이면 step 필드는 null 또는 생략.

""" + _MATH_RULES_BLOCK + """

이전 step 들 (지금까지 누적):
__PREV_STEPS_BLOCK__

Reference — 첫 step 예시 (hint 는 질문형, formula 는 식 1개, concept 는 명사구):
{"done": false, "step": {"hint": "\\\\(g(x)\\\\) 가 실수 전체에서 미분가능하려면 \\\\(x=k\\\\) 에서 어떤 조건이 필요할까?", "formula": "\\\\(\\\\lim_{x \\\\to k^-} g(x) = \\\\lim_{x \\\\to k^+} g(x) = g(k)\\\\)", "concept": "함수의 연속과 미분가능"}}

Reference — 해설 끝:
{"done": true}

부정 예시 (절대 금지):
  ❌ hint 에 식 대입/계산 과정 나열 ("a = 2^k 를 대입하여 정리하자")
  ❌ formula 에 중간 계산 여러 개 병렬 ("a = 2^k, a + 1/a = ..., a = 3")
  ❌ 이전 step 과 같은 concept 재사용 ("방정식의 변수 변환" 연속 2회)
  ❌ concept 가 서술형 ("수식의 정리와 값의 결정")

Output valid JSON only — 최상위 키는 오직 `done` 과 (선택) `step`. No prose, no markdown fences."""


# ── 2-Pass 프롬프트 (2026-04-23, schema v2) ─────────────────────────────────
#
# Pass 1: 해설 이미지 → step 의 라벨 관계 구조만 (hint/formula/concept 없음).
#         목적: Pass 2 에서 모델이 라벨을 즉흥으로 만들거나 중복 정의하는 걸 원천 차단.
# Pass 2: 스켈레톤 고정 상태에서 각 step 의 내용 + whys + produces 값 채움.

_PASS1_SKELETON_PROMPT = """You are a math tutor assistant analyzing a Korean high school math problem and its solution image.

Your task: output the **STRUCTURE ONLY** of the solution — how many steps, each step's logical role, and the dependency graph between them. DO NOT write any hints, formulas, or concepts. Those come in a later pass.

WHAT TO OUTPUT:
- `steps`: ordered list of steps matching the solution image top-to-bottom.
- Each step has:
  - `id`: short machine id, format exactly "s1", "s2", "s3", ... in order.
  - `step`: integer step number (1-based, matches id).
  - `role`: one of five logical roles (see ROLE section below).
  - `produces`: list of labels (format "r1", "r2", ...) that THIS step newly derives. 0~2 labels per step. Use a NEW label if this step produces a named intermediate result the solution later references; use [] if this step only manipulates previous results without introducing a new named quantity.
  - `uses`: list of labels that THIS step references from EARLIER steps' `produces`. 0~3 labels per step. Must only reference labels that appear in earlier steps' produces.

ROLE (new mandatory field — pick exactly one of these five):
- `condition_analysis`: 주어진 조건·정의를 해석해 함수/수열/집합의 성질·범위·관계를 파악.
- `equation_setup`: 새 식·함수·대수구조를 세우거나 변형 (치환, 일반형 도출, 정의 도입).
- `case_split`: 경우를 나누거나 부호·기호를 결정 (절댓값 분리, 구간 나눔, 부호 판정).
- `computation`: 기계적 대입·전개·수치 계산·방정식 해 구하기.
- `conclusion`: 결과를 종합해 문제의 최종 답을 도출.

ROLE ASSIGNMENT PRINCIPLES (general math, not problem-specific):
- 한 step 은 정확히 한 role. 두 역할이 섞이면 step 을 분리하라.
- 동일 role 이 3 step 이상 연속되면 구조가 잘못된 것이다. 묶어서 하나로 만들거나 중간에 다른 role (보통 condition_analysis 나 equation_setup) 을 끼워 넣어라.
- `conclusion` 은 풀이 전체에서 마지막 1개만 — 중간에 "소결론" 이라도 conclusion 으로 라벨링하지 마라.
- role 분포는 대체로 condition_analysis 1~2 + equation_setup 1~2 + computation 1~3 + conclusion 1 이 정상. case_split 는 문제에 경우 분리가 실제로 있을 때만.

LABEL POLICY (STRICT):
- Labels are strictly sequential: r1, r2, r3, ... Assign a new label only when the step derives a *referenceable intermediate result* (e.g., a constraint like "㉠", "㉡", a derived function definition, a specific value).
- A step can produce 0 labels if it's pure computation that the solution doesn't later point back to.
- `uses` must ONLY contain labels already produced by earlier steps. Never forward-reference.
- Total label count is typically 2~6 across the whole solution. Not every step produces a label.

STEP COUNT:
- Match the logical units in the solution image. Typical Korean high-school solutions have 3~7 steps.
- Do not over-split trivial arithmetic into separate steps.
- Do not merge distinct logical operations into one step.

EXAMPLE (삼차함수+적분부등식 류 — role 배정 시범):
{
  "steps": [
    {"id": "s1", "step": 1, "role": "condition_analysis", "produces": ["r1"], "uses": []},
    {"id": "s2", "step": 2, "role": "condition_analysis", "produces": ["r2"], "uses": []},
    {"id": "s3", "step": 3, "role": "equation_setup",     "produces": ["r3"], "uses": ["r1", "r2"]},
    {"id": "s4", "step": 4, "role": "condition_analysis", "produces": ["r4"], "uses": []},
    {"id": "s5", "step": 5, "role": "case_split",         "produces": ["r5"], "uses": ["r4"]},
    {"id": "s6", "step": 6, "role": "computation",        "produces": ["r6"], "uses": ["r3", "r5"]},
    {"id": "s7", "step": 7, "role": "conclusion",         "produces": [],     "uses": ["r6"]}
  ]
}
(역할 분포 예시 — condition_analysis 3, equation_setup 1, case_split 1, computation 1, conclusion 1. 이는 한 예시일 뿐이며 실제 문제에선 풀이 구조에 맞게 자유롭게 배정하라.)

Output valid JSON only. ONE top-level key: `steps`. No prose, no markdown fences."""


_PASS2_FILL_PROMPT_TEMPLATE = """You are a math tutor assistant. The solution image and its skeleton structure are given. Your task: fill in the content of EXACTLY ONE step.

SKELETON (already fixed — do NOT change ids or labels):
__SKELETON_BLOCK__

ALREADY FILLED STEPS (for continuity, do not repeat):
__FILLED_BLOCK__

TARGET STEP TO FILL NOW: __TARGET_ID__
  role:            __TARGET_ROLE__
  produces labels: __TARGET_PRODUCES__
  uses labels:     __TARGET_USES__

FIELDS TO OUTPUT:
  id              = "__TARGET_ID__" (copy as-is)
  role            = "__TARGET_ROLE__" (copy as-is — do not change)
  hint            = One sentence telling the student WHAT to do / think about. Korean. 수식은 \\( ... \\) 인라인 허용. ≤120자. 식 나열 금지.
  formula         = The NEW key equation this step sets up. Must start with \\( and end with \\). ONE equation (or one cases block). ≤200자.
  concept         = 1~3 단어 한국어 명사구 (e.g., "함수의 연속", "적분 부호 조건"). ≤40자.
  produces_values = For each label in TARGET's produces, give { "label": "r?", "value": "<short math or condition>" }. value 는 짧은 수식/조건 (예: "f(k)=k, f'(k)=2" 또는 "0 ≤ k ≤ 2"). 길이 ≤200자.
  whys            = 0~2개. 학생이 막힐 법한 "왜 X?" 서브질문만. 각 { "question": "왜 ...?", "reason": "..." }. 없으면 빈 배열.

ROLE GUIDANCE (수학 풀이 일반 원칙 — target step 의 role 에 맞춰 hint·formula·whys 톤을 결정하라):
- `condition_analysis`: hint = "어떤 조건을 어떤 성질·도구로 해석할지" 안내. formula = 해석 대상 조건식. whys 유도 질문 1~2개 권장.
- `equation_setup`: hint = "무엇을 어떻게 세우는지". formula = 새로 도입하는 식 1개. whys = 치환·정의 선택 이유.
- `case_split`: hint = 분기 기준과 갯수 명시. formula = 분기 조건식 또는 cases block. whys = 왜 이 기준으로 나누는지.
- `computation`: hint = 짧은 한 문장 ("X 를 Y 에 대입해 Z 를 얻는다"). formula = 계산 결과식. whys = 보통 빈 배열.
- `conclusion`: hint = 최종적으로 무엇을 합산·선택하는지. formula = 답에 이르는 마무리 식. whys = 빈 배열.

RELATIONSHIP TO PRIOR STEPS:
- 직전 step 과 role 이 같다면 관점을 반드시 바꿔라 — 다른 조건, 다른 값, 다른 케이스를 다루어야 한다. 같은 문장 복붙 금지.
- uses 에 라벨이 있으면 hint 에서 그 라벨의 value 를 "앞서 얻은 \\(...\\) 를 이용해" 형태로 인용. 단순 "이전 step 의 결과" 같은 모호한 언급 금지.

WHYS POLICY:
- whys 는 학생이 "이 조건이 왜 나왔지?" 헷갈릴 지점에만. 모든 step 에 억지로 만들지 마라.
- 좋은 예: "왜 이 구간에서 직선 부분만 체크해도 되는가?" "왜 좌미분계수 = 우미분계수?"
- 나쁜 예: "왜 더하면 이 값이 되는가?" (trivial 계산 설명)
- question 은 반드시 물음표 포함, reason 은 한국어 한 문장.

""" + _MATH_RULES_BLOCK + """

Output valid JSON only — keys: id, role, hint, formula, concept, produces_values, whys. No prose, no markdown fences."""


def _format_skeleton_block(skeleton: Skeleton) -> str:
  """Pass 2 프롬프트에 넣을 스켈레톤 블록 (읽기 쉬운 한 줄 요약)."""
  lines: list[str] = []
  for s in skeleton.steps:
    produces = ",".join(s.produces) if s.produces else "-"
    uses = ",".join(s.uses) if s.uses else "-"
    lines.append(f"  {s.id} (step {s.step}, {s.role}): produces=[{produces}] uses=[{uses}]")
  return "\n".join(lines)


def _dedupe_skeleton(skeleton: Skeleton) -> Skeleton:
  # Pass 1 (gemma4) repetition 방어: 두 가지 규칙으로 step 병합, 마지막 상한 적용.
  # (a) produces/uses 가 직전과 완전 동일 → drop. (b) 같은 role 이 3+ 연속이면서 produces=[] 이고 uses 가 비슷 → 2번째부터 drop.
  max_steps = int(os.environ.get("CALL_B_MAX_SKELETON_STEPS", "8"))

  def _sig(s: SkeletonStep) -> tuple[tuple[str, ...], tuple[str, ...]]:
    return (tuple(s.produces or []), tuple(s.uses or []))

  kept: list[SkeletonStep] = []
  dropped_ids: list[str] = []
  prev_sig: Optional[tuple[tuple[str, ...], tuple[str, ...]]] = None
  role_run_len = 0  # 같은 role 이 몇 개 연속으로 나왔는지
  prev_role: Optional[str] = None
  for s in skeleton.steps:
    cur_sig = _sig(s)
    if prev_sig is not None and cur_sig == prev_sig:
      dropped_ids.append(s.id)
      continue
    # role 연속 체크: 3번째부터 produces 비어있고 uses 도 유사하면 drop
    if s.role == prev_role:
      role_run_len += 1
    else:
      role_run_len = 1
    if role_run_len >= 3 and not s.produces and prev_sig and set(s.uses or []) <= set(prev_sig[1]):
      dropped_ids.append(s.id)
      role_run_len -= 1  # drop 했으니 run 카운트 되돌림
      continue
    kept.append(s)
    prev_sig = cur_sig
    prev_role = s.role

  if len(kept) > max_steps:
    dropped_ids.extend(k.id for k in kept[max_steps:])
    kept = kept[:max_steps]

  renumbered: list[SkeletonStep] = []
  for idx, s in enumerate(kept, start=1):
    renumbered.append(SkeletonStep(
      id=f"s{idx}",
      step=idx,
      role=s.role,
      produces=list(s.produces or []),
      uses=list(s.uses or []),
    ))

  if dropped_ids:
    role_dist = ",".join(f"{r.role}:{i+1}" for i, r in enumerate(renumbered))
    logger.info(f"[Call B Pass1 dedupe] before={len(skeleton.steps)} after={len(renumbered)} dropped={dropped_ids} roles=[{role_dist}]")

  return Skeleton(steps=renumbered)


def _format_filled_block(filled: list[dict]) -> str:
  """Pass 2 프롬프트에 넣을 이미 채워진 step 들의 요약."""
  if not filled:
    return "(없음 — 이번이 첫 step 이다)"
  lines: list[str] = []
  for f in filled:
    fid = f.get("id")
    role = f.get("role") or "?"
    hint = (f.get("hint") or "").strip()
    if len(hint) > 80:
      hint = hint[:80] + "…"
    formula = (f.get("formula") or "").strip()
    produces = f.get("produces") or []
    prod_str = ",".join(f"{p.get('label')}={p.get('value')!r}" for p in produces) if produces else "-"
    lines.append(f"  {fid} ({role}): hint={hint!r} formula={formula!r} produces=[{prod_str}]")
  return "\n".join(lines)


def _format_previous_steps_block(steps: list[dict]) -> str:
  """누적된 step 리스트를 프롬프트에 넣을 한국어 요약 블록으로 변환.

  길어지지 않게 hint 는 60자까지만, formula/concept 는 그대로.
  """
  if not steps:
    return "(없음 — 이번이 첫 step 이다)"
  lines: list[str] = []
  for s in steps:
    step_no = s.get("step")
    hint = (s.get("hint") or "").strip()
    formula = (s.get("formula") or "").strip()
    concept = (s.get("concept") or "").strip()
    if len(hint) > 60:
      hint = hint[:60] + "…"
    lines.append(f"  step {step_no}: hint={hint!r}, formula={formula!r}, concept={concept!r}")
  return "\n".join(lines)


# ── 내부 유틸 ─────────────────────────────────────────────────────────────────

def _strip_text_wrapper(s: str) -> str:
  """`\\text{INNER}` 를 balanced brace 로 파싱하여 처리.

  INNER 에 backslash 가 하나라도 있으면 수식으로 간주 → `\\(INNER\\)`.
  없으면 wrapper 만 벗겨 평문에 흡수. 중첩된 `\\text{}` 는 재귀로 먼저 푼다.
  """
  out: list[str] = []
  i = 0
  n = len(s)
  while i < n:
    if s.startswith(r'\text{', i):
      start = i + len(r'\text{')
      j = start
      depth = 1
      while j < n and depth > 0:
        ch = s[j]
        if ch == '{':
          depth += 1
        elif ch == '}':
          depth -= 1
        j += 1
      if depth != 0:
        out.append(s[i])
        i += 1
        continue
      inner = s[start : j - 1]
      inner = _strip_text_wrapper(inner)
      if '\\' in inner:
        out.append(r'\(' + inner.strip() + r'\)')
      else:
        out.append(inner)
      i = j
    else:
      out.append(s[i])
      i += 1
  return ''.join(out)


def _to_plain(s: str) -> str:
  """모든 LaTeX wrapper/명령어를 벗겨 한국어+숫자 평문만 남김 (sanity 실패 fallback)."""
  import re as _re
  s = _re.sub(r'\\text\{([^{}]*)\}', r'\1', s)
  s = _re.sub(r'\\\(([^)]*)\\\)', r'\1', s)
  s = _re.sub(r'\\\[([^\]]*)\\\]', r'\1', s)
  s = _re.sub(r'\\[a-zA-Z]+\{([^{}]*)\}', r'\1', s)
  s = _re.sub(r'\\[a-zA-Z]+', '', s)
  s = _re.sub(r'[_^]\{([^{}]*)\}', r'\1', s)
  s = _re.sub(r'[_^]', '', s)
  return s


# ── Step 후처리: formula delimiter 자동 감싸기 / description sanitize ────────

_PLACEHOLDER_RE = __import__('re').compile(
  r'^\s*(description[_\s:]\w*|options?_error|formula\s*[:：]|final[_\s]result|implying|case\s*\d+[:：]?)\b',
  __import__('re').I,
)
_DESC_PREFIX_RE = __import__('re').compile(r'^\s*description\s*[:：]\s*', __import__('re').I)
_RAW_MATH_RE = __import__('re').compile(
  r'(?<![\\\w])(?:[a-zA-Z]_\{[^}]+\}|[a-zA-Z]_\d+|\\alpha|\\beta|\\theta|\\int|\\sum|\\frac|\\sqrt|\\times|\\Rightarrow)'
)
# reason 이 영어·언더바·하이픈만 있고 한글이 전혀 없으면 버린다 (DB 박제 방지)
_REASON_EN_ONLY_RE = __import__('re').compile(r'^[\sA-Za-z0-9_\-\.\;:,]+$')

# 모델이 반복해서 뱉는 영어 단어/구절을 한국어로 치환 (30문제 실측 기반)
_EN_TO_KO: dict[str, str] = {
  'factorization': '인수분해',
  'combinatorics': '조합론',
  'equation solving': '방정식 풀이',
  'zero point': '영점',
  'product rule': '곱의 미분법',
  'triangle_area_formula': '삼각형 넓이 공식',
  'triangle area formula': '삼각형 넓이 공식',
  'fractional_value': '분수값',
  'fractional value': '분수값',
  'trigonometric identity': '삼각함수 항등식',
  'final result': '최종 결과',
  'conclusion': '결론',
  'case 1': '경우 1',
  'case 2': '경우 2',
  'case 3': '경우 3',
  'case 4': '경우 4',
  'case 5': '경우 5',
  'case 1 calculation': '경우 1 계산',
  'case 2 calculation': '경우 2 계산',
  'case 3 calculation': '경우 3 계산',
  'case 4 calculation': '경우 4 계산',
  'first part of the solution': '풀이 첫 부분',
  'true part of the solution': '풀이 참 부분',
  'accuracy-based logic': '정확도 기반 논리',
  'problem condition': '문제 조건',
  'is a natural number': '은 자연수이다',
  'summation': '합',
  'de_calculation': '계산',
}


def _translate_en(text: str) -> str:
  """_EN_TO_KO 에 정의된 영어 표현을 한국어로 치환 (case-insensitive, 긴 것 우선)."""
  if not text:
    return text
  for en in sorted(_EN_TO_KO.keys(), key=len, reverse=True):
    # 대소문자 무시, 단어 경계 (영어) 또는 한국어 인접 모두 허용
    pattern = __import__('re').compile(__import__('re').escape(en), __import__('re').I)
    text = pattern.sub(_EN_TO_KO[en], text)
  return text


def _wrap_formula(f: Optional[str]) -> Optional[str]:
  """formula 에 `\\(...\\)` delimiter 누락 / 짝 깨짐 자동 보정.

  이미 온전한 경우 그대로, 그 외엔 안쪽 delimiter 모두 벗기고 바깥만 감싼다.
  """
  if f is None:
    return None
  s = str(f).strip()
  if not s:
    return None
  if (s.startswith('\\(') and s.endswith('\\)')) or (s.startswith('\\[') and s.endswith('\\]')):
    if s.count('\\(') == s.count('\\)') and s.count('\\[') == s.count('\\]'):
      return s
  stripped = s.replace('\\(', '').replace('\\)', '').replace('\\[', '').replace('\\]', '').strip()
  if not stripped:
    return None
  return f'\\({stripped}\\)'


def _trim_looped(text: str) -> str:
  """같은 6~30자 구절이 3회 이상 반복되면 1회 + `…` 로 절삭.

  29번 "이차 방정식으로 × 13회", "전개개 × 40회" 같은 Call B repetition 버그 대응.
  """
  if not text or len(text) < 40:
    return text
  import re as _re
  # 6~30자 구절이 연속 3회 이상 (즉 총 4회+)
  m = _re.search(r'(.{6,30}?)\1{3,}', text)
  if m:
    phrase = m.group(1)
    return _re.sub(_re.escape(phrase) + r'(?:' + _re.escape(phrase) + r')+', phrase + '…', text)
  return text


def _sanitize_step(step: dict) -> dict:
  """한 step 의 hint / formula / concept 후처리.

  - hint: placeholder / prefix / 선행 쉼표·공백 제거 / 영어 치환 / 반복 절삭, 빈 결과면 대체 문구
  - formula: `_wrap_formula` 로 delimiter 보정 + 반복 절삭
  - concept: 문자열 'null' / 'none' / 공백 → None, 영어-only → None, 영어 단어 한국어 치환
  """
  hint = step.get('hint')
  if not isinstance(hint, str):
    hint = '' if hint is None else str(hint)
  hint = hint.strip()
  hint = _DESC_PREFIX_RE.sub('', hint)
  hint = __import__('re').sub(r'^[,\s;:]+', '', hint).strip()
  hint = _translate_en(hint)
  if _PLACEHOLDER_RE.match(hint):
    hint = ''
  hint = _trim_looped(hint)
  step['hint'] = hint if hint else '(힌트 누락)'

  f = _wrap_formula(step.get('formula'))
  if f:
    f = _trim_looped(f)
  step['formula'] = f

  c = step.get('concept')
  if isinstance(c, str):
    cs = c.strip()
    if cs.lower() in {'null', 'none', ''}:
      step['concept'] = None
    elif _REASON_EN_ONLY_RE.match(cs):
      translated = _translate_en(cs).strip()
      if translated == cs or _REASON_EN_ONLY_RE.match(translated):
        step['concept'] = None
      else:
        step['concept'] = translated
    else:
      step['concept'] = _translate_en(cs).strip()
  return step


def _load_taxonomy() -> dict:
  taxonomy_path = Path(__file__).parent.parent / "data" / "concept_taxonomy.json"
  if not taxonomy_path.exists():
    logger.warning("concept_taxonomy.json 없음 — 정규화 건너뜀")
    return {"concepts": {}, "skills": {}, "units": {}}
  with open(taxonomy_path, encoding="utf-8") as f:
    import json
    return json.load(f)


def _image_to_base64(image_path: str) -> str:
  import base64
  with open(image_path, "rb") as f:
    return base64.b64encode(f.read()).decode("utf-8")


def _call_vl(image_path: str | list[str], prompt: str, timeout: int | None = None) -> TagResult:
  """vl_providers.call_vl 래퍼. monkeypatch 및 레거시 호출 호환.

  image_path 는 단일 경로(str) 또는 리스트(list[str]) 모두 허용.
  """
  return call_vl(image_path, prompt, TagResult, timeout)


def normalize_tags(
  raw_tags: list[str],
  tag_type: str,
  section_embeddings: dict,
  threshold: float = 0.65,
) -> list[str]:
  """bge-m3 cosine 유사도로 태그 정규화.

  임계값 미만이면 원본 태그 유지 (taxonomy 에 없는 신규 개념 허용).
  """
  normalized: list[str] = []
  seen: set[str] = set()
  for tag in raw_tags:
    tag = tag.strip()
    if not tag:
      continue
    canonical, _score = tag_normalizer.match_tag(tag, section_embeddings, threshold=threshold)
    if canonical and canonical not in seen:
      seen.add(canonical)
      normalized.append(canonical)
  return normalized


def _apply_suggested_fixes(
  tag_result: dict,
  validation: dict,
  concept_embeddings: dict,
  skill_embeddings: dict,
  leaf_embeddings: dict | None,
) -> None:
  """validator 의 suggested_fixes 를 조건부로 tag_result 에 반영.

  - concept_tags / skill_tags: suggested_fixes 있으면 severity 무관 교체 (low 포함)
  - unit: match_unit 재매칭 후 신규 score 가 기존보다 높을 때만 덮어쓰기
  - difficulty_score: medium/high 이슈 + suggested_fixes 있을 때 반영
  - 원본은 validation["original_values"] 에 보존
  - 덮어쓴 issue 는 applied=True 플래그
  """
  status = validation.get("status")
  if status not in ("warning", "reject"):
    return
  fixes = validation.get("suggested_fixes") or {}

  original = {
    "unit": tag_result.get("unit", ""),
    "concept_tags": list(tag_result.get("concept_tags", [])),
    "skill_tags": list(tag_result.get("skill_tags", [])),
    "difficulty_score": tag_result.get("difficulty_score"),
  }

  issues = validation.get("issues", []) or []

  def _any_severity(field_names: set[str], min_severity: str = "low") -> list[dict]:
    levels = {"low": 0, "medium": 1, "high": 2}
    min_lvl = levels.get(min_severity, 0)
    return [
      i for i in issues
      if i.get("field") in field_names and levels.get(i.get("severity", "low"), 0) >= min_lvl
    ]

  applied_fields: set[str] = set()

  if not fixes:
    # suggested_fixes 없으면 difficulty_score 이슈는 수정하지 않고 이슈만 남김 (수동 수정 필요)
    return

  # concept_tags — low 포함 suggested_fixes 있으면 교체
  suggested_concepts = fixes.get("concept_tags") or []
  concept_issues = _any_severity({"concept_tags", "concept_tags/skill_tags"}, "low")
  if suggested_concepts and concept_issues:
    normalized = normalize_tags(suggested_concepts, "concept", concept_embeddings, threshold=0.65)
    if normalized:
      tag_result["concept_tags"] = normalized
      applied_fields.add("concept_tags")

  # skill_tags — low 포함 suggested_fixes 있으면 교체
  suggested_skills = fixes.get("skill_tags") or []
  skill_issues = _any_severity({"skill_tags", "concept_tags/skill_tags"}, "low")
  if suggested_skills and skill_issues:
    normalized = normalize_tags(suggested_skills, "skill", skill_embeddings, threshold=0.65)
    if normalized:
      tag_result["skill_tags"] = normalized
      applied_fields.add("skill_tags")

  # difficulty_score — suggested_fixes 직접 값 우선, 없으면 이슈 reason 텍스트 fallback
  diff_issues = _any_severity({"difficulty_score"}, "low")
  if diff_issues:
    import re as _re
    suggested_diff = fixes.get("difficulty_score")
    if isinstance(suggested_diff, int) and 1 <= suggested_diff <= 10:
      tag_result["difficulty_score"] = suggested_diff
      applied_fields.add("difficulty_score")
      logger.info(f"difficulty_score 조정: {original['difficulty_score']} → {suggested_diff} (suggested_fixes)")
    else:
      for iss in diff_issues:
        reason = iss.get("reason", "")
        m = _re.search(r'\b(10|[1-9])(?:~(10|[1-9]))?\s*점\s*(?:이|가|로|으로)?\s*(?:적절|조정|변경|평가|될\s*수\s*있)', reason)
        if m:
          score = int(m.group(1))
          tag_result["difficulty_score"] = score
          applied_fields.add("difficulty_score")
          logger.info(f"difficulty_score 조정: {original['difficulty_score']} → {score} (reason 파싱)")
          break

  # unit — validator 가 직접 제안한 unit path 또는 수정된 concept/skill 로 재매칭
  if leaf_embeddings is not None:
    unit_changed = False
    old_score = float(tag_result.get("unit_score", 0.0))

    # 1) validator 가 unit 을 직접 제시했으면 그 path 가 taxonomy leaf 에 있는지 확인 후 match_unit 로 점수 계산
    suggested_unit = (fixes.get("unit") or "").strip()
    if suggested_unit:
      # 해당 path 를 쿼리로 match_unit 돌려서 실제 점수 확인
      new_unit, new_score = unit_matcher.match_unit(suggested_unit, leaf_embeddings)
      if new_unit and new_score > old_score:
        tag_result["unit"] = new_unit
        tag_result["unit_score"] = new_score
        applied_fields.add("unit")
        unit_changed = True

    # 2) concept/skill 이 교체됐으면 그 새 태그들로 unit 재매칭 시도
    if not unit_changed and ("concept_tags" in applied_fields or "skill_tags" in applied_fields):
      query_parts = list(tag_result.get("concept_tags", [])) + list(tag_result.get("skill_tags", []))
      summary = tag_result.get("solution_summary")
      if isinstance(summary, str) and summary.strip():
        query_parts.append(summary.strip())
      query_text = ", ".join(query_parts)
      if query_text:
        new_unit, new_score = unit_matcher.match_unit(query_text, leaf_embeddings)
        if new_unit and new_score > old_score:
          tag_result["unit"] = new_unit
          tag_result["unit_score"] = new_score
          applied_fields.add("unit")

  if applied_fields:
    validation["original_values"] = original
    for issue in issues:
      if issue.get("field") in applied_fields or issue.get("field") == "concept_tags/skill_tags":
        if (issue.get("field") == "concept_tags/skill_tags"
            and ("concept_tags" in applied_fields or "skill_tags" in applied_fields)):
          issue["applied"] = True
        elif issue.get("field") in applied_fields:
          issue["applied"] = True
    logger.info(f"suggested_fixes 자동 반영: {sorted(applied_fields)}")


def _normalize_bug_ids(common_mistakes: list[CommonMistake], bug_embeddings: dict) -> list[dict]:
  result = []
  for mistake in common_mistakes:
    canonical, _score = tag_normalizer.match_tag(
      mistake.text, bug_embeddings, threshold=0.6
    )
    bug_id = canonical if canonical in bug_embeddings.get("canonicals", []) else None
    result.append({"text": mistake.text, "bug_id": bug_id})
  return result


# ── 공개 API ──────────────────────────────────────────────────────────────────

def extract_tags_from_image(
  image_path: str,
  has_solution: bool = True,
  taxonomy: dict | None = None,
  leaf_embeddings: dict | None = None,
  concept_embeddings: dict | None = None,
  skill_embeddings: dict | None = None,
  bug_embeddings: dict | None = None,
  problem_image_path: str | None = None,
  correct_rate: float | None = None,
) -> dict:
  """단일 이미지(또는 문제+해설 2장)에서 온톨로지 데이터 추출.

  Args:
    image_path: 해설 이미지(has_solution=True) 또는 문제 이미지(has_solution=False)
    problem_image_path: has_solution=True 일 때 함께 참조할 문제 이미지 (선택).
      전달되면 [problem_image_path, image_path] 순서로 VL 에 넘기며,
      프롬프트에서 "Image 1=문제, Image 2=해설" 로 명시된다.
    correct_rate: 문항 정답률(0~100%). 주어지면 GPT 의 난이도 추정을 버리고
      구간 매핑(difficulty_resolver)으로 difficulty_score 를 결정한다.

  Returns:
    {
      "unit": str,
      "unit_score": float,
      "difficulty": str,
      "concept_tags": [str, ...],
      "skill_tags": [str, ...],
      "solution_summary": str | None,
      "pitfall": str | None,
      "solution_steps": [{"step": int, "hint": str, "formula": str, "concept": str}, ...],
      "common_mistakes": [{"text": str, "bug_id": str | None}, ...],
    }
  """
  if taxonomy is None:
    taxonomy = _load_taxonomy()

  taxonomy_path = Path(__file__).parent.parent / "data" / "concept_taxonomy.json"
  if concept_embeddings is None:
    concept_embeddings = tag_normalizer.load_or_build_section_embeddings(taxonomy_path, "concepts")
  if skill_embeddings is None:
    skill_embeddings = tag_normalizer.load_or_build_section_embeddings(taxonomy_path, "skills")
  if bug_embeddings is None:
    bug_embeddings = tag_normalizer.load_or_build_section_embeddings(taxonomy_path, "bugs")

  use_problem = has_solution and bool(problem_image_path)
  if use_problem:
    prompt = _TAGGING_PROMPT_WITH_PROBLEM_AND_SOLUTION
    vl_image_arg: str | list[str] = [problem_image_path, image_path]
  else:
    prompt = _TAGGING_PROMPT_WITH_SOLUTION if has_solution else _TAGGING_PROMPT_NO_SOLUTION
    vl_image_arg = image_path

  fallback = {
    "unit": "",
    "unit_score": 0.0,
    "difficulty_score": 5,
    "correct_rate": correct_rate,
    "concept_tags": [],
    "skill_tags": [],
    "solution_summary": None,
    "pitfall": None,
    "solution_steps": [],
    "common_mistakes": [],
  }

  try:
    # ── Call A: 메타 (difficulty/tags/summary/pitfall/common_mistakes) ──
    meta: TagResultMeta = call_vl(vl_image_arg, prompt, TagResultMeta, None)

    if not meta.concept_tags or not meta.skill_tags:
      logger.warning(
        f"[Call A] concept/skill 비어 있음 → 재시도 [{image_path}] "
        f"(concept={len(meta.concept_tags)}, skill={len(meta.skill_tags)})"
      )
      retry_prompt = prompt + (
        "\n\nIMPORTANT: concept_tags 와 skill_tags 는 반드시 1개 이상 포함해야 한다. 빈 리스트 금지."
      )
      try:
        meta = call_vl(vl_image_arg, retry_prompt, TagResultMeta, None)
      except Exception as re_e:
        logger.warning(f"[Call A] 재시도 실패 (원본 결과 유지): {re_e}")

    # 정답률 출처 우선순위: 외부 전달(correct_rate 인자) > 해설에서 VL 이 읽은 값(meta.correct_rate).
    # (해설 PDF 에 정답률이 박혀 있으므로 보통 meta.correct_rate 로 채워진다.)
    effective_correct_rate = correct_rate if correct_rate is not None else meta.correct_rate

    # 난이도: 정답률 있으면 구간매핑(GPT 추정 버림), 없으면 GPT 추정. (2026-06-19)
    _d = difficulty_resolver.resolve_difficulty(effective_correct_rate, meta.difficulty_score)
    if effective_correct_rate is not None:
      logger.info(f"[난이도] correct_rate={effective_correct_rate}% → difficulty_score={_d} "
                  f"(GPT 추정 {meta.difficulty_score} 무시)")

    # ── Call B: 2-Pass (스키마 v2) — VL=OpenAI 단일(2026-06-19) ──
    # Pass 1: 스켈레톤 (step 수 + 라벨 관계 DAG, 내용 없음). 1호출.
    # Pass 2: 각 step 의 내용(hint/formula/concept/produces_values/whys) 채움. N호출.
    # (구 gemma4 폭주 방어용 attempts_scope/provider 분기는 OpenAI 단일화로 제거.)
    steps_list: list[SolutionStep] = []
    steps_v2: list[dict] = []   # 새 schema (id/produces/uses/whys 포함) — DB 저장용
    if has_solution:
      logger.info(f"[Call B] difficulty={_d} provider=openai mode=2pass image={image_path}")

      # ── Pass 1: 스켈레톤 ──
      skeleton: Optional[Skeleton] = None
      try:
        skeleton = call_vl(vl_image_arg, _PASS1_SKELETON_PROMPT, Skeleton, None)
        _role_counter = Counter(s.role for s in skeleton.steps)
        logger.info(f"[Call B Pass1] skeleton steps={len(skeleton.steps)} "
                    f"labels={[s.produces for s in skeleton.steps]} "
                    f"role_dist={dict(_role_counter)}")
      except Exception as se:
        logger.warning(f"[Call B Pass1] 실패 — Pass2 생략 [{image_path}]: {se}")

      if skeleton and skeleton.steps:
        skeleton = _dedupe_skeleton(skeleton)

      # ── Pass 2: per-step 채우기 ──
      if skeleton and skeleton.steps:
        skeleton_block = _format_skeleton_block(skeleton)
        filled: list[dict] = []

        def _call_fill(target: SkeletonStep, filled_block: str) -> FilledStep:
          prompt = (
            _PASS2_FILL_PROMPT_TEMPLATE
            .replace("__SKELETON_BLOCK__", skeleton_block)
            .replace("__FILLED_BLOCK__", filled_block)
            .replace("__TARGET_ID__", target.id)
            .replace("__TARGET_ROLE__", target.role)
            .replace("__TARGET_PRODUCES__", ",".join(target.produces) if target.produces else "(none)")
            .replace("__TARGET_USES__", ",".join(target.uses) if target.uses else "(none)")
          )
          return call_vl(vl_image_arg, prompt, FilledStep, None)

        for sk_step in skeleton.steps:
          filled_block = _format_filled_block(filled)
          try:
            fs: FilledStep = _call_fill(sk_step, filled_block)
          except Exception as fe:
            logger.warning(f"[Call B Pass2] {sk_step.id} 호출 실패 → 건너뜀: {fe}")
            continue

          produces_dicts = [{"label": p.label, "value": p.value} for p in fs.produces_values]
          whys_dicts = [{"question": w.question, "reason": w.reason} for w in fs.whys]
          filled.append({
            "id": sk_step.id,
            "step": sk_step.step,
            "role": sk_step.role,
            "hint": fs.hint,
            "formula": fs.formula,
            "concept": fs.concept,
            "produces": produces_dicts,
            "uses": list(sk_step.uses),
            "whys": whys_dicts,
          })

        steps_v2 = filled
        # v1 호환용 얇은 뷰 (아래 concept 정규화/저장 흐름과 호환)
        steps_list = [
          SolutionStep(step=f["step"], hint=f["hint"], formula=f["formula"], concept=f["concept"])
          for f in filled
        ]
        if not steps_list:
          logger.warning(f"[Call B Pass2] 모든 step 실패 [{image_path}] — Call A 메타만 유지")
      else:
        logger.warning(f"[Call B] skeleton 비어 있음 [{image_path}] — steps 없이 Call A 만 반환")

    # 병합 — 기존 흐름 호환용 TagResult-shape dict 조립
    class _MergedResult:
      def __init__(self, m: TagResultMeta, s: list[SolutionStep]):
        self.difficulty_score = m.difficulty_score
        self.concept_tags = list(m.concept_tags)
        self.skill_tags = list(m.skill_tags)
        self.answer_type = m.answer_type
        self.solution_summary = m.solution_summary
        self.pitfall = m.pitfall
        self.solution_steps = s
        self.common_mistakes = list(m.common_mistakes)
    result = _MergedResult(meta, steps_list)

    concept_tags = normalize_tags(result.concept_tags, "concept", concept_embeddings, threshold=0.65)
    skill_tags = normalize_tags(result.skill_tags, "skill", skill_embeddings, threshold=0.65)

    # _d 는 정답률 우선으로 이미 결정됨(정답률 있으면 구간매핑, 없으면 GPT). 저장도 _d 사용.
    difficulty_score = _d

    pitfall = result.pitfall.strip() if isinstance(result.pitfall, str) else None
    solution_summary = result.solution_summary

    # solution_steps — v2 (produces/uses/whys) 가 있으면 v2, 없으면 v1 형태로 저장
    if steps_v2:
      # step 번호 기준으로 매칭해 v2 의 새 필드 병합
      _v2_by_step = {f["step"]: f for f in steps_v2}
      solution_steps = []
      for s in result.solution_steps:
        v2 = _v2_by_step.get(s.step)
        if v2 is not None:
          solution_steps.append({
            "id": v2.get("id"),
            "step": s.step,
            "hint": s.hint,
            "formula": s.formula,
            "concept": s.concept,
            "produces": v2.get("produces", []),
            "uses": v2.get("uses", []),
            "whys": v2.get("whys", []),
          })
        else:
          solution_steps.append({
            "step": s.step, "hint": s.hint, "formula": s.formula, "concept": s.concept,
          })
    else:
      solution_steps = [
        {
          "step": s.step,
          "hint": s.hint,
          "formula": s.formula,
          "concept": s.concept,
        }
        for s in result.solution_steps
      ]
    common_mistakes = _normalize_bug_ids(result.common_mistakes, bug_embeddings)

    unit = ""
    unit_score = 0.0
    if leaf_embeddings is not None:
      query_parts: list[str] = []
      query_parts.extend(concept_tags)
      query_parts.extend(skill_tags)
      if isinstance(solution_summary, str) and solution_summary.strip():
        query_parts.append(solution_summary.strip())
      query_text = ", ".join(query_parts)
      if query_text:
        unit, unit_score = unit_matcher.match_unit(query_text, leaf_embeddings)
        logger.info(f"unit 매칭: '{unit}' (score={unit_score:.3f})")

    # LLM이 $...$ 형식으로 수식을 줄 경우 \(...\) 로 정규화
    # gemma4 `\text{...}` 남용 정리 — balanced brace parser 로 중첩 정확 처리
    def _nm(text):
      if not isinstance(text, str):
        return text
      import re as _re

      # 0) JSON escape 소실 복구
      #    - `term{`, `erm{`, `ext{` → `\text{` (앞에 \ 또는 알파벳 없을 때만)
      #    - `\toe`, `\tof` 등 \to + 소문자 → `\to` + 공백 + 문자 (\top 은 보존)
      #    - `\textascript{...}` 환각 명령은 wrapper 만 제거
      text = _re.sub(r'(?<![\\a-zA-Z])term\{', r'\\text{', text)
      text = _re.sub(r'(?<![\\a-zA-Z])erm\{', r'\\text{', text)
      text = _re.sub(r'(?<![\\a-zA-Z])ext\{', r'\\text{', text)
      text = _re.sub(r'\\to(?=[a-oq-z])', r'\\to ', text)
      text = _re.sub(r'\\textascript\{([^{}]*)\}', r'\1', text)
      text = _re.sub(r'\\textstyle\b', '', text)

      # 1) $...$ → \(...\)
      text = _re.sub(r'\$\$(.+?)\$\$', r'\\[\1\\]', text, flags=_re.DOTALL)
      text = _re.sub(r'\$([^$\n]+?)\$', r'\\(\1\\)', text)

      # 2) balanced brace parser 로 `\text{INNER}` 처리 (중첩/아래첨자 안전)
      #    INNER 에 backslash 가 있으면 수식으로 판단 → `\(INNER\)`
      #    없으면 wrapper 만 벗겨 평문으로 흡수
      text = _strip_text_wrapper(text)

      # 3) 고아 `$` 제거
      if text.count('$') == 1:
        text = text.replace('$', '')

      # 4) 최종 sanity — \text/\term 잔존 시 수식 자체를 벗겨 평문으로 강등
      if _re.search(r'\\(text|term|textascript)\{', text):
        logger.warning(f"[_nm] sanitize 실패 → plain 변환: {text[:120]!r}")
        text = _to_plain(text)

      # 5) \( vs \) 개수 불일치 경고
      open_n = len(_re.findall(r'\\\(', text))
      close_n = len(_re.findall(r'\\\)', text))
      if open_n != close_n:
        logger.warning(f"[_nm] \\( vs \\) 불일치 ({open_n} vs {close_n}): {text[:120]!r}")

      return text

    solution_summary = _nm(solution_summary)
    pitfall = _nm(pitfall)
    def _sanitize_full(s: dict) -> dict:
      """v1(step/hint/formula/concept) 만 _sanitize_step 로 돌리고,
      v2 필드(id/produces/uses/whys) 는 _nm 만 적용해 그대로 보존."""
      core = _sanitize_step({
        "step": s["step"],
        "hint": _nm(s.get("hint", "")),
        "formula": _nm(s.get("formula")) if s.get("formula") else None,
        "concept": _nm(s.get("concept")) if s.get("concept") else None,
      })
      if "id" in s:
        core["id"] = s["id"]
      if "role" in s:
        core["role"] = s["role"]
      if "produces" in s:
        core["produces"] = [
          {"label": p.get("label"), "value": _nm(p.get("value") or "")}
          for p in (s.get("produces") or [])
        ]
      if "uses" in s:
        core["uses"] = list(s.get("uses") or [])
      if "whys" in s:
        core["whys"] = [
          {"question": _nm(w.get("question") or ""), "reason": _nm(w.get("reason") or "")}
          for w in (s.get("whys") or [])
        ]
      return core
    solution_steps = [_sanitize_full(s) for s in solution_steps] if solution_steps else solution_steps
    common_mistakes = [{"bug_id": m.get("bug_id", ""), "text": _nm(m.get("text", ""))} for m in common_mistakes] if common_mistakes else common_mistakes

    tag_result = {
      "unit": unit,
      "unit_score": unit_score,
      "difficulty_score": difficulty_score,
      "correct_rate": effective_correct_rate,  # 해설에서 읽은(또는 외부 전달) 정답률 — DB 저장용
      "concept_tags": concept_tags,
      "skill_tags": skill_tags,
      "solution_summary": solution_summary,
      "pitfall": pitfall,
      "solution_steps": solution_steps,
      "common_mistakes": common_mistakes,
      "schema_version": SCHEMA_VERSION if steps_v2 else 1,
    }

    if os.environ.get("TAG_VALIDATOR_ENABLED", "true") == "true":
      try:
        from . import tag_validator
        validation = tag_validator.validate(tag_result, vl_image_arg)
        validation_dict = validation.model_dump()
        _apply_suggested_fixes(
          tag_result,
          validation_dict,
          concept_embeddings=concept_embeddings,
          skill_embeddings=skill_embeddings,
          leaf_embeddings=leaf_embeddings,
        )
        tag_result["_validation"] = validation_dict
      except Exception as ve:
        logger.warning(f"검증 에이전트 오류 (무시): {ve}")

    return tag_result

  except requests.exceptions.ConnectionError as e:  # type: ignore[name-defined]
    logger.error(f"Ollama 서버 연결 실패 [{image_path}]: {e}", exc_info=True)
    return fallback
  except requests.exceptions.Timeout as e:  # type: ignore[name-defined]
    logger.error(f"VL 모델 응답 타임아웃 [{image_path}]: {e}", exc_info=True)
    return fallback
  except ValidationError as e:
    logger.error(f"Pydantic 파싱 실패 [{image_path}]: {e}", exc_info=True)
    return fallback
  except Exception as e:
    logger.error(f"태깅 오류 [{image_path}]: {e}", exc_info=True)
    return fallback


def tag_all_solutions(
  solution_images: dict,
  progress_callback=None,
  numbers_filter: set[int] | None = None,
  problem_images: dict[int, str] | None = None,
  correct_rates: dict[int, float] | None = None,
) -> dict:
  """모든 해설 이미지 일괄 태깅.

  Args:
    solution_images: {번호: 해설 이미지 로컬 경로}
    problem_images: {번호: 문제 이미지 로컬 경로} — 있으면 문제+해설을 함께 VL 에 전달
    correct_rates: {번호: 정답률(0~100)} — 있으면 그 번호는 난이도를 정답률 구간매핑으로 결정

  Returns:
    {
      번호: extract_tags_from_image 결과,
      ...,
      "flagged_numbers": [validation reject 된 번호 목록],
    }
  """
  taxonomy = _load_taxonomy()
  taxonomy_path = Path(__file__).parent.parent / "data" / "concept_taxonomy.json"
  leaf_embeddings = unit_matcher.load_or_build_embeddings(taxonomy_path)
  concept_embeddings = tag_normalizer.load_or_build_section_embeddings(taxonomy_path, "concepts")
  skill_embeddings = tag_normalizer.load_or_build_section_embeddings(taxonomy_path, "skills")
  bug_embeddings = tag_normalizer.load_or_build_section_embeddings(taxonomy_path, "bugs")

  results: dict = {}
  flagged: list[int] = []

  items_sorted = sorted(solution_images.items())
  if numbers_filter is not None:
    items_sorted = [(n, p) for n, p in items_sorted if n in numbers_filter]

  total = len(items_sorted)

  for i, (num, img_path) in enumerate(items_sorted):
    if progress_callback:
      progress_callback(i, total, num)

    logger.info(f"태깅 중: {num}번 ({i+1}/{total})")
    problem_path = problem_images.get(num) if problem_images else None
    num_correct_rate = correct_rates.get(num) if correct_rates else None
    try:
      result = extract_tags_from_image(
        img_path,
        has_solution=True,
        taxonomy=taxonomy,
        leaf_embeddings=leaf_embeddings,
        concept_embeddings=concept_embeddings,
        skill_embeddings=skill_embeddings,
        bug_embeddings=bug_embeddings,
        problem_image_path=problem_path,
        correct_rate=num_correct_rate,
      )
    except Exception as e:
      logger.error(f"[tag_all_solutions] {num}번 실패 (skip, 다음 번호로 진행): {e}")
      results[num] = {
        "error": str(e),
        "concept_tags": [],
        "skill_tags": [],
        "solution_steps": [],
        "common_mistakes": [],
      }
      flagged.append(num)
      continue
    results[num] = result

    validation = result.get("_validation", {})
    if validation.get("status") == "reject":
      flagged.append(num)
      logger.warning(f"검증 reject: {num}번 — {validation.get('issues', [])}")

  if progress_callback:
    progress_callback(total, total, -1)

  results["flagged_numbers"] = flagged
  return results
