-- 022_student_analytics_rpcs.sql
-- ============================================================================
-- 학생 성취도/취약점 분석용 RPC 3종.
--
-- 공통 원칙:
--   - "최신 시도 기준" 집계. 같은 (student, problem) 을 여러 번 풀면 마지막 제출만 센다
--     (재풀이로 맞히면 맞은 것으로). DISTINCT ON (problem_id) ... ORDER BY submitted_at DESC.
--   - 정답률 = 정답 수 / 시도한(최신) 문제 수 * 100 (소수1자리).
--   - RLS 비활성 프로젝트라 RPC 내부에서 teacher 권한을 강제하지 않는다(앱이 보장).
--
-- 기존 RPC 없음 → CREATE OR REPLACE 안전(시그니처 신규).
-- ============================================================================

-- 학생의 "문제별 최신 답안" 헬퍼 뷰 대신, 각 함수 내부에서 CTE 로 처리(뷰 남발 방지).

-- ── 1) 성취도: 전체 + 배포별 ────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.get_student_achievement(uuid);
CREATE FUNCTION public.get_student_achievement(p_student_id uuid)
RETURNS TABLE (
  distribution_id uuid,
  distribution_title text,
  total_problems bigint,
  attempted bigint,
  correct bigint,
  accuracy numeric
)
LANGUAGE sql
STABLE
AS $$
  WITH latest AS (
    SELECT DISTINCT ON (sa.distribution_id, sa.problem_id)
      sa.distribution_id, sa.problem_id, sa.is_correct
    FROM public.student_answers sa
    WHERE sa.student_id = p_student_id
    ORDER BY sa.distribution_id, sa.problem_id, sa.submitted_at DESC
  ),
  -- 배포별 총 문제 수(problem_set_items 기준)
  set_size AS (
    SELECT d.id AS distribution_id, count(psi.problem_id) AS total_problems
    FROM public.distributions d
    JOIN public.distribution_students ds ON ds.distribution_id = d.id
    LEFT JOIN public.problem_set_items psi ON psi.problem_set_id = d.problem_set_id
    WHERE ds.student_id = p_student_id
    GROUP BY d.id
  )
  SELECT
    d.id,
    d.title,
    COALESCE(ss.total_problems, 0),
    count(l.problem_id),
    count(l.problem_id) FILTER (WHERE l.is_correct),
    CASE WHEN count(l.problem_id) > 0
      THEN round(100.0 * count(l.problem_id) FILTER (WHERE l.is_correct) / count(l.problem_id), 1)
      ELSE 0 END
  FROM public.distributions d
  JOIN public.distribution_students ds ON ds.distribution_id = d.id AND ds.student_id = p_student_id
  LEFT JOIN set_size ss ON ss.distribution_id = d.id
  LEFT JOIN latest l ON l.distribution_id = d.id
  GROUP BY d.id, d.title, ss.total_problems
  ORDER BY d.distribution_date DESC NULLS LAST;
$$;

-- ── 2) 취약점: unit / difficulty / concept / skill 별 정답률 ─────────────────
-- dimension 으로 묶어 한 함수에서 반환(프론트가 dimension 별로 필터). 임계값 이하만.
DROP FUNCTION IF EXISTS public.get_student_weaknesses(uuid, numeric);
CREATE FUNCTION public.get_student_weaknesses(p_student_id uuid, p_threshold numeric DEFAULT 50)
RETURNS TABLE (
  dimension text,   -- 'unit' | 'difficulty' | 'concept' | 'skill'
  label text,
  total bigint,
  correct bigint,
  accuracy numeric
)
LANGUAGE sql
STABLE
AS $$
  WITH latest AS (
    SELECT DISTINCT ON (sa.problem_id)
      sa.problem_id, sa.is_correct
    FROM public.student_answers sa
    WHERE sa.student_id = p_student_id
    ORDER BY sa.problem_id, sa.submitted_at DESC
  ),
  by_unit AS (
    SELECT 'unit'::text AS dimension, COALESCE(p.unit, '미분류') AS label,
           count(*) AS total, count(*) FILTER (WHERE l.is_correct) AS correct
    FROM latest l JOIN public.problems p ON p.id = l.problem_id
    GROUP BY COALESCE(p.unit, '미분류')
  ),
  by_diff AS (
    SELECT 'difficulty'::text AS dimension, COALESCE(p.difficulty, 'unknown') AS label,
           count(*) AS total, count(*) FILTER (WHERE l.is_correct) AS correct
    FROM latest l JOIN public.problems p ON p.id = l.problem_id
    GROUP BY COALESCE(p.difficulty, 'unknown')
  ),
  by_tag AS (
    SELECT pt.tag_type AS dimension, pt.tag AS label,
           count(*) AS total, count(*) FILTER (WHERE l.is_correct) AS correct
    FROM latest l
    JOIN public.problem_tags pt ON pt.problem_id = l.problem_id
    WHERE pt.tag_type IN ('concept', 'skill')
    GROUP BY pt.tag_type, pt.tag
  ),
  unioned AS (
    SELECT * FROM by_unit
    UNION ALL SELECT * FROM by_diff
    UNION ALL SELECT * FROM by_tag
  )
  SELECT
    dimension, label, total, correct,
    round(100.0 * correct / total, 1) AS accuracy
  FROM unioned
  WHERE total > 0
    AND round(100.0 * correct / total, 1) <= p_threshold
  ORDER BY accuracy ASC, total DESC;
$$;

-- ── 3) 반 전체 요약 ─────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.get_teacher_class_summary(uuid);
CREATE FUNCTION public.get_teacher_class_summary(p_teacher_id uuid)
RETURNS TABLE (
  student_id uuid,
  student_name text,
  attempted bigint,
  correct bigint,
  accuracy numeric,
  distributions_count bigint
)
LANGUAGE sql
STABLE
AS $$
  WITH my_students AS (
    SELECT id, name FROM public.profiles
    WHERE role = 'student' AND teacher_id = p_teacher_id
  ),
  latest AS (
    SELECT DISTINCT ON (sa.student_id, sa.problem_id)
      sa.student_id, sa.problem_id, sa.is_correct
    FROM public.student_answers sa
    WHERE sa.student_id IN (SELECT id FROM my_students)
    ORDER BY sa.student_id, sa.problem_id, sa.submitted_at DESC
  ),
  dist_count AS (
    SELECT ds.student_id, count(DISTINCT ds.distribution_id) AS cnt
    FROM public.distribution_students ds
    WHERE ds.student_id IN (SELECT id FROM my_students)
    GROUP BY ds.student_id
  )
  SELECT
    s.id, s.name,
    count(l.problem_id),
    count(l.problem_id) FILTER (WHERE l.is_correct),
    CASE WHEN count(l.problem_id) > 0
      THEN round(100.0 * count(l.problem_id) FILTER (WHERE l.is_correct) / count(l.problem_id), 1)
      ELSE 0 END,
    COALESCE(max(dc.cnt), 0)
  FROM my_students s
  LEFT JOIN latest l ON l.student_id = s.id
  LEFT JOIN dist_count dc ON dc.student_id = s.id
  GROUP BY s.id, s.name
  -- 풀이 없는 학생(attempted=0)은 뒤로, 그 외엔 정답률 낮은 순
  ORDER BY (count(l.problem_id) = 0), 5 ASC, s.name;
$$;
