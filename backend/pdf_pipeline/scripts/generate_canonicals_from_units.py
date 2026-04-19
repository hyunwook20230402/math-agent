"""units 소단원 기반 concepts/skills canonical 자동 확장

목적:
  AI 튜터가 학생에게 "이걸 연습해라" 구체적으로 추천할 수 있도록
  concepts/skills canonical 을 units 소단원 수준의 입도로 확장한다.

동작:
  1. taxonomy["units"] walk → 소단원(leaf) path 수집
  2. 각 소단원을 OpenAI gpt-4.1-mini 에 structured output 으로 질의
  3. 응답한 concepts_ko / skills_ko 를 누적 (중복 제거)
  4. 기존 canonical 은 그대로 두고, 신규만 merge
  5. --dry-run (기본) / --apply (taxonomy 쓰기)

출력 예상:
  concepts 40 → 약 250~400개
  skills   27 → 약 200~300개
"""
import argparse
import copy
import json
import os
import sys
import time
from pathlib import Path

try:
  sys.stdout.reconfigure(encoding="utf-8")
except Exception:
  pass

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv
load_dotenv(ROOT / ".env")

from pydantic import BaseModel, Field


class CanonicalSuggestion(BaseModel):
  unit_path: str
  concepts_ko: list[str] = Field(default_factory=list, max_length=5)
  skills_ko: list[str] = Field(default_factory=list, max_length=5)
  rationale: str | None = None


def _flatten_units(units: dict) -> list[str]:
  leaves: list[str] = []
  for subject, bigs in units.items():
    if not isinstance(bigs, dict):
      continue
    for big, mids in bigs.items():
      if not isinstance(mids, dict):
        continue
      for mid, smalls in mids.items():
        if not isinstance(smalls, list):
          continue
        for small in smalls:
          leaves.append(f"{subject} > {big} > {mid} > {small}")
  return leaves


def _build_prompt(unit_path: str) -> str:
  return (
    "너는 한국 고등학교 수학 커리큘럼 전문가다. "
    "AI 수학 튜터가 학생에게 '이 부분을 더 연습해라' 구체적으로 추천할 수 있도록, "
    "아래 소단원에서 핵심 개념(concept)과 풀이 기법(skill)을 뽑아라.\n\n"
    f"소단원 경로: {unit_path}\n\n"
    "규칙:\n"
    "- concepts_ko: 이 소단원에서 학생이 이해해야 할 개념 1~3개 (한국어)\n"
    "  * 예시: '판별식', '이차함수의 최대·최소', '확률의 곱셈정리', '등비수열의 합'\n"
    "  * 소단원명 그대로여도 되고, 더 세분화해도 된다\n"
    "  * 너무 포괄적인 단어('함수', '방정식' 단독)는 금지\n"
    "- skills_ko: 이 소단원의 문제를 풀 때 자주 쓰는 기법 1~3개 (한국어)\n"
    "  * 예시: '판별식 적용', '치환', '수형도 그리기', '점화식 세우기'\n"
    "- rationale: 한 문장, 왜 이 개념/기법을 뽑았는지\n"
    "- 모든 항목 한국어, 교과서에서 실제로 쓰는 용어로\n"
    "- JSON 으로만 응답"
  )


def _call_openai(prompt: str) -> CanonicalSuggestion:
  from openai import OpenAI
  api_key = os.environ.get("OPENAI_API_KEY", "").strip()
  if not api_key:
    raise ValueError("OPENAI_API_KEY 환경변수 없음")
  client = OpenAI(api_key=api_key)
  model = os.environ.get("OPENAI_TAXONOMY_MODEL", "gpt-4.1-mini")
  resp = client.responses.parse(
    model=model,
    input=[{"role": "user", "content": prompt}],
    text_format=CanonicalSuggestion,
    temperature=0.3,
  )
  return resp.output_parsed


def _collect_suggestions(leaves: list[str]) -> list[CanonicalSuggestion]:
  out: list[CanonicalSuggestion] = []
  total = len(leaves)
  for i, unit_path in enumerate(leaves):
    print(f"  [{i+1}/{total}] {unit_path} ... ", end="", flush=True)
    try:
      result = _call_openai(_build_prompt(unit_path))
    except Exception as e:
      print(f"error: {e}")
      continue
    result.unit_path = unit_path
    out.append(result)
    print(f"c={len(result.concepts_ko)} s={len(result.skills_ko)}")
    time.sleep(0.25)
  return out


