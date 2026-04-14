-- 003: 해설지 파이프라인 + AI 태그 자동 추출 지원
-- problem_staging에 해설 컬럼 추가
ALTER TABLE problem_staging
  ADD COLUMN IF NOT EXISTS solution_image_url text,
  ADD COLUMN IF NOT EXISTS solution_summary text,
  ADD COLUMN IF NOT EXISTS solution_job_id uuid,
  ADD COLUMN IF NOT EXISTS match_confidence real;

-- problems에 해설 컬럼 추가
ALTER TABLE problems
  ADD COLUMN IF NOT EXISTS solution_image_url text,
  ADD COLUMN IF NOT EXISTS solution_summary text;

-- 태그 정규화 테이블 (staging/problems 양쪽 참조)
CREATE TABLE IF NOT EXISTS problem_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  problem_id uuid REFERENCES problems(id) ON DELETE CASCADE,
  staging_id uuid REFERENCES problem_staging(id) ON DELETE CASCADE,
  tag text NOT NULL,
  tag_type text NOT NULL CHECK (tag_type IN ('concept', 'skill')),
  confidence real DEFAULT 1.0,
  source text DEFAULT 'ai' CHECK (source IN ('ai', 'manual')),
  created_at timestamptz DEFAULT now()
);

-- problem_id 또는 staging_id 둘 중 하나는 있어야 함
ALTER TABLE problem_tags
  ADD CONSTRAINT chk_problem_tags_has_ref
  CHECK (problem_id IS NOT NULL OR staging_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_problem_tags_problem ON problem_tags(problem_id);
CREATE INDEX IF NOT EXISTS idx_problem_tags_staging ON problem_tags(staging_id);
CREATE INDEX IF NOT EXISTS idx_problem_tags_tag ON problem_tags(tag, tag_type);

-- 해설지 job 관리 테이블
CREATE TABLE IF NOT EXISTS solution_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  problem_job_id uuid,           -- 연결된 문제 job (nullable: 나중에 연결 가능)
  teacher_id uuid NOT NULL,
  pdf_path text,
  status text DEFAULT 'pending', -- pending / extracting / tagging / done / error
  progress jsonb DEFAULT '{}'::jsonb,  -- {processed, total, current_number}
  error text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_solution_jobs_teacher ON solution_jobs(teacher_id);
CREATE INDEX IF NOT EXISTS idx_solution_jobs_problem_job ON solution_jobs(problem_job_id);
