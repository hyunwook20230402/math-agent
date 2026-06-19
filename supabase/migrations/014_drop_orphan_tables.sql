-- 014_drop_orphan_tables.sql
-- 고아 테이블 정리 (2026-06-20)
-- 코드 참조 0건 + 0행 + 들어오는 FK 없음 — 완전 무손실인 4개만 DROP.
--
-- 보류(이 마이그레이션에서 제외):
--   - tags: 시드 데이터 8행 존재(집합/인수분해/내신/기출/수능/쉬움/보통/어려움). problem_tags 로 대체됐으나
--           데이터가 있어 보존. (코드 참조·FK 없음 — 추후 확인 후 별도 DROP 가능)
--   - problem_sets_new: 살아있는 problems/distributions 가 FK 로 참조(참조 값은 0건). DROP 시 그 컬럼·제약
--           정리가 동반되므로 별도 마이그레이션으로 신중히.
DROP TABLE IF EXISTS learning_progress_snapshots CASCADE;
DROP TABLE IF EXISTS still_wrong_problems CASCADE;
DROP TABLE IF EXISTS distribution_problems CASCADE;
DROP TABLE IF EXISTS student_achievements CASCADE;
