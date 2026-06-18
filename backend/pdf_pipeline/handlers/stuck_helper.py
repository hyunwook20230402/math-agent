"""막힌 지점 도우미 — 풀이 그래프 위치추적 RAG 기반 힌트 1발 생성.

학생이 풀다 막힌 "그 지점"을 풀이 노드 그래프 위에 위치추적하고, 다음 한 노드만
근거 기반으로 끌어준다. 막힌 원인 4분류(독해/인출/전이/실행)를 한 흐름으로 흡수한다:

  1. localize : 학생의 막힌 서술 + 문제 이미지 + 노드 목록을 VL 에 줘
               "학생이 이해한 마지막 노드 index" 추정.
  2. retrieve : 그 다음 노드(같은 문제) + 같은 개념 타 기출 유사 노드를 pgvector 로 검색
               (search_solution_nodes_for_hint RPC).
  3. generate : 문제 원본 이미지 + retrieved 노드 근거 + (도형 crop 이미지) 를 VL 에 줘
               "다음 한 스텝만" 힌트 1~2문장 생성. 해설 통째 노출 금지.

해설 노드가 없는 문제(미백필)는 retrieve 를 건너뛰고 문제 이미지만 보고 즉석 힌트(fallback).

- 임베딩: embedder.generate_embedding() 통일 (problems/solution_nodes.embedding 과 동일 차원).
- VL: call_vl(provider=...) 통일. 기본 openai(gpt-4o) — 한국어/도형 품질. env TUTOR_VL_PROVIDER 로 override.
- 모든 LLM 출력은 Pydantic structured output 으로 강제.
"""
from __future__ import annotations

import logging
import os
import tempfile
from typing import Optional

import requests
from pydantic import BaseModel, Field

from pipeline import embedder
from pipeline.vl_providers import call_vl
from storage.supabase_client import get_client

logger = logging.getLogger(__name__)

# 튜터 힌트 VL provider — 기본 openai(gpt-4o). ollama 로 바꾸면 gemma4 사용 (비용 절감)
TUTOR_VL_PROVIDER = os.environ.get("TUTOR_VL_PROVIDER", "openai")


# ── 이미지 다운로드 (call_vl 은 로컬 파일 경로를 요구) ─────────────────────────

def _download(url: str) -> Optional[str]:
  try:
    resp = requests.get(url, timeout=60)
    resp.raise_for_status()
  except Exception as exc:
    logger.warning(f"이미지 다운로드 실패 {url}: {exc}")
    return None
  suffix = ".jpg" if (".jpg" in url.lower() or ".jpeg" in url.lower()) else ".png"
  fd, path = tempfile.mkstemp(suffix=suffix)
  with os.fdopen(fd, "wb") as f:
    f.write(resp.content)
  return path


# ── 1) localize ──────────────────────────────────────────────────────────────

class _Localized(BaseModel):
  last_understood_index: int = Field(
    ..., description="학생이 이해한 마지막 단계 index (0-indexed). 아예 모르면 -1"
  )
  reasoning: str = Field(..., description="그렇게 판단한 짧은 이유")


def _localize(problem_image_path: Optional[str], blocked_desc: str, nodes: list[dict]) -> int:
  """학생이 이해한 마지막 노드 index 추정. 노드 없거나 이미지/호출 실패 시 -1(처음부터)."""
  if not nodes or not problem_image_path:
    return -1
  outline = "\n".join(
    f"  step {n['node_index']}: {n['key_concept']}" for n in nodes
  )
  prompt = f"""[이미지 1] = 학생이 푸는 수학 문제입니다.

학생이 이 문제를 풀다가 막혔습니다.
학생의 말: "{blocked_desc}"

이 문제 풀이는 다음 단계들로 이뤄집니다:
{outline}

학생이 **이해해서 끝낸 마지막 단계의 index** 를 추정하세요(0-indexed).
- 학생이 "처음부터 모르겠다"거나 아무 진전이 없으면 last_understood_index = -1.
- "여기까지 했다"는 게 명확하면 그 단계 index."""

  try:
    res = call_vl(problem_image_path, prompt, _Localized, provider=TUTOR_VL_PROVIDER)
    idx = res.last_understood_index
    max_idx = max(n["node_index"] for n in nodes)
    return max(-1, min(idx, max_idx))
  except Exception as exc:
    logger.warning(f"localize 실패 → -1 fallback: {exc}")
    return -1


# ── 2) retrieve ──────────────────────────────────────────────────────────────

def _retrieve(problem_id: str, current_index: int, query_text: str, limit: int = 5) -> list[dict]:
  client = get_client()
  try:
    query_emb = embedder.generate_embedding(query_text)
  except Exception as exc:
    logger.warning(f"쿼리 임베딩 실패: {exc}")
    return []
  try:
    res = client.rpc("search_solution_nodes_for_hint", {
      "query_embedding": query_emb,
      "current_problem_id": problem_id,
      "current_node_index": current_index,
      "match_limit": limit,
    }).execute()
  except Exception as exc:
    logger.warning(f"search_solution_nodes_for_hint RPC 실패: {exc}")
    return []
  return res.data or []


# ── 3) generate ──────────────────────────────────────────────────────────────

class _Hint(BaseModel):
  hint_text: str = Field(..., description="학생에게 줄 힌트 1~2문장 (한국어). 다음 한 단계만.")
  next_step_concept: Optional[str] = Field(None, description="이 힌트가 짚는 개념명")


