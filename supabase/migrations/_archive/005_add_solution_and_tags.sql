-- 005: 해설지 파이프라인 + AI 태그 자동 추출 지원
-- 이미 일부 테이블/컬럼이 존재해도 안전하게 재실행 가능하도록 구성

-- 1) problem_staging / problems 에 해설 관련 컬럼 추가
ALTER TABLE problem_staging
  ADD COLUMN IF NOT EXISTS solution_image_url text,
  ADD COLUMN IF NOT EXISTS solution_summary text,
  ADD COLUMN IF NOT EXISTS solution_job_id uuid,
  ADD COLUMN IF NOT EXISTS match_confidence real;

ALTER TABLE problems
  ADD COLUMN IF NOT EXISTS solution_image_url text,
  ADD COLUMN IF NOT EXISTS solution_summary text;

-- 2) problem_tags 테이블이 없으면 최소 구조로만 생성 (id + created_at)
CREATE TABLE IF NOT EXISTS problem_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz DEFAULT now()
);

-- 3) problem_tags에 필요한 컬럼을 ALTER로 보강
--    (기존 테이블 구조가 어떻든 최신 스키마로 맞춰짐)
ALTER TABLE problem_tags
  ADD COLUMN IF NOT EXISTS tag text,
  ADD COLUMN IF NOT EXISTS tag_type text,
  ADD COLUMN IF NOT EXISTS problem_id uuid REFERENCES problems(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS staging_id uuid REFERENCES problem_staging(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS confidence real DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS source text DEFAULT 'ai';

-- 4) tag / tag_type NOT NULL 및 CHECK 제약 (기존 NULL 데이터 없을 때만 적용)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_problem_tags_tag_type'
  ) THEN
    ALTER TABLE problem_tags
      ADD CONSTRAINT chk_problem_tags_tag_type
      CHECK (tag_type IN ('concept', 'skill'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_problem_tags_source'
  ) THEN
    ALTER TABLE problem_tags
      ADD CONSTRAINT chk_problem_tags_source
      CHECK (source IN ('ai', 'manual'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_problem_tags_has_ref'
  ) THEN
    ALTER TABLE problem_tags
      ADD CONSTRAINT chk_problem_tags_has_ref
      CHECK (problem_id IS NOT NULL OR staging_id IS NOT NULL);
  END IF;
END $$;

-- 5) 인덱스 (컬럼이 보장된 뒤에 생성)
CREATE INDEX IF NOT EXISTS idx_problem_tags_problem ON problem_tags(problem_id);
CREATE INDEX IF NOT EXISTS idx_problem_tags_staging ON problem_tags(staging_id);
CREATE INDEX IF NOT EXISTS idx_problem_tags_tag ON problem_tags(tag, tag_type);

-- 6) 해설지 job 관리 테이블
CREATE TABLE IF NOT EXISTS solution_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  problem_job_id uuid,           -- 연결된 문제 job (nullable: 나중에 연결 가능)
  teacher_id uuid NOT NULL,
  pdf_path text,
  status text DEFAULT 'pending', -- pending / extracting / tagging / done / error
  progress jsonb DEFAULT '{}'::jsonb,
  error text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_solution_jobs_teacher ON solution_jobs(teacher_id);
CREATE INDEX IF NOT EXISTS idx_solution_jobs_problem_job ON solution_jobs(problem_job_id);
