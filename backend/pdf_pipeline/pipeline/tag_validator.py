"""온톨로지 태깅 검증 에이전트 (3-layer)

Layer 1 — Rule 기반 (비용 0): 필드 누락, 영어 혼입, formula delimiter, placeholder, step_no 중복 등
Layer 2 — LLM 재검증 (call_vl 1호출, OpenAI): 이미지 + 태깅 결과 cross-check
Layer 3 — 임베딩 자가 체크 (비용 0): solution_steps ↔ concept_tags cosine 일치도

VL 은 OpenAI 단일(2026-06-19 gemma4 폐기).

환경변수:
  TAG_VALIDATOR_ENABLED  — "true" (기본) | "false"
  TAG_VALIDATOR_LAYERS   — "123" (기본) | "1" | "13" 등 조합 가능

상세 문서: backend/pdf_pipeline/docs/TAG_VALIDATOR.md
"""
import json
import logging
import os
import re
from typing import Literal

import numpy as np
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

TAG_VALIDATOR_LAYERS = os.environ.get("TAG_VALIDATOR_LAYERS", "123")


# ── Pydantic 스키마 ───────────────────────────────────────────────────────────

class ValidationIssue(BaseModel):
  field: str
  reason: str
  severity: Literal["low", "medium", "high"]
  applied: bool = False  # suggested_fix 자동 반영 여부 (solution_tagger 가 세팅)

class SuggestedFixes(BaseModel):
  concept_tags: list[str] | None = None
  skill_tags: list[str] | None = None
  unit: str | None = None
  difficulty_score: int | None = None

class ValidationResult(BaseModel):
  status: Literal["ok", "warning", "reject"]
  score: float = Field(ge=0.0, le=1.0)
  issues: list[ValidationIssue] = Field(default_factory=list)
  suggested_fixes: SuggestedFixes | None = None


# ── Layer 1: Rule 기반 ────────────────────────────────────────────────────────

_EN_WORD_RE = re.compile(r"[a-zA-Z]{4,}")


def _has_english(text: str, ratio_threshold: float = 0.3) -> bool:
  """전체 단어 중 영단어(4자 이상) 비율이 threshold 초과하면 True."""
  if not text:
    return False
  words = text.split()
  if not words:
    return False
  en_count = sum(1 for w in words if _EN_WORD_RE.search(w))
  return (en_count / len(words)) > ratio_threshold


