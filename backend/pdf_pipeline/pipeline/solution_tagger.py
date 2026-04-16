"""VL 모델 (Ollama) 기반 개념/스킬 태그 + 풀이 요약 자동 추출

환경변수로 VL 모델 선택:
  VL_OLLAMA_URL  — Ollama 서버 URL (기본 http://localhost:11434)
  VL_MODEL       — 모델 태그 (기본 qwen2.5vl:7b, 서버에선 gemma4:26b 등으로 덮어씀)
  VL_TIMEOUT     — 호출 타임아웃 초 (기본 180)

주요 함수:
  extract_tags_from_image(image_path, has_solution) → {concept_tags, skill_tags, solution_summary}
  normalize_tags(raw_tags, tag_type, taxonomy) → 정규화된 태그 목록
  tag_all_solutions(solution_images, progress_callback) → {번호: 태그결과}
"""
import json
import base64
import logging
import os
from pathlib import Path

import requests

from . import unit_matcher

logger = logging.getLogger(__name__)

VL_OLLAMA_URL = os.environ.get("VL_OLLAMA_URL", "http://localhost:11434").rstrip("/")
VL_MODEL = os.environ.get("VL_MODEL", "qwen2.5vl:7b")
VL_TIMEOUT = int(os.environ.get("VL_TIMEOUT", "180"))

OLLAMA_GENERATE_URL = f"{VL_OLLAMA_URL}/api/generate"

# 유사도 임계값: 이 이상이면 정규화 사전의 표준 태그로 교체
_FUZZY_THRESHOLD = 0.75

_SYSTEM_PROMPT = """당신은 한국 고등수학 문제/해설을 분석하는 전문가입니다.
이미지를 보고 JSON만 출력하세요. 설명이나 다른 텍스트는 절대 포함하지 마세요."""

_TAGGING_PROMPT_WITH_SOLUTION = """이 수학 해설 이미지를 분석하고 다음 JSON 형식으로만 답하세요:

{
  "difficulty": "easy|medium|hard",
  "concept_tags": [
    {"tag": "개념명", "confidence": 0.0}
  ],
  "skill_tags": [
    {"tag": "풀이기술명", "confidence": 0.0}
  ],
  "solution_summary": "핵심 풀이 아이디어 1~2줄",
  "pitfall": "학생이 틀리기 쉬운 지점 1~2줄"
}

규칙:
- difficulty: easy(쉬움, 교과서 예제 수준) / medium(보통, 쎈 B단계) / hard(어려움, 쎈 C단계/수능 4점)
- concept_tags: 이 문제에 등장하는 수학 개념 (예: 이차함수, 삼각함수, 미분계수)
- skill_tags: 실제 풀이에 사용된 기술 (예: 완전제곱식 변환, 인수분해, 치환)
- confidence: 해당 태그가 이 문제에 핵심적으로 사용됐다는 확신도 (0.0~1.0)
- 한국어 수학 교육 용어 사용, 최대 5개씩
- solution_summary: 해설의 핵심 아이디어를 1~2줄로 요약
- pitfall: 이 문제에서 학생이 자주 실수하는 지점, 헷갈리는 개념, 놓치기 쉬운 조건을 1~2줄로"""

_TAGGING_PROMPT_NO_SOLUTION = """이 수학 문제 이미지를 분석하고 다음 JSON 형식으로만 답하세요:

{
  "difficulty": "easy|medium|hard",
  "concept_tags": [
    {"tag": "개념명", "confidence": 0.0}
  ],
  "skill_tags": [
    {"tag": "풀이기술명", "confidence": 0.0}
  ],
  "solution_summary": null,
  "pitfall": "학생이 틀리기 쉬운 지점 1~2줄"
}

규칙:
- difficulty: easy / medium / hard
- concept_tags: 이 문제에 필요한 수학 개념 (예: 이차함수, 삼각함수, 미분계수)
- skill_tags: 이 문제를 풀 때 사용될 기술 (예: 완전제곱식 변환, 인수분해, 치환)
- confidence: 해당 태그가 이 문제에 필요하다는 확신도 (0.0~1.0, 해설 없어서 최대 0.7)
- 한국어 수학 교육 용어 사용, 최대 5개씩
- solution_summary: null (해설 이미지 없음)
- pitfall: 문제 조건에서 학생이 자주 놓치거나 오해하는 지점 1~2줄"""


