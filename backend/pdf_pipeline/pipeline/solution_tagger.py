"""VL 모델 기반 온톨로지 데이터 추출

환경변수:
  VL_PROVIDER    — ollama (기본) | gemini | openai
  VL_OLLAMA_URL  — Ollama 서버 URL (기본 http://localhost:11434)
  VL_MODEL       — Ollama 모델 태그 (기본 gemma4:26b)
  GEMINI_MODEL   — Gemini 모델 ID (기본 gemini-2.0-flash)
  VL_TIMEOUT     — 호출 타임아웃 초 (기본 180)

주요 함수:
  extract_tags_from_image(image_path, has_solution) → dict
  tag_all_solutions(solution_images, ...)            → {번호: dict}
"""
import logging
import os
from pathlib import Path
from typing import Optional

import requests
from pydantic import BaseModel, Field, ValidationError

from . import tag_normalizer, unit_matcher
from .vl_providers import attempts_scope, call_vl

logger = logging.getLogger(__name__)


def _route_call_b_provider(difficulty_score: int) -> str:
  """Call B 호출용 provider 결정 (난이도 기반).

  환경변수:
    CALL_B_PROVIDER         = openai | ollama (강제 override, 비면 라우팅)
    CALL_B_HARD_THRESHOLD   = 어려움 기준 difficulty_score (기본 7)
    CALL_B_HARD_PROVIDER    = 어려움일 때 provider (기본 openai)
    CALL_B_EASY_PROVIDER    = 쉬움일 때 provider (기본 ollama)
  """
  forced = os.environ.get("CALL_B_PROVIDER", "").strip().lower()
  if forced:
    return forced
  threshold = int(os.environ.get("CALL_B_HARD_THRESHOLD", "7"))
  if difficulty_score >= threshold:
    return os.environ.get("CALL_B_HARD_PROVIDER", "openai").strip().lower()
  return os.environ.get("CALL_B_EASY_PROVIDER", "ollama").strip().lower()


# ── Pydantic 응답 스키마 ──────────────────────────────────────────────────────

class SolutionStep(BaseModel):
  step: int
  description: str                     # 이 단계에서 무엇을 하는지 (한국어 한 문장, 수식 포함 가능)
  formula: Optional[str] = None        # 핵심 식 \( ... \) — 식이 없는 단계면 null
  reason: Optional[str] = None         # 왜 이 단계가 필요한지 — 개념/정리 이름 (한국어, 선택)

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
  """Call A 전용 — solution_steps 제외한 메타 정보.

  gemma4 가 한 번에 steps 까지 뱉다가 repetition 루프에 빠지는 문제 완화 (2026-04-22).
  """
  difficulty_score: int = Field(ge=1, le=10)
  concept_tags: list[str] = Field(default_factory=list, min_length=1)
  skill_tags: list[str] = Field(default_factory=list, min_length=1)
  answer_type: Optional[str] = None
  solution_summary: Optional[str] = None
  pitfall: Optional[str] = None
  common_mistakes: list[CommonMistake] = Field(default_factory=list)


class SolutionStepsOnly(BaseModel):
  """Call B 전용 — solution_steps 만 뽑는 좁은 스키마."""
  solution_steps: list[SolutionStep] = Field(default_factory=list)


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
"""


_TAGGING_PROMPT_WITH_SOLUTION = """You are analyzing a Korean high school math solution image.

Rules:
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


