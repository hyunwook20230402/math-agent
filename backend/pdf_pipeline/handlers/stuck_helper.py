"""막힌 지점 도우미 — 풀이 그래프 위치추적 RAG 기반 힌트 1발 생성.

학생이 풀다 막힌 "그 지점"을 풀이 노드 그래프 위에 위치추적하고, 다음 한 노드만
근거 기반으로 끌어준다. 막힌 원인 4분류(독해/인출/전이/실행)를 한 흐름으로 흡수한다:

  1. 막힌 지점 찾기 (`_localize`) : 학생의 막힌 서술 + 문제 이미지 + 노드 목록을 VL 에 줘
               "학생이 이해한 마지막 노드 index" 추정.
  2. 유사 풀이 끌어오기 (`_retrieve`) : 그 다음 노드(같은 문제) + 같은 개념 타 기출 유사
               노드를 pgvector 로 검색 (search_solution_nodes_for_hint RPC).
  3. 힌트 만들기 (`_generate`) : 문제 원본 이미지 + 끌어온 노드 근거 + (도형 crop 이미지) 를
               VL 에 줘 "다음 한 스텝만" 힌트 1~2문장 생성. 해설 통째 노출 금지.

해설 노드가 없는 문제(미백필)는 "유사 풀이 끌어오기"를 건너뛰고 문제 이미지만 보고 즉석 힌트(fallback).

- 임베딩: embedder.generate_embedding() 통일 (problems/solution_nodes.embedding 과 동일 차원).
- VL: call_vl() 통일. OpenAI 단일(2026-06-19 gemma4 폐기).
- 모든 LLM 출력은 Pydantic structured output 으로 강제.
"""
from __future__ import annotations

import logging
import os
import re
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

import httpx
import openai
import requests
from pydantic import BaseModel, Field

from pipeline import embedder
from pipeline.vl_providers import call_vl, call_vl_text, _fix_latex_subscript_escapes
from storage.supabase_client import get_client

# 재시도하면 안 되는 timeout 계열 예외 — 재시도 시 대기시간만 2배.
_TIMEOUT_EXC = (openai.APITimeoutError, httpx.TimeoutException)

logger = logging.getLogger(__name__)

# VL 호출 timeout(초). 튜터 모델은 gpt-5.2(추론) 유지라 응답이 길 수 있어 넉넉히.
# 무한 대기는 막되, 정상 추론을 timeout 으로 끊지 않게 90초.
_VL_TIMEOUT = 90

# 튜터 힌트 VL 은 OpenAI 단일(2026-06-19 gemma4 폐기). call_vl 이 항상 OpenAI 호출.


# LaTeX 인라인 구분자(\( \)) 와 흔한 명령을 벗겨 읽기 쉬운 식으로 — _localize outline 용.
_MATH_DELIM = re.compile(r'\\[()\[\]]')


def _strip_math(s: Optional[str]) -> str:
  if not s:
    return "(없음)"
  s = _MATH_DELIM.sub('', s)
  s = s.replace('\\times', '×').replace('\\cdot', '·').replace('\\frac', 'frac')
  return s.strip()


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


# ── 1) 막힌 지점 찾기 (localize) ──────────────────────────────────────────────

class _Localized(BaseModel):
  last_understood_index: int = Field(
    ..., description="학생이 이해한 마지막 단계 index (0-indexed). 아예 모르면 -1"
  )
  reasoning: str = Field(..., description="그렇게 판단한 짧은 이유")


