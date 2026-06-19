"""RAG "막힌 지점 도우미" — 해설 이미지를 추론 노드(풀이 step) 단위로 분해.

문제/해설이 이미지에만 존재하므로 VLM(OpenAI gpt-5.2)으로 **1회 통합 추출**한다:
  문제+해설 이미지 → 전체 노드 배열(list[Node])을 1회 structured output 으로.
  (이전 2-pass(1+N회)는 gemma4 폭주 방어 잔재 — OpenAI 는 폭주 없어 1회로 충분.)

각 노드는 role / entry_conditions / key_concept / output_formula(LaTeX) /
figure_description(도형 언어화) 에 더해, **논리적 완결성**을 위한 2필드를 갖는다:
  uses : 이 노드가 성립하려고 참조하는 이전 node_index 들 (전이 근거 = DAG 엣지)
  whys : 학생이 "왜 이 다음 단계로?" 막힐 지점의 {question, reason} (0~2개)

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
from .vl_providers import call_vl, _fix_latex_subscript_escapes

logger = logging.getLogger(__name__)

# 한 문제당 노드 수 상한 (출력 토큰 상한 안전장치 — 1회 통합 시 슬라이스 기준)
MAX_NODES = int(os.environ.get("RAG_MAX_NODES", "15"))
# 1회 통합 출력 토큰 상한 (15노드×필드+uses/whys ≈ 1500tok 여유). 잘리면 _call_openai 가 loud fail.
RAG_MAX_OUTPUT_TOKENS = int(os.environ.get("VL_OPENAI_MAX_TOKENS", "4000"))

_VALID_ROLES = (
  "condition_analysis",
  "equation_setup",
  "case_split",
  "computation",
  "conclusion",
)


# ── Pydantic 스키마 (VLM structured output) ──────────────────────────────────

class _WhyEntry(BaseModel):
  """학생이 막힐 법한 전이 지점의 질문/이유.

  solution_tagger 의 WhyEntry 와 동일 형태지만 import 결합을 피해 별도 정의.
  question 은 학생에게 소크라테스식 질문으로 노출, reason 은 힌트 생성 배경 근거로만.
  """
  question: str = Field(..., description='"왜 ...?" 형태의 짧은 질문 (물음표 포함)')
  reason: str = Field(..., description="그 질문에 대한 짧은 한국어 이유")


class _Node(BaseModel):
  """1회 통합 추출의 노드 한 개 (골격+상세 합침)."""
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
    None, description="이 단계 직전까지 확보한 상태/정보를 구체적으로 (첫 단계는 null)"
  )
  key_concept: str = Field(
    ..., description="이 단계에서 쓰는 핵심 개념/정리 (한국어, 1~3 단어, 예: '시그마 분배', '판별식')"
  )
  output_formula: str = Field(
    ..., description=r"이 단계가 만들어내는 결과 수식. LaTeX 인라인 \( ... \). 식이 없으면 한국어 한 줄 요약"
  )
  uses: List[int] = Field(
    default_factory=list,
    description="이 단계가 성립하려고 참조하는 이전 단계의 node_index 들 (반드시 자기보다 작은 값). 첫 단계는 []",
  )
  whys: List[_WhyEntry] = Field(
    default_factory=list,
    description='학생이 "왜 이 단계로 넘어갈 수 있지?" 막힐 법한 질문/이유 0~2개. 자명하면 []',
  )
  figure_description: Optional[str] = Field(
    None,
    description=(
      "이 단계에 관련된 그래프/도형을 언어로 서술 "
      "(예: '한 변 6인 정사각형, 대각선 교점 O, 중심각 120도'). 도형이 없으면 null"
    ),
  )
  has_figure: bool = Field(
    False, description="이 단계에 학생에게 보여줄 도형/그래프가 있으면 true"
  )


class _NodeExtractionPayload(BaseModel):
  """1회 통합 응답 — 전체 노드 배열."""
  nodes: List[_Node] = Field(
    ..., min_length=1, description=f"풀이 단계 배열 (최소 1개, 최대 {MAX_NODES}개). 빈 배열 금지."
  )


# ── 결과 컨테이너 ─────────────────────────────────────────────────────────────

class ExtractedNode(BaseModel):
  node_index: int
  role: str
  entry_conditions: Optional[str]
  key_concept: str
  output_formula: str
  uses: List[int] = Field(default_factory=list)
  whys: List[dict] = Field(default_factory=list)  # [{question, reason}, ...] — DB jsonb 그대로
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


# ── 프롬프트 (1회 통합) ───────────────────────────────────────────────────────

_UNIFIED_EXTRACTION_PROMPT = f"""당신은 고등학교 수학 해설을 분석하는 전문가입니다.

[이미지 1] = 문제, [이미지 2] = 그 문제의 해설입니다.

해설의 풀이 과정을 학생이 따라갈 수 있는 "추론 단계(step)" 배열로 **한 번에** 분해하세요.
각 단계는 학생이 한 번에 이해할 수 있는 하나의 논리적 도약입니다.

각 노드를 **얕게 만들지 마세요.** 한 번에 전체 배열을 받으므로, 단계 간 "왜 넘어가는지"가
드러나야 합니다. 다음을 빠짐없이 채우세요:

