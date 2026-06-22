-- 023_teacher_class_progress_rpc.sql
-- ============================================================================
-- 선생님 반 전체 학생의 "진행률"(배포 합산) + 정답률을 한 번에 반환.
--
-- 진행률 = 푼 총 문항 / 받은 총 문항 * 100 (전체 배포 합산).
--   - total_assigned : 학생이 받은 모든 배포의 문항 수 합 (distribution_students JOIN problem_set_items)
--   - total_attempted: 학생이 푼 문항 수 (최신 시도 기준, DISTINCT ON student+problem)
--   - progress_pct   : total_assigned=0 이면 0 (배포 없음 = 미시작), 아니면 attempted/assigned*100
--   - accuracy       : 정답 문항 / 푼 문항 * 100 (022 패턴과 동일)
--
-- 022_student_analytics_rpcs 의 CTE 패턴 재사용. 신규 시그니처라 DROP CASCADE 불필요.
-- RLS 비활성 프로젝트라 RPC 내부에서 teacher 권한을 강제하지 않는다(앱이 보장).
-- ============================================================================

DROP FUNCTION IF EXISTS public.get_teacher_class_progress(uuid);
CREATE FUNCTION public.get_teacher_class_progress(p_teacher_id uuid)
RETURNS TABLE (
  student_id uuid,
  student_name text,
  total_assigned bigint,
  total_attempted bigint,
  progress_pct numeric,
  correct bigint,
  accuracy numeric
)
LANGUAGE sql
STABLE
AS $$
  WITH my_students AS (
    SELECT id, name FROM public.profiles
    WHERE role = 'student' AND teacher_id = p_teacher_id
  ),
  -- 각 학생이 받은 총 문항 수 (배포된 problem_set_items 합)
  assigned AS (
    SELECT ds.student_id, count(psi.problem_id) AS total_problems
    FROM public.distribution_students ds
    JOIN public.distributions d ON d.id = ds.distribution_id
    LEFT JOIN public.problem_set_items psi ON psi.problem_set_id = d.problem_set_id
    WHERE ds.student_id IN (SELECT id FROM my_students)
    GROUP BY ds.student_id
  ),
  -- 문제별 최신 답안만 (재풀이는 마지막 제출 기준)
  latest AS (
    SELECT DISTINCT ON (sa.student_id, sa.problem_id)
      sa.student_id, sa.problem_id, sa.is_correct
    FROM public.student_answers sa
    WHERE sa.student_id IN (SELECT id FROM my_students)
    ORDER BY sa.student_id, sa.problem_id, sa.submitted_at DESC
  )
  SELECT
    s.id,
    s.name,
    COALESCE(asg.total_problems, 0),
    count(l.problem_id),
    CASE
      WHEN COALESCE(asg.total_problems, 0) = 0 THEN 0::numeric
      ELSE round(100.0 * count(l.problem_id) / asg.total_problems, 1)
    END,
    count(l.problem_id) FILTER (WHERE l.is_correct),
    CASE WHEN count(l.problem_id) > 0
      THEN round(100.0 * count(l.problem_id) FILTER (WHERE l.is_correct) / count(l.problem_id), 1)
      ELSE 0 END
  FROM my_students s
  LEFT JOIN assigned asg ON asg.student_id = s.id
  LEFT JOIN latest l ON l.student_id = s.id
  GROUP BY s.id, s.name, asg.total_problems
  ORDER BY s.name;
$$;