def _localize(problem_image_path: Optional[str], blocked_desc: str, nodes: list[dict]) -> int:
  """학생이 이해한 마지막 노드 index 추정. 노드 없거나 이미지/호출 실패 시 -1(처음부터)."""
  if not nodes or not problem_image_path:
    return -1
  # 각 단계의 실제 결과식(output_formula)까지 보여줘야 학생 진술("3^2/3까지 했다")을
  # 정확한 단계에 매칭한다. key_concept(이름)만 주면 VL 이 위치를 뒤로 과대추정한다.
  outline = "\n".join(
    f"  step {n['node_index']}: {n['key_concept']} — 결과: {_strip_math(n.get('output_formula'))}"
    for n in nodes
  )
  prompt = f"""[이미지 1] = 학생이 푸는 수학 문제입니다.

학생이 이 문제를 풀다가 막혔습니다.
학생의 말: "{blocked_desc}"

이 문제 풀이는 다음 단계들로 이뤄집니다(각 단계의 결과식 포함):
{outline}

학생이 **이해해서 끝낸 마지막 단계의 index** 를 추정하세요(0-indexed).

먼저 reasoning 에 다음을 적고, 그 분석으로 last_understood_index 를 판정하세요:
1) 학생의 말에 나온 식/값을 적는다.
2) 그 식/값이 위 단계들의 **결과**와 하나씩 대조해 어느 단계의 결과와 일치하는지 찾는다.
   (예: 학생이 "3^(2/3)까지 했다" → 결과가 3^(2/3) 인 단계가 마지막 이해 단계.)
3) 학생이 "처음부터 모르겠다"거나 진전이 없으면 -1.

규칙:
- **애매하면 뒤(큰 index)가 아니라 앞(작은 index)으로 보수적으로** 잡으세요. 다음 한 걸음을
  안내하는 게 목적이라, 학생이 아직 안 한 단계를 이미 했다고 잘못 잡으면 힌트가 엉뚱해집니다."""

  try:
    # 위치 판단은 정확도가 중요 → reasoning medium(대조 추론). index 정수라 structured 유지(안전).
    res = call_vl(problem_image_path, prompt, _Localized, timeout=_VL_TIMEOUT,
                  max_tokens=2000, reasoning_effort="medium")
    idx = res.last_understood_index
    max_idx = max(n["node_index"] for n in nodes)
    return max(-1, min(idx, max_idx))
  except Exception as exc:
    logger.warning(f"막힌 지점 찾기(_localize) 실패 → -1 fallback: {exc}")
    return -1


# ── 2) 유사 풀이 끌어오기 (retrieve) ──────────────────────────────────────────

def _retrieve(problem_id: str, current_index: int, query_text: str, limit: int = 4) -> list[dict]:
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


# ── 3) 힌트 만들기 (generate) ─────────────────────────────────────────────────

class _Hint(BaseModel):
  hint_text: str = Field(..., description="학생에게 줄 힌트 1~2문장 (한국어). 다음 한 단계만.")
  next_step_concept: Optional[str] = Field(None, description="이 힌트가 짚는 개념명")


# 힌트가 정답을 흘렸는지 경량 탐지 — 객관식 보기기호 + "정답/답은" 패턴.
_LEAK_PATTERN = re.compile(r'[①②③④⑤]|정답\s*[은는이]?\s*|답\s*[은는이]?\s*[0-9①-⑤]')

# 정상 한글 힌트 판정 — gpt-5.2 가 간헐적으로 제어문자/깨진 출력을 뱉는 것 방어.
_HANGUL = re.compile(r'[가-힣]')


def _is_sane_hint(text: Optional[str]) -> bool:
  """힌트가 정상인지(빈 문자열·너무 짧음·한글 거의 없음이 아닌지)."""
  if not text:
    return False
  t = text.strip()
  if len(t) < 8:
    return False
  hangul = len(_HANGUL.findall(t))
  # 한국어 튜터 힌트라 한글이 최소 3자 이상은 있어야 정상(수식만/깨진 기호만은 비정상).
  return hangul >= 3


def _evidence_line(n: dict) -> str:
  """근거 노드 한 줄 — whys.question(소크라테스 질문) 포함, conclusion 의 최종 수식은 제외(정답 노출 방지)."""
  tag = "이 문제" if n.get("is_same_problem") else "유사 기출"
  parts = [f"개념={n['key_concept']}"]
  # conclusion(결론=최종답) 노드의 output_formula 는 정답이므로 evidence 에 안 넣음.
  if n.get("role") != "conclusion" and n.get("output_formula"):
    parts.append(f"산출={n['output_formula']}")
  whys = n.get("whys") or []
  qs = [w.get("question") for w in whys if isinstance(w, dict) and w.get("question")]
  if qs:
    parts.append("짚을점=" + " ".join(qs))   # question 만 — reason(이유)은 정답 흘릴 수 있어 제외
  if n.get("figure_description"):
    parts.append(f"도형={n['figure_description']}")
  return f"  - [{tag}] " + " / ".join(parts)


