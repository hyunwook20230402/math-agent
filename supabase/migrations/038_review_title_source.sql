-- 038_review_title_source.sql
-- 복습 배포 제목에 **출처 컨텐츠**를 넣는다 (2026-08-28)
--
-- 왜: 지금은 `[복습 다음 수업] 오답 8문제` 라 학생에게 쌓이면 어느 교재 무슨 단원인지 모른다.
--     선생님 지적 그대로 — "쎈 나머지정리와 인수분해인지 rpm 나머지정리와 인수분해인지
--     구별을 내가 못 하자나". 원본 배포 제목이 이미
--     `쎈_공통수학1_B,C단계 > B단계 > 나머지정리와 인수분해` 형식(프론트 buildContentTitle)이므로
--     그걸 그대로 물고 간다.
--
--     바뀌는 제목:
--       전  `[복습 다음 수업] 오답 8문제`
--       후  `[복습 다음 수업] 쎈_공통수학1_B,C단계 > B단계 > 나머지정리와 인수분해 (8문제)`
--
-- 출처는 `p_parent_distribution_id` 로 찾는다 — 인자를 안 늘려도 되고(시그니처 동일 →
-- CREATE OR REPLACE 안전), 자동 생성·수동 예약·보충이 전부 같은 경로를 탄다.
-- 계보가 없으면(여러 배포에서 모은 오답) 예전 형식으로 떨어진다.
--
-- 037 대비 달라진 곳은 v_source 조회와 title 조립 두 군데뿐이다. 나머지는 원문 그대로.

CREATE OR REPLACE FUNCTION public.create_review_distributions(
  p_teacher_id uuid,
  p_student_id uuid,
  p_student_name text,
  p_problem_ids uuid[],
  p_stages jsonb,
  p_start_time text DEFAULT '00:00',
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
  v_source  text := NULL;    -- ★출처 컨텐츠 이름(원본 배포 제목)
  v_title   text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = p_student_id AND role = 'student' AND teacher_id = p_teacher_id
  ) THEN
    RAISE EXCEPTION '내 학생이 아닙니다';
  END IF;

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

  -- ★출처 제목. 이미 '[복습 …]' 이 붙은 제목이면 벗겨서 중첩을 막는다
  --   (복습의 복습이 만들어져도 '[복습 2주] [복습 다음 수업] …' 이 되지 않게).
  IF p_parent_distribution_id IS NOT NULL THEN
    SELECT d.title INTO v_source
    FROM public.distributions d
    WHERE d.id = p_parent_distribution_id;
    v_source := NULLIF(btrim(regexp_replace(COALESCE(v_source, ''), '^\[[^\]]*\]\s*', '')), '');
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

    -- 시각은 Asia/Seoul 로 해석 — naive 캐스팅은 UTC 로 읽혀 9시간 늦어진다(037)
    v_start := (v_date::text || ' ' || p_start_time || ':00')::timestamp AT TIME ZONE 'Asia/Seoul';
    v_due   := (v_date::text || ' ' || p_due_time   || ':00')::timestamp AT TIME ZONE 'Asia/Seoul';

    v_title := CASE
      WHEN v_source IS NOT NULL THEN format('[복습 %s] %s (%s문제)', v_label, v_source, v_count)
      ELSE format('[복습 %s] 오답 %s문제', v_label, v_count)
    END;

    -- 1) 배포 전용 내부 세트 (folder_id=null → 교재 화면에 안 뜬다)
    INSERT INTO public.problem_sets (name, description, folder_id, teacher_id, set_type)
    VALUES (
      format('[복습 %s] %s %s', v_label, p_student_name, v_date),
      COALESCE(v_source, format('오답 %s문제 복습', v_count)),
      NULL, p_teacher_id, 'review'
    )
    RETURNING id INTO v_set_id;

    -- 2) 문제 담기 (선택 순서 유지)
    INSERT INTO public.problem_set_items (problem_set_id, problem_id, sort_order)
    SELECT v_set_id, u.pid, (u.ord - 1)::int
    FROM unnest(v_ids) WITH ORDINALITY AS u(pid, ord);

    PERFORM public.recalc_set_difficulty(v_set_id);

    -- 3) 배포
    INSERT INTO public.distributions (
      title, problem_set_id, teacher_id, description,
      distribution_date, due_at, is_active,
      review_stage, review_kind, parent_distribution_id
    )
    VALUES (
      v_title,
      v_set_id, p_teacher_id,
      COALESCE(v_source, format('오답 복습 — %s', v_label)),
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

COMMENT ON FUNCTION public.create_review_distributions IS
  '오답 복습 배포를 한 트랜잭션으로 생성. 날짜는 프론트(reviewSchedule.ts)가 계산해 넘긴다. '
  '시각은 Asia/Seoul(037). 제목은 원본 배포 제목(교재 > 폴더 경로)을 물고 간다(038).';
