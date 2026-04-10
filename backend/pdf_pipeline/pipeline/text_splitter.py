"""텍스트에서 문제 단위 분리 (정규식)"""
import re
from typing import List, Dict


# 문제 번호 패턴: "1.", "1)", "[1]", "문제 1", "01." 등
PROBLEM_START_PATTERN = re.compile(
    r'(?:^|\n)\s*(?:문제\s*)?(\d{1,3})[.)\]]\s',
    re.MULTILINE
)


def split_problems_from_text(text: str) -> List[Dict]:
    """
    전체 텍스트에서 문제 번호 기준으로 분리
    반환: [{"problem_number": 1, "text": "..."}, ...]
    """
    matches = list(PROBLEM_START_PATTERN.finditer(text))
    if not matches:
        return [{"problem_number": 1, "text": text.strip()}]

    problems = []
    for i, match in enumerate(matches):
        number = int(match.group(1))
        start = match.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        problem_text = text[start:end].strip()
        problems.append({
            "problem_number": number,
            "text": problem_text,
        })
    return problems


def split_problems_from_pages(pages: List[Dict]) -> List[Dict]:
    """페이지 목록에서 문제 분리 (텍스트형 PDF용)"""
    full_text = "\n".join(p["text"] for p in pages if p.get("text"))
    return split_problems_from_text(full_text)
