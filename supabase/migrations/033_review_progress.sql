-- 033_review_progress.sql
-- "한 번 틀린 문제는 무조건 총 5회 푼다"를 시스템이 보장하도록 (2026-08-27)
--
-- 문제 인식: 예약은 날짜에 못이 박혀 있는데 학원 현실엔 결석·숙제 미이행·보강이 있다.
--   회차를 거르면 그냥 안 푼 채로 지나가고, **아무도 몇 번 풀었는지 안 세고 있었다**.
--   (예약 4건이 같은 문제 목록을 담고 있어 이월 자체는 되지만, 5회 보장은 안 된다.)
--
-- 해결 방향: 날짜가 아니라 **횟수**를 추적한다.
--   ① 문제별 전체 시도 횟수(total_attempts)를 내려 화면에 "3/5" 로 보여주고
--   ② 5회 미달 학생 수(under_target)를 선생님이 알아채게 하고
--   ③ 빈 회차는 'makeup'(보충) 배포로 아무 때나 메운다.

-- ── 1. 보충 배포 종류 추가 ──────────────────────────────────────────
-- 결석·보강으로 회차가 비었을 때 선생님이 날짜 하나만 골라 즉시 내보내는 통로.
ALTER TABLE public.distributions DROP CONSTRAINT IF EXISTS ck_distributions_review_kind;
ALTER TABLE public.distributions
  ADD CONSTRAINT ck_distributions_review_kind
  CHECK (review_kind IS NULL OR review_kind IN ('homework', 'next_class', 'week2', 'week4', 'makeup'));

COMMENT ON COLUMN public.distributions.review_kind IS
  'NULL=일반 배포. homework=숙제(+1일) / next_class=다음 수업(월수금·화목토 격일) / week2=2주 / week4=4주 / makeup=보충(결석·보강으로 빈 회차 메우기)';

-- ── 2. 오답 목록에 "전체 시도 횟수" 추가 ────────────────────────────
-- 기존 attempt_count 는 p_from/p_to 안의 시도만 센다. 진행도(n/5)에 그걸 쓰면
-- "최근 3개월" 로 보는 순간 실제 3/5 가 1/5 로 보인다 → 기간과 무관한 total_attempts 를 따로 센다.
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
  all_attempts AS (                 -- ★기간 무관 전체 시도 수 = 진행도(n/5)의 근거
    SELECT sa.problem_id, count(*) AS total_attempts
    FROM public.student_answers sa
    WHERE sa.student_id = p_student_id
    GROUP BY sa.problem_id
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
    (NOT l.is_correct), l.answer,
    d.id, d.title, d.distribution_date
  FROM wrongs w
  JOIN public.problems p ON p.id = w.problem_id
  JOIN latest l ON l.problem_id = w.problem_id
  LEFT JOIN attempts     a  ON a.problem_id  = w.problem_id
  LEFT JOIN all_attempts aa ON aa.problem_id = w.problem_id
  LEFT JOIN origin       o  ON o.problem_id  = w.problem_id
  LEFT JOIN public.distributions d ON d.id = o.distribution_id
  ORDER BY w.last_wrong_at DESC;
$$;

-- ── 3. 반 오답 현황에 "5회 미달" 추가 ───────────────────────────────
-- 결석·숙제 미이행으로 회차가 빈 학생을 선생님이 알아채는 유일한 신호다.
-- 목표 회차는 인자로 받아 프론트 상수(REVIEW_TARGET_ROUNDS)와 맞춘다.
DROP FUNCTION IF EXISTS public.get_teacher_wrong_answer_counts(uuid);
DROP FUNCTION IF EXISTS public.get_teacher_wrong_answer_counts(uuid, int);
CREATE FUNCTION public.get_teacher_wrong_answer_counts(
  p_teacher_id uuid,
  p_target int DEFAULT 5
)
RETURNS TABLE (
  student_id uuid,
  student_name text,
  wrong_problems bigint,      -- 오답이 한 번이라도 난 문제 수
  still_wrong bigint,         -- 그 중 지금도 틀린 상태
  under_target bigint,        -- 그 중 아직 목표 회차를 못 채운 문제 수
  last_wrong_at timestamptz
)
LANGUAGE sql
STABLE
AS $$
  WITH my_students AS (
    SELECT id, name FROM public.profiles
    WHERE role = 'student' AND teacher_id = p_teacher_id
  ),
  latest AS (
    SELECT DISTINCT ON (sa.student_id, sa.problem_id) sa.student_id, sa.problem_id, sa.is_correct
    FROM public.student_answers sa
    WHERE sa.student_id IN (SELECT id FROM my_students)
    ORDER BY sa.student_id, sa.problem_id, sa.submitted_at DESC
  ),
  attempts AS (
    SELECT sa.student_id, sa.problem_id, count(*) AS total_attempts
    FROM public.student_answers sa
    WHERE sa.student_id IN (SELECT id FROM my_students)
    GROUP BY sa.student_id, sa.problem_id
  ),
  ever_wrong AS (
    SELECT sa.student_id, sa.problem_id, max(sa.submitted_at) AS last_wrong_at
    FROM public.student_answers sa
    WHERE sa.is_correct = false AND sa.student_id IN (SELECT id FROM my_students)
    GROUP BY sa.student_id, sa.problem_id
  )
  SELECT s.id, s.name,
         count(e.problem_id),
         count(e.problem_id) FILTER (WHERE l.is_correct = false),
         count(e.problem_id) FILTER (WHERE COALESCE(at.total_attempts, 0) < p_target),
         max(e.last_wrong_at)
  FROM my_students s
  LEFT JOIN ever_wrong e  ON e.student_id  = s.id
  LEFT JOIN latest     l  ON l.student_id  = s.id AND l.problem_id = e.problem_id
  LEFT JOIN attempts   at ON at.student_id = s.id AND at.problem_id = e.problem_id
  GROUP BY s.id, s.name
  ORDER BY count(e.problem_id) FILTER (WHERE COALESCE(at.total_attempts, 0) < p_target) DESC, s.name;
$$;
