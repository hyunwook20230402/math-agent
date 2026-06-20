-- 016_drop_problem_sets_new_and_tags.sql
-- problem_sets_new(미사용, 빈 테이블)·tags(옛 시드) 정리 (2026-06-20)
-- problem_sets_new 를 가리키던 빈 FK 컬럼 3개(전부 값 0건)를 떼고 테이블 DROP.
-- 보존: distributions.problem_set_id(현역 problem_sets 가리킴, 8행 사용 중) — 절대 안 건드림.
--
-- 주의: RLS 비활성이라 동작 안 하지만 죽은 정책 4개가 제거 대상 컬럼/테이블에 의존 →
--       정책을 먼저 명시 DROP 해야 컬럼/테이블 DROP 가능.

-- 0) 죽은 RLS 정책 4개 먼저 제거
DROP POLICY IF EXISTS "Students can view problems in new problem sets" ON problems;
DROP POLICY IF EXISTS "Authenticated users can manage problem sets new" ON problem_sets_new;
DROP POLICY IF EXISTS "Authenticated users can view all problem sets new" ON problem_sets_new;
DROP POLICY IF EXISTS "Students can view problem sets in their distributions new" ON problem_sets_new;

-- 1) problem_sets_new 를 가리키는 빈 FK 컬럼 제거 (제약도 같이 사라짐)
ALTER TABLE problems DROP COLUMN IF EXISTS problem_set_id;       -- 이름과 달리 problem_sets_new 가리킴
ALTER TABLE problems DROP COLUMN IF EXISTS problem_set_new_id;
ALTER TABLE distributions DROP COLUMN IF EXISTS problem_set_new_id;

-- 2) 이제 참조 없는 problem_sets_new DROP
DROP TABLE IF EXISTS problem_sets_new CASCADE;

-- 3) 옛 태그 시드 tags DROP (코드·FK 참조 없음)
DROP TABLE IF EXISTS tags CASCADE;
