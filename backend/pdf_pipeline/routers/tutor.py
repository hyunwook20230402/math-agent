"""막힌 지점 도우미 API 라우터.

POST /api/tutor/hint — 학생이 문제 풀다 막혔을 때 풀이 그래프 위치추적 RAG 힌트 1발.
멀티턴은 클라이언트가 next_revealed_node_index 를 들고 다니며 재호출(서버 무상태).

main.py 에서 prefix="/api/tutor" 로 include → 최종 경로는 /api/tutor/hint.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException

from auth import get_student_id
from handlers import stuck_helper
from models import HintRequest, HintResponse, NodeReference

logger = logging.getLogger(__name__)

router = APIRouter()


@router.post("/hint", response_model=HintResponse)
async def get_hint(
  req: HintRequest,
  student_id: str = Depends(get_student_id),
):
  try:
    result = stuck_helper.generate_hint(
      problem_id=req.problem_id,
      blocked_description=req.student_blocked_description or "아예 모르겠어요",
      revealed_node_index=req.revealed_node_index if req.revealed_node_index is not None else -1,
      conversation_history=[t.model_dump() for t in req.conversation_history] if req.conversation_history else None,
    )
  except ValueError as exc:
    raise HTTPException(status_code=404, detail=str(exc))
  except Exception as exc:
    logger.exception(f"힌트 생성 실패: {exc}")
    raise HTTPException(status_code=500, detail=f"힌트 생성 실패: {exc}")

  return HintResponse(
    hint_text=result["hint_text"],
    next_step_concept=result.get("next_step_concept"),
    next_revealed_node_index=result["next_revealed_node_index"],
    reference_nodes=[NodeReference(**n) for n in result["reference_nodes"]],
    figure_urls=result["figure_urls"],
    has_solution_nodes=result["has_solution_nodes"],
  )
