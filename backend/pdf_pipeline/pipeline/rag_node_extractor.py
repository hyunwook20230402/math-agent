"""RAG "막힌 지점 도우미" — 해설 이미지를 추론 노드(풀이 step) 단위로 분해.

문제/해설이 이미지에만 존재하므로 VLM(GPT-4o)으로 2-pass 추출한다:
  Pass 1 (skeleton): 풀이를 노드 배열로 구조화 (node_index / role / entry_conditions)
  Pass 2 (per-node): 각 노드의 key_concept / output_formula(LaTeX) / figure_description(도형 언어화)

각 노드의 검색용 텍스트(embedding_text)를 bge-m3 로 임베딩해 solution_nodes 에 저장한다.
임베딩은 problems.embedding 과 동일 차원(1024)으로 통일하기 위해 EMBED_PROVIDER=ollama 를 권장한다.

모든 LLM 출력은 Pydantic structured output 으로 강제한다 (free-form JSON 파싱 금지).

공개 API:
  extract_nodes(problem) -> NodeExtractionResult     # 한 문제 노드 추출 (DB 저장 안 함)
  build_and_store(problem) -> NodeExtractionResult   # 추출 + 임베딩 + solution_nodes 저장
"""
from __future__ import annotations

import logging
import os
import tempfile
from typing import List, Optional

import requests
from pydantic import BaseModel, Field

from . import embedder
from .vl_providers import call_vl

logger = logging.getLogger(__name__)

# 한 문제당 노드 수 상한 (gemma4 폭주 안전장치이자 GPT-4o 토큰 상한 — Call B MAX_STEPS 와 동일 정신)
MAX_NODES = int(os.environ.get("RAG_MAX_NODES", "15"))

_VALID_ROLES = (
  "condition_analysis",
  "equation_setup",
  "case_split",
  "computation",
  "conclusion",
)


# ── Pydantic 스키마 (VLM structured output) ──────────────────────────────────

class _SkeletonNode(BaseModel):
  """Pass 1 결과 — 풀이 골격 한 노드."""
  node_index: int = Field(..., description="0부터 시작하는 풀이 단계 순서")
  role: str = Field(
    ...,
    description=(
      "이 단계의 역할. 반드시 다음 중 하나: "
      "condition_analysis(조건 해석), equation_setup(식 세우기), "
      "case_split(경우 분리), computation(계산 실행), conclusion(결론 도출)"
    ),
  )
  entry_conditions: Optional[str] = Field(
    None, description="이 단계에 들어오기 전까지 확보한 상태/정보 (첫 단계는 null)"
  )


class _Skeleton(BaseModel):
  """Pass 1 전체 — 풀이 골격."""
  nodes: List[_SkeletonNode] = Field(..., description=f"풀이 단계 배열 (최대 {MAX_NODES}개)")


class _NodeDetail(BaseModel):
  """Pass 2 결과 — 한 노드의 상세 내용."""
  node_index: int
  key_concept: str = Field(
    ..., description="이 단계에서 사용하는 핵심 개념/정리 (한국어, 1~3 단어)"
  )
  output_formula: str = Field(
    ..., description=r"이 단계의 산출물 수식. LaTeX 인라인 형식 \( ... \). 식이 없으면 한국어 한 줄 요약"
  )
  figure_description: Optional[str] = Field(
    None,
    description=(
      "이 단계에 관련된 그래프/도형을 언어로 서술 "
      "(예: '한 변 6인 정사각형, 대각선 교점 O, 중심각 120도'). "
      "도형이 없으면 null"
    ),
  )
  has_figure: bool = Field(
    False, description="이 단계에 학생에게 보여줄 도형/그래프가 있으면 true"
  )


# ── 결과 컨테이너 ─────────────────────────────────────────────────────────────

