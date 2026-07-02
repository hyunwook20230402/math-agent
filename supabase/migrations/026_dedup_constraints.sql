-- 026: 합성키 중복 방지 UNIQUE 제약 + 고아 데이터 정리
--
-- 배경(2026-07-02): profiles.user_id 중복 버그(025)와 같은 부류를 전수 조사한 결과,
--   "합성키를 .single() 로 조회하는데 해당 테이블에 UNIQUE 제약이 없어 중복 시 406" 위험이
--   3곳 더 발견됨(distribution_students, wrong_answers, profiles.email). 현재 실제 중복은 0건이나
--   profiles 처럼 언제든 터질 시한폭탄 → DB 차원 UNIQUE 로 근본 차단.
--   코드(shared/lib/api.ts)도 .single()→.maybeSingle() 로 함께 수정(별도).
--
-- 사전 실측(2026-07-02): 아래 세 조합 모두 현재 중복 0건 확인 → 제약 추가 안전.
--   problem_tags 는 problem_id=NULL 고아 267개(옛 태깅 파이프라인 버그 잔재, 화면 미사용) → 삭제.

-- 1) problem_tags 고아 삭제 — 부모 problem 없는 태그(problem_id NULL). 어디에도 안 쓰임.
DELETE FROM public.problem_tags WHERE problem_id IS NULL;

-- 2) 합성키 UNIQUE 제약 — "논리적으로 1행이어야 하는" 조합을 DB 가 강제.
ALTER TABLE public.distribution_students
  ADD CONSTRAINT uk_distribution_students UNIQUE (distribution_id, student_id);

ALTER TABLE public.wrong_answers
  ADD CONSTRAINT uk_wrong_answers_student_problem UNIQUE (student_id, problem_id);

-- 3) profiles.email UNIQUE — 이메일 중복 계정 방지(user_id 는 025 에서 이미 UNIQUE).
ALTER TABLE public.profiles
  ADD CONSTRAINT uk_profiles_email UNIQUE (email);