def _layer1_rule(tag_result: dict) -> list[ValidationIssue]:
  issues: list[ValidationIssue] = []

  if not tag_result.get("concept_tags"):
    issues.append(ValidationIssue(field="concept_tags", reason="concept_tags 비어 있음", severity="high"))

  if not tag_result.get("skill_tags"):
    issues.append(ValidationIssue(field="skill_tags", reason="skill_tags 비어 있음", severity="medium"))

  steps = tag_result.get("solution_steps") or []
  if not steps:
    issues.append(ValidationIssue(field="solution_steps", reason="solution_steps 비어 있음", severity="medium"))

  if not tag_result.get("common_mistakes"):
    issues.append(ValidationIssue(field="common_mistakes", reason="common_mistakes 비어 있음", severity="low"))

  difficulty_score = tag_result.get("difficulty_score")
  if difficulty_score is not None and not (1 <= int(difficulty_score) <= 10):
    issues.append(ValidationIssue(field="difficulty_score", reason=f"difficulty_score={difficulty_score} 범위 초과 (1~10)", severity="high"))

  unit_score = tag_result.get("unit_score", 1.0)
  if unit_score < 0.5:
    issues.append(ValidationIssue(
      field="unit",
      reason=f"unit_score={unit_score:.2f} < 0.5 — 단원 매칭 신뢰도 낮음",
      severity="medium",
    ))

  mistakes: list[dict] = tag_result.get("common_mistakes", [])
  if mistakes:
    null_count = sum(1 for m in mistakes if m.get("bug_id") is None)
    if null_count / len(mistakes) >= 0.7:
      issues.append(ValidationIssue(
        field="common_mistakes",
        reason=f"bug_id null 비율 {null_count}/{len(mistakes)} — taxonomy bugs 동의어 부족",
        severity="medium",
      ))

  # 영어 혼입 체크 — 학생 UI 노출 텍스트 필드만 검사
  # difficulty(enum), bug_id(내부 식별자), unit(계층경로) 는 영어 허용
  for field_name in ("solution_summary", "pitfall"):
    val = tag_result.get(field_name) or ""
    if _has_english(str(val)):
      issues.append(ValidationIssue(field=field_name, reason=f"{field_name} 에 영어 혼입", severity="high"))

  steps: list[dict] = tag_result.get("solution_steps", [])
  for step in steps:
    hint = step.get("hint", "")
    if _has_english(hint):
      issues.append(ValidationIssue(field="solution_steps", reason=f"step {step.get('step')} hint 영어 혼입", severity="high"))
      break

  # formula delimiter 누락 / placeholder 잔존 / concept "null" 문자열 — 후처리가 잡지 못한 잔여 검증
  for step in steps:
    f = step.get("formula")
    if isinstance(f, str) and f.strip():
      fs = f.strip()
      if not (fs.startswith("\\(") or fs.startswith("\\[")):
        issues.append(ValidationIssue(
          field="solution_steps",
          reason=f"step {step.get('step')} formula delimiter 누락: {fs[:40]}",
          severity="high",
        ))
        break
  for step in steps:
    h = step.get("hint") or ""
    if re.match(r"^\s*(description[_:]\s*error?|final_result|implying)\b", h, re.I):
      issues.append(ValidationIssue(
        field="solution_steps",
        reason=f"step {step.get('step')} hint placeholder 잔존: {h[:40]}",
        severity="high",
      ))
      break
  for step in steps:
    c = step.get("concept")
    if isinstance(c, str) and c.strip().lower() in {"null", "none"}:
      issues.append(ValidationIssue(
        field="solution_steps",
        reason=f"step {step.get('step')} concept 문자열 'null' 박제",
        severity="medium",
      ))
      break

  # step_no 중복 (Call B 가 JSON 중간에 자기복제하는 케이스 — solution_tagger 가 dedup 하지만 안전망)
  st_nos = [s.get("step") for s in steps if s.get("step") is not None]
  dup_nos = sorted({n for n in st_nos if st_nos.count(n) > 1})
  if dup_nos:
    issues.append(ValidationIssue(
      field="solution_steps",
      reason=f"step_no 중복: {dup_nos}",
      severity="high",
    ))

  # skeleton 오염 증상: 번호는 다르지만 hint 내용이 같은 step 여러 개 (Pass 1 repetition)
  hint_seen: dict[str, int] = {}
  for s in steps:
    h = (s.get("hint") or "").strip()
    if not h:
      continue
    prev = hint_seen.get(h)
    if prev is not None:
      issues.append(ValidationIssue(
        field="solution_steps",
        reason=f"step {prev}/{s.get('step')} hint 텍스트 중복 (skeleton 오염)",
        severity="high",
      ))
      break
    hint_seen[h] = s.get("step")

  # LaTeX cases 짝 (\\begin{cases} vs \\end{cases}) — 토큰 잘림으로 미완성 감지
  full_text = json.dumps(steps, ensure_ascii=False)
  begin_cnt = full_text.count(r"\begin{cases}")
  end_cnt = full_text.count(r"\end{cases}")
  if begin_cnt != end_cnt:
    issues.append(ValidationIssue(
      field="solution_steps",
      reason=f"LaTeX cases 짝 안 맞음: begin={begin_cnt} end={end_cnt}",
      severity="high",
    ))

  # hint 한국어 비율 (< 50% 이면 영어 혼입 심각)
  for s in steps:
    d = s.get("hint") or ""
    if len(d) < 5:
      continue
    han = sum(1 for c in d if '\uac00' <= c <= '\ud7a3')
    alpha = sum(1 for c in d if c.isalpha() or '\uac00' <= c <= '\ud7a3')
    if alpha == 0:
      continue
    ratio = han / alpha
    if ratio < 0.5:
      issues.append(ValidationIssue(
        field="solution_steps",
        reason=f"step {s.get('step')} hint 한국어 비율 {ratio:.0%} — 영어 혼입 과다",
        severity="high",
      ))
      break

  for tag in tag_result.get("concept_tags", []) + tag_result.get("skill_tags", []):
    if _has_english(tag, ratio_threshold=0.8):
      issues.append(ValidationIssue(field="concept_tags/skill_tags", reason=f"태그 '{tag}' 영어 — 한국어 강제 필요", severity="high"))
      break

  # common_mistakes.text 는 학생 UI 노출 → 영어 체크 (bug_id 는 내부 식별자라 제외)
  for m in tag_result.get("common_mistakes", []):
    if _has_english(m.get("text", "")):
      issues.append(ValidationIssue(field="common_mistakes.text", reason=f"common_mistakes text 영어 혼입: {m.get('text', '')[:30]}", severity="high"))
      break

  # role 분포·연속 warning (schema v2 에서 추가된 role 필드 기준, 일반론)
  if any("role" in s for s in steps):
    roles = [s.get("role") for s in steps if s.get("role")]
    # 동일 role 이 3 step 이상 연속
    run = 1
    for i in range(1, len(roles)):
      if roles[i] == roles[i - 1]:
        run += 1
        if run >= 3:
          issues.append(ValidationIssue(
            field="solution_steps",
            reason=f"동일 role '{roles[i]}' 이 {run} step 이상 연속 (Pass 1 구조 이상 의심)",
            severity="medium",
          ))
          break
      else:
        run = 1
    # conclusion 갯수 체크
    conclusion_cnt = sum(1 for r in roles if r == "conclusion")
    if conclusion_cnt == 0 and len(roles) >= 3:
      issues.append(ValidationIssue(
        field="solution_steps",
        reason="conclusion role 이 없음 — 마지막 step 이 결론이어야 함",
        severity="medium",
      ))
    elif conclusion_cnt >= 2:
      issues.append(ValidationIssue(
        field="solution_steps",
        reason=f"conclusion role 이 {conclusion_cnt}개 — 풀이 전체에서 1개여야 함",
        severity="medium",
      ))

  # ── schema v2 DAG 검증 (produces/uses/whys 일관성) ──
  # v2 필드가 하나라도 있는 step 이 있으면 DAG 규칙 적용. 구 데이터에는 skip.
  if any("produces" in s or "uses" in s for s in steps):
    issues.extend(_layer1_dag(steps))

  return issues


