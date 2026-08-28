-- 032_review_stages.sql
-- 오답 복습 주기 재설계: 1·2·4주 → 숙제 / 다음수업 / 2주 / 4주 (2026-08-27)
--
-- 실제 운영은 "처음 풀기 + 오답 4회 = 총 5회" 다:
--   당일(선생님이 직접 배포) → 숙제(+1일) → 다음 수업 → 2주 → 4주
-- 자동 예약이 담당하는 건 뒤 4개다. 1주는 쓰지 않는다.
--
-- ★ 날짜 계산은 DB 가 아니라 프론트에서 한다.
--   "다음 수업날" 은 월수금 / 화목토 격일반이라는 **학원 운영 규칙**이라 바뀔 수 있고,
--   예약 모달이 날짜를 미리 보여줘야 한다. RPC 는 받은 날짜대로 만들기만 하므로
--   규칙이 바뀌어도 이 마이그레이션을 다시 쓸 일이 없다.

-- ── 1. 복습 종류 ────────────────────────────────────────────────────
ALTER TABLE public.distributions ADD COLUMN IF NOT EXISTS review_kind text;

ALTER TABLE public.distributions DROP CONSTRAINT IF EXISTS ck_distributions_review_kind;
ALTER TABLE public.distributions
  ADD CONSTRAINT ck_distributions_review_kind
  CHECK (review_kind IS NULL OR review_kind IN ('homework', 'next_class', 'week2', 'week4'));

COMMENT ON COLUMN public.distributions.review_kind IS
  'NULL=일반 배포. homework=숙제(+1일) / next_class=다음 수업(월수금·화목토 격일) / week2=2주 / week4=4주';

-- review_stage 의미 재정의: "주 수" → "회차 1~4".
-- 기존 CHECK(1~52) 를 그대로 통과하므로 제약은 손대지 않는다.
-- (1차 테스트 데이터는 이미 정리돼 실데이터 0건 — 재정의해도 깨질 행이 없다.)
COMMENT ON COLUMN public.distributions.review_stage IS
  'NULL=일반 배포. 1~4=오답 복습 회차(1 숙제 / 2 다음수업 / 3 2주 / 4 4주). 종류는 review_kind 참조.';

CREATE INDEX IF NOT EXISTS idx_distributions_review_kind
  ON public.distributions (review_kind) WHERE review_kind IS NOT NULL;

-- ── 2. 복습 예약 생성 RPC 교체 ──────────────────────────────────────
-- 옛 시그니처(p_weeks int[]) 는 더 이상 쓰지 않는다 → 먼저 DROP.
DROP FUNCTION IF EXISTS public.create_review_distributions(uuid, uuid, text, uuid[], date, int[], text, text, uuid);
DROP FUNCTION IF EXISTS public.create_review_distributions(uuid, uuid, text, uuid[], jsonb, text, text, uuid);

CREATE FUNCTION public.create_review_distributions(
  p_teacher_id uuid,
  p_student_id uuid,
  p_student_name text,
  p_problem_ids uuid[],
  p_stages jsonb,                 -- [{"stage":1,"kind":"homework","label":"숙제","date":"2026-08-28"}, …]
  p_start_time text DEFAULT '09:00',
  p_due_time   text DEFAULT '23:59',
  p_parent_distribution_id uuid DEFAULT NULL
)
RETURNS TABLE (
  distribution_id uuid,
  review_stage smallint,
  review_kind text,
  distribution_date timestamptz
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_ids     uuid[];
  v_count   int;
  v_stage   jsonb;
  v_no      int;
  v_kind    text;
  v_label   text;
  v_date    date;
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
  IF p_stages IS NULL OR jsonb_array_length(p_stages) = 0 THEN
    RAISE EXCEPTION '복습 단계를 선택해주세요';
  END IF;

  FOR v_stage IN SELECT * FROM jsonb_array_elements(p_stages)
  LOOP
    v_no    := (v_stage ->> 'stage')::int;
    v_kind  := v_stage ->> 'kind';
    v_label := COALESCE(v_stage ->> 'label', v_kind);
    v_date  := (v_stage ->> 'date')::date;

    IF v_date IS NULL THEN
      RAISE EXCEPTION '복습 날짜가 비어 있습니다(kind=%)', v_kind;
    END IF;

    v_start := (v_date::text || ' ' || p_start_time || ':00')::timestamptz;
    v_due   := (v_date::text || ' ' || p_due_time   || ':00')::timestamptz;

    -- 1) 배포 전용 내부 세트 (folder_id=null → 교재 화면에 안 뜬다. 배포하기와 같은 규약)
    INSERT INTO public.problem_sets (name, description, folder_id, teacher_id, set_type)
    VALUES (
      format('[복습 %s] %s %s', v_label, p_student_name, v_date),
      format('오답 %s문제 복습', v_count),
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
      distribution_date, due_at, is_active,
      review_stage, review_kind, parent_distribution_id
    )
    VALUES (
      format('[복습 %s] 오답 %s문제', v_label, v_count),
      v_set_id, p_teacher_id,
      format('오답 복습 — %s', v_label),
      v_start, v_due, true,
      v_no::smallint, v_kind, p_parent_distribution_id
    )
    RETURNING id INTO v_dist_id;

    -- 4) 학생 연결
    INSERT INTO public.distribution_students (distribution_id, student_id)
    VALUES (v_dist_id, p_student_id);

    RETURN QUERY SELECT v_dist_id, v_no::smallint, v_kind, v_start;
  END LOOP;
END;
$$;

-- ── 3. 월간 배포 내역에 review_kind 노출 ────────────────────────────
-- 안 하면 학습보고서 배포표 배지가 회차 숫자를 주 수로 오해해 "복습 1주"(실제는 숙제)로 찍힌다.
DROP FUNCTION IF EXISTS public.get_student_monthly_distributions(uuid, int, int);
CREATE FUNCTION public.get_student_monthly_distributions(p_student_id uuid, p_year int, p_month int)
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