class ExtractedNode(BaseModel):
  node_index: int
  role: str
  entry_conditions: Optional[str]
  key_concept: str
  output_formula: str
  figure_description: Optional[str]
  figure_image_crop_url: Optional[str]
  embedding_text: str


class NodeExtractionResult(BaseModel):
  problem_id: str
  nodes: List[ExtractedNode]
  status: str  # "success" | "skipped" | "error"
  error: Optional[str] = None


# ── 이미지 다운로드 (call_vl 은 로컬 파일 경로를 요구) ─────────────────────────

def _download_to_temp(url: str) -> str:
  """Supabase Storage 등의 이미지 URL 을 임시 파일로 내려받고 경로 반환."""
  resp = requests.get(url, timeout=60)
  resp.raise_for_status()
  suffix = ".png"
  lower = url.lower()
  if ".jpg" in lower or ".jpeg" in lower:
    suffix = ".jpg"
  fd, path = tempfile.mkstemp(suffix=suffix)
  with os.fdopen(fd, "wb") as f:
    f.write(resp.content)
  return path


# ── 프롬프트 ─────────────────────────────────────────────────────────────────

_PASS1_PROMPT = f"""당신은 고등학교 수학 해설을 분석하는 전문가입니다.

[이미지 1] = 문제, [이미지 2] = 그 문제의 해설입니다.

해설의 풀이 과정을 학생이 따라갈 수 있는 "추론 단계(step)"의 배열로 분해하세요.
각 단계는 학생이 한 번에 이해할 수 있는 하나의 논리적 도약이어야 합니다.

규칙:
- node_index 는 0부터 순서대로.
- 단계 수는 풀이 복잡도에 맞춰 자유롭게(최대 {MAX_NODES}개). 억지로 늘리거나 줄이지 마세요.
- role 은 반드시 다음 중 하나: condition_analysis / equation_setup / case_split / computation / conclusion
- entry_conditions 는 이 단계 직전까지 확보한 정보. 첫 단계(node_index=0)는 null.
- 이 단계에서는 골격(index/role/entry_conditions)만 만듭니다. 구체적 수식은 다음에 채웁니다."""


def _pass2_prompt(skeleton: _Skeleton, target_index: int) -> str:
  outline = "\n".join(
    f"  - step {n.node_index} ({n.role})"
    + (f": 진입조건={n.entry_conditions}" if n.entry_conditions else "")
    for n in skeleton.nodes
  )
  return f"""당신은 고등학교 수학 해설을 분석하는 전문가입니다.

[이미지 1] = 문제, [이미지 2] = 해설입니다.

이 풀이는 다음 단계들로 구성됩니다:
{outline}

지금은 **step {target_index} 한 단계만** 상세히 채웁니다.

다음을 한국어로 작성하세요:
- key_concept: 이 단계에서 쓰는 핵심 개념/정리 (1~3 단어, 예: "시그마 분배", "판별식")
- output_formula: 이 단계가 만들어내는 결과 수식. LaTeX 인라인 \\( ... \\) 형식. 순수 계산이면 그 식.
- figure_description: 이 단계에 관련된 그래프/도형이 해설에 있으면 그 모양을 말로 서술. 없으면 null.
- has_figure: 학생에게 보여줄 도형/그래프가 이 단계에 있으면 true, 아니면 false.

해설에 적힌 내용에만 근거하세요. 추측으로 지어내지 마세요."""


# ── 추출 ─────────────────────────────────────────────────────────────────────

def _normalize_role(role: str) -> str:
  r = (role or "").strip().lower()
  return r if r in _VALID_ROLES else "computation"


