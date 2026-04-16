"""LangGraph 노드 함수들.

각 노드는 TutorState 를 받아 부분 업데이트 dict 를 반환한다.
LangGraph 가 자동으로 state 를 merge.
"""
from __future__ import annotations

import logging

from ..config import HINT_LEVEL_MAX, HISTORY_TURNS_FOR_PROMPT
from ..handlers import conversation_db, similar_problems
from ..llm import gemma_client
from .prompts import (
    SYSTEM_EXPLAIN,
    SYSTEM_FEEDBACK,
    SYSTEM_HINT,
    SYSTEM_INTENT_CLASSIFIER,
    format_problem_context,
    messages_to_history,
)
from .state import TutorState

logger = logging.getLogger(__name__)


# ── 1. 문제 맥락 로드 ───────────────────────────────────────────────

def node_load_context(state: TutorState) -> dict:
    """첫 호출 시 problems + problem_tags + pitfall 로드.

    이미 로드돼있으면 skip.
    """
    if state.get("problem_context"):
        return {}

    ctx = conversation_db.load_problem_context(state["problem_id"])
    is_correct = _is_answer_correct(state["student_answer"], ctx["correct_answer"])

    return {
        "problem_context": ctx,
        "correct_answer": ctx["correct_answer"],
        "is_correct": is_correct,
    }


def _is_answer_correct(student: str, correct: str) -> bool:
    """문자열 비교 — 공백/대소문자/한자숫자 정도만 정규화.

    객관식 1~5 또는 주관식 숫자 하나만 받기로 했으므로 복잡한 비교 불필요.
    """
    if student is None or correct is None:
        return False
    s = str(student).strip().lower().replace(" ", "")
    c = str(correct).strip().lower().replace(" ", "")
    return s == c


# ── 2. 첫 턴 피드백 ─────────────────────────────────────────────────

def node_respond_feedback(state: TutorState) -> dict:
    """정오답 판정 직후 첫 튜터 응답 생성."""
    ctx = state["problem_context"]
    is_correct = state["is_correct"]
    student_answer = state["student_answer"]

    user_prompt = (
        f"{format_problem_context(ctx)}\n\n"
        f"학생이 제출한 답: {student_answer}\n"
        f"판정: {'정답' if is_correct else '오답'}\n\n"
        f"이 학생에게 첫 반응을 보여주세요. 짧게, 2~3문장."
    )

    try:
        response = gemma_client.chat(
            system_prompt=SYSTEM_FEEDBACK,
            user_prompt=user_prompt,
        )
    except gemma_client.GemmaError as exc:
        logger.error(f"feedback 생성 실패: {exc}")
        response = (
            "답을 잘 제출했어. 어디까지 풀었는지 말해줄래?"
            if not is_correct
            else "정답이야! 풀이 과정 같이 볼래?"
        )

    return {
        "next_response": response,
        "current_intent": "initial",
        "turn_count": state.get("turn_count", 0) + 1,
    }


# ── 3. 의도 분류 (후속 턴) ──────────────────────────────────────────

def node_classify_intent(state: TutorState) -> dict:
    """학생 최신 발화를 보고 다음 행동 결정."""
    latest = state.get("student_latest", "").strip()
    if not latest:
        return {"current_intent": "general_question"}

    try:
        result = gemma_client.chat_json(
            system_prompt=SYSTEM_INTENT_CLASSIFIER,
            user_prompt=f"학생 발화: {latest}",
            temperature=0.1,
            num_predict=64,
        )
        intent = result.get("intent", "general_question")
    except gemma_client.GemmaError as exc:
        logger.warning(f"intent 분류 실패 — fallback general_question: {exc}")
        intent = "general_question"

    # 방어적: 알 수 없는 값이면 general_question 으로
    valid = {"ask_hint", "ask_explain", "understood", "retry_answer", "general_question"}
    if intent not in valid:
        intent = "general_question"

    return {"current_intent": intent}


# ── 4. 힌트 생성 ─────────────────────────────────────────────────────

def node_give_hint(state: TutorState) -> dict:
    ctx = state["problem_context"]
    hint_level = state.get("hint_level", 0)
    latest = state.get("student_latest", "")

    history = messages_to_history(
        state.get("messages", []), limit=HISTORY_TURNS_FOR_PROMPT
    )

    user_prompt = (
        f"{format_problem_context(ctx)}\n\n"
        f"hint_level: {hint_level} (0=추상적, 1=방향, 2=구체적)\n"
        f"학생 발화: {latest or '(힌트 요청)'}\n\n"
        f"이 hint_level 에 맞는 힌트를 주세요. 답은 절대 공개하지 마세요."
    )

    try:
        response = gemma_client.chat(
            system_prompt=SYSTEM_HINT,
            user_prompt=user_prompt,
            history=history,
        )
    except gemma_client.GemmaError as exc:
        logger.error(f"hint 생성 실패: {exc}")
        response = "잠시 서버가 바쁜 것 같아. 다시 한번 요청해줄래?"

    return {
        "next_response": response,
        "hint_level": min(hint_level + 1, HINT_LEVEL_MAX),
        "turn_count": state.get("turn_count", 0) + 1,
    }


