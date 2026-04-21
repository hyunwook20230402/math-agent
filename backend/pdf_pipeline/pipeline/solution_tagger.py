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
from .vl_providers import call_vl

logger = logging.getLogger(__name__)


# ── Pydantic 응답 스키마 ──────────────────────────────────────────────────────

class SolutionStep(BaseModel):
  step: int
  description: str  # 한국어, 수식 포함 가능

class CommonMistake(BaseModel):
  text: str         # 한국어, 학생 UI 노출

class TagResult(BaseModel):
  difficulty_score: int = Field(ge=1, le=10)  # 1~10 정수 (1-2=very_easy, 3-4=easy, 5-6=medium, 7-8=hard, 9-10=very_hard)
  concept_tags: list[str] = Field(default_factory=list, min_length=1)
  skill_tags: list[str] = Field(default_factory=list, min_length=1)
  answer_type: Optional[str] = None  # "multiple_choice" or "short_answer"
  solution_summary: Optional[str] = None
  pitfall: Optional[str] = None
  solution_steps: list[SolutionStep] = Field(default_factory=list)
  common_mistakes: list[CommonMistake] = Field(default_factory=list)


# ── 프롬프트 ──────────────────────────────────────────────────────────────────

_TAGGING_PROMPT_WITH_SOLUTION = """You are analyzing a Korean high school math solution image.

Rules:
- difficulty_score: integer 1 to 10 where 1-2=아주 쉬움(공식 직접 대입), 3-4=쉬움(쎈 B초반/모의 3점 쉬움), 5-6=보통(쎈 B/모의 3점 표준), 7-8=어려움(쎈 C/모의 4점 준킬러), 9-10=최상위 킬러(수능 21/29/30번류)
- answer_type: "multiple_choice" if the problem has numbered options (①②③④⑤), otherwise "short_answer"
- concept_tags: 반드시 1~3개 IN KOREAN (빈 리스트 금지). 한국 고등학교 수학 대단원 수준 용어 사용 (예: "삼각함수", "이차방정식", "미분", "수열", "함수의 극한")
- skill_tags: 반드시 1~3개 IN KOREAN (빈 리스트 금지). 문제 풀이에 실제 쓰인 기법 (예: "인수분해", "치환", "그래프 해석", "시그마 분배")
- solution_summary: max 20 words IN KOREAN
- pitfall: max 20 words IN KOREAN
- solution_steps: 3~5 steps for difficulty 1-6, 5~8 steps for difficulty 7-10. Each description max 15 words IN KOREAN
- common_mistakes: 2-3 items, each text max 10 words IN KOREAN

All text fields MUST be in Korean.

MATH NOTATION RULES (반드시 준수):
1. 모든 수학 표현은 \\( ... \\) 로 감쌀 것. 단일 변수/숫자도 포함: \\(x\\), \\(2\\), \\(f(2)\\), \\(x+2\\), \\(x^2\\).
2. \\text{...} 절대 사용 금지. 한글 설명은 그냥 평문으로 쓰고, 수식 부분만 \\( ... \\) 로 감싼다.
3. 모든 백슬래시는 JSON 에서 두 개로 이스케이프할 것: \\\\sum, \\\\frac, \\\\lim, \\\\to, \\\\text 금지.
4. LaTeX 명령어는 반드시 수식 구간 안에서만. \\(x \\to 0^+\\) ✅, x \\to 0 ❌ (평문에 명령어 금지).
5. 닫는 괄호 확인: 열린 \\( 는 반드시 \\) 로 닫는다.

예시 (올바른 형식):
{
  "difficulty_score": 4,
  "concept_tags": ["수열", "시그마"],
  "skill_tags": ["시그마 분배 법칙", "수열의 합 계산"],
  "answer_type": "short_answer",
  "solution_summary": "\\(\\sum_{k=1}^{5}(a_k+1)=9\\) 에서 \\(\\sum a_k\\) 를 구한 뒤 \\(a_6\\) 을 더한다.",
  "pitfall": "\\(\\sum_{k=1}^{5} 1\\) 을 1로 착각",
  "solution_steps": [{"step":1,"description":"\\(\\sum (a_k+1)\\) 을 분리하여 \\(\\sum a_k + 5 = 9\\) 로 정리"}],
  "common_mistakes": [{"text":"\\(\\sum 1\\) 을 1로 계산"}]
}

잘못된 예시 (이렇게 쓰지 말 것):
- "\\text{\\sum a_k}" ❌ → "\\(\\sum a_k\\)" ✅
- "함수 f(x) = x^2 + x + 2" ❌ → "함수 \\(f(x) = x^2 + x + 2\\)" ✅
- "x → 0+ 일 때" ❌ → "\\(x \\to 0^+\\) 일 때" ✅
- "\\text{그래프에서...}" ❌ → "그래프에서..." (한글은 평문, 수식만 \\( \\))

Output valid JSON only."""

