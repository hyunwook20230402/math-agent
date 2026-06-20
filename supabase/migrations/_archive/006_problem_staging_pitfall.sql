-- 006: problem_staging 에 pitfall(오답 포인트) 컬럼 추가
-- AI 태깅 시 Qwen2.5-VL 이 학생이 틀리기 쉬운 지점 1~2줄을 반환하며,
-- solution_summary 와 별도 필드로 저장한다 (문제 카드/풀이 화면에서 구분 표시용).

ALTER TABLE problem_staging
  ADD COLUMN IF NOT EXISTS pitfall TEXT;