def _layer1_dag(steps: list[dict]) -> list[ValidationIssue]:
  """produces/uses 일관성 + DAG cycle + whys 형식 검증."""
  issues: list[ValidationIssue] = []

  # 1) produces.label 중복 (같은 라벨 여러 step 이 정의 → 의존관계 모호)
  label_to_steps: dict[str, list[int]] = {}
  for s in steps:
    for p in (s.get("produces") or []):
      label = p.get("label") if isinstance(p, dict) else None
      if label:
        label_to_steps.setdefault(label, []).append(s.get("step"))
  dups = {l: ss for l, ss in label_to_steps.items() if len(ss) > 1}
  if dups:
    issues.append(ValidationIssue(
      field="solution_steps",
      reason=f"produces 라벨 중복: {dups}",
      severity="high",
    ))

  # 2) uses 가 이전 step 의 produces 에 존재하는 라벨만 참조해야 함 (유령 참조)
  produced_so_far: set[str] = set()
  for s in steps:
    for u in (s.get("uses") or []):
      if u not in produced_so_far:
        issues.append(ValidationIssue(
          field="solution_steps",
          reason=f"step {s.get('step')} uses='{u}' — 이전 step produces 에 미정의 (유령 참조)",
          severity="high",
        ))
        break
    for p in (s.get("produces") or []):
      label = p.get("label") if isinstance(p, dict) else None
      if label:
        produced_so_far.add(label)

  # 3) step 순서가 이미 배열 인덱스 순이므로, 2) 에서 "이전에 정의된 것만 uses"
  # 체크가 곧 DAG 무결성 (cycle 불가능). 추가 cycle 검증 생략.

  # 4) whys 형식: question 물음표 필수
  for s in steps:
    for w in (s.get("whys") or []):
      q = (w.get("question") if isinstance(w, dict) else None) or ""
      if q and "?" not in q and "？" not in q:
        issues.append(ValidationIssue(
          field="solution_steps",
          reason=f"step {s.get('step')} whys.question 물음표 누락: {q[:30]}",
          severity="medium",
        ))
        break

  # 5) produces 개수 상한 (2) / uses 개수 상한 (3) — Pydantic 에서 이미 막지만 구 데이터 안전망
  for s in steps:
    prod = s.get("produces") or []
    uses = s.get("uses") or []
    if len(prod) > 2:
      issues.append(ValidationIssue(
        field="solution_steps",
        reason=f"step {s.get('step')} produces 과다 ({len(prod)} > 2)",
        severity="medium",
      ))
      break
    if len(uses) > 3:
      issues.append(ValidationIssue(
        field="solution_steps",
        reason=f"step {s.get('step')} uses 과다 ({len(uses)} > 3)",
        severity="medium",
      ))
      break

  return issues


