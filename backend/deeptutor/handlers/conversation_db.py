"""student_conversations / student_attempts CRUD.

LangGraph 노드와 API 라우터가 공유.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Optional

from ..storage.supabase_client import get_client

logger = logging.getLogger(__name__)


# ── student_conversations ──────────────────────────────────────────

def create_conversation(
    student_id: str,
    problem_id: str,
    student_answer: str,
    correct_answer: str,
    initial_state: Optional[dict] = None,
) -> dict:
    """새 대화 시작 — student_conversations row insert."""
    client = get_client()
    row = {
        "student_id": student_id,
        "problem_id": problem_id,
        "student_answer": student_answer,
        "correct_answer": correct_answer,
        "state": initial_state or {},
        "messages": [],
        "status": "active",
    }
    result = client.table("student_conversations").insert(row).execute()
    if not result.data:
        raise RuntimeError("student_conversations insert 실패")
    return result.data[0]


def get_conversation(conversation_id: str) -> Optional[dict]:
    client = get_client()
    result = (
        client.table("student_conversations")
        .select("*")
        .eq("id", conversation_id)
        .maybe_single()
        .execute()
    )
    return result.data


def append_message(
    conversation_id: str,
    role: str,  # "student" | "tutor"
    content: str,
    node: Optional[str] = None,
) -> dict:
    """대화에 메시지 한 건 추가.

    Supabase 는 JSONB 배열 append 연산자가 제한적이므로 read-modify-write.
    동시성 걱정은 낮음 (학생-튜터 1:1 대화).
    """
    conv = get_conversation(conversation_id)
    if not conv:
        raise ValueError(f"conversation 없음: {conversation_id}")

    messages = list(conv.get("messages") or [])
    messages.append({
        "role": role,
        "content": content,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        **({"node": node} if node else {}),
    })

    client = get_client()
    result = (
        client.table("student_conversations")
        .update({
            "messages": messages,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        })
        .eq("id", conversation_id)
        .execute()
    )
    return result.data[0] if result.data else {}


def update_state(conversation_id: str, state: dict) -> dict:
    """LangGraph state 전체 교체 저장."""
    client = get_client()
    result = (
        client.table("student_conversations")
        .update({
            "state": state,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        })
        .eq("id", conversation_id)
        .execute()
    )
    return result.data[0] if result.data else {}


def update_similar_problems(
    conversation_id: str,
    similar_problems: list[dict],
) -> dict:
    client = get_client()
    result = (
        client.table("student_conversations")
        .update({
            "similar_problems": similar_problems,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        })
        .eq("id", conversation_id)
        .execute()
    )
    return result.data[0] if result.data else {}


def set_status(conversation_id: str, status: str) -> dict:
    """status: 'active' | 'completed' | 'abandoned'"""
    client = get_client()
    result = (
        client.table("student_conversations")
        .update({
            "status": status,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        })
        .eq("id", conversation_id)
        .execute()
    )
    return result.data[0] if result.data else {}


# ── problem 맥락 로드 ─────────────────────────────────────────────────

def load_problem_context(problem_id: str) -> dict:
    """문제 + 태그 + staging pitfall 을 모두 가져와 튜터 프롬프트용 dict 구성.

    Returns:
      {
        "problem_id": str,
        "image_url": str,
        "solution_image_url": str | None,
        "correct_answer": str,
        "answer_type": str,
        "unit": str,
        "difficulty": str,
        "solution_summary": str | None,
        "pitfall": str | None,
        "concept_tags": [str],
        "skill_tags": [str],
      }
    """
    client = get_client()

    prob = (
        client.table("problems")
        .select(
            "id, image_url, solution_image_url, correct_answer, answer_type, "
            "unit, difficulty, solution_summary, problem_text"
        )
        .eq("id", problem_id)
        .maybe_single()
        .execute()
    ).data

    if not prob:
        raise ValueError(f"문제 없음: {problem_id}")

    # 태그 조회
    tags = (
        client.table("problem_tags")
        .select("tag, tag_type")
        .eq("problem_id", problem_id)
        .execute()
    ).data or []

    concept_tags = [t["tag"] for t in tags if t.get("tag_type") == "concept"]
    skill_tags = [t["tag"] for t in tags if t.get("tag_type") == "skill"]

    # pitfall 은 현재 problem_staging 에만 저장됨. approve 시 이동 X.
    # staging 에서 같은 문제(동일 image_url 또는 원본) 찾기 시도.
    pitfall = None
    try:
        staging = (
            client.table("problem_staging")
            .select("pitfall")
            .eq("source_image_url", prob.get("image_url"))
            .limit(1)
            .execute()
        ).data
        if staging:
            pitfall = staging[0].get("pitfall")
    except Exception as exc:
        logger.debug(f"pitfall 조회 건너뜀: {exc}")

    return {
        "problem_id": prob["id"],
        "image_url": prob.get("image_url"),
        "solution_image_url": prob.get("solution_image_url"),
        "correct_answer": prob.get("correct_answer", ""),
        "answer_type": prob.get("answer_type", "short_answer"),
        "unit": prob.get("unit", ""),
        "difficulty": prob.get("difficulty", "medium"),
        "solution_summary": prob.get("solution_summary"),
        "problem_text": prob.get("problem_text"),
        "pitfall": pitfall,
        "concept_tags": concept_tags,
        "skill_tags": skill_tags,
    }


# ── student_attempts ───────────────────────────────────────────────

def log_attempt(
    student_id: str,
    problem_id: str,
    student_answer: str,
    correct_answer: str,
    is_correct: bool,
    conversation_id: Optional[str] = None,
) -> dict:
    """오답/정답 이력 저장."""
    client = get_client()
    row = {
        "student_id": student_id,
        "problem_id": problem_id,
        "student_answer": student_answer,
        "correct_answer": correct_answer,
        "is_correct": is_correct,
    }
    if conversation_id:
        row["conversation_id"] = conversation_id
    result = client.table("student_attempts").insert(row).execute()
    return result.data[0] if result.data else {}
