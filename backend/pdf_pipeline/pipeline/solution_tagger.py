"""VL 모델 기반 온톨로지 데이터 추출

VL 은 OpenAI 단일(2026-06-19 gemma4 폐기). 환경변수:
  OPENAI_MODEL   — OpenAI 모델 ID (기본 gpt-4o)

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

from . import difficulty_resolver, tag_normalizer, unit_matcher
from .vl_providers import call_vl

logger = logging.getLogger(__name__)


# ── Pydantic 응답 스키마 ──────────────────────────────────────────────────────

class TagResultMeta(BaseModel):
  """Call A 전용 — 메타 정보."""
  difficulty_score: int = Field(ge=1, le=10)
  correct_rate: Optional[float] = Field(
    default=None, ge=0, le=100,
    description="해설에 적힌 정답률(%). 이미지에 정답률이 보이면 그 숫자, 없으면 null."
  )
  concept_tags: list[str] = Field(default_factory=list, min_length=1)
  skill_tags: list[str] = Field(default_factory=list, min_length=1)
  answer_type: Optional[str] = None


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
- All prose/text fields (태그 등) MUST be Korean.
- NEVER write English words like "final result", "therefore", "step", "error" in any prose field.
- If you are uncertain of the Korean word, use 한국어 synonyms (예: "최종 결과" 대신 "따라서", "정리하면" 사용).

추가 규칙(한국어): 모든 text 필드는 반드시 한국어로만 작성한다. 영어 단어 금지. formula 는 반드시 \\\\( ... \\\\) 로 감싼다.

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
    9-10 (killer): 다음 중 2개 이상 해당 → 경우 분리 3개 이상 / 합성·역·절댓값 중첩 2개 이상 / 미지수 2개 이상을 여러 조건으로 동시 결정 / 그래프 해석+경우분리+대수 조작 모두 / 개념 3개 이상 복합.
    시대 무관 (2012 수능 30번, 2021 수능 30번, 최근 평가원 22/30 급 모두 9-10).
    하한 규칙 (엄수): 경우 분리가 3개 이상이면 difficulty_score 최소 8 (7 이하 절대 금지). 위 구조 신호 중 2개 이상 동시 해당이면 최소 9 (8 이하 절대 금지). 보수적으로 8 에 몰리지 말고, 신호 카운트가 2+ 면 망설이지 말고 9~10 을 줘라.
- answer_type: "multiple_choice" if the problem has numbered options (①②③④⑤), otherwise "short_answer"
- concept_tags: MUST contain 1~3 tags IN KOREAN (empty list forbidden). Use Korean high-school math unit-level terms (e.g. "삼각함수", "이차방정식", "미분", "수열", "함수의 극한")
- skill_tags: MUST contain 1~3 tags IN KOREAN (empty list forbidden). Techniques actually used in the solution (e.g. "인수분해", "치환", "그래프 해석", "시그마 분배")

All text fields MUST be in Korean (prose) with math isolated in \\( ... \\).

""" + _MATH_RULES_BLOCK + """
Reference output (well-formed):
{
  "difficulty_score": 4,
  "concept_tags": ["수열", "시그마"],
  "skill_tags": ["시그마 분배 법칙", "수열의 합 계산"],
  "answer_type": "short_answer"
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
    9-10 (killer): 다음 중 2개 이상 해당 → 경우 분리 3개 이상 / 합성·역·절댓값 중첩 2개 이상 / 미지수 2개 이상을 여러 조건으로 동시 결정 / 그래프 해석+경우분리+대수 조작 모두 / 개념 3개 이상 복합.
    시대 무관 (2012 수능 30번, 2021 수능 30번, 최근 평가원 22/30 급 모두 9-10).
    하한 규칙 (엄수): 경우 분리가 3개 이상이면 difficulty_score 최소 8 (7 이하 절대 금지). 위 구조 신호 중 2개 이상 동시 해당이면 최소 9 (8 이하 절대 금지). 보수적으로 8 에 몰리지 말고, 신호 카운트가 2+ 면 망설이지 말고 9~10 을 줘라.
- answer_type: "multiple_choice" if the problem image shows numbered options (①②③④⑤), otherwise "short_answer"
- concept_tags: MUST contain 1~3 tags IN KOREAN (empty list forbidden). Cross-check problem and solution (e.g. "삼각함수", "이차방정식", "미분", "수열", "함수의 극한")
- skill_tags: MUST contain 1~3 tags IN KOREAN (empty list forbidden). Techniques actually used (e.g. "인수분해", "치환", "그래프 해석", "시그마 분배")

All text fields MUST be in Korean (prose) with math isolated in \\( ... \\).

""" + _MATH_RULES_BLOCK + """
Reference output (well-formed):
{
  "difficulty_score": 4,
  "concept_tags": ["수열", "시그마"],
  "skill_tags": ["시그마 분배 법칙", "수열의 합 계산"],
  "answer_type": "short_answer"
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

All text fields MUST be in Korean (prose) with math isolated in \\( ... \\).

""" + _MATH_RULES_BLOCK + """
Output valid JSON only. No prose, no markdown fences."""



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
      "difficulty_score": int,
      "correct_rate": float | None,
      "concept_tags": [str, ...],
      "skill_tags": [str, ...],
      "answer_type": str | None,
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
    "answer_type": None,
  }

  try:
    # ── Call A: 메타 추출 (difficulty_score/correct_rate/concept_tags/skill_tags/answer_type) ──
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

    # Call A 만 수행 (Call B 제거, 2026-06-20)
    result = meta

    concept_tags = normalize_tags(result.concept_tags, "concept", concept_embeddings, threshold=0.65)
    skill_tags = normalize_tags(result.skill_tags, "skill", skill_embeddings, threshold=0.65)

    # _d 는 정답률 우선으로 이미 결정됨(정답률 있으면 구간매핑, 없으면 GPT). 저장도 _d 사용.
    difficulty_score = _d


    unit = ""
    unit_score = 0.0
    if leaf_embeddings is not None:
      query_parts: list[str] = []
      query_parts.extend(concept_tags)
      query_parts.extend(skill_tags)
      query_text = ", ".join(query_parts)
      if query_text:
        unit, unit_score = unit_matcher.match_unit(query_text, leaf_embeddings)
        logger.info(f"unit 매칭: '{unit}' (score={unit_score:.3f})")

    tag_result = {
      "unit": unit,
      "unit_score": unit_score,
      "difficulty_score": difficulty_score,
      "correct_rate": effective_correct_rate,
      "concept_tags": concept_tags,
      "skill_tags": skill_tags,
      "answer_type": result.answer_type,
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
        "answer_type": None,
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
