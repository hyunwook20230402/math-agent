-- 039_report_timezone.sql
-- 학습보고서·오답추이의 월/주 경계가 UTC 라 어긋나던 것 (2026-08-28)
--
-- 037 은 **쓰기** 쪽(배포 시각)을 Asia/Seoul 로 고쳤다. 이 파일은 **읽기** 쪽이다.
--
-- ⚠️ `make_timestamptz(y, m, 1, 0,0,0)` 은 시간대 인자가 없으면 **세션 시간대(UTC)** 로 읽는다.
--    → 9월 창이 `2026-09-01 00:00+00` = KST 09:00 에서 시작한다. 그런데 배포는 KST 자정
--    (`2026-08-31T15:00:00+00`)으로 저장되므로 **매달 1일 배포가 전달 보고서로 밀린다.**
--    같은 경계를 쓰는 답안 집계도 1일 00:00~08:59(KST) 제출을 전달로 샌다.
--    출석만 `make_date`(date 컬럼)라 정상이어서 한 보고서 안에서 기준 달이 서로 달랐다.
--    이 숫자는 monthly_reports.snapshot 에 박제돼 학부모 문자로 나간다.
--
-- ⚠️⚠️ **월 연산은 반드시 '날짜'에 먼저 한다.**
--    `make_timestamptz(..., 'Asia/Seoul') + interval '1 month'` 로 고치면 안 된다 —
--    그건 이미 UTC 인스턴트가 된 값에 **UTC 달력으로** 한 달을 더해 말일이 다른 달에서
--    어긋난다(실측: 2026-03 은 3일, 2026-02 는 3일 초과, 2026-09 는 하루 어긋남).
--    `make_date(...) + interval '1 month'` 로 **달력 위에서** 더한 뒤 Seoul 로 해석해야 한다.
--
-- ⚠️ `date_trunc('week', submitted_at)` 도 UTC 로 잘라 주 경계가 **월요일 KST 09:00** 이 된다.
--    → 등원 전·밤샘 제출(월요일 오전)이 지난주 막대로 합산된다. 조회 구간 `p_from::timestamptz`
--    도 date 를 UTC 자정으로 캐스팅해 창 전체가 9시간 밀린다(프론트는 로컬 날짜를 넘긴다).
--
-- 본문은 **각 함수의 최신 원문 그대로**이고, 아래만 바꾼다:
--   ① make_timestamptz(y,m,1,…)  → (make_date(y,m,1)::timestamp AT TIME ZONE 'Asia/Seoul')
--      끝 경계는 make_date 에 +1 month 한 뒤 같은 방식으로 해석
--   ② date_trunc('week', submitted_at)  → submitted_at AT TIME ZONE 'Asia/Seoul'
--   ③ p_from::timestamptz / (p_to+1)::…  → ::timestamp AT TIME ZONE 'Asia/Seoul'
--
-- 시그니처(인자·반환)는 원본과 동일 → CREATE OR REPLACE 안전. 데이터는 안 건드린다.

-- ── get_student_monthly_distributions (032 기준) ────────
CREATE OR REPLACE FUNCTION public.get_student_monthly_distributions(p_student_id uuid, p_year int, p_month int)
RETURNS TABLE (
  distribution_id uuid,
  distribution_title text,
  distribution_date timestamptz,
  review_stage smallint,
  review_kind text,
  total_problems bigint,
  attempted bigint,
  correct bigint,
  accuracy numeric
)
LANGUAGE sql
STABLE
AS $$
  WITH bounds AS (
    SELECT (make_date(p_year, p_month, 1)::timestamp AT TIME ZONE 'Asia/Seoul') AS s,
           ((make_date(p_year, p_month, 1) + interval '1 month')::timestamp AT TIME ZONE 'Asia/Seoul') AS e
  ),
  latest AS (
    SELECT DISTINCT ON (sa.distribution_id, sa.problem_id)
      sa.distribution_id, sa.problem_id, sa.is_correct
    FROM public.student_answers sa
    WHERE sa.student_id = p_student_id
    ORDER BY sa.distribution_id, sa.problem_id, sa.submitted_at DESC
  ),
  set_size AS (
    SELECT d.id AS distribution_id, count(psi.problem_id) AS total_problems
    FROM public.distributions d
    JOIN public.distribution_students ds ON ds.distribution_id = d.id AND ds.student_id = p_student_id
    LEFT JOIN public.problem_set_items psi ON psi.problem_set_id = d.problem_set_id
    GROUP BY d.id
  )
  SELECT d.id, d.title, d.distribution_date, d.review_stage, d.review_kind,
         COALESCE(ss.total_problems, 0),
         count(l.problem_id),
         count(l.problem_id) FILTER (WHERE l.is_correct),
         CASE WHEN count(l.problem_id) > 0
           THEN round(100.0 * count(l.problem_id) FILTER (WHERE l.is_correct) / count(l.problem_id), 1)
           ELSE 0 END
  FROM public.distributions d
  JOIN public.distribution_students ds ON ds.distribution_id = d.id AND ds.student_id = p_student_id
  CROSS JOIN bounds b
  LEFT JOIN set_size ss ON ss.distribution_id = d.id
  LEFT JOIN latest   l  ON l.distribution_id = d.id
  WHERE d.distribution_date >= b.s AND d.distribution_date < b.e
    AND d.distribution_date <= now()          -- 예약(미래) 배포는 보고서에 넣지 않는다
  GROUP BY d.id, d.title, d.distribution_date, d.review_stage, d.review_kind, ss.total_problems
  ORDER BY d.distribution_date ASC;