# ── 5. 스텝별 설명 ──────────────────────────────────────────────────

def node_explain_step(state: TutorState) -> dict:
    ctx = state["problem_context"]
    latest = state.get("student_latest", "")

    history = messages_to_history(
        state.get("messages", []), limit=HISTORY_TURNS_FOR_PROMPT
    )

    user_prompt = (
        f"{format_problem_context(ctx)}\n\n"
        f"학생 발화: {latest or '(풀이 설명 요청)'}\n\n"
        f"지금까지 대화를 참고해서, 학생이 막힌 부분부터 단계별로 설명해줘."
    )

    try:
        response = gemma_client.chat(
            system_prompt=SYSTEM_EXPLAIN,
            user_prompt=user_prompt,
            history=history,
            num_predict=768,  # 설명은 조금 더 길게
        )
    except gemma_client.GemmaError as exc:
        logger.error(f"explain 생성 실패: {exc}")
        response = (
            "풀이를 설명하려는데 서버가 잠깐 느려. 다시 한번 '설명해줘' 해줄래?"
        )

    return {
        "next_response": response,
        "turn_count": state.get("turn_count", 0) + 1,
    }


# ── 6. 유사 문제 추천 (대화 마무리) ────────────────────────────────

def node_recommend_similar(state: TutorState) -> dict:
    """학생이 '이해했다' 고 하면 유사 문제 3개 제시하고 대화 종료."""
    problem_id = state["problem_id"]
    sims = similar_problems.find_similar(problem_id, limit=3)

    if sims:
        lines = [
            "좋아! 잘 이해했네. 비슷한 문제 몇 개 추천할게:",
            *[
                f"- {s.get('unit') or '?'} / 난이도 {s.get('difficulty') or '?'} "
                f"(유사도 {round(s.get('similarity') or 0, 2)})"
                for s in sims
            ],
            "풀어보고 모르는 거 있으면 다시 물어봐!",
        ]
        response = "\n".join(lines)
    else:
        response = "좋아, 잘 이해했네! 다른 문제 풀다가 막히면 또 물어봐."

    return {
        "next_response": response,
        "similar_problems": sims,
        "done": True,
        "turn_count": state.get("turn_count", 0) + 1,
    }


# ── 7. 턴 저장 (DB sync) ───────────────────────────────────────────

def node_save_turn(state: TutorState) -> dict:
    """이번 턴 결과를 DB 에 반영.

    - messages 배열에 student + tutor 메시지 추가
    - state JSONB 갱신
    - 종료 시 status=completed + similar_problems 저장
    """
    conversation_id = state["conversation_id"]

    # 학생 메시지는 첫 턴일 때만 student_answer 기록
    # (후속 턴은 API 라우터가 이미 append_message 로 추가했음)
    if state.get("current_intent") == "initial":
        conversation_db.append_message(
            conversation_id,
            role="student",
            content=state["student_answer"],
            node="initial_answer",
        )

    # 튜터 응답 저장
    conversation_db.append_message(
        conversation_id,
        role="tutor",
        content=state["next_response"],
        node=_which_node_generated(state),
    )

    # state 직렬화 저장 (problem_context 는 크므로 제외하고 경량 state 만)
    light_state = {
        "turn_count": state.get("turn_count", 0),
        "hint_level": state.get("hint_level", 0),
        "current_intent": state.get("current_intent", "initial"),
        "is_correct": state.get("is_correct", False),
        "done": state.get("done", False),
    }
    conversation_db.update_state(conversation_id, light_state)

    # 종료 처리
    if state.get("done"):
        conversation_db.update_similar_problems(
            conversation_id, state.get("similar_problems") or []
        )
        conversation_db.set_status(conversation_id, "completed")

    return {}


def _which_node_generated(state: TutorState) -> str:
    """로깅용 — 현재 응답을 어느 노드가 만들었는지 추정."""
    intent = state.get("current_intent", "initial")
    if intent == "initial":
        return "respond_feedback"
    if intent == "ask_hint":
        return "give_hint"
    if intent == "ask_explain":
        return "explain_step"
    if intent == "understood":
        return "recommend_similar"
    return "explain_step"  # general_question, retry_answer fallback