# ── Layer 3: 임베딩 자가 체크 ─────────────────────────────────────────────────

def _layer3_embedding(tag_result: dict) -> list[ValidationIssue]:
  """solution_steps 텍스트 ↔ concept_tags 임베딩 cosine 일치도 체크."""
  issues: list[ValidationIssue] = []

  concept_tags: list[str] = tag_result.get("concept_tags", [])
  steps: list[dict] = tag_result.get("solution_steps", [])

  if not concept_tags or not steps:
    return issues

  try:
    from . import embedder

    steps_text = " ".join(s.get("hint", "") for s in steps)
    tags_text = " ".join(concept_tags)

    steps_vec = np.array(embedder.generate_embedding(steps_text), dtype=np.float32)
    tags_vec = np.array(embedder.generate_embedding(tags_text), dtype=np.float32)

    steps_norm = np.linalg.norm(steps_vec)
    tags_norm = np.linalg.norm(tags_vec)

    if steps_norm > 0 and tags_norm > 0:
      similarity = float(np.dot(steps_vec / steps_norm, tags_vec / tags_norm))
      if similarity < 0.4:
        issues.append(ValidationIssue(
          field="concept_tags",
          reason=f"solution_steps 내용과 concept_tags 임베딩 유사도 낮음 ({similarity:.2f})",
          severity="medium",
        ))
  except Exception as e:
    logger.debug(f"Layer 3 임베딩 체크 실패 (무시): {e}")

  return issues


# ── Layer 2: LLM 재검증 ───────────────────────────────────────────────────────

