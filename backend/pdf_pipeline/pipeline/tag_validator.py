"""온톨로지 태깅 검증 에이전트 (3-layer)

Layer 1 — Rule 기반 (비용 0): 필드 누락, 영어 혼입, unit_score 경고
Layer 2 — LLM 재검증 (Gemini 1호출): 이미지 + 태깅 결과 cross-check
Layer 3 — 임베딩 자가 체크 (비용 0): solution_steps ↔ concept_tags cosine 일치도

환경변수:
  TAG_VALIDATOR_ENABLED  — "true" (기본) | "false"
  TAG_VALIDATOR_LAYERS   — "123" (기본) | "1" | "13" 등 조합 가능
"""
import json
import logging
import os
import re
from typing import Literal

import numpy as np
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

TAG_VALIDATOR_LAYERS = os.environ.get("TAG_VALIDATOR_LAYERS", "123")


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

  steps = tag_result.get("solution_steps") or []
  if not steps:
    issues.append(ValidationIssue(field="solution_steps", reason="solution_steps 비어 있음", severity="medium"))
  else:
    difficulty_score = tag_result.get("difficulty_score")
    if difficulty_score is not None:
      d = int(difficulty_score)
      step_count = len(steps)
      if d <= 6 and step_count < 3:
        issues.append(ValidationIssue(field="solution_steps", reason=f"difficulty {d}(쉬움)인데 steps {step_count}개 — 최소 3개 필요", severity="medium"))
      elif d >= 7 and step_count < 5:
        issues.append(ValidationIssue(field="solution_steps", reason=f"difficulty {d}(어려움)인데 steps {step_count}개 — 최소 5개 필요", severity="medium"))

  if not tag_result.get("common_mistakes"):
    issues.append(ValidationIssue(field="common_mistakes", reason="common_mistakes 비어 있음", severity="low"))

  difficulty_score = tag_result.get("difficulty_score")
  if difficulty_score is not None and not (1 <= int(difficulty_score) <= 10):
    issues.append(ValidationIssue(field="difficulty_score", reason=f"difficulty_score={difficulty_score} 범위 초과 (1~10)", severity="high"))

  unit_score = tag_result.get("unit_score", 1.0)
  if unit_score < 0.5:
    issues.append(ValidationIssue(
      field="unit",
      reason=f"unit_score={unit_score:.2f} < 0.5 — 단원 매칭 신뢰도 낮음",
      severity="medium",
    ))

  mistakes: list[dict] = tag_result.get("common_mistakes", [])
  if mistakes:
    null_count = sum(1 for m in mistakes if m.get("bug_id") is None)
    if null_count / len(mistakes) >= 0.7:
      issues.append(ValidationIssue(
        field="common_mistakes",
        reason=f"bug_id null 비율 {null_count}/{len(mistakes)} — taxonomy bugs 동의어 부족",
        severity="medium",
      ))

  # 영어 혼입 체크 — 학생 UI 노출 텍스트 필드만 검사
  # difficulty(enum), bug_id(내부 식별자), unit(계층경로) 는 영어 허용
  for field_name in ("solution_summary", "pitfall"):
    val = tag_result.get(field_name) or ""
    if _has_english(str(val)):
      issues.append(ValidationIssue(field=field_name, reason=f"{field_name} 에 영어 혼입", severity="high"))

  steps: list[dict] = tag_result.get("solution_steps", [])
  for step in steps:
    desc = step.get("description", "")
    if _has_english(desc):
      issues.append(ValidationIssue(field="solution_steps", reason=f"step {step.get('step')} description 영어 혼입", severity="high"))
      break

  for tag in tag_result.get("concept_tags", []) + tag_result.get("skill_tags", []):
    if _has_english(tag, ratio_threshold=0.8):
      issues.append(ValidationIssue(field="concept_tags/skill_tags", reason=f"태그 '{tag}' 영어 — 한국어 강제 필요", severity="high"))
      break

  # common_mistakes.text 는 학생 UI 노출 → 영어 체크 (bug_id 는 내부 식별자라 제외)
  for m in tag_result.get("common_mistakes", []):
    if _has_english(m.get("text", "")):
      issues.append(ValidationIssue(field="common_mistakes.text", reason=f"common_mistakes text 영어 혼입: {m.get('text', '')[:30]}", severity="high"))
      break

  return issues


# ── Layer 3: 임베딩 자가 체크 ─────────────────────────────────────────────────

