-- 015_drop_legacy_solution_fields.sql
-- 옛 해설 4필드 제거 (2026-06-20)
-- 풀이그래프 노드(solution_nodes)가 메인이 되면서 이 4필드는 코드·화면·튜터에서 폐기됨.
-- 의존 객체(인덱스·뷰·함수) 0개 확인. 60문제 중 30문제에 데이터가 있으나 기능상 무의미 → 그냥 삭제.
ALTER TABLE problems
  DROP COLUMN IF EXISTS solution_summary,
  DROP COLUMN IF EXISTS pitfall,
  DROP COLUMN IF EXISTS solution_steps,
  DROP COLUMN IF EXISTS common_mistakes;

ALTER TABLE problem_staging
  DROP COLUMN IF EXISTS solution_summary,
  DROP COLUMN IF EXISTS pitfall,
  DROP COLUMN IF EXISTS solution_steps,
  DROP COLUMN IF EXISTS common_mistakes;
