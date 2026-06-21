"""온톨로지 태깅 검증 에이전트 (2-layer)

Layer 1 — Rule 기반 (비용 0): 필드 누락, 영어 혼입, 범위 검사 등
Layer 2 — LLM 재검증 (call_vl 1호출, OpenAI): 이미지 + 태깅 결과 cross-check

VL 은 OpenAI 단일(2026-06-19 gemma4 폐기).
solution_steps/solution_summary/pitfall/common_mistakes 는 폐기(2026-06-20).

환경변수:
  TAG_VALIDATOR_ENABLED  — "true" (기본) | "false"
  TAG_VALIDATOR_LAYERS   — "12" (기본) | "1" | "2" 등 조합 가능

상세 문서: backend/pdf_pipeline/docs/TAG_VALIDATOR.md
"""
import json
import logging
import os
from typing import Literal

from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

TAG_VALIDATOR_LAYERS = os.environ.get("TAG_VALIDATOR_LAYERS", "12")


# ── Pydantic 스키마 ───────────────────────────────────────────────────────────

class ValidationIssue(BaseModel):
  field: str
  reason: str
  severity: Literal["low", "medium", "high"]
  applied: bool = False  # suggested_fix 자동 반영 여부 (solution_tagger 가 세팅)

class SuggestedFixes(BaseModel):
  concept_tags: list[str] | None = None
  skill_tags: list[str] | None = None
  unit: str | None = None
  difficulty_score: int | None = None

class ValidationResult(BaseModel):
  status: Literal["ok", "warning", "reject"]
  score: float = Field(ge=0.0, le=1.0)
  issues: list[ValidationIssue] = Field(default_factory=list)
  suggested_fixes: SuggestedFixes | None = None


# ── Layer 1: Rule 기반 ────────────────────────────────────────────────────────

import re

_EN_WORD_RE = re.compile(r"[a-zA-Z]{4,}")


def _has_english(text: str, ratio_threshold: float = 0.3) -> bool:
  """전체 단어 중 영단어(4자 이상) 비율이 threshold 초과하면 True."""
  if not text:
    return False
  words = text.split()
  if not words:
    return False
  en_count = sum(1 for w in words if _EN_WORD_RE.search(w))
  return (en_count / len(words)) > ratio_threshold


def _layer1_rule(tag_result: dict) -> list[ValidationIssue]:
  issues: list[ValidationIssue] = []

  if not tag_result.get("concept_tags"):
    issues.append(ValidationIssue(field="concept_tags", reason="concept_tags 비어 있음", severity="high"))

  if not tag_result.get("skill_tags"):
    issues.append(ValidationIssue(field="skill_tags", reason="skill_tags 비어 있음", severity="medium"))

  difficulty_score = tag_result.get("difficulty_score")
  if difficulty_score is not None and not (1 <= int(difficulty_score) <= 4):
    issues.append(ValidationIssue(field="difficulty_score", reason=f"difficulty_score={difficulty_score} 범위 초과 (1~4)", severity="high"))

  unit_score = tag_result.get("unit_score", 1.0)
  if unit_score < 0.5:
    issues.append(ValidationIssue(
      field="unit",
      reason=f"unit_score={unit_score:.2f} < 0.5 — 단원 매칭 신뢰도 낮음",
      severity="medium",
    ))

  for tag in tag_result.get("concept_tags", []) + tag_result.get("skill_tags", []):
    if _has_english(tag, ratio_threshold=0.8):
      issues.append(ValidationIssue(field="concept_tags/skill_tags", reason=f"태그 '{tag}' 영어 — 한국어 강제 필요", severity="high"))
      break

  return issues


# ── Layer 2: LLM 재검증 ───────────────────────────────────────────────────────

_VALIDATION_PROMPT_TEMPLATE = """\
아래는 수학 해설 이미지에 대한 자동 태깅 결과다.
이미지와 태깅 결과를 비교해서 다음을 검사해라:
1. concept_tags / skill_tags 중 명백히 누락된 개념이나 오태깅이 있는가?
2. unit (단원 경로) 이 이미지 내용과 맞는가?
3. difficulty_score (1~4 정수, Lv1~Lv4) 가 문제 난이도와 맞는가? 해설에 Lv 라벨이 인쇄돼 있으면 그 숫자와 일치해야 한다. 라벨이 없으면 구조 신호 기반:
   - 1 (Lv1, 쉬움): 공식 1개 직접 대입, 개념 1개 안 2~3단 계산
   - 2 (Lv2, 보통): 조건 2~3개 조합, 개념 1~2개
   - 3 (Lv3, 어려움): 아이디어 1개 — 경우분리 2개 / 그래프+대수 / 합성·역·절댓값 1개 / 개념 2~3개 복합 중 1개
   - 4 (Lv4, 최상위): 경우분리 3+ / 합성·역·절댓값 중첩 2+ / 미지수 2+ 동시결정 / 그래프+경우분리+대수 모두 / 개념 3+ 복합 중 2개 이상 해당
   문제 번호는 참고만 — 시대별로 킬러 번호 다름.

태깅 결과:
{tag_json}

{canonical_section}

모든 text 필드는 한국어여야 한다. 영어가 있으면 반드시 지적해라.
suggested_fixes 를 제안할 때:
- concept_tags / skill_tags 는 반드시 위에 제시된 "사용 가능한 canonical 목록" 안에서만 골라라.
- unit 은 반드시 "사용 가능한 unit 경로" 중 하나를 골라라.
- difficulty_score 가 부적절하면 suggested_fixes.difficulty_score 에 1~4 정수로 직접 제시해라.
- 목록에 없는 용어는 제안하지 마라 (후처리에서 매칭 실패).

문제 없으면 status=ok, 경미한 문제면 warning, 심각하면 reject 로 판단해라.
JSON 으로만 응답해라."""