def _load_taxonomy() -> dict:
    """concept_taxonomy.json 로드"""
    taxonomy_path = Path(__file__).parent.parent / "data" / "concept_taxonomy.json"
    if not taxonomy_path.exists():
        logger.warning("concept_taxonomy.json 없음 — 정규화 건너뜀")
        return {"concepts": {}, "skills": {}, "units": {}}
    with open(taxonomy_path, encoding="utf-8") as f:
        return json.load(f)


def _image_to_base64(image_path: str) -> str:
    """이미지 파일 → base64 인코딩"""
    with open(image_path, "rb") as f:
        return base64.b64encode(f.read()).decode("utf-8")


def _call_vl(image_path: str, prompt: str, timeout: int | None = None) -> str:
    """Ollama VL 모델 API 호출 → 텍스트 응답 반환.

    모델은 VL_MODEL 환경변수로 결정 (기본 qwen2.5vl:7b, 서버 배포 시 gemma4:26b 등).
    """
    img_b64 = _image_to_base64(image_path)
    payload = {
        "model": VL_MODEL,
        "prompt": prompt,
        "images": [img_b64],
        "system": _SYSTEM_PROMPT,
        "stream": False,
        "options": {
            "temperature": 0.1,  # 태깅은 낮은 temperature
            "num_predict": 512,
        },
    }
    resp = requests.post(OLLAMA_GENERATE_URL, json=payload, timeout=timeout or VL_TIMEOUT)
    resp.raise_for_status()
    return resp.json().get("response", "")


def _parse_json_response(raw: str) -> dict:
    """LLM 응답에서 JSON 부분만 파싱 (마크다운 코드블록 제거)"""
    raw = raw.strip()
    # ```json ... ``` 또는 ``` ... ``` 제거
    if raw.startswith("```"):
        lines = raw.split("\n")
        lines = [l for l in lines if not l.startswith("```")]
        raw = "\n".join(lines).strip()

    # JSON 블록 추출 시도
    start = raw.find("{")
    end = raw.rfind("}") + 1
    if start != -1 and end > start:
        raw = raw[start:end]

    return json.loads(raw)


def _fuzzy_normalize(tag: str, synonyms: list[str]) -> float:
    """단순 문자열 유사도 (Jaccard 기반)
    태그와 동의어 목록 각각 비교 → 최대 점수 반환
    """
    def jaccard(a: str, b: str) -> float:
        a_set = set(a.lower())
        b_set = set(b.lower())
        if not a_set or not b_set:
            return 0.0
        return len(a_set & b_set) / len(a_set | b_set)

    return max((jaccard(tag, syn) for syn in synonyms), default=0.0)


def normalize_tags(raw_tags: list, tag_type: str, taxonomy: dict) -> list:
    """concept_taxonomy.json 기반 태그 정규화

    AI가 "2차 함수"를 출력하면 "이차함수"로 통일.
    매칭 안 되면 원본 그대로 유지.

    Args:
      raw_tags: [{"tag": str, "confidence": float}, ...]
      tag_type: "concept" | "skill"
      taxonomy: concept_taxonomy.json 내용

    Returns:
      정규화된 [{"tag": str, "confidence": float}, ...]
    """
    section = taxonomy.get("concepts" if tag_type == "concept" else "skills", {})
    normalized = []

    for item in raw_tags:
        tag = item.get("tag", "").strip()
        confidence = float(item.get("confidence", 0.5))

        if not tag:
            continue

        best_canonical = tag
        best_score = 0.0

        for canonical, synonyms in section.items():
            # 정확 매칭
            if tag == canonical or tag in synonyms:
                best_canonical = canonical
                best_score = 1.0
                break

            # 퍼지 매칭 (Jaccard)
            score = _fuzzy_normalize(tag, [canonical] + synonyms)
            if score > best_score and score >= _FUZZY_THRESHOLD:
                best_score = score
                best_canonical = canonical

        normalized.append({"tag": best_canonical, "confidence": confidence})

    # 중복 제거 (같은 tag → confidence 최대값 유지)
    seen: dict[str, float] = {}
    for item in normalized:
        t = item["tag"]
        c = item["confidence"]
        if t not in seen or c > seen[t]:
            seen[t] = c

    return [{"tag": t, "confidence": c} for t, c in seen.items()]