def _merge_canonicals(
  taxonomy: dict,
  suggestions: list[CanonicalSuggestion],
) -> tuple[dict, dict]:
  """신규 canonical merge. 기존 canonical 은 유지.

  Returns:
    (new_taxonomy, diff) — diff = {'concepts': [added...], 'skills': [added...]}
  """
  new_tax = copy.deepcopy(taxonomy)
  existing_concepts = set(new_tax.setdefault("concepts", {}).keys())
  existing_skills = set(new_tax.setdefault("skills", {}).keys())

  added_concepts: list[str] = []
  added_skills: list[str] = []

  for s in suggestions:
    for c in s.concepts_ko:
      c = (c or "").strip()
      if not c or c in existing_concepts:
        continue
      new_tax["concepts"][c] = []
      existing_concepts.add(c)
      added_concepts.append(c)
    for k in s.skills_ko:
      k = (k or "").strip()
      if not k or k in existing_skills:
        continue
      new_tax["skills"][k] = []
      existing_skills.add(k)
      added_skills.append(k)

  return new_tax, {"concepts": added_concepts, "skills": added_skills}


def main():
  parser = argparse.ArgumentParser()
  parser.add_argument("--dry-run", action="store_true", default=False)
  parser.add_argument("--apply", action="store_true", default=False)
  parser.add_argument("--limit", type=int, default=0, help="leaf 수 제한 (0 = 전체)")
  parser.add_argument("--suggestions-out", type=str, default="", help="suggestions JSON 저장 경로 (선택)")
  args = parser.parse_args()

  if not args.apply:
    args.dry_run = True

  taxonomy_path = ROOT / "data" / "concept_taxonomy.json"
  backup_path = ROOT / "data" / "concept_taxonomy.backup2.json"

  with open(taxonomy_path, encoding="utf-8") as f:
    taxonomy = json.load(f)

  leaves = _flatten_units(taxonomy.get("units", {}))
  if args.limit > 0:
    leaves = leaves[: args.limit]

  print(f"=== units leaves: {len(leaves)} ===")
  print(f"기존 concepts: {len(taxonomy.get('concepts', {}))}, skills: {len(taxonomy.get('skills', {}))}")
  print()

  suggestions = _collect_suggestions(leaves)

  if args.suggestions_out:
    out_path = Path(args.suggestions_out)
    with open(out_path, "w", encoding="utf-8") as f:
      json.dump([s.model_dump() for s in suggestions], f, ensure_ascii=False, indent=2)
    print(f"\nsuggestions 저장: {out_path}")

  new_tax, diff = _merge_canonicals(taxonomy, suggestions)

  print("\n=== diff summary ===")
  print(f"concepts: +{len(diff['concepts'])}")
  print(f"skills:   +{len(diff['skills'])}")
  if diff["concepts"]:
    print("\n신규 concepts (최대 30개 샘플):")
    for c in diff["concepts"][:30]:
      print(f"  - {c}")
    if len(diff["concepts"]) > 30:
      print(f"  ... 외 {len(diff['concepts']) - 30}개")
  if diff["skills"]:
    print("\n신규 skills (최대 30개 샘플):")
    for k in diff["skills"][:30]:
      print(f"  - {k}")
    if len(diff["skills"]) > 30:
      print(f"  ... 외 {len(diff['skills']) - 30}개")

  if args.apply:
    with open(backup_path, "w", encoding="utf-8") as f:
      json.dump(taxonomy, f, ensure_ascii=False, indent=2)
    print(f"\n백업 저장: {backup_path}")
    with open(taxonomy_path, "w", encoding="utf-8") as f:
      json.dump(new_tax, f, ensure_ascii=False, indent=2)
    print(f"taxonomy 업데이트: {taxonomy_path}")
    print(f"최종: concepts={len(new_tax['concepts'])}, skills={len(new_tax['skills'])}")
    print("다음 실행 시 임베딩 캐시 자동 재생성.")
    print("동의어 보강: venv/Scripts/python.exe scripts/expand_taxonomy.py --apply")
  else:
    print("\n(--apply 없음 → taxonomy 파일 수정 안 함)")


if __name__ == "__main__":
  main()
