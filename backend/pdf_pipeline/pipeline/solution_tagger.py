"""VL 모델 (Ollama) 기반 온톨로지 데이터 추출

환경변수로 VL 모델 선택:
  VL_OLLAMA_URL  — Ollama 서버 URL (기본 http://localhost:11434)
  VL_MODEL       — 모델 태그 (기본 qwen2.5vl:7b, 서버에선 gemma4:26b 등으로 덮어씀)
  VL_TIMEOUT     — 호출 타임아웃 초 (기본 180)

주요 함수:
  extract_tags_from_image(image_path, has_solution) → TagResult
  normalize_tags(raw_tags, tag_type, taxonomy) → 정규화된 태그 목록
  tag_all_solutions(solution_images, progress_callback) → {번호: 태그결과}
"""
import base64
import logging
import os
from pathlib import Path
from typing import Optional

import requests
from pydantic import BaseModel, ValidationError

from . import tag_normalizer, unit_matcher

logger = logging.getLogger(__name__)

VL_OLLAMA_URL = os.environ.get("VL_OLLAMA_URL", "http://localhost:11434").rstrip("/")
VL_MODEL = os.environ.get("VL_MODEL", "qwen2.5vl:7b")
VL_TIMEOUT = int(os.environ.get("VL_TIMEOUT", "180"))

OLLAMA_GENERATE_URL = f"{VL_OLLAMA_URL}/api/generate"


# ── Pydantic 응답 스키마 ──────────────────────────────────────────────────────

class ConceptTag(BaseModel):
  tag: str

class SkillTag(BaseModel):
  tag: str

class SolutionStep(BaseModel):
  step: int
  description: str  # 이 단계에서 하는 것 (수식 포함 자연어, 한국어)

class TagResult(BaseModel):
  difficulty: str                        # easy | medium | hard
  concept_tags: list[ConceptTag]
  skill_tags: list[SkillTag]
  solution_summary: Optional[str]
  pitfall: Optional[str]
  solution_steps: list[SolutionStep]     # 단계별 풀이 경로
  common_mistakes: list[str]             # 흔한 실수 텍스트 (bug taxonomy 매칭용)


# ── 프롬프트 ──────────────────────────────────────────────────────────────────

_TAGGING_PROMPT_WITH_SOLUTION = """Analyze this Korean high school math solution image.
Output only valid JSON. No explanation or markdown. Be concise.

Rules:
- difficulty: easy / medium / hard
- concept_tags: max 3 terms, 1-4 words each
- skill_tags: max 3 terms, 1-4 words each
- solution_summary: max 20 words
- pitfall: max 20 words
- solution_steps: max 5 steps, each description max 10 words
- common_mistakes: 2-3 items, max 8 words each"""

_TAGGING_PROMPT_NO_SOLUTION = """Analyze this Korean high school math problem image.
Output only valid JSON. No explanation or markdown. Be concise.

Rules:
- difficulty: easy / medium / hard
- concept_tags: max 3 terms, 1-4 words each
- skill_tags: max 3 terms, 1-4 words each
- solution_summary: null
- pitfall: max 20 words
- solution_steps: []
- common_mistakes: 2-3 items, max 8 words each"""


# ── 내부 유틸 ─────────────────────────────────────────────────────────────────

def _load_taxonomy() -> dict:
  """concept_taxonomy.json 로드"""
  taxonomy_path = Path(__file__).parent.parent / "data" / "concept_taxonomy.json"
  if not taxonomy_path.exists():
    logger.warning("concept_taxonomy.json 없음 — 정규화 건너뜀")
    return {"concepts": {}, "skills": {}, "units": {}}
  with open(taxonomy_path, encoding="utf-8") as f:
    import json
    return json.load(f)


def _image_to_base64(image_path: str) -> str:
  """이미지 파일 → base64 인코딩"""
  with open(image_path, "rb") as f:
    return base64.b64encode(f.read()).decode("utf-8")


def _call_vl(image_path: str, prompt: str, timeout: int | None = None) -> TagResult:
  """Ollama VL 모델 API 호출 → TagResult 반환.

  Structured Output (format: JSON Schema) 으로 Pydantic 스키마를 강제.
  system 필드 미사용 (gemma4:26b에서 빈 응답 유발).
  """
  img_b64 = _image_to_base64(image_path)
  payload = {
    "model": VL_MODEL,
    "prompt": prompt,
    "images": [img_b64],
    "format": TagResult.model_json_schema(),
    "stream": False,
    "options": {
      "temperature": 0.1,
      "num_ctx": 16384,   # 이미지 토큰 + JSON 응답 공간 확보 (Ollama 기본값 2048로는 부족)
      "num_predict": 16384,
    },
  }
  resp = requests.post(OLLAMA_GENERATE_URL, json=payload, timeout=timeout or VL_TIMEOUT)
  resp.raise_for_status()
  raw = resp.json().get("response", "")
  return TagResult.model_validate_json(raw)


