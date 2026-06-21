-- 019: problem_staging 에 promoted_to_problems 플래그 추가 (2026-06-21)
--
-- 배경: approve_to_problems 가 멱등성이 없어, approve-all 이 여러 번 호출되면 같은 문제가
--   problems 에 중복 INSERT 됐다(26년 30문제가 90개로). 이 플래그로 "이미 problems 로 승격됨"
--   을 표시하고, approve 는 FALSE 인 것만 INSERT 한다.
--
-- 기존 행은 DEFAULT FALSE. 컬럼 추가뿐이라 GENERATED·제약 변경 없음.

ALTER TABLE public.problem_staging
  ADD COLUMN IF NOT EXISTS promoted_to_problems BOOLEAN NOT NULL DEFAULT FALSE;

-- approve 쿼리(job_id + promoted=FALSE 조회) 최적화용 부분 인덱스
CREATE INDEX IF NOT EXISTS idx_problem_staging_promoted_job
  ON public.problem_staging (job_id)
  WHERE promoted_to_problems = FALSE;
