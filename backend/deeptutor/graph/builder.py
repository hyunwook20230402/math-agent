"""LangGraph StateGraph 구성.

두 개의 그래프:
- START_GRAPH: 첫 턴 전용 (load_context → respond_feedback → save_turn → END)
- CHAT_GRAPH: 후속 턴 (load_context → classify_intent → [hint|explain|recommend] → save_turn → END)

API 라우터는 상황에 따라 둘 중 하나를 invoke.
"""
from __future__ import annotations

from langgraph.graph import END, START, StateGraph

from . import nodes
from .state import TutorState


# ── 공통 분기 함수 ─────────────────────────────────────────────────

def _route_by_intent(state: TutorState) -> str:
    """classify_intent 의 결과에 따라 다음 노드 결정."""
    intent = state.get("current_intent", "general_question")

    if intent == "ask_hint":
        return "give_hint"
    if intent == "understood":
        return "recommend_similar"
    # ask_explain, general_question, retry_answer 전부 explain 으로
    # (retry_answer 도 일단 설명으로 유도 — 완벽한 재채점은 향후 과제)
    return "explain_step"


# ── 첫 턴 그래프 ────────────────────────────────────────────────────

def build_start_graph():
    g = StateGraph(TutorState)
    g.add_node("load_context", nodes.node_load_context)
    g.add_node("respond_feedback", nodes.node_respond_feedback)
    g.add_node("save_turn", nodes.node_save_turn)

    g.add_edge(START, "load_context")
    g.add_edge("load_context", "respond_feedback")
    g.add_edge("respond_feedback", "save_turn")
    g.add_edge("save_turn", END)
    return g.compile()


# ── 후속 턴 그래프 ─────────────────────────────────────────────────

def build_chat_graph():
    g = StateGraph(TutorState)
    g.add_node("load_context", nodes.node_load_context)
    g.add_node("classify_intent", nodes.node_classify_intent)
    g.add_node("give_hint", nodes.node_give_hint)
    g.add_node("explain_step", nodes.node_explain_step)
    g.add_node("recommend_similar", nodes.node_recommend_similar)
    g.add_node("save_turn", nodes.node_save_turn)

    g.add_edge(START, "load_context")
    g.add_edge("load_context", "classify_intent")

    g.add_conditional_edges(
        "classify_intent",
        _route_by_intent,
        {
            "give_hint": "give_hint",
            "explain_step": "explain_step",
            "recommend_similar": "recommend_similar",
        },
    )

    g.add_edge("give_hint", "save_turn")
    g.add_edge("explain_step", "save_turn")
    g.add_edge("recommend_similar", "save_turn")
    g.add_edge("save_turn", END)
    return g.compile()


# 모듈 로드 시 컴파일 (반복 컴파일 비용 방지)
START_GRAPH = build_start_graph()
CHAT_GRAPH = build_chat_graph()