_STEPS_ONLY_PROMPT = """You are analyzing a Korean high school math problem and its solution.

You are given the problem image and the solution image. Your ONLY task now is to extract `solution_steps` — nothing else.

- solution_steps: 풀이의 논리 단계만큼 step 을 만들어라. 개수 제한 없음. 한 step 에 여러 동작을 우겨넣지 말고, 한 step 에 한 가지 의미 있는 단계만 담아라. 단, 같은 step 을 의미 없이 반복하거나 같은 식을 두 번 쓰는 건 금지. MUST NOT be empty.
  (경우 분리는 한 step 안에서 i)/ii)/iii) 로 묶어 표기 — 단순한 case 나누기로 step 을 인위적으로 쪼개지 마라.)

- 각 step 의 세 필드 — 역할 엄격 분리 (STRICT):
    description: *무엇을* 하는지 한국어 서술만. 수식 금지 (변수 \\(x\\) 하나도 금지). 영어 단어 단독 금지 (factorization → 인수분해). 영어 문장 금지. "case 1:" / "description:" / "final result" 같은 메타 라벨로 시작 금지.
    formula: *핵심 식 하나* 를 \\( ... \\) 로 감싼다. 식 없으면 null.
    reason: *왜* 필요한지 — 한국어 명사구 1~3단어 ("대수 계산", "인수분해", "대입"). 영어·코드 식별자 금지 (triangle_area_formula, product_rule, case 2 calculation 모두 금지). null 허용하나 가급적 채워라. "null" 문자열 금지.
- description 안에 \\( ... \\) 가 등장하면 JSON 전체가 무효로 간주된다. 수식은 formula 로만.

""" + _MATH_RULES_BLOCK + """
Reference output (well-formed):
{
  "solution_steps": [
    {"step":1,"description":"시그마를 두 항으로 분리한다","formula":"\\\\(\\\\sum (a_k+1) = \\\\sum a_k + \\\\sum 1\\\\)","reason":"시그마 분배"},
    {"step":2,"description":"상수항 시그마를 계산하여 합을 구한다","formula":"\\\\(\\\\sum a_k + 5 = 9 \\\\Rightarrow \\\\sum a_k = 4\\\\)","reason":"상수합 공식"}
  ]
}

부정 예시 (절대 금지):
  ❌ {"description":"factorization을 이용하여 ...","reason":"product rule"}
  ❌ {"description":"case 1: a<0 인 경우 ...","reason":"case 2 calculation"}
  ❌ {"description":"final result를 도출한다","reason":"conclusion"}

Output valid JSON only — JSON 은 오직 `solution_steps` 키 하나만 포함. 다른 키 금지. No prose, no markdown fences."""


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
  """한 step 의 description / formula / reason 후처리.

  - description: placeholder / `description:` prefix / 선행 쉼표·공백 제거 / 영어 치환 / 반복 절삭, 빈 결과면 대체 문구
  - formula: `_wrap_formula` 로 delimiter 보정 + 반복 절삭
  - reason: 문자열 'null' / 'none' / 공백 → None, 영어-only → None, 영어 단어 한국어 치환
  """
  desc = step.get('description')
  if not isinstance(desc, str):
    desc = '' if desc is None else str(desc)
  desc = desc.strip()
  desc = _DESC_PREFIX_RE.sub('', desc)
  desc = __import__('re').sub(r'^[,\s;:]+', '', desc).strip()
  desc = _translate_en(desc)
  if _PLACEHOLDER_RE.match(desc):
    desc = ''
  desc = _trim_looped(desc)
  if desc and _RAW_MATH_RE.search(desc) and not step.get('formula'):
    logger.warning(
      f"[sanitize] step {step.get('step')} description 에 raw 수식 감지, formula 비어있음 — 수동 확인 필요"
    )
  step['description'] = desc if desc else '(설명 누락)'

  f = _wrap_formula(step.get('formula'))
  if f:
    f = _trim_looped(f)
  step['formula'] = f

  r = step.get('reason')
  if isinstance(r, str):
    rs = r.strip()
    if rs.lower() in {'null', 'none', ''}:
      step['reason'] = None
    elif _REASON_EN_ONLY_RE.match(rs):
      # 영어·기호만으로 이루어진 reason 은 치환 시도, 치환 후에도 여전히 영어만이면 None
      translated = _translate_en(rs).strip()
      if translated == rs or _REASON_EN_ONLY_RE.match(translated):
        step['reason'] = None
      else:
        step['reason'] = translated
    else:
      step['reason'] = _translate_en(rs).strip()
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
) -> dict:
  """단일 이미지(또는 문제+해설 2장)에서 온톨로지 데이터 추출.

  Args:
    image_path: 해설 이미지(has_solution=True) 또는 문제 이미지(has_solution=False)
    problem_image_path: has_solution=True 일 때 함께 참조할 문제 이미지 (선택).
      전달되면 [problem_image_path, image_path] 순서로 VL 에 넘기며,
      프롬프트에서 "Image 1=문제, Image 2=해설" 로 명시된다.

  Returns:
    {
      "unit": str,
      "unit_score": float,
      "difficulty": str,
      "concept_tags": [str, ...],
      "skill_tags": [str, ...],
      "solution_summary": str | None,
      "pitfall": str | None,
      "solution_steps": [{"step": int, "description": str, "formula": str|None, "reason": str|None}, ...],
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

    _d = max(1, min(10, int(meta.difficulty_score)))

    def _dedup_steps(steps: list[SolutionStep]) -> list[SolutionStep]:
      """step_no 중복만 제거. 개수 제한 없음 — 모델이 자연스럽게 결정."""
      seen: set = set()
      cleaned: list[SolutionStep] = []
      for s in steps:
        no = s.step if isinstance(s, SolutionStep) else (s.get('step') if isinstance(s, dict) else None)
        if no in seen:
          logger.warning(f"[Call B] step_no 중복 제거: step={no}")
          continue
        seen.add(no)
        cleaned.append(s)
      return cleaned

    # ── Call B: solution_steps 전용 (문제+해설 있을 때만) ──
    # 어려운 문제 (difficulty >= CALL_B_HARD_THRESHOLD) 는 OpenAI 로 분기 — gemma4 한계 회피.
    _CALL_B_ATTEMPTS = [(0.05, 3072), (0.15, 4096), (0.3, 5120)]
    steps_list: list[SolutionStep] = []
    if has_solution:
      call_b_provider = _route_call_b_provider(_d)
      logger.info(f"[Call B] difficulty={_d} provider={call_b_provider} image={image_path}")

      def _call_b(prompt: str) -> SolutionStepsOnly:
        if call_b_provider == "openai":
          # OpenAI 는 자체 JSON 안정 (responses.parse + Pydantic) → attempts_scope 없이 1회 호출
          return call_vl(vl_image_arg, prompt, SolutionStepsOnly, None, provider="openai")
        with attempts_scope(_CALL_B_ATTEMPTS):
          return call_vl(vl_image_arg, prompt, SolutionStepsOnly, None)

      try:
        steps_res: SolutionStepsOnly = _call_b(_STEPS_ONLY_PROMPT)
        steps_list = _dedup_steps(steps_res.solution_steps)
        if not steps_list:
          logger.warning(f"[Call B] steps 비어 있음 → 재시도 [{image_path}]")
          retry_steps_prompt = _STEPS_ONLY_PROMPT + (
            "\n\nIMPORTANT: solution_steps 는 절대 비워 두지 마라. 풀이의 각 논리 단계를 반드시 포함해라."
          )
          try:
            steps_res = _call_b(retry_steps_prompt)
            steps_list = _dedup_steps(steps_res.solution_steps)
          except Exception as se:
            logger.warning(f"[Call B] 재시도 실패 (빈 steps 로 진행): {se}")
      except Exception as be:
        logger.warning(f"[Call B] steps 호출 실패 → steps 빈 상태로 Call A 결과만 유지: {be}")

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

    difficulty_score = max(1, min(10, int(result.difficulty_score)))

    pitfall = result.pitfall.strip() if isinstance(result.pitfall, str) else None
    solution_summary = result.solution_summary

    solution_steps = [
      {
        "step": s.step,
        "description": s.description,
        "formula": s.formula,
        "reason": s.reason,
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
    solution_steps = [
      _sanitize_step({
        "step": s["step"],
        "description": _nm(s.get("description", "")),
        "formula": _nm(s.get("formula")) if s.get("formula") else None,
        "reason": _nm(s.get("reason")) if s.get("reason") else None,
      })
      for s in solution_steps
    ] if solution_steps else solution_steps
    common_mistakes = [{"bug_id": m.get("bug_id", ""), "text": _nm(m.get("text", ""))} for m in common_mistakes] if common_mistakes else common_mistakes

    tag_result = {
      "unit": unit,
      "unit_score": unit_score,
      "difficulty_score": difficulty_score,
      "concept_tags": concept_tags,
      "skill_tags": skill_tags,
      "solution_summary": solution_summary,
      "pitfall": pitfall,
      "solution_steps": solution_steps,
      "common_mistakes": common_mistakes,
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
) -> dict:
  """모든 해설 이미지 일괄 태깅.

  Args:
    solution_images: {번호: 해설 이미지 로컬 경로}
    problem_images: {번호: 문제 이미지 로컬 경로} — 있으면 문제+해설을 함께 VL 에 전달

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
