-- problem_staging에 bbox 편집 + 재학습용 컬럼 추가
ALTER TABLE problem_staging
  ADD COLUMN IF NOT EXISTS bbox JSONB,
  ADD COLUMN IF NOT EXISTS source_page_image_url TEXT,
  ADD COLUMN IF NOT EXISTS page_number INT;
