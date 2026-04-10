"""Qwen2.5-7B (Ollama) 를 사용해 문제 텍스트 → 구조화 JSON"""
import json
import httpx
from config import OLLAMA_BASE_URL, OLLAMA_MODEL

SYSTEM_PROMPT = """당신은 수학 문제를 구조화하는 전문가입니다.
주어진 문제 텍스트를 분석해서 다음 JSON 형식으로 반환하세요.
반드시 JSON만 반환하고, 다른 텍스트는 포함하지 마세요.

{
  "problem_number": <문제 번호 정수>,
  "answer_type": "multiple_choice" 또는 "short_answer",
  "correct_answer": <객관식이면 "1"~"5" 중 하나, 주관식이면 정답 문자열>,
  "difficulty": "easy" 또는 "medium" 또는 "hard",
  "unit": <단원명 (알 수 없으면 null)>,
  "explanation": <해설 텍스트 (없으면 null)>,
  "confidence": <0.0~1.0, 추출 신뢰도>
}

규칙:
- answer_type이 multiple_choice이면 correct_answer는 반드시 "1"~"5" 사이 숫자 문자열
- 보기 내용(①②③④⑤)은 correct_answer에 포함하지 말 것
- 난이도 판단: 계산 위주=easy, 개념 응용=medium, 종합 사고=hard
"""


async def structurize_problem(problem_text: str, problem_number: int) -> dict:
    """문제 텍스트를 LLM으로 구조화"""
    prompt = f"다음 수학 문제를 구조화하세요:\n\n{problem_text}"

    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.post(
            f"{OLLAMA_BASE_URL}/api/generate",
            json={
                "model": OLLAMA_MODEL,
                "prompt": prompt,
                "system": SYSTEM_PROMPT,
                "stream": False,
                "format": "json",
            },
        )
        response.raise_for_status()
        result = response.json()

    try:
        parsed = json.loads(result["response"])
    except (json.JSONDecodeError, KeyError):
        # LLM 응답 파싱 실패 시 기본값
        parsed = {
            "problem_number": problem_number,
            "answer_type": "short_answer",
            "correct_answer": "",
            "difficulty": "medium",
            "unit": None,
            "explanation": None,
            "confidence": 0.1,
        }

    parsed.setdefault("problem_number", problem_number)
    parsed.setdefault("confidence", 0.5)
    return parsed


async def structurize_problems_batch(
    problems: list,
    category: str = "기타",
) -> list:
    """여러 문제를 순차적으로 구조화"""
    results = []
    for p in problems:
        structured = await structurize_problem(p["text"], p["problem_number"])
        structured["problem_text"] = p["text"]
        structured["category"] = category
        if structured.get("unit") is None:
            structured["unit"] = "미분류"
        results.append(structured)
    return results
