"""LangGraph TutorState TypedDict.

주의: JSONB 로 직렬화되므로 기본 타입(str, int, bool, list, dict)만 사용.
"""
from __future__ import annotations

from typing import Any, Literal, Optional, TypedDict


Intent = Literal[
    "initial",          # 첫 턴 (아직 의도 분류 전)
    "ask_hint",         # 학생이 힌트 요청
    "ask_explain",      # 학생이 전체 설명 요청
    "understood",       # 학생이 이해했다고 표현 → 추천 문제로 마무리
    "retry_answer",     # 학생이 다시 답을 제출 (예: "2번 같아요")
    "general_question", # 기타 질문 (개념 물어봄 등)
]


class TutorState(TypedDict, total=False):
    """LangGraph 상태.

    대화 한 턴을 그래프 한 번 실행할 때마다 읽고/쓰는 값.
    DB 의 student_conversations.state 필드에 JSON 으로 저장됨.
    """
    # 고정 식별자
    conversation_id: str
    student_id: str
    problem_id: str

    # 문제 맥락 (load_context 노드에서 채움)
    problem_context: dict

    # 정오답 정보 (첫 턴에서 결정 후 불변)
    student_answer: str       # 최초 답
    correct_answer: str
    is_correct: bool

    # 대화 이력
    messages: list[dict]      # [{role, content, timestamp, node?}]
    student_latest: str       # 이번 턴 학생 입력 (초기 턴에선 "" 또는 답안)

    # 흐름 제어
    turn_count: int
    hint_level: int           # 0 → 1 → 2 → (그 이상이면 explain 으로)
    current_intent: Intent

    # 출력 (이번 턴 노드가 생성)
    next_response: str
    similar_problems: list[dict]

    # 종료 상태
    done: bool                # True 면 recommend_similar 로 마무리 후 END


def initial_state(
    conversation_id: str,
    student_id: str,
    problem_id: str,
    student_answer: str,
) -> TutorState:
    """새 대화 시작 시 초기 state."""
    return TutorState(
        conversation_id=conversation_id,
        student_id=student_id,
        problem_id=problem_id,
        problem_context={},
        student_answer=student_answer,
        correct_answer="",
        is_correct=False,
        messages=[],
        student_latest=student_answer,  # 첫 턴엔 답 자체가 입력
        turn_count=0,
        hint_level=0,
        current_intent="initial",
        next_response="",
        similar_problems=[],
        done=False,
    )
