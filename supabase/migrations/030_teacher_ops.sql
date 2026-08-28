-- 030_teacher_ops.sql
-- 선생님 운영 기능(출석·문자·학습보고서·오답 복습) 기반 테이블 (2026-08-27)
--
-- 새 조인/1행보장 테이블은 처음부터 UNIQUE 를 건다
-- (db-conventions: profiles.user_id 중복 21개로 로그인이 통째로 깨진 사고와 같은 부류).
-- 모든 FK 는 profiles.id 참조 — auth.users.id 직접 사용 금지.

-- ── 1. 연락처 (학부모 문자 발송의 전제) ─────────────────────────────
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS parent_phone  text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS student_phone text;

COMMENT ON COLUMN public.profiles.parent_phone  IS '학부모 휴대폰(숫자만, 예 01012345678). 문자 발송 기본 수신처.';
COMMENT ON COLUMN public.profiles.student_phone IS '학생 본인 휴대폰(숫자만). 선택 입력.';
-- CHECK 는 걸지 않는다: 집전화·해외번호·미입력 학생을 막으면 학생 등록 자체가 실패한다.
-- 정규화(숫자만 남김)는 앱이, 형식 검증은 백엔드가 발송 직전에 한다.

-- ── 2. 출석 (날짜별 1일 1회) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.attendance (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id      uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  teacher_id      uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  attendance_date date NOT NULL,
  status          text NOT NULL CHECK (status IN ('present','late','absent')),
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- "한 학생 하루 1행" — upsert(onConflict) 가 이 제약에 걸린다.
-- 없으면 중복이 쌓여 어느 날 maybeSingle 조회가 통째로 깨진다.
ALTER TABLE public.attendance DROP CONSTRAINT IF EXISTS uk_attendance_student_date;
ALTER TABLE public.attendance
  ADD CONSTRAINT uk_attendance_student_date UNIQUE (student_id, attendance_date);

CREATE INDEX IF NOT EXISTS idx_attendance_teacher_date ON public.attendance (teacher_id, attendance_date);
CREATE INDEX IF NOT EXISTS idx_attendance_student_date ON public.attendance (student_id, attendance_date DESC);

DROP TRIGGER IF EXISTS update_attendance_updated_at ON public.attendance;
CREATE TRIGGER update_attendance_updated_at
  BEFORE UPDATE ON public.attendance
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ── 3. 문자 발송 로그 (append-only — UNIQUE 없음이 정상) ─────────────
CREATE TABLE IF NOT EXISTS public.message_logs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id          uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  student_id          uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  batch_id            uuid NOT NULL,
  recipient_kind      text NOT NULL DEFAULT 'parent' CHECK (recipient_kind IN ('parent','student')),
  recipient_phone     text NOT NULL,
  message_type        text NOT NULL CHECK (message_type IN ('notice','attendance','report')),
  body                text NOT NULL,
  status              text NOT NULL CHECK (status IN ('sent','failed','mock','skipped')),
  provider            text NOT NULL DEFAULT 'solapi',
  provider_message_id text,
  error               text,
  sent_at             timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN public.message_logs.status IS
  'sent=실제 발송 / failed=발송 실패 / mock=솔라피 키 미설정 상태의 모의발송(문자 안 나감) / skipped=번호 미등록';

CREATE INDEX IF NOT EXISTS idx_message_logs_teacher_sent ON public.message_logs (teacher_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_message_logs_student      ON public.message_logs (student_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_message_logs_batch        ON public.message_logs (batch_id);

-- ── 4. 월간 학습보고서 (학생×월 1행) ────────────────────────────────
CREATE TABLE IF NOT EXISTS public.monthly_reports (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  teacher_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  year       int  NOT NULL CHECK (year BETWEEN 2000 AND 2200),
  month      int  NOT NULL CHECK (month BETWEEN 1 AND 12),
  feedback   text NOT NULL DEFAULT '',
  sms_body   text,
  snapshot   jsonb NOT NULL DEFAULT '{}'::jsonb,
  sent_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN public.monthly_reports.snapshot IS
  '저장 버튼을 누른 시점의 집계(배포수/정답률/오답/출석). 나중에 학생이 재풀이해 수치가 바뀌어도 "그때 학부모에게 보낸 보고서"가 흔들리지 않게 박제한다.';
COMMENT ON COLUMN public.monthly_reports.sent_at IS 'NULL = 아직 학부모에게 문자 미발송';

ALTER TABLE public.monthly_reports DROP CONSTRAINT IF EXISTS uk_monthly_reports_student_year_month;
ALTER TABLE public.monthly_reports
  ADD CONSTRAINT uk_monthly_reports_student_year_month UNIQUE (student_id, year, month);

CREATE INDEX IF NOT EXISTS idx_monthly_reports_teacher ON public.monthly_reports (teacher_id, year DESC, month DESC);

DROP TRIGGER IF EXISTS update_monthly_reports_updated_at ON public.monthly_reports;
CREATE TRIGGER update_monthly_reports_updated_at
  BEFORE UPDATE ON public.monthly_reports
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ── 5. 배포 복습 계보 ───────────────────────────────────────────────
ALTER TABLE public.distributions
  ADD COLUMN IF NOT EXISTS parent_distribution_id uuid REFERENCES public.distributions(id) ON DELETE SET NULL;
ALTER TABLE public.distributions
  ADD COLUMN IF NOT EXISTS review_stage smallint;

-- CASCADE 가 아니라 SET NULL 인 이유: 원본 배포를 지웠다고 예약된 복습까지 조용히 사라지면
-- 선생님은 "예약했는데 안 나갔다"를 사고 난 뒤에야 안다. 복습은 자기 problem_set 을 따로 갖는다.
ALTER TABLE public.distributions DROP CONSTRAINT IF EXISTS ck_distributions_review_stage;
ALTER TABLE public.distributions
  ADD CONSTRAINT ck_distributions_review_stage
  CHECK (review_stage IS NULL OR (review_stage BETWEEN 1 AND 52));

COMMENT ON COLUMN public.distributions.review_stage IS
  'NULL=일반 배포. 1/2/4=오답 복습 N주차(값 자체가 주 수 — 나중에 3주·8주를 추가해도 스키마 변경 불필요).';

CREATE INDEX IF NOT EXISTS idx_distributions_parent ON public.distributions (parent_distribution_id);
CREATE INDEX IF NOT EXISTS idx_distributions_review_date
  ON public.distributions (review_stage, distribution_date) WHERE review_stage IS NOT NULL;

-- ── 6. student_answers 인덱스 (현재 전무 — 오답 RPC 가 풀스캔) ────────
-- ① DISTINCT ON (student_id, problem_id) ORDER BY submitted_at DESC 와 정확히 같은 순서
CREATE INDEX IF NOT EXISTS idx_student_answers_student_problem_submitted
  ON public.student_answers (student_id, problem_id, submitted_at DESC);
-- ② 기간 필터(월간 보고서·오답 추이)
CREATE INDEX IF NOT EXISTS idx_student_answers_student_submitted
  ON public.student_answers (student_id, submitted_at DESC);
-- ③ 배포별 답안 조회(학생 대시보드가 배포마다 1회씩 부른다)
CREATE INDEX IF NOT EXISTS idx_student_answers_distribution
  ON public.student_answers (distribution_id);
-- CONCURRENTLY 는 쓰지 않는다: 마이그레이션이 트랜잭션 안에서 돌아 실패한다.
