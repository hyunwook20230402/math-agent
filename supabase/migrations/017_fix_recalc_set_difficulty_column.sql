-- 017_fix_recalc_set_difficulty_column.sql
-- recalc_set_difficulty 버그 수정 (2026-06-20)
-- problem_set_items 에 없는 set_id 를 참조하던 것을 올바른 컬럼 problem_set_id 로.
-- 이 버그로 세트 난이도 자동 재계산이 실행 시 에러나 동작 안 하던 것을 복구.
-- (baseline_20260620.sql 에는 수정본이 반영됨. 이 파일은 baseline 이후의 첫 변경 기록.)
CREATE OR REPLACE FUNCTION public.recalc_set_difficulty(p_set_id uuid)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
BEGIN
  UPDATE problem_sets ps
  SET
    difficulty_score_avg = sub.avg_score,
    difficulty_score_p75 = sub.p75_score,
    difficulty_score_max = sub.max_score
  FROM (
    SELECT
      ROUND(AVG(p.difficulty_score))::INT AS avg_score,
      PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY p.difficulty_score)::INT AS p75_score,
      MAX(p.difficulty_score) AS max_score
    FROM problem_set_items psi
    JOIN problems p ON p.id = psi.problem_id
    WHERE psi.problem_set_id = p_set_id
  ) sub
  WHERE ps.id = p_set_id;
END;
$function$;
