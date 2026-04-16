"""대화형 튜터 API 라우터.

POST /api/tutor/start                       — 대화 시작 (정오답 판정 + 첫 반응)
POST /api/tutor/chat/{conversation_id}      — 후속 턴
GET  /api/tutor/conversations/{id}          — 대화 조회
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException

from ..auth import get_student_id
from ..graph.builder import CHAT_GRAPH, START_GRAPH
from ..graph.state import initial_state
from ..handlers import conversation_db
from ..models import (
    ChatRequest,
    ConversationDetail,
    Message,
    SimilarProblem,
    StartTutorRequest,
    TutorResponse,
)

logger = logging.getLogger(__name__)

router = APIRouter()


# ── 대화 시작 ───────────────────────────────────────────────────────

@router.post("/start", response_model=TutorResponse)
async def start_conversation(
    req: StartTutorRequest,
    student_id: str = Depends(get_student_id),
):
    """학생이 "AI 도움받기" 누르면 첫 호출.

    - student_attempts 에 기록
    - student_conversations 새로 생성
    - START_GRAPH 실행 → 정오답 판정 + 첫 튜터 응답
    """
    # 1) 문제 맥락 로드 (정답 확인용)
    try:
        ctx = conversation_db.load_problem_context(req.problem_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="문제를 찾을 수 없습니다")

    # 2) 대화 row 먼저 생성 (conversation_id 필요)
    conv = conversation_db.create_conversation(
        student_id=student_id,
        problem_id=req.problem_id,
        student_answer=req.student_answer,
        correct_answer=ctx["correct_answer"],
    )
    conversation_id = conv["id"]

    # 3) student_attempts 에도 기록
    from ..graph.nodes import _is_answer_correct
    is_correct = _is_answer_correct(req.student_answer, ctx["correct_answer"])
    conversation_db.log_attempt(
        student_id=student_id,
        problem_id=req.problem_id,
        student_answer=req.student_answer,
        correct_answer=ctx["correct_answer"],
        is_correct=is_correct,
        conversation_id=conversation_id,
    )

    # 4) START_GRAPH 실행
    state = initial_state(
        conversation_id=conversation_id,
        student_id=student_id,
        problem_id=req.problem_id,
        student_answer=req.student_answer,
    )
    try:
        result = START_GRAPH.invoke(state)
    except Exception as exc:
        logger.exception(f"START_GRAPH 실패: {exc}")
        raise HTTPException(
            status_code=500,
            detail=f"튜터 응답 생성 실패: {exc}",
        )

    return TutorResponse(
        conversation_id=conversation_id,
        turn=result.get("turn_count", 1),
        is_correct=result.get("is_correct"),
        tutor_message=result.get("next_response", ""),
        similar_problems=[],
        status="active",
    )


# ── 후속 턴 ─────────────────────────────────────────────────────────

@router.post("/chat/{conversation_id}", response_model=TutorResponse)
async def chat(
    conversation_id: str,
    req: ChatRequest,
    student_id: str = Depends(get_student_id),
):
    # 1) 대화 조회 + 본인 확인
    conv = conversation_db.get_conversation(conversation_id)
    if not conv:
        raise HTTPException(status_code=404, detail="대화를 찾을 수 없습니다")
    if conv.get("student_id") != student_id:
        raise HTTPException(status_code=403, detail="본인 대화만 접근 가능")
    if conv.get("status") == "completed":
        raise HTTPException(status_code=400, detail="이미 종료된 대화입니다")

    # 2) 학생 메시지 선저장 (튜터 응답 생성 중 실패해도 남도록)
    conversation_db.append_message(
        conversation_id,
        role="student",
        content=req.message,
        node="chat_input",
    )

    # 3) state 복원 — DB 에 저장된 경량 state + 이번 턴 입력
    saved_state = conv.get("state") or {}
    # messages 는 방금 append 한 걸 다시 읽어야 하므로 재조회
    refreshed = conversation_db.get_conversation(conversation_id)
    messages = refreshed.get("messages") or []

    state_dict = {
        "conversation_id": conversation_id,
        "student_id": student_id,
        "problem_id": conv["problem_id"],
        "problem_context": {},  # load_context 가 채움
        "student_answer": conv.get("student_answer", ""),
        "correct_answer": conv.get("correct_answer", ""),
        "is_correct": saved_state.get("is_correct", False),
        "messages": messages,
        "student_latest": req.message,
        "turn_count": saved_state.get("turn_count", 1),
        "hint_level": saved_state.get("hint_level", 0),
        "current_intent": saved_state.get("current_intent", "initial"),
        "next_response": "",
        "similar_problems": [],
        "done": False,
    }

    # 4) CHAT_GRAPH 실행
    try:
        result = CHAT_GRAPH.invoke(state_dict)
    except Exception as exc:
        logger.exception(f"CHAT_GRAPH 실패: {exc}")
        raise HTTPException(
            status_code=500,
            detail=f"튜터 응답 생성 실패: {exc}",
        )

    return TutorResponse(
        conversation_id=conversation_id,
        turn=result.get("turn_count", saved_state.get("turn_count", 1) + 1),
        is_correct=None,  # 첫 턴에만 의미 있음
        tutor_message=result.get("next_response", ""),
        similar_problems=[
            SimilarProblem(**s) for s in (result.get("similar_problems") or [])
        ],
        status="completed" if result.get("done") else "active",
    )


# ── 대화 조회 ───────────────────────────────────────────────────────

@router.get("/conversations/{conversation_id}", response_model=ConversationDetail)
async def get_conversation_detail(
    conversation_id: str,
    student_id: str = Depends(get_student_id),
):
    conv = conversation_db.get_conversation(conversation_id)
    if not conv:
        raise HTTPException(status_code=404, detail="대화 없음")
    if conv.get("student_id") != student_id:
        raise HTTPException(status_code=403, detail="본인 대화만 조회 가능")

    return ConversationDetail(
        id=conv["id"],
        student_id=conv["student_id"],
        problem_id=conv["problem_id"],
        student_answer=conv.get("student_answer"),
        correct_answer=conv.get("correct_answer"),
        messages=[Message(**m) for m in (conv.get("messages") or [])],
        similar_problems=(
            [SimilarProblem(**s) for s in conv["similar_problems"]]
            if conv.get("similar_problems")
            else None
        ),
        status=conv.get("status", "active"),
        state=conv.get("state") or {},
        created_at=conv["created_at"],
        updated_at=conv["updated_at"],
    )
