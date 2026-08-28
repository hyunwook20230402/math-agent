-- 034_review_timeline.sql
-- 오답 표를 "회차 타임라인"으로 — 5칸에 날짜를 찍기 위한 데이터 (2026-08-27)
--
-- 진행도 n/5 만으로는 부족하다는 요구: **몇 번 풀었나뿐 아니라 언제 풀었나·언제 풀 차례인가**가
-- 같이 보여야 한다(교재 빠른정답지의 #1~#5 칸처럼). 총 5회를 채우는 것만큼 **날짜 간격**이 중요.
--
-- 화면이 각 칸을 채우는 우선순위: 실제로 푼 날 > 예약된 배포 날짜 > 계산된 예상일.
-- 예상일 계산(월수금·화목토 격일 규칙, 밀렸을 때 rolling)은 프론트
-- shared/lib/reviewSchedule.ts 가 담당한다 — 학원 운영 규칙이라 바뀔 수 있어서.

DROP FUNCTION IF EXISTS public.get_student_wrong_answers(uuid, timestamptz, timestamptz);
CREATE FUNCTION public.get_student_wrong_answers(
  p_student_id uuid,
  p_from timestamptz DEFAULT NULL,
  p_to   timestamptz DEFAULT NULL
)
RETURNS TABLE (
  problem_id uuid,
  problem_title text,
  problem_number integer,
  source_label text,
  unit text,
  difficulty text,
  image_url text,
  correct_answer text,
  answer_type text,
  choices jsonb,
  first_wrong_at timestamptz,
  last_wrong_at timestamptz,
  wrong_count bigint,
  attempt_count bigint,
  total_attempts bigint,
  attempt_dates timestamptz[],
  attempt_results boolean[],
  scheduled jsonb,
  is_still_wrong boolean,
  last_answer text,
  origin_distribution_id uuid,
  origin_distribution_title text,
  origin_distribution_date timestamptz
)
LANGUAGE sql
STABLE
AS $$
  WITH scoped AS (
    SELECT sa.problem_id, sa.is_correct, sa.answer, sa.submitted_at, sa.distribution_id
    FROM public.student_answers sa
    WHERE sa.student_id = p_student_id
      AND (p_from IS NULL OR sa.submitted_at >= p_from)
      AND (p_to   IS NULL OR sa.submitted_at <  p_to)
  ),
  latest AS (                       -- 문제별 최신 시도 = 현재 상태
    SELECT DISTINCT ON (s.problem_id) s.problem_id, s.is_correct, s.answer
    FROM scoped s
    ORDER BY s.problem_id, s.submitted_at DESC
  ),
  wrongs AS (                       -- 오답 이력 집계
    SELECT s.problem_id,
           min(s.submitted_at) AS first_wrong_at,
           max(s.submitted_at) AS last_wrong_at,
           count(*)            AS wrong_count
    FROM scoped s
    WHERE s.is_correct = false
    GROUP BY s.problem_id
  ),
  attempts AS (                     -- 기간 내 시도 수(기존 호환)
    SELECT s.problem_id, count(*) AS attempt_count FROM scoped s GROUP BY s.problem_id
  ),
  -- ★기간 무관 전체 시도. 회차 타임라인의 근거 —
  --   두 배열은 같은 ORDER BY 로 뽑아야 i번째끼리 짝이 맞는다.
  all_attempts AS (
    SELECT sa.problem_id,
           count(*)                                                AS total_attempts,
           array_agg(sa.submitted_at ORDER BY sa.submitted_at)      AS attempt_dates,
           array_agg(sa.is_correct   ORDER BY sa.submitted_at)      AS attempt_results
    FROM public.student_answers sa
    WHERE sa.student_id = p_student_id
    GROUP BY sa.problem_id
  ),
  -- 이 학생에게 걸린 **아직 시작 안 된 복습 예약**을 문제별로 모은다.
  -- 선생님이 달력에서 날짜를 옮겼으면 그게 진실이므로 계산된 예상일보다 우선한다.
  sched AS (
    SELECT psi.problem_id,
           jsonb_agg(
             jsonb_build_object(
               'distribution_id', d.id,
               'stage', d.review_stage,
               'kind',  d.review_kind,
               'date',  d.distribution_date
             ) ORDER BY d.distribution_date
           ) AS scheduled
    FROM public.distributions d
    JOIN public.distribution_students ds
      ON ds.distribution_id = d.id AND ds.student_id = p_student_id
    JOIN public.problem_set_items psi ON psi.problem_set_id = d.problem_set_id
    WHERE d.review_kind IS NOT NULL
      AND d.distribution_date > now()
    GROUP BY psi.problem_id
  ),
  origin AS (                       -- 최초 오답이 난 배포 = 이 오답의 출처
    SELECT DISTINCT ON (s.problem_id) s.problem_id, s.distribution_id
    FROM scoped s
    WHERE s.is_correct = false
    ORDER BY s.problem_id, s.submitted_at ASC
  )
  SELECT
    w.problem_id, p.title, p.problem_number, p.source_label, p.unit, p.difficulty::text,
    p.image_url, p.correct_answer, p.answer_type, p.choices,
    w.first_wrong_at, w.last_wrong_at, w.wrong_count,
    COALESCE(a.attempt_count, 0), COALESCE(aa.total_attempts, 0),
    COALESCE(aa.attempt_dates, ARRAY[]::timestamptz[]),
    COALESCE(aa.attempt_results, ARRAY[]::boolean[]),
    COALESCE(sc.scheduled, '[]'::jsonb),
    (NOT l.is_correct), l.answer,
    d.id, d.title, d.distribution_date
  FROM wrongs w
  JOIN public.problems p ON p.id = w.problem_id
  JOIN latest l ON l.problem_id = w.problem_id
  LEFT JOIN attempts     a  ON a.problem_id  = w.problem_id
  LEFT JOIN all_attempts aa ON aa.problem_id = w.problem_id
  LEFT JOIN sched        sc ON sc.problem_id = w.problem_id
  LEFT JOIN origin       o  ON o.problem_id  = w.problem_id
  LEFT JOIN public.distributions d ON d.id = o.distribution_id
  ORDER BY w.last_wrong_at DESC;
$$;
