-- 003: problems/problem_staging 테이블에 교재 계층 FK 추가

-- problems 테이블에 교재 계층 FK 추가
ALTER TABLE problems ADD COLUMN IF NOT EXISTS textbook_id UUID REFERENCES textbooks(id);
ALTER TABLE problems ADD COLUMN IF NOT EXISTS chapter_id UUID REFERENCES chapters(id);
ALTER TABLE problems ADD COLUMN IF NOT EXISTS subchapter_id UUID REFERENCES subchapters(id);

-- problem_staging에도 동일 추가
ALTER TABLE problem_staging ADD COLUMN IF NOT EXISTS textbook_id UUID REFERENCES textbooks(id);
ALTER TABLE problem_staging ADD COLUMN IF NOT EXISTS chapter_id UUID REFERENCES chapters(id);
ALTER TABLE problem_staging ADD COLUMN IF NOT EXISTS page_start INTEGER;
ALTER TABLE problem_staging ADD COLUMN IF NOT EXISTS page_end INTEGER;

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_problems_textbook ON problems(textbook_id);
CREATE INDEX IF NOT EXISTS idx_problems_chapter ON problems(chapter_id);
CREATE INDEX IF NOT EXISTS idx_problems_subchapter ON problems(subchapter_id);
CREATE INDEX IF NOT EXISTS idx_staging_textbook ON problem_staging(textbook_id);
