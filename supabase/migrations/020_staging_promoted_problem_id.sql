-- 020: problem_staging 에 promoted_problem_id 백링크 추가 (2026-06-22)
--
-- 배경: 상세입력 화면(ProblemDetail)은 problem_staging 을 다루는데, 승격된 problems.id 를
--   몰라서 풀이 노드 편집기를 못 연다. 승격 시 problems.id 를 staging 에 저장해 백링크를 만든다.
--
-- FK 는 ON DELETE SET NULL — problems 삭제해도 staging 은 남고 링크만 끊긴다.

ALTER TABLE public.problem_staging
  ADD COLUMN IF NOT EXISTS promoted_problem_id UUID
    REFERENCES public.problems(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_problem_staging_promoted_problem_id
  ON public.problem_staging (promoted_problem_id);

-- 이미 승격된 staging 백필: problem_number + job_id 로 problems 역조회.
-- (problems.source_info->>'job_id' 에 problem_job_id 가 들어있음)
UPDATE public.problem_staging ps
SET promoted_problem_id = p.id
FROM public.problems p
WHERE ps.promoted_to_problems = TRUE
  AND ps.promoted_problem_id IS NULL
  AND ps.problem_number = p.problem_number
  AND ps.job_id = (p.source_info->>'job_id')::uuid;
