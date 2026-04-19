"""Gemini API 단발 스모크 테스트

VL_PROVIDER=gemini 로 설정해 vl_providers._call_gemini 를 통해 Gemini API 호출.
TagResult Pydantic 스키마를 그대로 사용하므로 provider 교체 외 파이프라인 동일.

사용법:
  cd backend/pdf_pipeline
  set VL_PROVIDER=gemini
  set GEMINI_MODEL=gemini-2.0-flash   # 또는 gemini-1.5-flash 등
  python scripts/smoke_test_gemini.py [해설이미지경로] [문제이미지경로(선택)]

- 첫 번째 인자: 해설 이미지 (생략 시 기본값)
- 두 번째 인자: 문제 이미지 (생략 시 해설 단독 모드).
  두 인자를 모두 주면 문제+해설 동시 태깅 결과가 solo 결과와 함께 출력된다.
"""
import json
import os
import sys
import time
from pathlib import Path

try:
  sys.stdout.reconfigure(encoding="utf-8")
except Exception:
  pass

print("[1/5] 시작", flush=True)

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))

print("[2/5] dotenv 로드", flush=True)
try:
  from dotenv import load_dotenv
  load_dotenv(ROOT / ".env")
except ImportError:
  print("❌ python-dotenv 패키지가 없습니다.  pip install python-dotenv")
  sys.exit(1)

# Gemini 사용 강제
os.environ["VL_PROVIDER"] = "gemini"

GEMINI_API_KEY = (os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY") or "").strip()
if not GEMINI_API_KEY:
  print("❌ GEMINI_API_KEY / GOOGLE_API_KEY 환경변수가 없습니다.")
  sys.exit(1)

print("[3/5] google-genai import 확인", flush=True)
try:
  from google import genai  # noqa: F401
except ImportError:
  print("❌ google-genai 패키지가 없습니다.  pip install google-genai")
  sys.exit(1)

print("[4/5] pipeline import", flush=True)
from pipeline import solution_tagger, unit_matcher
from pipeline.tag_normalizer import load_or_build_section_embeddings
print("[5/5] import 완료", flush=True)

# ── 이미지 경로 ───────────────────────────────────────────────────────────────
DEFAULT_IMAGE = (
  ROOT
  / "uploads"
  / "solutions"
  / "2021학년도_수능_수리(나형)_해설_2"
  / "solution_crops"
  / "page_001_0016_edit_16.png"
)

IMAGE_PATH = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_IMAGE
PROBLEM_IMAGE_PATH = Path(sys.argv[2]) if len(sys.argv) > 2 else None

if not IMAGE_PATH.exists():
  print(f"❌ 해설 이미지가 없습니다: {IMAGE_PATH}")
  sys.exit(1)
if PROBLEM_IMAGE_PATH is not None and not PROBLEM_IMAGE_PATH.exists():
  print(f"❌ 문제 이미지가 없습니다: {PROBLEM_IMAGE_PATH}")
  sys.exit(1)

VL_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.0-flash")
print(f"모델     : {VL_MODEL}")
print(f"해설이미지: {IMAGE_PATH}")
if PROBLEM_IMAGE_PATH is not None:
  print(f"문제이미지: {PROBLEM_IMAGE_PATH}")
print("-" * 60)

taxonomy_path = ROOT / "data" / "concept_taxonomy.json"
leaf_embeddings = unit_matcher.load_or_build_embeddings(taxonomy_path)
concept_embeddings = load_or_build_section_embeddings(taxonomy_path, "concepts")
skill_embeddings = load_or_build_section_embeddings(taxonomy_path, "skills")
bug_embeddings = load_or_build_section_embeddings(taxonomy_path, "bugs")


def _tag(problem_path: str | None, label: str) -> tuple[dict, float]:
  t = time.time()
  r = solution_tagger.extract_tags_from_image(
    str(IMAGE_PATH),
    has_solution=True,
    leaf_embeddings=leaf_embeddings,
    concept_embeddings=concept_embeddings,
    skill_embeddings=skill_embeddings,
    bug_embeddings=bug_embeddings,
    problem_image_path=problem_path,
  )
  el = time.time() - t
  print(f"\n=== [{label}] 결과 ({el:.1f}s) ===")
  print(json.dumps(r, ensure_ascii=False, indent=2))
  return r, el


solo_result, solo_elapsed = _tag(None, "해설만")
dual_result: dict | None = None
dual_elapsed: float | None = None
if PROBLEM_IMAGE_PATH is not None:
  dual_result, dual_elapsed = _tag(str(PROBLEM_IMAGE_PATH), "문제+해설")

print("-" * 60)
print(f"해설만   : {solo_elapsed:.1f}s | concept={solo_result.get('concept_tags')} | skill={solo_result.get('skill_tags')}")
if dual_result is not None:
  print(f"문제+해설: {dual_elapsed:.1f}s | concept={dual_result.get('concept_tags')} | skill={dual_result.get('skill_tags')}")

# 파일 저장
out_dir = ROOT / "scripts" / "smoke_results"
out_dir.mkdir(exist_ok=True)
stamp = time.strftime("%Y%m%d_%H%M%S")
out_path = out_dir / f"{stamp}_{IMAGE_PATH.stem}.json"
with open(out_path, "w", encoding="utf-8") as f:
  json.dump({
    "model": VL_MODEL,
    "provider": "gemini",
    "solution_image": str(IMAGE_PATH),
    "problem_image": str(PROBLEM_IMAGE_PATH) if PROBLEM_IMAGE_PATH else None,
    "solo": {"elapsed_sec": solo_elapsed, "result": solo_result},
    "dual": {"elapsed_sec": dual_elapsed, "result": dual_result} if dual_result is not None else None,
  }, f, ensure_ascii=False, indent=2)
print(f"\n저장: {out_path}")