_VALIDATION_PROMPT_TEMPLATE = """\
아래는 수학 해설 이미지에 대한 자동 태깅 결과다.
이미지와 태깅 결과를 비교해서 다음을 검사해라:
1. concept_tags / skill_tags 중 명백히 누락된 개념이나 오태깅이 있는가?
2. unit (단원 경로) 이 이미지 내용과 맞는가?
3. solution_steps 가 실제 풀이 흐름과 맞는가? 아래 기준으로 엄격히 판단해라:
   - 이미지에 등장하는 핵심 계산/변환 단계가 steps에 빠져 있으면 "solution_steps step 누락" 이슈 (severity=high)
   - steps 순서가 실제 풀이 순서와 다르면 "solution_steps 순서 불일치" 이슈 (severity=high)
   - steps 내용이 이미지와 무관한 엉뚱한 풀이면 "solution_steps 내용 불일치" 이슈 (severity=high, reject)
   - steps 개수가 풀이 복잡도 대비 비현실적이면 (예: difficulty_score=2 인데 12 steps, 또는 difficulty_score=10 인데 1 step) "difficulty_score 부적절" 이슈로 suggested_fixes.difficulty_score 재조정 제안 (severity=medium)
   - steps 개수가 1개뿐이거나 지나치게 뭉뚱그려진 경우 "solution_steps 세분화 부족" 이슈 (severity=medium)
   - 단순한 step 개수 구간 검증은 하지 않는다 — 모델이 풀이 복잡도에 맞춰 자유 결정 (4차 정책)
4. difficulty_score (1~10 정수) 가 문제 난이도와 맞는가? 시대 무관 구조 신호 기반:
   - 1-2 (very_easy): 공식 1개 직접 대입
   - 3-4 (easy): 2~3단 계산, 개념 1개 안
   - 5-6 (medium): 조건 2~3개 조합, 개념 1~2개
   - 7-8 (hard): 아이디어 1개 — 경우분리 2개 / 그래프+대수 / 합성·역·절댓값 1개 / 개념 2~3개 복합 중 1개
   - 9-10 (killer): 경우분리 3+ / 합성·역·절댓값 중첩 2+ / 미지수 2+ 동시결정 / 스텝 7+ / 그래프+경우분리+대수 모두 / 개념 3+ 복합 중 2개 이상 해당
   문제 번호는 참고만 — 시대별로 킬러 번호 다름.

태깅 결과:
{tag_json}

{canonical_section}

모든 text 필드는 한국어여야 한다. 영어가 있으면 반드시 지적해라.
suggested_fixes 를 제안할 때:
- concept_tags / skill_tags 는 반드시 위에 제시된 "사용 가능한 canonical 목록" 안에서만 골라라.
- unit 은 반드시 "사용 가능한 unit 경로" 중 하나를 골라라.
- difficulty_score 가 부적절하면 suggested_fixes.difficulty_score 에 1~10 정수로 직접 제시해라.
- 목록에 없는 용어는 제안하지 마라 (후처리에서 매칭 실패).

문제 없으면 status=ok, 경미한 문제면 warning, 심각하면 reject 로 판단해라.
JSON 으로만 응답해라."""


# canonical/unit 목록 캐시 (매 호출마다 파일 읽지 않도록)
_canonical_cache: dict | None = None


def _load_canonical_lists() -> dict:
  """taxonomy 에서 concepts/skills canonical + unit leaf path 목록을 읽어온다."""
  global _canonical_cache
  if _canonical_cache is not None:
    return _canonical_cache
  try:
    from pathlib import Path
    tax_path = Path(__file__).parent.parent / "data" / "concept_taxonomy.json"
    with open(tax_path, encoding="utf-8") as f:
      tax = json.load(f)
    concepts = sorted(tax.get("concepts", {}).keys())
    skills = sorted(tax.get("skills", {}).keys())
    units: list[str] = []
    for subject, bigs in (tax.get("units") or {}).items():
      if not isinstance(bigs, dict):
        continue
      for big, mids in bigs.items():
        if not isinstance(mids, dict):
          continue
        for mid, smalls in mids.items():
          if not isinstance(smalls, list):
            continue
          for small in smalls:
            units.append(f"{subject} > {big} > {mid} > {small}")
    _canonical_cache = {"concepts": concepts, "skills": skills, "units": sorted(units)}
    return _canonical_cache
  except Exception as e:
    logger.warning(f"canonical 목록 로드 실패 (프롬프트에 빈 목록): {e}")
    _canonical_cache = {"concepts": [], "skills": [], "units": []}
    return _canonical_cache


