"""튜터 API 요청/응답 Pydantic 스키마.

막힌 지점 도우미(POST /api/tutor/hint) 전용. deeptutor 의 대화튜터 모델은
가져오지 않는다 (LangGraph 대화튜터 폐기 — 2026-06-18).
"""
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field


# ── 요청 ────────────────────────────────────────────────────────────

class HintRequest(BaseModel):
    """POST /api/tutor/hint — 막힌 지점 도우미"""
    problem_id: str
    student_blocked_description: str = Field(
        ..., description='학생의 막힌 지점 서술. "아예 모르겠어요" 도 가능'
    )
    revealed_node_index: Optional[int] = Field(
        None, description="멀티턴 — 직전 호출까지 공개한 노드 index. 첫 호출은 생략(또는 -1)"
    )


# ── 응답 ────────────────────────────────────────────────────────────

class NodeReference(BaseModel):
    """힌트 근거로 쓰인 추론 노드"""
    problem_id: str
    node_index: int
    key_concept: str
    is_same_problem: bool


class HintResponse(BaseModel):
    """POST /api/tutor/hint 응답 — 막힌 지점 힌트 1발"""
    hint_text: str
    next_step_concept: Optional[str] = None
    next_revealed_node_index: int  # 다음 "다음 힌트" 호출 시 그대로 전달
    reference_nodes: list[NodeReference] = []
    figure_urls: list[str] = []
    has_solution_nodes: bool = True  # False 면 fallback(즉석 생성)으로 응답한 것
