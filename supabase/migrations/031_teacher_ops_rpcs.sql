-- 031_teacher_ops_rpcs.sql
-- 오답 조회 / 복습 예약 / 월간 보고서 집계 RPC
-- + 예약(미래) 배포가 진행률 통계를 오염시키던 것 차단 (2026-08-27)
--
-- 공통 원칙(022 계승):
--   - "최신 시도 기준" 상태 판정 = DISTINCT ON (…) ORDER BY submitted_at DESC
--   - 오답의 유일한 진실 원천은 student_answers. wrong_answers 는 정답 시 DELETE 로 이력이
--     소실되고 updated_at 컬럼이 없어 UPDATE 가 무음 실패하므로 여기서 절대 쓰지 않는다.
--   - RLS 비활성 프로젝트라 조회 RPC 는 권한을 강제하지 않는다(앱이 보장).
--     단 쓰기 RPC(create_review_distributions)는 사제 관계를 직접 확인한다.

-- ── 1) 학생 오답 목록 ───────────────────────────────────────────────
-- "얼마나·언제 생겼는지" = wrong_count / first_wrong_at / last_wrong_at
-- "지금도 틀린 상태인가" = is_still_wrong (최신 시도 기준)
--   상태를 파라미터로 안 받는 이유: 화면의 '전체/미해결' 토글이 재조회 없이 즉시 전환돼야 한다.
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
  attempts AS (
    SELECT s.problem_id, count(*) AS attempt_count FROM scoped s GROUP BY s.problem_id
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
    w.first_wrong_at, w.last_wrong_at, w.wrong_count, COALESCE(a.attempt_count, 0),
    (NOT l.is_correct), l.answer,
    d.id, d.title, d.distribution_date
  FROM wrongs w
  JOIN public.problems p ON p.id = w.problem_id
  JOIN latest l ON l.problem_id = w.problem_id
  LEFT JOIN attempts a ON a.problem_id = w.problem_id
  LEFT JOIN origin   o ON o.problem_id = w.problem_id
  LEFT JOIN public.distributions d ON d.id = o.distribution_id
  ORDER BY w.last_wrong_at DESC;
$$;

-- ── 2) 선생님 반 오답 현황 (오답 관리 좌측 학생 목록 — N+1 방지) ─────
DROP FUNCTION IF EXISTS public.get_teacher_wrong_answer_counts(uuid);
CREATE FUNCTION public.get_teacher_wrong_answer_counts(p_teacher_id uuid)
RETURNS TABLE (
  student_id uuid,
  student_name text,
  wrong_problems bigint,      -- 오답이 한 번이라도 난 문제 수
  still_wrong bigint,         -- 그 중 지금도 틀린 상태
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
  ever_wrong AS (
    SELECT sa.student_id, sa.problem_id, max(sa.submitted_at) AS last_wrong_at
    FROM public.student_answers sa
    WHERE sa.is_correct = false AND sa.student_id IN (SELECT id FROM my_students)
    GROUP BY sa.student_id, sa.problem_id
  )
  SELECT s.id, s.name,
         count(e.problem_id),
         count(e.problem_id) FILTER (WHERE l.is_correct = false),
         max(e.last_wrong_at)
  FROM my_students s
  LEFT JOIN ever_wrong e ON e.student_id = s.id
  LEFT JOIN latest     l ON l.student_id = s.id AND l.problem_id = e.problem_id
  GROUP BY s.id, s.name
  ORDER BY count(e.problem_id) FILTER (WHERE l.is_correct = false) DESC, s.name;
$$;

-- ── 3) 오답 복습 예약 생성 (한 트랜잭션) ─────────────────────────────
-- 클라이언트에서 주차마다 4번씩 INSERT 하면 중간 실패 시 "1주차만 있는 유령 예약"이 남는다.
-- supabase-js 에는 트랜잭션이 없으므로 RPC 한 방으로 원자화한다.
DROP FUNCTION IF EXISTS public.create_review_distributions(uuid, uuid, text, uuid[], date, int[], text, text, uuid);
CREATE FUNCTION public.create_review_distributions(
  p_teacher_id uuid,
  p_student_id uuid,
  p_student_name text,
  p_problem_ids uuid[],
  p_base_date date,
  p_weeks int[],
  p_start_time text DEFAULT '09:00',
  p_due_time   text DEFAULT '23:59',
  p_parent_distribution_id uuid DEFAULT NULL
)
RETURNS TABLE (
  distribution_id uuid,
  review_stage smallint,
  distribution_date timestamptz
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_ids     uuid[];
  v_count   int;
  v_week    int;
  v_target  date;
  v_start   timestamptz;
  v_due     timestamptz;
  v_set_id  uuid;
  v_dist_id uuid;
BEGIN
  -- 쓰기 RPC 라 사제 관계를 직접 확인한다(RLS 가 없어 이게 유일한 방어선).
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = p_student_id AND role = 'student' AND teacher_id = p_teacher_id
  ) THEN
    RAISE EXCEPTION '내 학생이 아닙니다';
  END IF;

  -- 같은 문제를 두 번 담으면 problem_set_items UNIQUE 에 걸린다 → 순서를 지키며 중복 제거
  SELECT array_agg(pid ORDER BY ord) INTO v_ids
  FROM (
    SELECT DISTINCT ON (u.pid) u.pid, u.ord
    FROM unnest(p_problem_ids) WITH ORDINALITY AS u(pid, ord)
    ORDER BY u.pid, u.ord
  ) s;

  v_count := COALESCE(array_length(v_ids, 1), 0);
  IF v_count = 0 THEN
    RAISE EXCEPTION '복습할 문제를 선택해주세요';
  END IF;
  IF COALESCE(array_length(p_weeks, 1), 0) = 0 THEN
    RAISE EXCEPTION '복습 주차를 선택해주세요';
  END IF;

  FOR v_week IN SELECT DISTINCT w FROM unnest(p_weeks) AS w ORDER BY 1
  LOOP
    v_target := p_base_date + (v_week * 7);
    v_start  := (v_target::text || ' ' || p_start_time || ':00')::timestamptz;
    v_due    := (v_target::text || ' ' || p_due_time   || ':00')::timestamptz;

    -- 1) 배포 전용 내부 세트 (folder_id=null → 교재 화면에 안 뜬다. 배포하기와 같은 규약)
    INSERT INTO public.problem_sets (name, description, folder_id, teacher_id, set_type)
    VALUES (
      format('[복습 %s주] %s %s', v_week, p_student_name, v_target),
      format('%s 오답 %s문제 복습', p_base_date, v_count),
      NULL, p_teacher_id, 'review'
    )
    RETURNING id INTO v_set_id;

    -- 2) 문제 담기 (선택 순서 유지)
    INSERT INTO public.problem_set_items (problem_set_id, problem_id, sort_order)
    SELECT v_set_id, u.pid, (u.ord - 1)::int
    FROM unnest(v_ids) WITH ORDINALITY AS u(pid, ord);

    PERFORM public.recalc_set_difficulty(v_set_id);

    -- 3) 배포 — 미래 시각이라 그날이 되어야 학생 화면에 뜬다(스케줄러 불필요)
    INSERT INTO public.distributions (
      title, problem_set_id, teacher_id, description,
      distribution_date, due_at, is_active, review_stage, parent_distribution_id
    )
    VALUES (
      format('[복습 %s주] 오답 %s문제', v_week, v_count),
      v_set_id, p_teacher_id,
      format('%s 기준 오답 복습 (%s주 후)', p_base_date, v_week),
      v_start, v_due, true, v_week::smallint, p_parent_distribution_id
    )
    RETURNING id INTO v_dist_id;

    -- 4) 학생 연결
    INSERT INTO public.distribution_students (distribution_id, student_id)
    VALUES (v_dist_id, p_student_id);

    RETURN QUERY SELECT v_dist_id, v_week::smallint, v_start;
  END LOOP;
