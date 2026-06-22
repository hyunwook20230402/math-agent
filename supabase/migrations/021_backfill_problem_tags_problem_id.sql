-- 021_backfill_problem_tags_problem_id.sql
-- ============================================================================
-- problem_tags 백필: staging_id 로만 저장된 AI 태그를 승격된 problem_id 로 복사.
--
-- 배경: 해설/문제 태깅 파이프라인은 problem_tags 를 staging_id 기준으로만 저장한다.
--   승격(approve_to_problems)이 태그를 problems 로 옮기지 않아 problem_tags.problem_id 가
--   전부 NULL → 학생 취약점 분석(student_answers ⨝ problem_tags.problem_id)이 불가능했다.
--   (2026-06-22 실측: 267행 전부 staging_id 만, problem_id 0개.)
--
-- 이 마이그레이션은 promoted_problem_id 백링크가 있는 staging 의 태그를 problem_id 로 복사한다.
-- 앞으로의 승격은 코드(_copy_tags_staging_to_problem)가 자동 처리하므로 이 백필은 1회성.
--
-- 멱등: 동일 (problem_id, tag, tag_type) 가 이미 있으면 건너뛴다. 재실행 안전.
-- ============================================================================

INSERT INTO public.problem_tags (problem_id, tag, tag_type, confidence, source)
SELECT
  ps.promoted_problem_id,
  pt.tag,
  pt.tag_type,
  pt.confidence,
  pt.source
FROM public.problem_tags pt
JOIN public.problem_staging ps ON pt.staging_id = ps.id
WHERE ps.promoted_problem_id IS NOT NULL
  AND pt.problem_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.problem_tags x
    WHERE x.problem_id = ps.promoted_problem_id
      AND x.tag = pt.tag
      AND x.tag_type = pt.tag_type
  );