def normalize_tags(
  raw_tags: list[ConceptTag | SkillTag],
  tag_type: str,
  section_embeddings: dict,
) -> list[str]:
  """bge-m3 cosine 유사도로 태그 정규화.

  AI가 "trigonometric equations"를 출력하면 "삼각함수"로 통일.
  매칭 안 되면 원본 유지.

  Args:
    raw_tags: VL 모델이 낸 태그 리스트
    tag_type: "concept" | "skill" (로깅용)
    section_embeddings: tag_normalizer.load_or_build_section_embeddings 결과
  """
  normalized: list[str] = []
  seen: set[str] = set()
  for item in raw_tags:
    tag = item.tag.strip()
    if not tag:
      continue
    canonical, _score = tag_normalizer.match_tag(tag, section_embeddings)
    if canonical and canonical not in seen:
      seen.add(canonical)
      normalized.append(canonical)
  return normalized


def _normalize_bug_ids(common_mistakes: list[str], bug_embeddings: dict) -> list[dict]:
  """common_mistakes 텍스트 → bug_id 매칭 (bge-m3 cosine)

  Args:
    bug_embeddings: tag_normalizer.load_or_build_section_embeddings("bugs") 결과
  """
  result = []
  for mistake in common_mistakes:
    canonical, score = tag_normalizer.match_tag(mistake, bug_embeddings)
    # canonical 이 bug_id(예: "bug_sign_error") 그대로면 매칭 성공, raw_tag면 실패
    bug_id = canonical if canonical in bug_embeddings.get("canonicals", []) else None
    result.append({"text": mistake, "bug_id": bug_id})
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
  """단일 이미지에서 온톨로지 데이터 추출

  Args:
    image_path: 해설 이미지 경로 (has_solution=True) 또는 문제 이미지 경로
    has_solution: True = 해설 이미지, False = 문제 이미지만
    taxonomy: 정규화 사전 (None이면 자동 로드, section_embeddings 자동 생성)
    leaf_embeddings: unit 매칭용 임베딩 (None이면 unit 매칭 건너뜀)
    concept_embeddings: concept 태그 정규화 임베딩 (None이면 taxonomy_path에서 빌드)
    skill_embeddings: skill 태그 정규화 임베딩 (None이면 taxonomy_path에서 빌드)
    bug_embeddings: bug_id 매칭 임베딩 (None이면 taxonomy_path에서 빌드)

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

    concept_tags = normalize_tags(result.concept_tags, "concept", concept_embeddings)
    skill_tags = normalize_tags(result.skill_tags, "skill", skill_embeddings)

    difficulty = result.difficulty.strip().lower()
    if difficulty not in ("easy", "medium", "hard"):
      difficulty = ""

    pitfall = result.pitfall.strip() if isinstance(result.pitfall, str) else None
    solution_summary = result.solution_summary

    solution_steps = [{"step": s.step, "description": s.description} for s in result.solution_steps]
    common_mistakes = _normalize_bug_ids(result.common_mistakes, bug_embeddings)

    # unit은 AI가 아니라 임베딩 매칭으로 결정
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

    return {
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

  except requests.exceptions.ConnectionError:
    logger.error("Ollama 서버 연결 실패. 'ollama serve' 실행 여부 확인")
    return fallback
  except requests.exceptions.Timeout:
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
  """모든 해설 이미지 일괄 태깅

  Args:
    solution_images: {번호: 이미지경로} (merge_cross_page_solutions 결과)
    progress_callback: callable(current, total, number) | None
    numbers_filter: 지정되면 이 번호들만 태깅. None이면 전체.

  Returns:
    {번호: extract_tags_from_image 결과}
  """
  taxonomy = _load_taxonomy()
  taxonomy_path = Path(__file__).parent.parent / "data" / "concept_taxonomy.json"
  leaf_embeddings = unit_matcher.load_or_build_embeddings(taxonomy_path)
  concept_embeddings = tag_normalizer.load_or_build_section_embeddings(taxonomy_path, "concepts")
  skill_embeddings = tag_normalizer.load_or_build_section_embeddings(taxonomy_path, "skills")
  bug_embeddings = tag_normalizer.load_or_build_section_embeddings(taxonomy_path, "bugs")

  results: dict[int, dict] = {}

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

  if progress_callback:
    progress_callback(total, total, -1)

  return results