def _generate(problem_image_path: Optional[str], blocked_desc: str,
              nodes: list[dict], figure_paths: list[str]) -> _Hint:
  if nodes:
    evidence = "\n".join(_evidence_line(n) for n in nodes)
    grounding = f"""다음은 이 문제(및 같은 유형 기출)의 풀이 단계 근거입니다:
{evidence}

위 근거 중 학생이 막힌 지점 **바로 다음 한 단계만** 골라 안내하세요.
"짚을점"이 있으면 그걸 학생 스스로 떠올리도록 **질문 형태**로 던지세요(소크라테스식)."""
  else:
    grounding = """이 문제는 단계별 해설 데이터가 아직 없습니다.
문제 이미지를 직접 읽고, 학생이 막힌 지점 바로 다음 한 단계만 힌트로 안내하세요."""

  prompt = f"""당신은 친절한 고등학교 수학 튜터입니다.

[이미지 1] = 학생이 푸는 문제입니다.
학생의 말: "{blocked_desc}"

{grounding}

규칙:
- 힌트는 1~2문장, 한국어. 한 번에 다음 한 걸음만. 전체 풀이를 쏟아내지 마세요.
- **정답(최종 수치)·객관식 보기 번호(①②③④⑤)를 절대 말하지 마세요.** 답을 직접 알려주는 게 아니라
  학생이 스스로 다음 발을 디디게 질문·방향만 주세요.
- 수식은 LaTeX 인라인 \\( ... \\) 로."""

  # call_vl 은 이미지 경로 리스트를 받음 — 문제 이미지 + 도형 이미지(최대 2개)
  images = [p for p in (problem_image_path, *figure_paths[:2]) if p]
  if not images:
    # 이미지가 하나도 없으면 텍스트만으로는 멀티모달 호출이 부적절 → 안내 문구 fallback
    return _Hint(
      hint_text="문제 이미지를 불러오지 못했어요. 어디까지 풀었는지 조금 더 자세히 알려줄래요?",
      next_step_concept=None,
    )
  vl_input = images if len(images) > 1 else images[0]

  def _call_once() -> str:
    # gpt-5.2(추론 모델)는 structured output(JSON 강제)에서 디코딩 루프(같은 문자 반복)로 깨진다.
    # → 자유 텍스트(call_vl_text)로 받아 안정화. thinking 최소(low) + max_tokens 넉넉히(2000).
    try:
      txt = call_vl_text(vl_input, prompt, timeout=_VL_TIMEOUT, max_tokens=2000, reasoning_effort="low")
    except _TIMEOUT_EXC:
      logger.error("힌트 생성 VL timeout → 재시도 안 함(즉시 실패)")
      raise
    except Exception as exc:
      logger.warning(f"힌트 생성 VL 일시 오류 추정 → 1회 재시도: {exc}")
      txt = call_vl_text(vl_input, prompt, timeout=_VL_TIMEOUT, max_tokens=2000, reasoning_effort="low")
    # LaTeX 보정(제어문자 제거·깨진 구분자·아래첨자·닫는짝). 추출 경로와 동일 함수로 일관성.
    return _fix_latex_subscript_escapes(txt or "")

  text = _call_once()
  # 비정상(빈/깨진 출력)이면 1회 재생성 — 자유 텍스트로 거의 없지만 안전망 유지.
  if not _is_sane_hint(text):
    logger.warning(f"[hint] 비정상 출력 감지 → 1회 재생성: {text!r}")
    text = _call_once()
    if not _is_sane_hint(text):
      logger.error(f"[hint] 재생성 후에도 비정상 → 안내 fallback: {text!r}")
      return _Hint(
        hint_text="힌트를 만드는 데 문제가 있었어요. 어디까지 풀었는지 한 번만 더 말해줄래요?",
        next_step_concept=None,
      )

  # answer leakage 경량 검사 — 보기기호/정답 패턴이면 경고 로깅(차단은 안 함, 운영 관찰용).
  if _LEAK_PATTERN.search(text):
    logger.warning(f"[leakage?] 힌트에 정답/보기 패턴 의심: {text!r}")
  # next_step_concept 은 자유 텍스트라 모델이 따로 안 줌 → None(프론트 개념 배지 생략).
  return _Hint(hint_text=text, next_step_concept=None)


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
    .select("problem_id, node_index, role, key_concept, output_formula, uses, whys, "
            "figure_description, figure_image_crop_url")
    .eq("problem_id", problem_id)
    .order("node_index")
    .execute()
  ).data or []

  _t0 = time.time()
  prob_path = _download(prob["image_url"]) if prob.get("image_url") else None
  _t_download = time.time() - _t0
  figure_paths: list[str] = []
  _t_localize = _t_retrieve = _t_figures = _t_generate = 0.0
  try:
    # 막힌 지점 찾기: 멀티턴이면 revealed_node_index 이후부터, 첫 호출이면 _localize 로 추정
    if revealed_node_index >= 0:
      current_index = revealed_node_index
    else:
      _t = time.time()
      current_index = _localize(prob_path, blocked_description, nodes_all)
      _t_localize = time.time() - _t

    # 멀티턴 끝 도달 — 마지막 노드까지 안내했으면 더 줄 힌트 없음.
    # 이때 VL 을 부르면 근거 공백으로 gpt-5.2 가 쓰레기(제어문자)를 뱉으므로 호출 없이 종료 안내.
    if nodes_all:
      last_idx = max(n["node_index"] for n in nodes_all)
      if revealed_node_index >= 0 and current_index >= last_idx:
        logger.info("[TUTOR] problem_id=%s 멀티턴 끝 도달 → 종료 안내(VL 호출 안 함)", problem_id)
        return {
          "hint_text": "여기까지 오면 마지막 한 걸음만 남았어요. 지금까지 정리한 걸 바탕으로 스스로 답을 적어볼까요?",
          "next_step_concept": None,
          "next_revealed_node_index": current_index,  # 더 진행 안 함(클라가 hasMore=false 처리)
          "reference_nodes": [],
          "figure_urls": [],
          "has_solution_nodes": True,
        }

    # 검색 쿼리 텍스트: 학생 서술 + 현재 위치 다음 노드 개념(있으면)
    next_node = next((n for n in nodes_all if n["node_index"] == current_index + 1), None)
    query_text = blocked_description
    if next_node:
      query_text = f"{blocked_description}. {next_node['key_concept']}"

    _t = time.time()
    retrieved = _retrieve(problem_id, current_index, query_text) if nodes_all else []
    _t_retrieve = time.time() - _t

    # 유사 풀이 끌어오기 fallback — 노드는 있는데 임베딩/RPC 실패로 빈 결과면 "데이터 없음"이 아니라
    # 같은 문제의 다음 노드(node_index > current)를 raw 로 넘긴다(부실 힌트 방지).
    if not retrieved and nodes_all:
      logger.error("유사 풀이 끌어오기(_retrieve) 빈 결과(임베딩/RPC 실패 추정) → same-problem 다음 노드 fallback")
      retrieved = [
        {**n, "is_same_problem": True}
        for n in nodes_all if n["node_index"] > current_index
      ][:3]

    # 힌트 생성에 쓸 도형 이미지 다운로드 (근거 노드 중 crop URL 있는 것) — 병렬 다운로드.
    # 1차: figure_image_crop_url 이 "해설 통째 폴백" 이면 정답 노출 위험이 있으므로
    #      같은 문제(is_same_problem) 노드의 crop 은 보여주지 않고, 타 기출 노드 crop 만 허용.
    _t = time.time()
    figure_urls = [
      n["figure_image_crop_url"]
      for n in retrieved[:2]
      if n.get("figure_image_crop_url") and not n.get("is_same_problem")
    ]
    if figure_urls:
      with ThreadPoolExecutor(max_workers=2) as pool:
        for fp in pool.map(_download, figure_urls):
          if fp:
            figure_paths.append(fp)
    _t_figures = time.time() - _t

    _t = time.time()
    hint = _generate(prob_path, blocked_description, retrieved, figure_paths)
    _t_generate = time.time() - _t
    logger.info(
      "[TUTOR] problem_id=%s download=%.1fs localize=%.1fs retrieve=%.1fs figures=%.1fs generate=%.1fs total=%.1fs",
      problem_id, _t_download, _t_localize, _t_retrieve, _t_figures, _t_generate,
      time.time() - _t0,
    )

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
