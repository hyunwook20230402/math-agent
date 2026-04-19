"""VL 모델 기반 온톨로지 데이터 추출

환경변수:
  VL_PROVIDER    — ollama (기본) | gemini | openai
  VL_OLLAMA_URL  — Ollama 서버 URL (기본 http://localhost:11434)
  VL_MODEL       — Ollama 모델 태그 (기본 gemma3:27b)
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
  difficulty: str                              # easy | medium | hard
  concept_tags: list[str] = Field(default_factory=list)
  skill_tags: list[str] = Field(default_factory=list)
  solution_summary: Optional[str] = None
  pitfall: Optional[str] = None
  solution_steps: list[SolutionStep] = Field(default_factory=list)
  common_mistakes: list[CommonMistake] = Field(default_factory=list)


# ── 프롬프트 ──────────────────────────────────────────────────────────────────

_TAGGING_PROMPT_WITH_SOLUTION = """You are analyzing a Korean high school math solution image.

Rules:
- difficulty: easy / medium / hard
- concept_tags: max 3 terms IN KOREAN (e.g. "삼각함수", "이차방정식", "미분")
- skill_tags: max 3 terms IN KOREAN (e.g. "인수분해", "치환", "그래프 해석")
- solution_summary: max 20 words IN KOREAN
- pitfall: max 20 words IN KOREAN
- solution_steps: max 5 steps, each description max 15 words IN KOREAN
- common_mistakes: 2-3 items, each text max 10 words IN KOREAN

All text fields (concept_tags, skill_tags, solution_summary, pitfall, solution_steps.description, common_mistakes.text) MUST be in Korean.
Output valid JSON only."""

_TAGGING_PROMPT_NO_SOLUTION = """You are analyzing a Korean high school math problem image (no solution shown).

Rules:
- difficulty: easy / medium / hard
- concept_tags: max 3 terms IN KOREAN (e.g. "삼각함수", "이차방정식", "미분")
- skill_tags: max 3 terms IN KOREAN (e.g. "인수분해", "치환", "그래프 해석")
- solution_summary: null
- pitfall: max 20 words IN KOREAN
- solution_steps: []
- common_mistakes: 2-3 items, each text max 10 words IN KOREAN

All text fields MUST be in Korean.
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


def _call_vl(image_path: str, prompt: str, timeout: int | None = None) -> TagResult:
  """vl_providers.call_vl 래퍼. monkeypatch 및 레거시 호출 호환."""
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

  - concept_tags / skill_tags: tag_normalizer 로 canonical 매칭 성공한 항목만 덮어쓰기
  - unit: match_unit 재매칭 후 신규 score 가 기존보다 높을 때만 덮어쓰기
  - 원본은 validation["original_values"] 에 보존
  - 덮어쓴 issue 는 applied=True 플래그
  """
  status = validation.get("status")
  if status not in ("warning", "reject"):
    return
  fixes = validation.get("suggested_fixes") or {}
  if not fixes:
    return

  original = {
    "unit": tag_result.get("unit", ""),
    "concept_tags": list(tag_result.get("concept_tags", [])),
    "skill_tags": list(tag_result.get("skill_tags", [])),
  }

  issues = validation.get("issues", []) or []

  def _any_medium_plus(field_names: set[str]) -> list[dict]:
    return [
      i for i in issues
      if i.get("field") in field_names and i.get("severity") in ("medium", "high")
    ]

  applied_fields: set[str] = set()

  # concept_tags
  suggested_concepts = fixes.get("concept_tags") or []
  concept_issues = _any_medium_plus({"concept_tags", "concept_tags/skill_tags"})
  if suggested_concepts and concept_issues:
    normalized = normalize_tags(suggested_concepts, "concept", concept_embeddings, threshold=0.65)
    if normalized:
      tag_result["concept_tags"] = normalized
      applied_fields.add("concept_tags")

  # skill_tags
  suggested_skills = fixes.get("skill_tags") or []
  skill_issues = _any_medium_plus({"skill_tags", "concept_tags/skill_tags"})
  if suggested_skills and skill_issues:
    normalized = normalize_tags(suggested_skills, "skill", skill_embeddings, threshold=0.65)
    if normalized:
      tag_result["skill_tags"] = normalized
      applied_fields.add("skill_tags")

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
) -> dict:
  """단일 이미지에서 온톨로지 데이터 추출.

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

  prompt = _TAGGING_PROMPT_WITH_SOLUTION if has_solution else _TAGGING_PROMPT_NO_SOLUTION

  fallback = {
    "unit": "",
    "unit_score": 0.0,
    "difficulty": "",
    "concept_tags": [],
    "skill_tags": [],
    "solution_summary": None,
    "pitfall": None,
    "solution_steps": [],
    "common_mistakes": [],
  }

  try:
    result = _call_vl(image_path, prompt)

    concept_tags = normalize_tags(result.concept_tags, "concept", concept_embeddings, threshold=0.65)
    skill_tags = normalize_tags(result.skill_tags, "skill", skill_embeddings, threshold=0.65)

    difficulty = result.difficulty.strip().lower()
    if difficulty not in ("easy", "medium", "hard"):
      difficulty = ""

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

    tag_result = {
      "unit": unit,
      "unit_score": unit_score,
      "difficulty": difficulty,
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
        validation = tag_validator.validate(tag_result, image_path)
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

  except requests.exceptions.ConnectionError:  # type: ignore[name-defined]
    logger.error("Ollama 서버 연결 실패. 'ollama serve' 실행 여부 확인")
    return fallback
  except requests.exceptions.Timeout:  # type: ignore[name-defined]
    logger.error(f"VL 모델 응답 타임아웃: {image_path}")
    return fallback
  except ValidationError as e:
    logger.error(f"Pydantic 파싱 실패: {e}")
    return fallback
  except Exception as e:
    logger.error(f"태깅 오류: {e}")
    return fallback


def tag_all_solutions(
  solution_images: dict,
  progress_callback=None,
  numbers_filter: set[int] | None = None,
) -> dict:
  """모든 해설 이미지 일괄 태깅.

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
    result = extract_tags_from_image(
      img_path,
      has_solution=True,
      taxonomy=taxonomy,
      leaf_embeddings=leaf_embeddings,
      concept_embeddings=concept_embeddings,
      skill_embeddings=skill_embeddings,
      bug_embeddings=bug_embeddings,
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
