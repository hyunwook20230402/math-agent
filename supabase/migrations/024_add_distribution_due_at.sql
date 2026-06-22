-- 024_add_distribution_due_at.sql
-- ============================================================================
-- 배포 마감 시각 컬럼 추가.
--   - distribution_date(TIMESTAMPTZ)는 "배포 시작 시각"으로 사용(시각까지 저장).
--   - due_at(TIMESTAMPTZ)은 "배포 마감 시각". 기존 행 호환 위해 NULL 허용.
-- ============================================================================

ALTER TABLE public.distributions
  ADD COLUMN IF NOT EXISTS due_at TIMESTAMP WITH TIME ZONE;
