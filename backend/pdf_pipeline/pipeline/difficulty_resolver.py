"""정답률 기반 난이도 결정 (2026-06-19)

정답률(퍼센트 0~100)이 있으면 구간 매핑으로 difficulty_score(1~10)를 정하고,
없으면 GPT(Call A)가 추정한 점수를 그대로 쓴다. 정답률이 더 신뢰도 높은 실측
객관 데이터라 우선한다(정답률 낮을수록 어려움).

구간 경계는 _CORRECT_RATE_BANDS 상수로 조정 가능.
"""
from typing import Optional

# (하한 정답률[%], difficulty_score) — 내림차순. 정답률이 band 하한 이상이면 그 score.
# 예: 정답률 85% → 첫 매칭 (80.0, 2) → score 2 (very_easy)
#     정답률 30% → (20.0, 8) → score 8 (hard)
_CORRECT_RATE_BANDS: list[tuple[float, int]] = [
  (80.0, 2),   # 80% 이상      → very_easy
  (60.0, 4),   # 60~80%        → easy
  (40.0, 6),   # 40~60%        → medium
  (20.0, 8),   # 20~40%        → hard
  (0.0, 10),   # 20% 미만      → very_hard
]

_DEFAULT_SCORE = 5  # 정답률·GPT 둘 다 없을 때 medium 폴백


def score_from_correct_rate(correct_rate: float) -> int:
  """정답률(0~100) → difficulty_score(1~10) 구간 매핑. 정답률 낮을수록 높은 점수."""
  # 범위 방어 — DB CHECK 가 0~100 보장하지만 호출측 입력도 클램프.
  cr = max(0.0, min(100.0, float(correct_rate)))
  for lower, score in _CORRECT_RATE_BANDS:
    if cr >= lower:
      return score
  return _CORRECT_RATE_BANDS[-1][1]  # 도달 불가(마지막 band 하한 0.0) — 방어


def resolve_difficulty(correct_rate: Optional[float], gpt_score: Optional[int]) -> int:
  """최종 difficulty_score 결정.

  - correct_rate 있으면: 구간 매핑(GPT 추정 무시).
  - correct_rate 없고 gpt_score 있으면: gpt_score(1~10 클램프).
  - 둘 다 없으면: _DEFAULT_SCORE(5).
  """
  if correct_rate is not None:
    return score_from_correct_rate(correct_rate)
  if gpt_score is not None:
    return max(1, min(10, int(gpt_score)))
  return _DEFAULT_SCORE
