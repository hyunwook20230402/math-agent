"""문제 staging ↔ 해설 추출 결과 매칭 + 신뢰도 계산

주요 함수:
  match_solutions_to_problems(problem_job_id, solution_data) → 매칭 결과
"""
import logging
from typing import Optional

logger = logging.getLogger(__name__)


def calculate_match_confidence(
    staging_number: int,
    solution_numbers: set,
    has_answer: bool,
    has_image: bool,
) -> float:
    """매칭 신뢰도 점수 계산 (0~1)

    - 번호 정확 매칭: +0.5
    - 정답 추출 성공: +0.3
    - 해설 이미지 존재: +0.2

    Args:
      staging_number: 문제 번호
      solution_numbers: 해설 추출된 번호 집합
      has_answer: 정답 추출 여부
      has_image: 해설 이미지 존재 여부

    Returns:
      0.0 ~ 1.0
    """
    score = 0.0
    if staging_number in solution_numbers:
        score += 0.5
    if has_answer:
        score += 0.3
    if has_image:
        score += 0.2
    return round(score, 2)


def match_solutions_to_problems(
    staging_problems: list,
    answers: dict,
    solution_images: dict,
    tag_results: dict,
) -> dict:
    """문제 staging과 해설 추출 결과 매칭

    Args:
      staging_problems: get_staging_by_job 결과 리스트
        [{"id": str, "problem_number": int, ...}, ...]
      answers: extract_answers 결과
        {번호: {"answer": str, "answer_type": str}}
      solution_images: merge_cross_page_solutions 결과
        {번호: 이미지경로}
      tag_results: tag_all_solutions 결과
        {번호: {"concept_tags": [...], "skill_tags": [...], "unit": str, ...}}

    Returns:
      {staging_id: {
        "problem_number": int,
        "solution_image_url": str | None,
        "answer": str | None,
        "answer_type": str | None,
        "concept_tags": [...],
        "skill_tags": [...],
        "match_confidence": float,
      }}
    """
    solution_numbers = set(answers.keys()) | set(solution_images.keys())
    results: dict[str, dict] = {}

    for staging in staging_problems:
        sid = staging["id"]
        num = staging.get("problem_number", 0)

        answer_data = answers.get(num, {})
        answer = answer_data.get("answer")
        img_path = solution_images.get(num)
        tags = tag_results.get(num, {})
        # answer_type: 태거 판단 우선 (이미지 보고 보기 유무 판단), 없으면 정답 파싱 결과
        answer_type = tags.get("answer_type") or answer_data.get("answer_type")

        confidence = calculate_match_confidence(
            staging_number=num,
            solution_numbers=solution_numbers,
            has_answer=bool(answer),
            has_image=bool(img_path),
        )

        validation = tags.get("validation") or {}
        results[sid] = {
            "problem_number": num,
            "solution_image_local_path": img_path,
            "answer": answer,
            "answer_type": answer_type,
            "concept_tags": tags.get("concept_tags", []),
            "skill_tags": tags.get("skill_tags", []),
            "unit": tags.get("unit") or "",
            "difficulty_score": tags.get("difficulty_score"),
            "correct_rate": tags.get("correct_rate"),
            "match_confidence": confidence,
            "validation_status": validation.get("status"),
            "validation_score": validation.get("score"),
            "validation_issues": validation.get("issues"),
        }

    return results


def summarize_match_results(match_results: dict) -> dict:
    """매칭 결과 요약 통계

    Returns:
      {
        "total": int,
        "matched": int,   # confidence >= 0.5
        "with_answer": int,
        "with_image": int,
        "with_tags": int,
        "low_confidence": [{"staging_id": str, "problem_number": int, "confidence": float}]
      }
    """
    total = len(match_results)
    matched = 0
    with_answer = 0
    with_image = 0
    with_tags = 0
    low_confidence = []

    for sid, data in match_results.items():
        c = data.get("match_confidence", 0)
        if c >= 0.5:
            matched += 1
        if data.get("answer"):
            with_answer += 1
        if data.get("solution_image_local_path"):
            with_image += 1
        if data.get("concept_tags") or data.get("skill_tags"):
            with_tags += 1
        if c < 0.5:
            low_confidence.append({
                "staging_id": sid,
                "problem_number": data.get("problem_number"),
                "confidence": c,
            })

    return {
        "total": total,
        "matched": matched,
        "with_answer": with_answer,
        "with_image": with_image,
        "with_tags": with_tags,
        "low_confidence": sorted(low_confidence, key=lambda x: x["problem_number"] or 0),
    }
