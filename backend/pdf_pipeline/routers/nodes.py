"""CMS 풀이 노드(solution_nodes) 편집 API — 교사 전용.

학생 힌트용 /api/tutor/hint 와 분리된 운영자 통로.
- 노드 목록 조회 / 수정 / 추가 / 삭제 / 통째 재추출.
- 노드 내용이 바뀌면 검색용 임베딩(embedding_text → bge-m3)을 자동 재생성한다.
- uses(DAG)·node_index 순번 무결성을 저장 시점에 정리한다.

VL=OpenAI, 임베딩=bge-m3(ollama). 인증은 get_teacher_id(teacher role 강제).
"""
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from auth import get_teacher_id
from pipeline import embedder, rag_node_extractor
from storage.supabase_client import get_client

logger = logging.getLogger(__name__)

router = APIRouter()

_VALID_ROLES = (
  "condition_analysis", "equation_setup", "case_split", "computation", "conclusion",
)


# ── 스키마 ────────────────────────────────────────────────────────────────────

class WhyEntry(BaseModel):
  question: str
  reason: str = ""


class NodeOut(BaseModel):
  """CMS 에 내려줄 노드 한 개 (embedding 벡터는 제외 — 무겁고 불필요)."""
  node_index: int
  role: str
  entry_conditions: Optional[str] = None
  key_concept: str
  output_formula: str
  uses: list[int] = Field(default_factory=list)
  whys: list[WhyEntry] = Field(default_factory=list)
  figure_description: Optional[str] = None
  figure_image_crop_url: Optional[str] = None


class NodeIn(BaseModel):
  """노드 수정/추가 입력. node_index 는 경로/순번 로직이 정함."""
  role: str
  entry_conditions: Optional[str] = None
  key_concept: str
  output_formula: str
  uses: list[int] = Field(default_factory=list)
  whys: list[WhyEntry] = Field(default_factory=list)
  figure_description: Optional[str] = None
  figure_image_crop_url: Optional[str] = None


class NodeListResponse(BaseModel):
  problem_id: str
  nodes: list[NodeOut]


# ── 공통 헬퍼 ─────────────────────────────────────────────────────────────────

def _normalize_role(role: str) -> str:
  r = (role or "").strip().lower()
  return r if r in _VALID_ROLES else "computation"


def _whys_to_dicts(whys: list[WhyEntry]) -> list[dict]:
  return [{"question": w.question, "reason": w.reason} for w in whys]


def _clean_uses(raw_uses: list[int], node_index: int, valid_indices: set[int]) -> list[int]:
  """자기보다 작고 실제 존재하는 인덱스만 — acyclic 보장 + 미래/범위밖 참조 제거."""
  seen: set[int] = set()
  out: list[int] = []
  for u in raw_uses or []:
    if isinstance(u, int) and 0 <= u < node_index and u in valid_indices and u not in seen:
      seen.add(u)
      out.append(u)
  return sorted(out)


def _embed_row(node: NodeIn, node_index: int) -> dict:
  """NodeIn → solution_nodes row(임베딩 포함). embedding_text 재합성 + bge-m3 재임베딩."""
  output_formula = rag_node_extractor._fix_latex_subscript_escapes(node.output_formula)
  whys = _whys_to_dicts(node.whys)
  embedding_text = rag_node_extractor.compose_embedding_text(
    key_concept=node.key_concept,
    entry_conditions=node.entry_conditions,
    whys=whys,
    output_formula=output_formula,
    figure_description=(node.figure_description or "").strip() or None,
  )
  embedding = embedder.generate_embedding(embedding_text)
  return {
    "node_index": node_index,
    "role": _normalize_role(node.role),
    "entry_conditions": node.entry_conditions,
    "key_concept": node.key_concept,
    "output_formula": output_formula,
    "uses": node.uses,  # 호출부에서 _clean_uses 적용
    "whys": whys,
    "figure_description": node.figure_description,
    "figure_image_crop_url": node.figure_image_crop_url,
    "embedding_text": embedding_text,
    "embedding": embedding,
  }


def _fetch_nodes_for_display(client, problem_id: str) -> list[dict]:
  """CMS 표시용 — 임베딩 제외(무겁다)."""
  return (
    client.table("solution_nodes")
    .select("node_index, role, entry_conditions, key_concept, output_formula, "
            "uses, whys, figure_description, figure_image_crop_url")
    .eq("problem_id", problem_id)
    .order("node_index")
    .execute()
  ).data or []


def _fetch_nodes_full(client, problem_id: str) -> list[dict]:
  """편집 연산용 — embedding/embedding_text 포함(순번만 바뀐 노드의 임베딩 보존용)."""
  return (
    client.table("solution_nodes")
    .select("node_index, role, entry_conditions, key_concept, output_formula, "
            "uses, whys, figure_description, figure_image_crop_url, "
            "embedding_text, embedding")
    .eq("problem_id", problem_id)
    .order("node_index")
    .execute()
  ).data or []