def _layer3_embedding(tag_result: dict) -> list[ValidationIssue]:
  """solution_steps 텍스트 ↔ concept_tags 임베딩 cosine 일치도 체크."""
  issues: list[ValidationIssue] = []

  concept_tags: list[str] = tag_result.get("concept_tags", [])
  steps: list[dict] = tag_result.get("solution_steps", [])

  if not concept_tags or not steps:
    return issues

  try:
    from . import embedder

    steps_text = " ".join(s.get("description", "") for s in steps)
    tags_text = " ".join(concept_tags)

    steps_vec = np.array(embedder.generate_embedding(steps_text), dtype=np.float32)
    tags_vec = np.array(embedder.generate_embedding(tags_text), dtype=np.float32)

    steps_norm = np.linalg.norm(steps_vec)
    tags_norm = np.linalg.norm(tags_vec)

    if steps_norm > 0 and tags_norm > 0:
      similarity = float(np.dot(steps_vec / steps_norm, tags_vec / tags_norm))
      if similarity < 0.4:
        issues.append(ValidationIssue(
          field="concept_tags",
          reason=f"solution_steps 내용과 concept_tags 임베딩 유사도 낮음 ({similarity:.2f})",
          severity="medium",
        ))
  except Exception as e:
    logger.debug(f"Layer 3 임베딩 체크 실패 (무시): {e}")

  return issues


# ── Layer 2: LLM 재검증 ───────────────────────────────────────────────────────

_VALIDATION_PROMPT_TEMPLATE = """\
아래는 수학 해설 이미지에 대한 자동 태깅 결과다.
이미지와 태깅 결과를 비교해서 다음을 검사해라:
1. concept_tags / skill_tags 중 명백히 누락된 개념이나 오태깅이 있는가?
2. unit (단원 경로) 이 이미지 내용과 맞는가?
3. solution_steps 가 실제 풀이 흐름과 맞는가? 아래 기준으로 엄격히 판단해라:
   - 이미지에 등장하는 핵심 계산/변환 단계가 steps에 빠져 있으면 "solution_steps step 누락" 이슈 (severity=high)
   - steps 순서가 실제 풀이 순서와 다르면 "solution_steps 순서 불일치" 이슈 (severity=high)
   - steps 내용이 이미지와 무관한 엉뚱한 풀이면 "solution_steps 내용 불일치" 이슈 (severity=high, reject)
   - difficulty_score 1~6인데 steps 3개 미만, 또는 difficulty_score 7~10인데 steps 5개 미만이면 "solution_steps 개수 부족" 이슈 (severity=medium)
   - steps 개수가 1개뿐이거나 지나치게 뭉뚱그려진 경우 "solution_steps 세분화 부족" 이슈 (severity=medium)
4. difficulty_score (1~10 정수) 가 문제 난이도와 맞는가? (1-2=아주 쉬움, 3-4=쉬움, 5-6=보통, 7-8=어려움, 9-10=최상위 킬러)

태깅 결과:
{tag_json}

{canonical_section}

모든 text 필드는 한국어여야 한다. 영어가 있으면 반드시 지적해라.
suggested_fixes 를 제안할 때:
- concept_tags / skill_tags 는 반드시 위에 제시된 "사용 가능한 canonical 목록" 안에서만 골라라.
- unit 은 반드시 "사용 가능한 unit 경로" 중 하나를 골라라.
- difficulty_score 가 부적절하면 suggested_fixes.difficulty_score 에 1~10 정수로 직접 제시해라.
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
  """Gemini (또는 현재 VL_PROVIDER) 로 태깅 결과를 재검증.

  image_path 는 단일 경로 또는 리스트([문제경로, 해설경로]). 리스트면 멀티 이미지로 전달.
  """
  try:
    from .vl_providers import call_vl

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

    llm_result = call_vl(image_path, prompt, _LLMValidation)
    return llm_result.issues, llm_result.suggested_fixes

  except Exception as e:
    logger.warning(f"Layer 2 LLM 재검증 실패 (무시): {e}")
    return [], None


# ── 공개 API ──────────────────────────────────────────────────────────────────

def validate(tag_result: dict, image_path: str | list[str]) -> ValidationResult:
  """태깅 결과를 3-layer 로 검증.

  TAG_VALIDATOR_LAYERS 환경변수로 레이어 선택 (기본 "123" = 전체).
  image_path 는 단일 경로 또는 [문제, 해설] 리스트 허용.
  """
  layers = os.environ.get("TAG_VALIDATOR_LAYERS", TAG_VALIDATOR_LAYERS)

  all_issues: list[ValidationIssue] = []
  suggested_fixes: SuggestedFixes | None = None

  if "1" in layers:
    all_issues.extend(_layer1_rule(tag_result))

  if "3" in layers:
    all_issues.extend(_layer3_embedding(tag_result))

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
