"""DeepTutor API 요청/응답 Pydantic 스키마"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field


# ── 요청 ────────────────────────────────────────────────────────────

class StartTutorRequest(BaseModel):
    """POST /api/tutor/start"""
    problem_id: str
    student_answer: str = Field(..., description="객관식 1~5 또는 주관식 숫자")


class ChatRequest(BaseModel):
    """POST /api/tutor/chat/{conversation_id}"""
    message: str


# ── 응답 ────────────────────────────────────────────────────────────

class Message(BaseModel):
    role: Literal["student", "tutor"]
    content: str
    timestamp: str
    node: Optional[str] = None  # 어느 LangGraph 노드가 생성했는지


class SimilarProblem(BaseModel):
    id: str
    image_url: Optional[str] = None
    unit: Optional[str] = None
    difficulty: Optional[str] = None
    similarity: float


class TutorResponse(BaseModel):
    """대화 한 턴의 응답"""
    conversation_id: str
    turn: int
    is_correct: Optional[bool] = None  # 첫 턴에서만 채워짐
    tutor_message: str
    similar_problems: list[SimilarProblem] = []
    status: Literal["active", "completed", "abandoned"] = "active"


class ConversationDetail(BaseModel):
    """GET /api/tutor/conversations/{id}"""
    id: str
    student_id: str
    problem_id: str
    student_answer: Optional[str]
    correct_answer: Optional[str]
    messages: list[Message]
    similar_problems: Optional[list[SimilarProblem]] = None
    status: str
    state: dict[str, Any] = {}
    created_at: datetime
    updated_at: datetime
