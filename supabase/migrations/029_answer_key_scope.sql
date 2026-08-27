-- 029_answer_key_scope.sql
-- 빠른정답표를 '회차/시험' 단위까지 나눠 담는다 (2026-08-27)
--
-- 문제: 028 의 제약은 UNIQUE(textbook_id, label) 였다. 쎈처럼 번호가 책 전체에서 유일한
--   교재(0001~1316)는 이걸로 충분하지만, 모의고사·내신은 한 교재 안에 회차/학교가 폴더로
--   들어 있고 **번호가 겹친다**. 실측:
--     [고3 모의고사] 평가원 6월 24년 / 25년 / 26년 — 세 폴더 모두 1~30번
--     [내신 기출]    대장중 / 태원고 / 이매고      — 같은 문제
--   그래서 25년 6월 답지를 넣으면 24년 답지를 **덮어쓴다**. 정답이 틀리면 학생이 맞는 답을
--   쓰고도 오답이 되므로, 조용히 덮이는 것이 이 데이터에서 가장 위험한 사고다.
--
-- 해결: 답지에 folder_id 를 달고, '스코프' 단위로 유일성을 건다.
--   folder_id 가 있으면 그 폴더(회차/시험) 답지, 없으면 교재 전체 답지.

ALTER TABLE answer_keys
  ADD COLUMN IF NOT EXISTS folder_id uuid REFERENCES problem_folders(id) ON DELETE CASCADE;

-- 같은 PDF 를 실수로 또 읽는 것을 막기 위한 원본 파일 해시(sha256).
-- 한 번 읽는 데 VL 22회 + 6분이 든다.
ALTER TABLE answer_keys
  ADD COLUMN IF NOT EXISTS source_hash text;

COMMENT ON COLUMN answer_keys.folder_id IS
  '이 답지가 붙는 폴더(모의고사 회차·내신 학교). NULL 이면 교재 전체 답지(쎈 등).';
COMMENT ON COLUMN answer_keys.source_hash IS
  '읽어들인 PDF 의 sha256. 같은 파일 재업로드를 읽기 전에 걸러내는 용도.';

-- 스코프 키 = 폴더 답지면 폴더, 교재 전체 답지면 교재.
--
-- 왜 (textbook_id, folder_id, label) 로 안 걸었나: Postgres 는 UNIQUE 안의 NULL 을 서로
-- 다른 값으로 본다. 그래서 folder_id IS NULL 인 '교재 전체' 답지는 제약이 전혀 안 먹고
-- 중복이 그대로 쌓인다 — profiles.user_id 중복 21개로 로그인이 깨졌던 사고와 같은 부류다.
-- COALESCE 로 NULL 을 없애면 두 경우 모두 실제로 막힌다.
ALTER TABLE answer_keys
  ADD COLUMN IF NOT EXISTS scope_id uuid
  GENERATED ALWAYS AS (COALESCE(folder_id, textbook_id)) STORED;

COMMENT ON COLUMN answer_keys.scope_id IS
  '유일성 기준. folder_id 가 있으면 그 값, 없으면 textbook_id. GENERATED 라 직접 쓰지 말 것.';

-- 옛 제약을 걷어내고 스코프 기준으로 다시 건다.
-- (기존 1,316행은 folder_id=NULL → scope_id=textbook_id 로 자동 채워지므로
--  쎈 답지는 지금과 완전히 동일하게 동작한다. 데이터 이관 불필요.)
DROP INDEX IF EXISTS uq_answer_keys_textbook_label;
CREATE UNIQUE INDEX IF NOT EXISTS uq_answer_keys_scope_label
  ON answer_keys (scope_id, label);

-- 교재 단위 현황 조회("이 교재 답지 몇 개 있나")용.
CREATE INDEX IF NOT EXISTS idx_answer_keys_textbook ON answer_keys (textbook_id);