def _build_canonical_section() -> str:
  lists = _load_canonical_lists()
  concepts_str = ", ".join(lists["concepts"]) if lists["concepts"] else "(없음)"
  skills_str = ", ".join(lists["skills"]) if lists["skills"] else "(없음)"
  units_str = "\n  - " + "\n  - ".join(lists["units"]) if lists["units"] else "(없음)"
  return (
    "사용 가능한 concepts canonical 목록:\n"
    f"{concepts_str}\n\n"
    "사용 가능한 skills canonical 목록:\n"
    f"{skills_str}\n\n"
    "사용 가능한 unit 경로 (소단원 leaf):"
    f"{units_str}"
  )


def _layer2_llm(tag_result: dict, image_path: str | list[str]) -> tuple[list[ValidationIssue], SuggestedFixes | None]:
  """LLM 으로 태깅 결과를 재검증. VL=OpenAI 단일(2026-06-19 gemma4 폐기).

  image_path 는 단일 경로 또는 리스트([문제경로, 해설경로]). 리스트면 멀티 이미지로 전달.
  (구 난이도 기반 provider 분기는 OpenAI 단일화로 제거.)
  """
  try:
    from .vl_providers import call_vl

    # LLM 검증용 경량 스키마 (suggested_fixes 없이 먼저 받음)
    class _LLMValidation(BaseModel):
      status: Literal["ok", "warning", "reject"]
      issues: list[ValidationIssue] = Field(default_factory=list)
      suggested_fixes: SuggestedFixes | None = None

    tag_json = json.dumps(tag_result, ensure_ascii=False, indent=2)
    prompt = _VALIDATION_PROMPT_TEMPLATE.format(
      tag_json=tag_json,
      canonical_section=_build_canonical_section(),
    )

    d = int(tag_result.get("difficulty_score") or 5)
    logger.info(f"[validator L2] difficulty={d} provider=openai")

    llm_result = call_vl(image_path, prompt, _LLMValidation)
    return llm_result.issues, llm_result.suggested_fixes

  except Exception as e:
    logger.warning(f"Layer 2 LLM 재검증 실패 (무시): {e}")
    return [], None


# ── 공개 API ──────────────────────────────────────────────────────────────────

def validate(tag_result: dict, image_path: str | list[str]) -> ValidationResult:
  """태깅 결과를 3-layer 로 검증.

  TAG_VALIDATOR_LAYERS 환경변수로 레이어 선택 (기본 "123" = 전체).
  image_path 는 단일 경로 또는 [문제, 해설] 리스트 허용.
  """
  layers = os.environ.get("TAG_VALIDATOR_LAYERS", TAG_VALIDATOR_LAYERS)

  all_issues: list[ValidationIssue] = []
  suggested_fixes: SuggestedFixes | None = None

  if "1" in layers:
    all_issues.extend(_layer1_rule(tag_result))

  if "3" in layers:
    all_issues.extend(_layer3_embedding(tag_result))

  if "2" in layers:
    llm_issues, llm_fixes = _layer2_llm(tag_result, image_path)
    all_issues.extend(llm_issues)
    if llm_fixes:
      suggested_fixes = llm_fixes

  # severity 기준으로 status 결정
  severities = {i.severity for i in all_issues}
  if "high" in severities:
    status: Literal["ok", "warning", "reject"] = "reject"
  elif "medium" in severities:
    status = "warning"
  elif all_issues:
    status = "warning"
  else:
    status = "ok"

  # score: high issue 1개당 -0.2, medium -0.1, low -0.05
  score = 1.0
  for issue in all_issues:
    if issue.severity == "high":
      score -= 0.2
    elif issue.severity == "medium":
      score -= 0.1
    else:
      score -= 0.05
  score = max(0.0, round(score, 2))

  return ValidationResult(
    status=status,
    score=score,
    issues=all_issues,
    suggested_fixes=suggested_fixes,
  )