# canonical/unit 목록 캐시 (매 호출마다 파일 읽지 않도록)
_canonical_cache: dict | None = None


def _load_canonical_lists() -> dict:
  """taxonomy 에서 concepts/skills canonical + unit leaf path 목록을 읽어온다."""
  global _canonical_cache
  if _canonical_cache is not None:
    return _canonical_cache
  try:
    from pathlib import Path
    tax_path = Path(__file__).parent.parent / "data" / "concept_taxonomy.json"
    with open(tax_path, encoding="utf-8") as f:
      tax = json.load(f)
    concepts = sorted(tax.get("concepts", {}).keys())
    skills = sorted(tax.get("skills", {}).keys())
    units: list[str] = []
    for subject, bigs in (tax.get("units") or {}).items():
      if not isinstance(bigs, dict):
        continue
      for big, mids in bigs.items():
        if not isinstance(mids, dict):
          continue
        for mid, smalls in mids.items():
          if not isinstance(smalls, list):
            continue
          for small in smalls:
            units.append(f"{subject} > {big} > {mid} > {small}")
    _canonical_cache = {"concepts": concepts, "skills": skills, "units": sorted(units)}
    return _canonical_cache
  except Exception as e:
    logger.warning(f"canonical 목록 로드 실패 (프롬프트에 빈 목록): {e}")
    _canonical_cache = {"concepts": [], "skills": [], "units": []}
    return _canonical_cache


def _build_canonical_section() -> str:
  lists = _load_canonical_lists()
  concepts_str = ", ".join(lists["concepts"]) if lists["concepts"] else "(없음)"
  skills_str = ", ".join(lists["skills"]) if lists["skills"] else "(없음)"
  units_str = "\n  - " + "\n  - ".join(lists["units"]) if lists["units"] else "(없음)"
  return (
    "사용 가능한 concepts canonical 목록:\n"
    f"{concepts_str}\n\n"
    "사용 가능한 skills canonical 목록:\n"
    f"{skills_str}\n\n"
    "사용 가능한 unit 경로 (소단원 leaf):"
    f"{units_str}"
  )


def _layer2_llm(tag_result: dict, image_path: str | list[str]) -> tuple[list[ValidationIssue], SuggestedFixes | None]:
  """LLM 으로 태깅 결과를 재검증. VL=OpenAI 단일(2026-06-19 gemma4 폐기).

  image_path 는 단일 경로 또는 리스트([문제경로, 해설경로]). 리스트면 멀티 이미지로 전달.
  (구 난이도 기반 provider 분기는 OpenAI 단일화로 제거.)
  """
  try:
    from .vl_providers import call_vl
    from .solution_tagger import META_MODEL  # 검증도 메타 계열 → gpt-4o

    # LLM 검증용 경량 스키마 (suggested_fixes 없이 먼저 받음)
    class _LLMValidation(BaseModel):
      status: Literal["ok", "warning", "reject"]
      issues: list[ValidationIssue] = Field(default_factory=list)
      suggested_fixes: SuggestedFixes | None = None

    tag_json = json.dumps(tag_result, ensure_ascii=False, indent=2)
    prompt = _VALIDATION_PROMPT_TEMPLATE.format(
      tag_json=tag_json,
      canonical_section=_build_canonical_section(),
    )

    d = int(tag_result.get("difficulty_score") or 2)
    logger.info(f"[validator L2] difficulty={d} provider=openai model={META_MODEL}")

    llm_result = call_vl(image_path, prompt, _LLMValidation, model=META_MODEL)
    return llm_result.issues, llm_result.suggested_fixes

  except Exception as e:
    logger.warning(f"Layer 2 LLM 재검증 실패 (무시): {e}")
    return [], None


# ── 공개 API ──────────────────────────────────────────────────────────────────

def validate(tag_result: dict, image_path: str | list[str]) -> ValidationResult:
  """태깅 결과를 2-layer 로 검증.

  TAG_VALIDATOR_LAYERS 환경변수로 레이어 선택 (기본 "12" = 전체).
  image_path 는 단일 경로 또는 [문제, 해설] 리스트 허용.
  """
  layers = os.environ.get("TAG_VALIDATOR_LAYERS", TAG_VALIDATOR_LAYERS)

  all_issues: list[ValidationIssue] = []
  suggested_fixes: SuggestedFixes | None = None

  if "1" in layers:
    all_issues.extend(_layer1_rule(tag_result))

  if "2" in layers:
    llm_issues, llm_fixes = _layer2_llm(tag_result, image_path)
    all_issues.extend(llm_issues)
    if llm_fixes:
      suggested_fixes = llm_fixes

  # severity 기준으로 status 결정
  severities = {i.severity for i in all_issues}
  if "high" in severities:
    status: Literal["ok", "warning", "reject"] = "reject"
  elif "medium" in severities:
    status = "warning"
  elif all_issues:
    status = "warning"
  else:
    status = "ok"

  # score: high issue 1개당 -0.2, medium -0.1, low -0.05
  score = 1.0
  for issue in all_issues:
    if issue.severity == "high":
      score -= 0.2
    elif issue.severity == "medium":
      score -= 0.1
    else:
      score -= 0.05
  score = max(0.0, round(score, 2))

  return ValidationResult(
    status=status,
    score=score,
    issues=all_issues,
    suggested_fixes=suggested_fixes,
  )