_TAGGING_PROMPT_WITH_PROBLEM_AND_SOLUTION = """You are analyzing a Korean high school math problem and its solution.

You are given TWO images in order:
- Image 1 = Problem (문제)
- Image 2 = Solution (해설)

Use BOTH images together: the problem tells you what is being asked and which given conditions matter; the solution tells you which techniques were actually used. Tags must reflect both the problem's intent and the solution's method.

Rules:
- difficulty_score: integer 1 to 10 where 1-2=아주 쉬움(공식 직접 대입), 3-4=쉬움(쎈 B초반/모의 3점 쉬움), 5-6=보통(쎈 B/모의 3점 표준), 7-8=어려움(쎈 C/모의 4점 준킬러), 9-10=최상위 킬러(수능 21/29/30번류)
- answer_type: "multiple_choice" if the problem image shows numbered options (①②③④⑤), otherwise "short_answer"
- concept_tags: 반드시 1~3개 IN KOREAN (빈 리스트 금지). 문제의 핵심 개념을 풀이와 교차 확인 (예: "삼각함수", "이차방정식", "미분", "수열", "함수의 극한")
- skill_tags: 반드시 1~3개 IN KOREAN (빈 리스트 금지). 풀이에서 실제로 사용된 기법 (예: "인수분해", "치환", "그래프 해석", "시그마 분배")
- solution_summary: max 20 words IN KOREAN — describe the core approach
- pitfall: max 20 words IN KOREAN — the most likely mistake given the problem's trap
- solution_steps: 3~5 steps for difficulty 1-6, 5~8 steps for difficulty 7-10. Each description max 15 words IN KOREAN
- common_mistakes: 2-3 items, each text max 10 words IN KOREAN

All text fields MUST be in Korean.
For any mathematical expression in text fields, wrap it in \\( ... \\). Examples: \\(f(x)\\), \\(x^2\\), \\(\\frac{a}{b}\\), \\(\\log_5 3\\), \\(a_n\\).

예시:
{
  "difficulty_score": 4,
  "concept_tags": ["수열", "시그마"],
  "skill_tags": ["시그마 분배 법칙", "수열의 합 계산"],
  "answer_type": "short_answer",
  "solution_summary": "\\(\\sum (a_k+1)=9\\) 에서 \\(\\sum a_k\\) 를 구한 뒤 \\(a_6\\) 을 더한다.",
  "pitfall": "\\(\\sum 1\\) 을 1로 착각",
  "solution_steps": [{"step":1,"description":"\\(\\sum (a_k+1)\\) 을 분리하여 \\(\\sum a_k + 5 = 9\\) 로 정리"}],
  "common_mistakes": [{"text":"\\(\\sum 1\\) 을 1로 계산"}]
}
Output valid JSON only."""

_TAGGING_PROMPT_NO_SOLUTION = """You are analyzing a Korean high school math problem image (no solution shown).

Rules:
- difficulty_score: integer 1 to 10 where 1-2=아주 쉬움(공식 직접 대입), 3-4=쉬움(쎈 B초반/모의 3점 쉬움), 5-6=보통(쎈 B/모의 3점 표준), 7-8=어려움(쎈 C/모의 4점 준킬러), 9-10=최상위 킬러(수능 21/29/30번류)
- answer_type: "multiple_choice" if the problem image shows numbered options (①②③④⑤), otherwise "short_answer"
- concept_tags: 반드시 1~3개 IN KOREAN (빈 리스트 금지). (예: "삼각함수", "이차방정식", "미분", "수열", "함수의 극한")
- skill_tags: 반드시 1~3개 IN KOREAN (빈 리스트 금지). (예: "인수분해", "치환", "그래프 해석", "시그마 분배")
- solution_summary: null
- pitfall: max 20 words IN KOREAN
- solution_steps: []
- common_mistakes: 2-3 items, each text max 10 words IN KOREAN

All text fields MUST be in Korean.

MATH NOTATION RULES (반드시 준수):
1. 모든 수학 표현은 \\( ... \\) 로 감쌀 것. 단일 변수/숫자도 포함: \\(x\\), \\(2\\), \\(f(2)\\), \\(x+2\\).
2. \\text{...} 절대 사용 금지. 한글 설명은 평문, 수식만 \\( ... \\) 로 감싼다.
3. 모든 백슬래시는 두 개로 이스케이프: \\\\sum, \\\\frac, \\\\lim, \\\\to.
4. 열린 \\( 는 반드시 \\) 로 닫는다.

Output valid JSON only."""