END;
$$;

-- ── 4) 월간 배포 내역 (학습보고서 표) ────────────────────────────────
DROP FUNCTION IF EXISTS public.get_student_monthly_distributions(uuid, int, int);
CREATE FUNCTION public.get_student_monthly_distributions(p_student_id uuid, p_year int, p_month int)
RETURNS TABLE (
  distribution_id uuid,
  distribution_title text,
  distribution_date timestamptz,
  review_stage smallint,
  total_problems bigint,
  attempted bigint,
  correct bigint,
  accuracy numeric
)
LANGUAGE sql
STABLE
AS $$
  WITH bounds AS (
    SELECT make_timestamptz(p_year, p_month, 1, 0, 0, 0) AS s,
           (make_timestamptz(p_year, p_month, 1, 0, 0, 0) + interval '1 month') AS e
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
  SELECT d.id, d.title, d.distribution_date, d.review_stage,
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
  GROUP BY d.id, d.title, d.distribution_date, d.review_stage, ss.total_problems
  ORDER BY d.distribution_date ASC;
$$;

-- ── 5) 월간 보고서 요약 (배포+오답+출석 한 방) ───────────────────────
DROP FUNCTION IF EXISTS public.get_student_monthly_report(uuid, int, int);
CREATE FUNCTION public.get_student_monthly_report(p_student_id uuid, p_year int, p_month int)
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
    SELECT make_timestamptz(p_year, p_month, 1, 0, 0, 0) AS s,
           (make_timestamptz(p_year, p_month, 1, 0, 0, 0) + interval '1 month') AS e
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