$$;

-- ── get_student_monthly_report (031 기준) ───────────────
CREATE OR REPLACE FUNCTION public.get_student_monthly_report(p_student_id uuid, p_year int, p_month int)
RETURNS TABLE (
  distributions_count bigint,
  assigned_problems bigint,
  attempted bigint,
  correct bigint,
  accuracy numeric,
  new_wrong_problems bigint,   -- 그 달에 오답이 난 문제 수(중복 제거)
  resolved_problems bigint,    -- 그 달 안에 오답 → 정답으로 뒤집은 문제 수
  attendance_total bigint,
  attendance_present bigint,
  attendance_late bigint,
  attendance_absent bigint,
  attendance_rate numeric      -- (출석+지각)/기록일 * 100
)
LANGUAGE sql
STABLE
AS $$
  WITH bounds AS (
    SELECT (make_date(p_year, p_month, 1)::timestamp AT TIME ZONE 'Asia/Seoul') AS s,
           ((make_date(p_year, p_month, 1) + interval '1 month')::timestamp AT TIME ZONE 'Asia/Seoul') AS e
  ),
  month_answers AS (
    SELECT sa.problem_id, sa.is_correct, sa.submitted_at
    FROM public.student_answers sa, bounds b
    WHERE sa.student_id = p_student_id AND sa.submitted_at >= b.s AND sa.submitted_at < b.e
  ),
  latest_in_month AS (
    SELECT DISTINCT ON (m.problem_id) m.problem_id, m.is_correct
    FROM month_answers m ORDER BY m.problem_id, m.submitted_at DESC
  ),
  dists AS (
    SELECT d.id, d.problem_set_id
    FROM public.distributions d
    JOIN public.distribution_students ds ON ds.distribution_id = d.id AND ds.student_id = p_student_id
    CROSS JOIN bounds b
    WHERE d.distribution_date >= b.s AND d.distribution_date < b.e AND d.distribution_date <= now()
  ),
  assigned AS (
    SELECT count(psi.problem_id) AS n
    FROM dists dd LEFT JOIN public.problem_set_items psi ON psi.problem_set_id = dd.problem_set_id
  ),
  att AS (
    SELECT
      count(*)                                     AS total,
      count(*) FILTER (WHERE a.status = 'present') AS present,
      count(*) FILTER (WHERE a.status = 'late')    AS late,
      count(*) FILTER (WHERE a.status = 'absent')  AS absent
    FROM public.attendance a
    WHERE a.student_id = p_student_id
      AND a.attendance_date >= make_date(p_year, p_month, 1)
      AND a.attendance_date <  (make_date(p_year, p_month, 1) + interval '1 month')
  )
  SELECT
    (SELECT count(*) FROM dists),
    (SELECT n FROM assigned),
    (SELECT count(*) FROM latest_in_month),
    (SELECT count(*) FROM latest_in_month WHERE is_correct),
    CASE WHEN (SELECT count(*) FROM latest_in_month) > 0
      THEN round(100.0 * (SELECT count(*) FROM latest_in_month WHERE is_correct)
                       / (SELECT count(*) FROM latest_in_month), 1)
      ELSE 0 END,
    (SELECT count(DISTINCT problem_id) FROM month_answers WHERE is_correct = false),
    (SELECT count(*) FROM latest_in_month l
      WHERE l.is_correct
        AND EXISTS (SELECT 1 FROM public.student_answers sa
                    WHERE sa.student_id = p_student_id AND sa.problem_id = l.problem_id
                      AND sa.is_correct = false)),
    a.total, a.present, a.late, a.absent,
    CASE WHEN a.total > 0 THEN round(100.0 * (a.present + a.late) / a.total, 1) ELSE 0 END
  FROM att a;
$$;

-- ── get_student_wrong_trend (031 기준) ──────────────────
CREATE OR REPLACE FUNCTION public.get_student_wrong_trend(p_student_id uuid, p_from date, p_to date)
RETURNS TABLE (bucket_start date, attempted bigint, wrong bigint, accuracy numeric)
LANGUAGE sql
STABLE
AS $$
  SELECT
    (date_trunc('week', sa.submitted_at AT TIME ZONE 'Asia/Seoul'))::date,
    count(*),
    count(*) FILTER (WHERE sa.is_correct = false),
    CASE WHEN count(*) > 0
      THEN round(100.0 * count(*) FILTER (WHERE sa.is_correct) / count(*), 1) ELSE 0 END
  FROM public.student_answers sa
  WHERE sa.student_id = p_student_id
    AND sa.submitted_at >= (p_from::timestamp AT TIME ZONE 'Asia/Seoul')
    AND sa.submitted_at <  ((p_to + 1)::timestamp AT TIME ZONE 'Asia/Seoul')
  GROUP BY 1
  ORDER BY 1;
$$;