def extract_tags_from_image(
    image_path: str,
    has_solution: bool = True,
    taxonomy: dict | None = None,
    leaf_embeddings: dict | None = None,
) -> dict:
    """단일 이미지에서 태그 + 풀이 요약 추출

    Args:
      image_path: 해설 이미지 경로 (has_solution=True) 또는 문제 이미지 경로
      has_solution: True = 해설 이미지, False = 문제 이미지만 (confidence 상한 0.7)
      taxonomy: 정규화 사전 (None이면 자동 로드)

    Returns:
      {
        "concept_tags": [{"tag": str, "confidence": float}, ...],
        "skill_tags": [{"tag": str, "confidence": float}, ...],
        "solution_summary": str | None,
        "raw_response": str,  # 디버깅용
      }
    """
    if taxonomy is None:
        taxonomy = _load_taxonomy()

    prompt = _TAGGING_PROMPT_WITH_SOLUTION if has_solution else _TAGGING_PROMPT_NO_SOLUTION

    fallback = {
        "unit": "",
        "unit_score": 0.0,
        "difficulty": "",
        "concept_tags": [],
        "skill_tags": [],
        "solution_summary": None,
        "pitfall": None,
        "raw_response": "",
    }

    try:
        raw = _call_vl(image_path, prompt)
        fallback["raw_response"] = raw

        parsed = _parse_json_response(raw)

        concept_tags = normalize_tags(
            parsed.get("concept_tags", []), "concept", taxonomy
        )
        skill_tags = normalize_tags(
            parsed.get("skill_tags", []), "skill", taxonomy
        )

        # 해설 없는 경우: confidence 상한 0.7
        if not has_solution:
            concept_tags = [
                {**t, "confidence": min(t["confidence"], 0.7)} for t in concept_tags
            ]
            skill_tags = [
                {**t, "confidence": min(t["confidence"], 0.7)} for t in skill_tags
            ]

        difficulty_raw = (parsed.get("difficulty") or "").strip().lower()
        difficulty = difficulty_raw if difficulty_raw in ("easy", "medium", "hard") else ""

        pitfall = parsed.get("pitfall")
        if isinstance(pitfall, str):
            pitfall = pitfall.strip() or None
        else:
            pitfall = None

        solution_summary = parsed.get("solution_summary")

        # unit 은 AI 가 아니라 임베딩 매칭으로 결정
        unit = ""
        unit_score = 0.0
        if leaf_embeddings is not None:
            query_parts: list[str] = []
            query_parts.extend([t["tag"] for t in concept_tags if t.get("tag")])
            query_parts.extend([t["tag"] for t in skill_tags if t.get("tag")])
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
            "raw_response": raw,
        }

    except requests.exceptions.ConnectionError:
        logger.error("Ollama 서버 연결 실패. 'ollama serve' 실행 여부 확인")
        return fallback
    except requests.exceptions.Timeout:
        logger.error(f"Qwen 응답 타임아웃: {image_path}")
        return fallback
    except json.JSONDecodeError as e:
        logger.error(f"JSON 파싱 실패: {e} | 응답: {fallback['raw_response'][:200]}")
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
      numbers_filter: 지정되면 이 번호들만 태깅. None 이면 전체.

    Returns:
      {번호: extract_tags_from_image 결과} — filter 가 있으면 filter 범위만
    """
    taxonomy = _load_taxonomy()
    taxonomy_path = Path(__file__).parent.parent / "data" / "concept_taxonomy.json"
    leaf_embeddings = unit_matcher.load_or_build_embeddings(taxonomy_path)

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
        )
        results[num] = result

    if progress_callback:
        progress_callback(total, total, -1)

    return results
