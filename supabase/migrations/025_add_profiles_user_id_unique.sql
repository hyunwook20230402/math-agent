-- 025: profiles.user_id 에 UNIQUE 제약 추가 (프로필 중복 생성 근본 차단)
--
-- 배경(2026-07-01): 한 auth 유저에 profiles 행이 여러 개 중복 생성되는 버그 발견.
--   원인 ① DB 에 user_id UNIQUE 제약 없음(baseline 누락) — 무한 중복 가능.
--        ② useAuth.ensureProfile 이 .single() 조회 406(중복) 을 감지 못해 계속 insert(악순환).
--   증상: profiles 조회 .single() 이 406(다중 행) 반환 → 학생 로그인/배포 데이터 조회 실패.
--
-- 이 제약으로 코드 버그가 있어도 DB 가 두 번째 insert 를 거부한다(근본 방어).
-- 사전 조건: 중복 행은 이미 정리됨(참조 없는 중복 삭제, user_id 별 1행만 남김).
--
-- handle_new_user() 트리거가 회원가입 시 자동 insert 하므로, 클라이언트측 중복 insert 는
-- ON CONFLICT 로 무시되게 useAuth 를 함께 수정(별도 커밋).

ALTER TABLE public.profiles
  ADD CONSTRAINT uk_profiles_user_id UNIQUE (user_id);