-- ── 6) 오답 추이 (주 단위 — 학습보고서 차트) ─────────────────────────
-- 주의: 여기는 "최신 시도"가 아니라 제출 이벤트 하나하나를 센다. 추이는 "그 주에 얼마나
-- 틀렸나"를 보는 것이므로, 나중에 맞혔다고 그 주의 오답이 사라지면 그래프가 거짓말이 된다.
DROP FUNCTION IF EXISTS public.get_student_wrong_trend(uuid, date, date);
CREATE FUNCTION public.get_student_wrong_trend(p_student_id uuid, p_from date, p_to date)
RETURNS TABLE (bucket_start date, attempted bigint, wrong bigint, accuracy numeric)
LANGUAGE sql
STABLE
AS $$
  SELECT
    (date_trunc('week', sa.submitted_at))::date,
    count(*),
    count(*) FILTER (WHERE sa.is_correct = false),
    CASE WHEN count(*) > 0
      THEN round(100.0 * count(*) FILTER (WHERE sa.is_correct) / count(*), 1) ELSE 0 END
  FROM public.student_answers sa
  WHERE sa.student_id = p_student_id
    AND sa.submitted_at >= p_from::timestamptz
    AND sa.submitted_at <  (p_to + 1)::timestamptz
  GROUP BY 1
  ORDER BY 1;
$$;

-- ── 7) ★예약 배포가 진행률을 오염시키던 것 차단 (022/023 본문만 교체) ─
-- 시그니처 동일 → CREATE OR REPLACE 안전. 미래 배포(distribution_date > now())를 제외한다.
-- 이걸 안 하면 복습 3건을 예약하는 순간 "받은 총 문항"이 3배가 돼 진행률이 폭락한다.
CREATE OR REPLACE FUNCTION public.get_student_achievement(p_student_id uuid)
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
  set_size AS (
    SELECT d.id AS distribution_id, count(psi.problem_id) AS total_problems
    FROM public.distributions d
    JOIN public.distribution_students ds ON ds.distribution_id = d.id
    LEFT JOIN public.problem_set_items psi ON psi.problem_set_id = d.problem_set_id
    WHERE ds.student_id = p_student_id AND d.distribution_date <= now()
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
  WHERE d.distribution_date <= now()
  GROUP BY d.id, d.title, ss.total_problems
  ORDER BY d.distribution_date DESC NULLS LAST;
$$;

CREATE OR REPLACE FUNCTION public.get_teacher_class_progress(p_teacher_id uuid)
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
  assigned AS (
    SELECT ds.student_id, count(psi.problem_id) AS total_problems
    FROM public.distribution_students ds
    JOIN public.distributions d ON d.id = ds.distribution_id
    LEFT JOIN public.problem_set_items psi ON psi.problem_set_id = d.problem_set_id
    WHERE ds.student_id IN (SELECT id FROM my_students)
      AND d.distribution_date <= now()          -- ★예약 배포 제외
    GROUP BY ds.student_id
  ),
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

-- 반 요약의 "배포 건수"도 같은 이유로 미래 배포를 빼야 한다
-- (예약 3건이 곧바로 "배포 N건"으로 잡히면 대시보드 숫자가 틀린다).
CREATE OR REPLACE FUNCTION public.get_teacher_class_summary(p_teacher_id uuid)
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
    JOIN public.distributions d ON d.id = ds.distribution_id
    WHERE ds.student_id IN (SELECT id FROM my_students)
      AND d.distribution_date <= now()          -- ★예약 배포 제외
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
  ORDER BY (count(l.problem_id) = 0), 5 ASC, s.name;
$$;
