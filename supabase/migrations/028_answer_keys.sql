-- 028_answer_keys.sql
-- 빠른정답 PDF 로 정답을 자동 입력하기 위한 두 가지 (2026-08-27)
--
-- 문제: 크롭한 문제 120개의 정답을 하나씩 손으로 넣고 있다. 교재의 빠른정답 PDF 에
--   0001~0776 정답이 다 들어 있는데도 쓰지 못한다. 이유는 두 가지다.
--     ① staging 에는 순번(problem_number=1..120)만 있고 **지면에 인쇄된 번호**(0243)가
--        없어서, 정답표의 번호와 맞출 방법이 없다.
--     ② 읽어 둔 정답을 보관할 곳이 없어 단원마다 PDF 를 다시 읽어야 한다.
--
-- 해결:
--   ① source_label — 크롭이 앵커로 읽은 그 지면 번호를 그대로 저장한다.
--      판형 무관이다: 내신은 "3", 쎈은 "0243" 처럼 **인쇄된 문자열 그대로** 담는다.
--      정답 PDF 도 같은 번호를 쓰므로 이걸로 맞춘다.
--   ② answer_keys — 교재 단위 정답표. 한 번 읽으면 다음 단원부터는 PDF 없이 채운다.

-- ── ① 지면 번호 ──────────────────────────────────────────────────────
ALTER TABLE problem_staging ADD COLUMN IF NOT EXISTS source_label text;
ALTER TABLE problems        ADD COLUMN IF NOT EXISTS source_label text;

COMMENT ON COLUMN problem_staging.source_label IS
  '지면에 인쇄된 문제번호 그대로(쎈 "0243", 내신 "3"). 빠른정답 매칭 기준.';
COMMENT ON COLUMN problems.source_label IS
  '지면에 인쇄된 문제번호 그대로. staging 에서 승격될 때 복사된다.';

-- 매칭은 (교재, 지면번호) 로 한다 — 그 조합으로 자주 조회한다.
CREATE INDEX IF NOT EXISTS idx_problem_staging_label
  ON problem_staging (textbook_id, source_label);
CREATE INDEX IF NOT EXISTS idx_problems_label
  ON problems (textbook_id, source_label);

-- ── ② 교재 단위 정답표 ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS answer_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  textbook_id   uuid NOT NULL REFERENCES textbooks(id) ON DELETE CASCADE,
  -- 지면에 인쇄된 번호. problem_staging.source_label 과 같은 값끼리 맞춘다.
  label         text NOT NULL,
  -- 정답 원문. 객관식이면 "1"~"5", 주관식이면 LaTeX 나 한글 그대로.
  answer        text NOT NULL DEFAULT '',
  answer_type   text NOT NULL DEFAULT 'short_answer',
  -- VL 이 두 번 읽어 달랐거나, 소문항·한글·여러 값이라 사람이 봐야 하는 항목.
  needs_review  boolean NOT NULL DEFAULT false,
  -- 어느 PDF 에서 읽었는지 (재파싱·추적용)
  source_pdf    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- 한 교재의 한 번호에는 정답이 하나뿐이다.
-- (db-conventions: "한 조합에 1행" 이면 처음부터 UNIQUE 를 건다 — 중복이 쌓인 뒤에
--  제약을 추가하려면 정리부터 해야 해서 번거롭다.)
CREATE UNIQUE INDEX IF NOT EXISTS uq_answer_keys_textbook_label
  ON answer_keys (textbook_id, label);

COMMENT ON TABLE answer_keys IS
  '교재별 빠른정답표. 빠른정답 PDF 를 VL 로 한 번 읽어 저장해 두고, 이후 단원은 PDF 없이 채운다.';