def extract_nodes(problem: dict) -> NodeExtractionResult:
  """한 문제(problems row dict)에서 추론 노드를 추출. DB 저장은 하지 않는다.

  problem 은 최소 {id, image_url, solution_image_url} 를 포함해야 한다.
  GPT-4o 멀티모달 강제 (provider="openai") — 도형 언어화 품질 우선.
  """
  problem_id = problem["id"]
  prob_url = problem.get("image_url")
  sol_url = problem.get("solution_image_url")

  if not sol_url:
    return NodeExtractionResult(problem_id=problem_id, nodes=[], status="skipped",
                                error="solution_image_url 없음")

  prob_path = sol_path = None
  try:
    prob_path = _download_to_temp(prob_url) if prob_url else None
    sol_path = _download_to_temp(sol_url)
    images = [p for p in (prob_path, sol_path) if p]

    # Pass 1: 골격
    skeleton = call_vl(images, _PASS1_PROMPT, _Skeleton, provider="openai")
    skeleton.nodes = sorted(skeleton.nodes, key=lambda n: n.node_index)[:MAX_NODES]
    if not skeleton.nodes:
      return NodeExtractionResult(problem_id=problem_id, nodes=[], status="error",
                                  error="Pass 1 노드 0개")

    # Pass 2: 노드별 상세
    out: List[ExtractedNode] = []
    for sk in skeleton.nodes:
      detail = call_vl(images, _pass2_prompt(skeleton, sk.node_index),
                       _NodeDetail, provider="openai")
      fig_desc = (detail.figure_description or "").strip() or None
      # 검색용 합성 텍스트 — 개념 + 산출 수식 + 도형 서술
      embedding_text = ". ".join(
        part for part in (detail.key_concept, detail.output_formula, fig_desc) if part
      )
      out.append(ExtractedNode(
        node_index=sk.node_index,
        role=_normalize_role(sk.role),
        entry_conditions=sk.entry_conditions,
        key_concept=detail.key_concept,
        output_formula=detail.output_formula,
        figure_description=fig_desc,
        # 도형 crop URL 은 비워둔다. 해설 전체 이미지를 폴백으로 넣으면 정답이 통째 노출되므로
        # 위험. 정확한 도형 영역은 CMS 수동 bbox 로 채운다(후속). figure_description(언어화)은
        # 검색·힌트 근거로 계속 쓰이므로 has_figure 여부와 무관하게 유지된다.
        figure_image_crop_url=None,
        embedding_text=embedding_text,
      ))

    return NodeExtractionResult(problem_id=problem_id, nodes=out, status="success")

  except Exception as exc:
    logger.exception(f"[rag_node] 추출 실패 problem_id={problem_id}: {exc}")
    return NodeExtractionResult(problem_id=problem_id, nodes=[], status="error", error=str(exc))
  finally:
    for p in (prob_path, sol_path):
      if p and os.path.exists(p):
        try:
          os.remove(p)
        except OSError:
          pass


def build_and_store(problem: dict, supabase_client) -> NodeExtractionResult:
  """추출 → 임베딩 → solution_nodes 저장 (기존 노드는 교체).

  supabase_client 는 service-role Client (get_client()).
  """
  result = extract_nodes(problem)
  if result.status != "success" or not result.nodes:
    return result

  # 임베딩 (배치)
  texts = [n.embedding_text for n in result.nodes]
  embeddings = embedder.generate_embeddings_batch(texts)

  rows = []
  for node, emb in zip(result.nodes, embeddings):
    rows.append({
      "problem_id": result.problem_id,
      "node_index": node.node_index,
      "role": node.role,
      "entry_conditions": node.entry_conditions,
      "key_concept": node.key_concept,
      "output_formula": node.output_formula,
      "figure_description": node.figure_description,
      "figure_image_crop_url": node.figure_image_crop_url,
      "embedding_text": node.embedding_text,
      "embedding": emb,
    })

  # 재실행 멱등성 — 기존 노드 삭제 후 삽입
  supabase_client.table("solution_nodes").delete().eq(
    "problem_id", result.problem_id
  ).execute()
  supabase_client.table("solution_nodes").insert(rows).execute()

  logger.info(f"[rag_node] 저장 완료 problem_id={result.problem_id} nodes={len(rows)}")
  return result