- node_index: 0부터 순서대로.
- role: 반드시 condition_analysis / equation_setup / case_split / computation / conclusion 중 하나.
- entry_conditions: 이 단계 직전까지 확보한 상태(식·부등식·관계)를 구체적으로. 첫 단계는 null.
- key_concept: 이 단계 핵심 개념/정리 (1~3 단어, 예: "시그마 분배", "판별식").
- output_formula: 이 단계가 만들어내는 결과 수식. LaTeX 인라인 \\( ... \\) 형식.
- uses: 이 단계가 성립하려고 **참조하는 이전 단계의 node_index 들**. 반드시 자기 node_index 보다
  작은 값만. 첫 단계나 새 조건 도입이면 []. (예: node 3 이 node 0,2 의 결과를 쓰면 uses=[0,2])
- whys: 학생이 "왜 이 단계로 넘어갈 수 있지?" 막힐 법한 지점만 0~2개. 각 {{"question": "왜 ...?",
  "reason": "..."}}. 자명한 계산 단계는 []. (예: case_split 이면 "왜 이 기준으로 나누나?")
- figure_description: 이 단계 관련 그래프/도형이 해설에 있으면 모양을 말로 서술. 없으면 null.
- has_figure: 학생에게 보여줄 도형/그래프가 이 단계에 있으면 true.

규칙:
- 단계 수는 풀이 복잡도에 맞춰 자유롭게(최대 {MAX_NODES}개). 억지로 늘리거나 줄이지 마세요.
- 해설에 적힌 내용에만 근거하세요. 추측으로 지어내지 마세요.

**LaTeX 표기 규칙 (반드시 지킬 것):**
- 조합: {{}}_nC_r (예: {{}}_10C_3), 순열: {{}}_nP_r, 중복조합: {{}}_nH_r 로 쓰세요.
- 아래첨자는 a_1, a_{{n+1}} 처럼 쓰고, **밑줄(_) 앞에 백슬래시(\\_)를 절대 붙이지 마세요.**
- 시그마 \\sum, 분수 \\frac{{}}{{}}, 제곱근 \\sqrt{{}}, 적분 \\int."""


# ── 추출 ─────────────────────────────────────────────────────────────────────

def _normalize_role(role: str) -> str:
  r = (role or "").strip().lower()
  return r if r in _VALID_ROLES else "computation"


def _clean_uses(raw_uses: List[int], node_index: int, valid_indices: set[int]) -> List[int]:
  """uses 를 유효 범위로 정제 — 자기보다 작고 실제 존재하는 node_index 만 남긴다.

  이렇게 "더 작은 인덱스만 참조" 를 강제하면 DAG 가 정의상 acyclic 이 된다(순환 불가).
  범위 밖/미래 참조/자기참조/중복을 제거. LLM 이 잘못 뱉은 인덱스 방어.
  """
  if not raw_uses:
    return []
  seen: set[int] = set()
  out: List[int] = []
  for u in raw_uses:
    if isinstance(u, int) and 0 <= u < node_index and u in valid_indices and u not in seen:
      seen.add(u)
      out.append(u)
  return sorted(out)


def extract_nodes(problem: dict) -> NodeExtractionResult:
  """한 문제(problems row dict)에서 추론 노드를 **1회 통합 호출**로 추출. DB 저장은 안 한다.

  problem 은 최소 {id, image_url, solution_image_url} 를 포함해야 한다.
  OpenAI gpt-5.2 멀티모달 강제 (provider="openai") — 도형 언어화 품질 우선.
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

    # 1회 통합 호출 — 전체 노드 배열을 한 번에. 잘리면 _call_openai 가 loud fail.
    payload = call_vl(images, _UNIFIED_EXTRACTION_PROMPT, _NodeExtractionPayload,
                      provider="openai", max_tokens=RAG_MAX_OUTPUT_TOKENS)

    nodes = sorted(payload.nodes, key=lambda n: n.node_index)
    if len(nodes) > MAX_NODES:
      logger.warning(f"[rag_node] nodes truncated {len(nodes)}→{MAX_NODES} problem_id={problem_id}")
      nodes = nodes[:MAX_NODES]
    if not nodes:
      return NodeExtractionResult(problem_id=problem_id, nodes=[], status="error",
                                  error="통합 호출 노드 0개")

    valid_indices = {n.node_index for n in nodes}
    out: List[ExtractedNode] = []
    for node in nodes:
      fig_desc = (node.figure_description or "").strip() or None
      # LaTeX 조합기호 아래첨자 앞 잘못된 백슬래시(\_2H_3 → _2H_3) 저장 직전 보정
      output_formula = _fix_latex_subscript_escapes(node.output_formula)
      # uses 정제 — 자기보다 작고 존재하는 인덱스만(acyclic 보장)
      uses = _clean_uses(node.uses, node.node_index, valid_indices)
      whys = [{"question": w.question, "reason": w.reason} for w in node.whys]
      # 검색용 합성 텍스트 — 개념 + (진입조건) + (whys 질문) + 산출 수식 + 도형.
      # "이 노드가 어떤 상황에서 필요한가" 가 벡터에 녹아 학생 막힌 서술과 매칭↑.
      why_q = " ".join(w["question"] for w in whys)
      embedding_text = ". ".join(
        part for part in (node.key_concept, node.entry_conditions, why_q, output_formula, fig_desc)
        if part
      )
      out.append(ExtractedNode(
        node_index=node.node_index,
        role=_normalize_role(node.role),
        entry_conditions=node.entry_conditions,
        key_concept=node.key_concept,
        output_formula=output_formula,
        uses=uses,
        whys=whys,
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
      "uses": node.uses,
      "whys": node.whys,
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
