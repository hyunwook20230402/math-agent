-- 0단계: DB 정리 마이그레이션
-- Supabase SQL Editor에서 실행하세요

-- 1. problems.image_url 컬럼을 nullable로 변경
ALTER TABLE public.problems
  ALTER COLUMN image_url DROP NOT NULL;

-- 2. difficulty 컬럼에 CHECK 제약 추가 (기존 데이터 정리 후 실행)
-- 먼저 기존 숫자 데이터를 easy/medium/hard로 변환
UPDATE public.problems
SET difficulty = CASE
  WHEN difficulty ~ '^\d+$' THEN
    CASE
      WHEN difficulty::int <= 2 THEN 'easy'
      WHEN difficulty::int >= 4 THEN 'hard'
      ELSE 'medium'
    END
  ELSE difficulty
END
WHERE difficulty NOT IN ('easy', 'medium', 'hard');

-- 그 후 CHECK 제약 추가
ALTER TABLE public.problems
  ADD CONSTRAINT problems_difficulty_check
  CHECK (difficulty IN ('easy', 'medium', 'hard'));

-- 3. problem_staging 테이블 생성 (자동화 파이프라인용 검수 테이블)
CREATE TABLE IF NOT EXISTS public.problem_staging (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id UUID NOT NULL,
  teacher_id UUID NOT NULL REFERENCES profiles(id),
  problem_number INTEGER,
  title TEXT,
  unit TEXT,
  difficulty TEXT CHECK (difficulty IN ('easy', 'medium', 'hard')),
  answer_type TEXT CHECK (answer_type IN ('multiple_choice', 'short_answer')),
  correct_answer TEXT,
  choices JSONB,
  explanation TEXT,
  problem_text TEXT,
  source_image_url TEXT,
  source_pdf TEXT,
  source_page INTEGER,
  confidence FLOAT DEFAULT 0,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'modified')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- problem_staging 인덱스
CREATE INDEX IF NOT EXISTS idx_problem_staging_job_id ON public.problem_staging(job_id);
CREATE INDEX IF NOT EXISTS idx_problem_staging_teacher_id ON public.problem_staging(teacher_id);
CREATE INDEX IF NOT EXISTS idx_problem_staging_status ON public.problem_staging(status);