def _renumber_and_persist(client, problem_id: str, rows: list[dict]) -> None:
  """node_index 0..N-1 로 다시 매기고, uses 를 새 인덱스 기준으로 정제 후 통째 교체.

  rows 는 원하는 최종 순서대로 정렬돼 들어온다(node_index 필드는 무시하고 위치로 재부여).
  같은 problem_id 의 기존 노드를 모두 지우고 새로 INSERT (UNIQUE(problem_id,node_index) 충돌 방지).
  """
  valid_indices = set(range(len(rows)))
  for new_idx, row in enumerate(rows):
    row["node_index"] = new_idx
    row["uses"] = _clean_uses(row.get("uses", []), new_idx, valid_indices)
    row["problem_id"] = problem_id
  client.table("solution_nodes").delete().eq("problem_id", problem_id).execute()
  if rows:
    client.table("solution_nodes").insert(rows).execute()


# ── 엔드포인트 ────────────────────────────────────────────────────────────────

@router.get("/{problem_id}/nodes", response_model=NodeListResponse)
async def list_nodes(problem_id: str, teacher_id: str = Depends(get_teacher_id)):
  """한 문제의 풀이 노드를 순서대로 조회."""
  client = get_client()
  nodes = _fetch_nodes_for_display(client, problem_id)
  return NodeListResponse(problem_id=problem_id, nodes=[NodeOut(**n) for n in nodes])


@router.put("/{problem_id}/nodes/{node_index}", response_model=NodeListResponse)
async def update_node(
  problem_id: str, node_index: int, body: NodeIn,
  teacher_id: str = Depends(get_teacher_id),
):
  """한 노드의 내용을 교체. embedding_text 재합성 + 재임베딩 자동."""
  client = get_client()
  existing = _fetch_nodes_full(client, problem_id)
  if not any(n["node_index"] == node_index for n in existing):
    raise HTTPException(status_code=404, detail=f"node_index={node_index} 없음")

  rows: list[dict] = []
  for n in existing:
    if n["node_index"] == node_index:
      rows.append(_embed_row(body, node_index))
    else:
      rows.append(_row_from_existing(n))
  rows.sort(key=lambda r: r["node_index"])
  _renumber_and_persist(client, problem_id, rows)
  return await list_nodes(problem_id, teacher_id)


@router.post("/{problem_id}/nodes", response_model=NodeListResponse)
async def add_node(
  problem_id: str, body: NodeIn,
  at_index: Optional[int] = None,
  teacher_id: str = Depends(get_teacher_id),
):
  """노드 추가. at_index 위치에 끼우거나(없으면 맨 뒤). 이후 순번·uses 자동 재정렬."""
  client = get_client()
  existing = _fetch_nodes_full(client, problem_id)
  rows = [_row_from_existing(n) for n in existing]
  rows.sort(key=lambda r: r["node_index"])

  insert_pos = len(rows) if at_index is None else max(0, min(at_index, len(rows)))
  new_row = _embed_row(body, insert_pos)  # node_index 는 _renumber 가 최종 부여
  rows.insert(insert_pos, new_row)
  _renumber_and_persist(client, problem_id, rows)
  return await list_nodes(problem_id, teacher_id)


@router.delete("/{problem_id}/nodes/{node_index}", response_model=NodeListResponse)
async def delete_node(
  problem_id: str, node_index: int,
  teacher_id: str = Depends(get_teacher_id),
):
  """노드 삭제. 남은 노드 순번·uses 자동 재정렬(끊긴 참조 제거)."""
  client = get_client()
  existing = _fetch_nodes_full(client, problem_id)
  if not any(n["node_index"] == node_index for n in existing):
    raise HTTPException(status_code=404, detail=f"node_index={node_index} 없음")
  rows = [_row_from_existing(n) for n in existing if n["node_index"] != node_index]
  rows.sort(key=lambda r: r["node_index"])
  _renumber_and_persist(client, problem_id, rows)
  return await list_nodes(problem_id, teacher_id)


@router.post("/{problem_id}/nodes/re-extract", response_model=NodeListResponse)
async def re_extract(problem_id: str, teacher_id: str = Depends(get_teacher_id)):
  """기존 노드를 버리고 AI 로 통째 재추출(추출 로직 재사용)."""
  client = get_client()
  prob = (
    client.table("problems")
    .select("id, image_url, solution_image_url, unit, difficulty_score")
    .eq("id", problem_id)
    .single()
    .execute()
  ).data
  if not prob:
    raise HTTPException(status_code=404, detail="문제 없음")
  if not prob.get("solution_image_url"):
    raise HTTPException(status_code=400, detail="해설 이미지가 없어 재추출 불가")

  result = rag_node_extractor.build_and_store(prob, client)
  if result.status != "success":
    raise HTTPException(status_code=500, detail=f"재추출 실패: {result.error}")
  return await list_nodes(problem_id, teacher_id)


def _row_from_existing(n: dict) -> dict:
  """기존 노드(_fetch_nodes_full 조회분)를 교체 INSERT 용 row 로. embedding 보존.

  내용이 안 바뀐 노드는 재임베딩하지 않고 기존 embedding_text/embedding 을 그대로 옮긴다
  (순번만 바뀌어도 임베딩은 동일 — 비용 절감 + NULL 방지).
  """
  return {
    "node_index": n["node_index"],
    "role": n["role"],
    "entry_conditions": n.get("entry_conditions"),
    "key_concept": n["key_concept"],
    "output_formula": n["output_formula"],
    "uses": n.get("uses", []),
    "whys": n.get("whys", []),
    "figure_description": n.get("figure_description"),
    "figure_image_crop_url": n.get("figure_image_crop_url"),
    "embedding_text": n.get("embedding_text"),
    "embedding": n.get("embedding"),
  }
