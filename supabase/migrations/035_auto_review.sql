-- 035_auto_review.sql
-- 오답 복습 배포를 **자동 생성**한다 (2026-08-28)
--
-- 왜: 선생님 루틴은 정해져 있다 — 학원에 오면 무조건 1회 풀고, 그날 오답을 바로 다시 풀리고
-- 퇴원시킨 뒤 복습 컨텐츠를 준다. 정해진 일을 매번 손으로 누르는 게 문제고, 바쁘면 놓친다.
-- 그래서 학생이 과제를 다 풀어 자동 채점되는 순간 복습 배포 3개를 만든다.
--
--   1회차 처음 풀기      ← 원본 배포
--   2회차 당일 재풀이    ← 같은 원본 배포 안에서 오답만 (배포를 안 만든다)
--   3회차 다음 수업 (빨) ┐
--   4회차 2주      (주) ├ 여기서 자동 생성
--   5회차 4주      (노) ┘
--
-- 날짜는 프론트가 계산해 p_stages 로 넘긴다(월수금·화목토는 학원 운영 규칙이라 바뀔 수 있어
-- shared/lib/reviewSchedule.ts 에 둔다 — 032 와 같은 방침).

-- ── 1. 중복 방지는 DB 제약으로 ──────────────────────────────────────
-- 학생 클라이언트가 부르는 경로라 탭이 두 개면 동시에 들어올 수 있다. 코드의 EXISTS 검사만으로는
-- 경합에서 6개가 만들어질 수 있으므로 제약으로 못 박는다(db-conventions "합성키는 UNIQUE 와 짝").
-- ⚠️ 'makeup'(보충)은 같은 원본에 여러 번 나갈 수 있으므로 **자동 3종만** 대상으로 한다.
--
-- 손으로 예약하던 시절에 같은 원본으로 두 번 예약한 데이터가 있으면 인덱스 생성이 실패해
-- **이 마이그레이션 전체가 안 돈다**. 그건 과하므로 중복이 있으면 경고만 내고 넘어간다
-- (중복을 정리한 뒤 이 블록만 다시 돌리면 된다).
DO $$
DECLARE v_dupes int;
BEGIN
  SELECT count(*) INTO v_dupes FROM (
    SELECT d.parent_distribution_id, d.review_kind
    FROM public.distributions d
    WHERE d.parent_distribution_id IS NOT NULL
      AND d.review_kind IN ('next_class', 'week2', 'week4')
    GROUP BY 1, 2
    HAVING count(*) > 1
  ) x;

  IF v_dupes > 0 THEN
    RAISE WARNING '기존 중복 %건 때문에 uq_distributions_auto_review 를 건너뜁니다. 중복 정리 후 인덱스를 다시 만드세요.', v_dupes;
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS uq_distributions_auto_review
      ON public.distributions (parent_distribution_id, review_kind)
      WHERE parent_distribution_id IS NOT NULL
        AND review_kind IN ('next_class', 'week2', 'week4');
  END IF;
END $$;

-- ── 2. 자동 생성 ────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.auto_create_reviews_for_distribution(uuid, uuid, jsonb);

CREATE FUNCTION public.auto_create_reviews_for_distribution(
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
      '09:00',
      '23:59',
      p_distribution_id
    );
END;
$$;

COMMENT ON FUNCTION public.auto_create_reviews_for_distribution(uuid, uuid, jsonb) IS
  '학생이 원본 과제를 다 풀면 첫 시도 오답으로 복습 배포 3개(다음수업/2주/4주)를 만든다. 멱등.';

-- ── 3. 안전망 — 놓친 것 찾기 ────────────────────────────────────────
-- 학생 브라우저가 죽거나 오프라인이면 위 함수가 안 돈다. 선생님 화면에서 배너로 알리고
-- 한 번에 만들 수 있게 목록을 준다.
--
-- ⚠️ p_days 로 최근 것만 본다. 안 그러면 이 기능 이전의 **과거 배포가 통째로** 잡혀
-- "빠진 복습 47건" 같은 쓸모없는 배너가 뜬다.
DROP FUNCTION IF EXISTS public.find_missing_review_batches(uuid, int);

CREATE FUNCTION public.find_missing_review_batches(
  p_teacher_id uuid,
  p_days int DEFAULT 14
)
RETURNS TABLE (
  distribution_id uuid,
  distribution_title text,
  student_id uuid,
  student_name text,
  first_attempt_at timestamptz,
  wrong_count bigint
)
LANGUAGE sql
STABLE
AS $$
  WITH firsts AS (                  -- 배포×학생×문제의 첫 시도
    SELECT DISTINCT ON (sa.distribution_id, sa.student_id, sa.problem_id)
           sa.distribution_id, sa.student_id, sa.problem_id, sa.is_correct, sa.submitted_at
    FROM public.student_answers sa
    WHERE sa.distribution_id IS NOT NULL
      AND sa.submitted_at >= now() - make_interval(days => GREATEST(p_days, 1))
    ORDER BY sa.distribution_id, sa.student_id, sa.problem_id, sa.submitted_at ASC
  ),
  agg AS (
    SELECT f.distribution_id, f.student_id,
           count(*) FILTER (WHERE NOT f.is_correct) AS wrong_count,
           min(f.submitted_at) AS first_at
    FROM firsts f
    GROUP BY f.distribution_id, f.student_id
  )
  SELECT d.id, d.title, a.student_id, p.name, a.first_at, a.wrong_count
  FROM agg a
  JOIN public.distributions d ON d.id = a.distribution_id
  JOIN public.profiles p      ON p.id = a.student_id
  WHERE d.teacher_id = p_teacher_id
    AND d.review_kind IS NULL       -- 원본 배포만
    AND a.wrong_count > 0
    AND NOT EXISTS (
      SELECT 1 FROM public.distributions c
      WHERE c.parent_distribution_id = d.id
        AND c.review_kind IN ('next_class', 'week2', 'week4')
    )
  ORDER BY a.first_at DESC;
$$;

COMMENT ON FUNCTION public.find_missing_review_batches(uuid, int) IS
  '최근 p_days 안에 학생이 풀어 오답이 났는데 복습 배포 3개가 안 만들어진 원본 배포 목록.';
