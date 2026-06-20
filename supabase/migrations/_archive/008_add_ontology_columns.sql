-- 008: 온톨로지 데이터 컬럼 추가 (solution_steps, common_mistakes)
-- Gemma 4 VL 태깅에서 추출한 단계별 풀이 경로와 흔한 실수(+bug_id)를 저장.
-- AI 튜터가 단계별 힌트 / 오답 원인 진단에 활용.
--
-- 구조:
--   solution_steps: JSONB — [{step: int, description: str}, ...]
--   common_mistakes: JSONB — [{text: str, bug_id: str | null}, ...]

ALTER TABLE problem_staging
  ADD COLUMN IF NOT EXISTS solution_steps JSONB,
  ADD COLUMN IF NOT EXISTS common_mistakes JSONB;

ALTER TABLE problems
  ADD COLUMN IF NOT EXISTS solution_steps JSONB,
  ADD COLUMN IF NOT EXISTS common_mistakes JSONB;
