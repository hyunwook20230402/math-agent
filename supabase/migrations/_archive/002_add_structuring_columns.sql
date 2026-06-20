-- DeepTutor 대비: problems 테이블에 구조화 컬럼 추가
-- Supabase SQL Editor에서 실행하세요

-- 1. pgvector 확장 활성화 (Supabase 대시보드 > Database > Extensions 에서 먼저 활성화 필요)
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. problems 테이블에 구조화 컬럼 추가
ALTER TABLE problems ADD COLUMN IF NOT EXISTS problem_text TEXT;
ALTER TABLE problems ADD COLUMN IF NOT EXISTS problem_latex TEXT;
ALTER TABLE problems ADD COLUMN IF NOT EXISTS topic_tags TEXT[];
ALTER TABLE problems ADD COLUMN IF NOT EXISTS source_info JSONB;
ALTER TABLE problems ADD COLUMN IF NOT EXISTS structuring_status TEXT DEFAULT 'pending'
  CHECK (structuring_status IN ('pending', 'processing', 'done', 'failed'));
ALTER TABLE problems ADD COLUMN IF NOT EXISTS embedding vector(1024);

-- 3. problem_staging 테이블에 category 컬럼 추가 (approve 시 problems로 전달용)
ALTER TABLE problem_staging ADD COLUMN IF NOT EXISTS category TEXT;

-- 4. 인덱스
CREATE INDEX IF NOT EXISTS idx_problems_embedding
  ON problems USING ivfflat (embedding vector_cosine_ops) WITH (lists = 20);

CREATE INDEX IF NOT EXISTS idx_problems_structuring_status
  ON problems(structuring_status);