def _generate(problem_image_path: Optional[str], blocked_desc: str,
              nodes: list[dict], figure_paths: list[str]) -> _Hint:
  if nodes:
    evidence = "\n".join(
      f"  - [{'이 문제' if n.get('is_same_problem') else '유사 기출'}] "
      f"개념={n['key_concept']} / 산출={n['output_formula']}"
      + (f" / 도형={n['figure_description']}" if n.get("figure_description") else "")
      for n in nodes
    )
    grounding = f"""다음은 이 문제(및 같은 유형 기출)의 풀이 단계 근거입니다:
{evidence}

위 근거 중 학생이 막힌 지점 **바로 다음 한 단계만** 골라, 답을 직접 말하지 말고
스스로 다음 발을 디딜 수 있게 힌트로 안내하세요."""
  else:
    grounding = """이 문제는 단계별 해설 데이터가 아직 없습니다.
문제 이미지를 직접 읽고, 학생이 막힌 지점 바로 다음 한 단계만 힌트로 안내하세요.
답을 직접 말하지 마세요."""

  prompt = f"""당신은 친절한 고등학교 수학 튜터입니다.

[이미지 1] = 학생이 푸는 문제입니다.
학생의 말: "{blocked_desc}"

{grounding}

규칙:
- 힌트는 1~2문장, 한국어.
- 한 번에 다음 한 걸음만. 전체 풀이를 쏟아내지 마세요.
- 수식은 LaTeX 인라인 \\( ... \\) 로."""

  # call_vl 은 이미지 경로 리스트를 받음 — 문제 이미지 + 도형 이미지(최대 2개)
  images = [p for p in (problem_image_path, *figure_paths[:2]) if p]
  if not images:
    # 이미지가 하나도 없으면 텍스트만으로는 멀티모달 호출이 부적절 → 안내 문구 fallback
    return _Hint(
      hint_text="문제 이미지를 불러오지 못했어요. 어디까지 풀었는지 조금 더 자세히 알려줄래요?",
      next_step_concept=None,
    )
  return call_vl(images if len(images) > 1 else images[0], prompt, _Hint, provider=TUTOR_VL_PROVIDER)


# ── 공개 진입점 ───────────────────────────────────────────────────────────────

def generate_hint(problem_id: str, blocked_description: str,
                  revealed_node_index: int = -1) -> dict:
  """막힌 지점 힌트 1발 생성.

  Args:
    problem_id: 현재 푸는 문제 id
    blocked_description: 학생의 막힌 지점 서술 ("아예 모르겠어요" 포함)
    revealed_node_index: 직전 호출까지 공개한 노드 index (멀티턴; 첫 호출 -1)

  Returns:
    {hint_text, next_step_concept, next_revealed_node_index,
     reference_nodes, figure_urls, has_solution_nodes}
  """
  client = get_client()

  prob = (
    client.table("problems")
    .select("id, image_url, solution_image_url, unit")
    .eq("id", problem_id)
    .maybe_single()
    .execute()
  ).data
  if not prob:
    raise ValueError("문제를 찾을 수 없습니다")

  nodes_all = (
    client.table("solution_nodes")
    .select("node_index, role, key_concept, output_formula, figure_description, figure_image_crop_url")
    .eq("problem_id", problem_id)
    .order("node_index")
    .execute()
  ).data or []

  prob_path = _download(prob["image_url"]) if prob.get("image_url") else None
  figure_paths: list[str] = []
  try:
    # 위치 추적: 멀티턴이면 revealed_node_index 이후부터, 첫 호출이면 localize
    if revealed_node_index >= 0:
      current_index = revealed_node_index
    else:
      current_index = _localize(prob_path, blocked_description, nodes_all)

    # 검색 쿼리 텍스트: 학생 서술 + 현재 위치 다음 노드 개념(있으면)
    next_node = next((n for n in nodes_all if n["node_index"] == current_index + 1), None)
    query_text = blocked_description
    if next_node:
      query_text = f"{blocked_description}. {next_node['key_concept']}"

    retrieved = _retrieve(problem_id, current_index, query_text) if nodes_all else []

    # 힌트 생성에 쓸 도형 이미지 다운로드 (근거 노드 중 crop URL 있는 것)
    # 1차: figure_image_crop_url 이 "해설 통째 폴백" 이면 정답 노출 위험이 있으므로
    #      같은 문제(is_same_problem) 노드의 crop 은 보여주지 않고, 타 기출 노드 crop 만 허용.
    for n in retrieved[:2]:
      url = n.get("figure_image_crop_url")
      if url and not n.get("is_same_problem"):
        fp = _download(url)
        if fp:
          figure_paths.append(fp)

    hint = _generate(prob_path, blocked_description, retrieved, figure_paths)

    # 다음 공개 인덱스 — 같은 문제의 다음 노드까지 진행
    same_problem_nodes = [n for n in retrieved if n.get("is_same_problem")]
    if same_problem_nodes:
      next_revealed = min(n["node_index"] for n in same_problem_nodes)
    else:
      next_revealed = current_index + 1

    return {
      "hint_text": hint.hint_text,
      "next_step_concept": hint.next_step_concept,
      "next_revealed_node_index": next_revealed,
      "reference_nodes": [
        {
          "problem_id": n["problem_id"],
          "node_index": n["node_index"],
          "key_concept": n["key_concept"],
          "is_same_problem": n.get("is_same_problem", False),
        }
        for n in retrieved
      ],
      # 같은 문제 crop 은 정답 노출 위험으로 제외 — 타 기출 도형만 노출
      "figure_urls": [
        n["figure_image_crop_url"]
        for n in retrieved
        if n.get("figure_image_crop_url") and not n.get("is_same_problem")
      ],
      "has_solution_nodes": bool(nodes_all),
    }
  finally:
    for p in [prob_path, *figure_paths]:
      if p and os.path.exists(p):
        try:
          os.remove(p)
        except OSError:
          pass
