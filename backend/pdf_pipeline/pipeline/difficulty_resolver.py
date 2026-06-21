"""난이도 결정 (2026-06-21 — 4단계 Lv1~4 체계로 전환)

난이도 근거 우선순위:
  1) 해설에 인쇄된 Lv 라벨(Lv1~Lv4) — 가장 신뢰도 높은 실측. Lv1=쉬움 … Lv4=최상위.
  2) 정답률(%) — 과거 해설 호환용. 있으면 구간 매핑.
  3) VL(Call A) 의 구조 신호 추정값.

difficulty_score 는 이제 1~4 정수다(옛 1~10 체계 폐기). 옛 정답률 구간도 1~4 로
재매핑했다. correct_rate 컬럼·경로는 호환을 위해 남겨둔다.
"""
from typing import Optional

# (하한 정답률[%], difficulty_score 1~4) — 내림차순. 정답률 낮을수록 어려움.
# 예: 정답률 85% → (80.0, 1) → Lv1 / 정답률 25% → (20.0, 3) → Lv3 / 10% → (0.0, 4) → Lv4
_CORRECT_RATE_BANDS: list[tuple[float, int]] = [
  (80.0, 1),   # 80% 이상      → Lv1
  (50.0, 2),   # 50~80%        → Lv2
  (30.0, 3),   # 30~50%        → Lv3
  (0.0, 4),    # 30% 미만      → Lv4
]

_DEFAULT_SCORE = 2  # 라벨·정답률·GPT 모두 없을 때 중간(Lv2) 폴백

# Lv 라벨 → difficulty_score(1~4). "Lv1"/"lv1"/"LV1"/"Lv 1" 등 표기 흔들림 흡수.
_LV_TO_SCORE: dict[str, int] = {"1": 1, "2": 2, "3": 3, "4": 4}


def score_from_level(level: Optional[str]) -> Optional[int]:
  """해설에 적힌 Lv 라벨("Lv1"~"Lv4") → difficulty_score(1~4).

  파싱 불가/None 이면 None 반환(상위에서 다음 근거로 폴백).
  """
  if not level:
    return None
  digits = "".join(ch for ch in str(level) if ch.isdigit())
  return _LV_TO_SCORE.get(digits)


def score_from_correct_rate(correct_rate: float) -> int:
  """정답률(0~100) → difficulty_score(1~4) 구간 매핑. 정답률 낮을수록 높은 점수."""
  cr = max(0.0, min(100.0, float(correct_rate)))
  for lower, score in _CORRECT_RATE_BANDS:
    if cr >= lower:
      return score
  return _CORRECT_RATE_BANDS[-1][1]  # 도달 불가(마지막 band 하한 0.0) — 방어


def resolve_difficulty(
  correct_rate: Optional[float],
  gpt_score: Optional[int],
  level: Optional[str] = None,
) -> int:
  """최종 difficulty_score(1~4) 결정.

  - level(Lv 라벨) 있으면: 라벨 환산(나머지 무시) — 가장 우선.
  - 없고 correct_rate 있으면: 구간 매핑.
  - 둘 다 없고 gpt_score 있으면: gpt_score(1~4 클램프).
  - 모두 없으면: _DEFAULT_SCORE(2).
  """
  lv = score_from_level(level)
  if lv is not None:
    return lv
  if correct_rate is not None:
    return score_from_correct_rate(correct_rate)
  if gpt_score is not None:
    return max(1, min(4, int(gpt_score)))
  return _DEFAULT_SCORE
