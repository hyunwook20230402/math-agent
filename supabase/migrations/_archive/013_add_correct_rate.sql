-- 013_add_correct_rate.sql
-- 문항 정답률(퍼센트 0~100, 소수 허용). 평가원/EBS 공개 정답률 등 실측 객관 데이터.
-- NULL 허용(기본값 없음) = 안전. 정답률이 있으면 난이도(difficulty_score)를 구간매핑으로 결정,
-- 없으면 기존 GPT(Call A) 추정값을 사용. (2026-06-19)

ALTER TABLE problems ADD COLUMN IF NOT EXISTS correct_rate NUMERIC
  CHECK (correct_rate IS NULL OR (correct_rate >= 0 AND correct_rate <= 100));

-- 태깅 파이프라인이 staging 을 거치므로 problem_staging 에도 동일 컬럼 추가.
ALTER TABLE problem_staging ADD COLUMN IF NOT EXISTS correct_rate NUMERIC
  CHECK (correct_rate IS NULL OR (correct_rate >= 0 AND correct_rate <= 100));

COMMENT ON COLUMN problems.correct_rate IS '문항 정답률(0~100%). 있으면 난이도 구간매핑 우선, 없으면 GPT 추정.';
COMMENT ON COLUMN problem_staging.correct_rate IS '문항 정답률(0~100%). problems.correct_rate 와 동일 용도.';
