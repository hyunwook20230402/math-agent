"""Provider 시간대 기반 auto-select + 환경변수 override

운영 전략 (2026-04-19 확정):
  평일 09:00~19:00 KST (서버 근무)  → ollama  (Gemma3 27B / bge-m3)
  그 외 시간 (집)                   → openai  (VL + embed)
  (Gemini free tier 하루 20회 한도로 실용성 없어 제거)

환경변수:
  VL_PROVIDER, EMBED_PROVIDER — 비어 있으면 시간대 기반 default 사용
"""
import os
from datetime import datetime

try:
  from zoneinfo import ZoneInfo
  _KST = ZoneInfo("Asia/Seoul")
except Exception:
  _KST = None


def is_work_hours() -> bool:
  """평일(월~금) 09:00~19:00 KST 이면 True. ZoneInfo 로드 실패 시 로컬 시간 fallback."""
  now = datetime.now(_KST) if _KST else datetime.now()
  if now.weekday() >= 5:
    return False
  return 9 <= now.hour < 19


def select_vl_provider() -> str:
  forced = os.environ.get("VL_PROVIDER", "").strip().lower()
  if forced:
    return forced
  return "ollama" if is_work_hours() else "openai"


def select_embed_provider() -> str:
  forced = os.environ.get("EMBED_PROVIDER", "").strip().lower()
  if forced:
    return forced
  return "ollama" if is_work_hours() else "openai"


def describe_selection() -> str:
  """로그용 한 줄 요약."""
  vl = select_vl_provider()
  emb = select_embed_provider()
  mode = "work-hours" if is_work_hours() else "off-hours"
  return f"[provider_selector] mode={mode} vl={vl} embed={emb}"