# ── 내부 유틸 ─────────────────────────────────────────────────────────────────

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
      "solution_steps": [{"step": int, "description": str}, ...],
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
    result = _call_vl(vl_image_arg, prompt)

    # gemma4 가 개념/스킬을 비우는 경향이 있어 빈 리스트면 1회 재시도
    if not result.concept_tags or not result.skill_tags:
      logger.warning(
        f"concept/skill 비어 있음 → 재시도 [{image_path}] "
        f"(concept={len(result.concept_tags)}, skill={len(result.skill_tags)})"
      )
      retry_prompt = prompt + (
        "\n\nIMPORTANT: concept_tags 와 skill_tags 는 반드시 1개 이상 포함해야 한다. "
        "빈 리스트는 허용되지 않는다."
      )
      try:
        result = _call_vl(vl_image_arg, retry_prompt)
      except Exception as re_e:
        logger.warning(f"재시도 실패 (원본 결과 유지): {re_e}")

    concept_tags = normalize_tags(result.concept_tags, "concept", concept_embeddings, threshold=0.65)
    skill_tags = normalize_tags(result.skill_tags, "skill", skill_embeddings, threshold=0.65)

    difficulty_score = max(1, min(10, int(result.difficulty_score)))

    pitfall = result.pitfall.strip() if isinstance(result.pitfall, str) else None
    solution_summary = result.solution_summary

    solution_steps = [{"step": s.step, "description": s.description} for s in result.solution_steps]
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
    # gemma4 `\text{...}` 남용 정리 (수식은 \(...\) 로, 중첩 해제)
    def _nm(text):
      if not isinstance(text, str):
        return text
      import re as _re

      # 0) JSON escape 가 소실된 "term{", "erm{", "ext{" 를 `\text{` 로 복구
      #    (앞에 백슬래시/알파벳이 없을 때만 — 단어 중간의 term/erm 는 건드리지 않음)
      text = _re.sub(r'(?<![\\a-zA-Z])term\{', r'\\text{', text)
      text = _re.sub(r'(?<![\\a-zA-Z])erm\{', r'\\text{', text)
      text = _re.sub(r'(?<![\\a-zA-Z])ext\{', r'\\text{', text)

      # 1) $...$ → \(...\)
      text = _re.sub(r'\$\$(.+?)\$\$', r'\\[\1\\]', text, flags=_re.DOTALL)
      text = _re.sub(r'\$([^$\n]+?)\$', r'\\(\1\\)', text)

      # 2) `\text{\text{...}}` 같은 중첩을 안쪽 한 겹으로 축약 (여러 번 반복)
      for _ in range(4):
        new_text = _re.sub(r'\\text\{\s*\\text\{', r'\\text{', text)
        if new_text == text:
          break
        text = new_text

      # 3) `\text{ ... LaTeX 명령어 ... }` → `\( ... \)` 변환.
      #    내용 안에 `\sum`, `\frac`, `\sqrt`, `\lim`, `\int`, `\to`, `a_k`, `^`, `_{`
      #    등 수식 전용 토큰이 있으면 수식으로 간주. 한글만 있으면 평문으로 풀어버림.
      _MATH_MARKER = _re.compile(
        r'\\(sum|frac|sqrt|lim|int|to|times|cdot|left|right|binom|overline|bar|sqrt|infty|cdots|ldots|alpha|beta|gamma|theta|pi|mu|sigma|delta|text|rm)\b'
        r'|[_^]\{|\^\d|=\s*\\|_[a-zA-Z0-9]'
      )
      def _text_to_math_or_plain(m: _re.Match) -> str:
        inner = m.group(1)
        # 안쪽의 `\text{` 한 번 더 제거 (중첩 잔존 대비)
        inner = _re.sub(r'\\text\{([^{}]*)\}', r'\1', inner)
        if _MATH_MARKER.search(inner):
          return r'\(' + inner.strip() + r'\)'
        # 한글/영어 평문 → 그대로 풀어버림
        return inner

      # `\text{...}` — 내부에 중첩된 `{}` 가 없는 가장 안쪽부터 처리
      prev = None
      guard = 0
      while prev != text and guard < 6:
        prev = text
        text = _re.sub(r'\\text\{([^{}]*)\}', _text_to_math_or_plain, text)
        guard += 1

      # 4) 고아 `$` 제거 (쌍 안 맞아 남은 단일 `$` 는 렌더 깨뜨림)
      if text.count('$') == 1:
        text = text.replace('$', '')

      # 5) 열린 `\(` 와 닫힌 `\)` 개수 불일치 시 경고만 (함부로 보정하면 내용 꼬임)
      open_n = len(_re.findall(r'\\\(', text))
      close_n = len(_re.findall(r'\\\)', text))
      if open_n != close_n:
        logger.warning(f"[_nm] \\( vs \\) 불일치 ({open_n} vs {close_n}): {text[:120]!r}")

      # 6) 여전히 backslash 가 유실된 LaTeX 명령어 흔적이 있으면 경고
      if _re.search(r'(?<![\\a-zA-Z])(sum|frac|sqrt|lim|int)_?\{', text):
        logger.warning(f"[_nm] LaTeX 명령 backslash 유실 의심: {text[:120]!r}")

      return text

    solution_summary = _nm(solution_summary)
    pitfall = _nm(pitfall)
    solution_steps = [{"step": s["step"], "description": _nm(s.get("description", ""))} for s in solution_steps] if solution_steps else solution_steps
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
    results[num] = result

    validation = result.get("_validation", {})
    if validation.get("status") == "reject":
      flagged.append(num)
      logger.warning(f"검증 reject: {num}번 — {validation.get('issues', [])}")

  if progress_callback:
    progress_callback(total, total, -1)

  results["flagged_numbers"] = flagged
  return results
