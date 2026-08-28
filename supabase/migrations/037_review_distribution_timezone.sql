-- 037_review_distribution_timezone.sql
-- 복습 배포 시각이 9시간 늦게 저장되던 것 + 시각 의존 제거 (2026-08-28)
--
-- ⚠️ **naive 문자열을 timestamptz 로 캐스팅하면 DB 시간대(UTC)로 읽힌다.**
--    032 의 `(v_date::text || ' ' || p_start_time || ':00')::timestamptz` 는
--    '2026-08-30 00:00:00' 을 **00:00 UTC** 로 박는다 → 한국 시간으로는 **그날 오전 9시**.
--
--    실측(원본 배포에서 같은 원인으로 재현): 8/28 자 배포가 DB 에
--    `2026-08-28T00:00:00+00:00` = KST 8/28 09:00 으로 저장돼, KST 08:46 에 학생 화면이
--    "배포된 문제집 0개" 였다. 프론트 쪽 같은 버그는 DistributeProblemSet.tsx 에서
--    toISOString() 으로 고쳤고, 노출 판정 자체도 날짜 단위로 바꿨다(api.ts endOfTodayIso).
--
-- 이 파일이 바꾸는 것 — **본문은 032/035 원문 그대로**이고 아래만 다르다:
--   ① create_review_distributions: `::timestamptz` → `::timestamp AT TIME ZONE 'Asia/Seoul'`
--      "그 날짜의 그 시각(한국)" 이 정확히 저장된다. DB 시간대 설정과 무관해진다.
--   ② 시각 기본값 09:00 → 00:00 (create_review_distributions 기본값 +
--      auto_create_reviews_for_distribution 이 넘기는 하드코딩 값).
--      과제는 날짜 단위다 — 그날 0시부터 하루 종일 유효해야 SQL 쪽 `<= now()` 필터도 맞는다.
--
-- 시그니처(인자 타입·반환)는 032/035 와 동일 → CREATE OR REPLACE 안전(DROP 불필요).
-- 데이터는 건드리지 않는다. 여러 번 돌려도 결과가 같다.

-- ── ① 복습 배포 생성 (032 기준) ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_review_distributions(
  p_teacher_id uuid,
  p_student_id uuid,
  p_student_name text,
  p_problem_ids uuid[],
  p_stages jsonb,                 -- [{"stage":1,"kind":"homework","label":"숙제","date":"2026-08-28"}, …]
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

    v_start := (v_date::text || ' ' || p_start_time || ':00')::timestamp AT TIME ZONE 'Asia/Seoul';
    v_due   := (v_date::text || ' ' || p_due_time   || ':00')::timestamp AT TIME ZONE 'Asia/Seoul';

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

-- ── ② 자동 생성 래퍼 (035 기준) — 넘기는 시각만 00:00 으로 ──────────
CREATE OR REPLACE FUNCTION public.auto_create_reviews_for_distribution(
  p_distribution_id uuid,
  p_student_id uuid,
  p_stages jsonb                  -- [{"stage":2,"kind":"next_class","label":"다음 수업","date":"…"}, …]
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
  v_teacher_id   uuid;
  v_student_name text;
  v_ids          uuid[];
BEGIN
  -- ① 원본 배포이고, 그 학생에게 실제로 나간 배포인가.
  --    teacher_id 를 **배포에서 파생**하므로 클라이언트가 남의 학생에게 못 만든다.
  SELECT d.teacher_id INTO v_teacher_id
  FROM public.distributions d
  JOIN public.distribution_students ds
    ON ds.distribution_id = d.id AND ds.student_id = p_student_id
  WHERE d.id = p_distribution_id
    AND d.review_kind IS NULL;      -- 복습 배포를 풀었다고 또 복습을 만들지 않는다

  -- 학생 화면이 부르는 경로라 예외를 던지지 않는다 — 조용히 아무것도 안 한다.
  -- (제출 자체는 이미 성공했고, 못 만든 건 find_missing_review_batches 가 잡아낸다)
  IF v_teacher_id IS NULL THEN
    RETURN;
  END IF;

  -- ② 이미 만들었으면 그대로 돌려준다 (멱등 — 다시 눌러도, 보정이 겹쳐 돌아도 중복 없음)
  IF EXISTS (
    SELECT 1 FROM public.distributions c
    WHERE c.parent_distribution_id = p_distribution_id
      AND c.review_kind IN ('next_class', 'week2', 'week4')
  ) THEN
    RETURN QUERY
      SELECT c.id, c.review_stage, c.review_kind, c.distribution_date
      FROM public.distributions c
      WHERE c.parent_distribution_id = p_distribution_id
        AND c.review_kind IN ('next_class', 'week2', 'week4')
      ORDER BY c.distribution_date;
    RETURN;
  END IF;

  -- ③ **첫 시도 기준** 오답만 모은다.
  --    DISTINCT ON … ORDER BY submitted_at ASC 라, 나중에 당일 재풀이로 맞혀도 이 묶음은
  --    그대로다. 선생님 요구가 정확히 이것 — "처음 틀린 그 묶음을 3번 반복".
  --    (그래서 이 함수를 나중에 언제 불러도 같은 결과가 나온다.)
  SELECT array_agg(f.problem_id ORDER BY f.submitted_at, f.problem_id) INTO v_ids
  FROM (
    SELECT DISTINCT ON (sa.problem_id)
           sa.problem_id, sa.is_correct, sa.submitted_at
    FROM public.student_answers sa
    WHERE sa.distribution_id = p_distribution_id
      AND sa.student_id = p_student_id
    ORDER BY sa.problem_id, sa.submitted_at ASC
  ) f
  WHERE f.is_correct = false;

  IF COALESCE(array_length(v_ids, 1), 0) = 0 THEN
    RETURN;                          -- 다 맞았으면 만들 게 없다
  END IF;

  SELECT p.name INTO v_student_name FROM public.profiles p WHERE p.id = p_student_id;

  -- ④ 생성은 기존 원자 RPC 를 그대로 재사용한다(세트+문항+배포+학생연결 한 트랜잭션)
  RETURN QUERY
    SELECT * FROM public.create_review_distributions(
      v_teacher_id,
      p_student_id,
      COALESCE(v_student_name, '학생'),
      v_ids,
      p_stages,
      '00:00',
      '23:59',
      p_distribution_id
    );
END;
$$;

COMMENT ON FUNCTION public.create_review_distributions IS
  '오답 복습 배포를 한 트랜잭션으로 생성. 날짜는 프론트(reviewSchedule.ts)가 계산해 넘긴다. '
  '시각은 Asia/Seoul 로 해석 — naive 캐스팅은 UTC 로 읽혀 9시간 늦어진다(037).';
