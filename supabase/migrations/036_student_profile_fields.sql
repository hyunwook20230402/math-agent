-- 036_student_profile_fields.sql
-- 학생 등록 정보 확장 — 반 이름 / 등록경로 / 등록이유 (2026-08-28)
--
-- 학생번호(student_phone)·학부모번호(parent_phone)·학교(school)·학년(grade)은 이미 있다(030).
-- 여기서 더하는 건 세 가지뿐이다.

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS class_name text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS enroll_source text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS enroll_source_note text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS enroll_reason text;

-- 등록경로는 **코드로 저장**하고 화면에서 한글 라벨로 보여준다(ENROLL_SOURCE_LABEL, api.ts).
-- 자유 입력이면 '인스타'·'인스타그램'·'insta' 가 섞여 나중에 "어느 경로로 몇 명 왔나" 를
-- 셀 수 없다. CHECK 로 오타를 막는 건 attendance.status·review_kind 와 같은 방식.
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS ck_profiles_enroll_source;
ALTER TABLE public.profiles
  ADD CONSTRAINT ck_profiles_enroll_source
  CHECK (enroll_source IS NULL OR enroll_source IN
    ('instagram', 'youtube', 'referral', 'blog', 'karrot', 'etc'));

COMMENT ON COLUMN public.profiles.class_name IS
  '반 이름(선택). 자유 문자열 — 화면에서는 이미 쓴 반 목록에서 고르거나 새로 친다.';
COMMENT ON COLUMN public.profiles.enroll_source IS
  '등록경로: instagram=인스타 / youtube=유튜브 / referral=지인소개 / blog=블로그 / karrot=당근마켓 / etc=기타';
COMMENT ON COLUMN public.profiles.enroll_source_note IS
  '등록경로 부연(기타를 골랐을 때의 실제 경로, 지인소개면 누가 소개했는지 등)';
COMMENT ON COLUMN public.profiles.enroll_reason IS
  '등록이유(자유 입력) — 내신 대비, 성적 하락, 선행 등';

-- 반 목록을 뽑을 때(선생님별 distinct class_name) 쓰는 인덱스.
-- 학생 수가 많지 않아 필수는 아니지만, 등록 화면이 열릴 때마다 도는 조회라 붙여 둔다.
CREATE INDEX IF NOT EXISTS idx_profiles_teacher_class
  ON public.profiles (teacher_id, class_name)
  WHERE role = 'student' AND class_name IS NOT NULL;
