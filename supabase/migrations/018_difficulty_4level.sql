-- 018: 난이도 체계 1~10 → 4단계(Lv1~Lv4) 전환 (2026-06-21)
--
-- 배경: 해설 PDF 에 정답률이 아니라 Lv1~Lv4 라벨이 인쇄돼 있어, 난이도를 4단계로 통일한다.
--   difficulty_score 매핑: Lv1→1, Lv2→2, Lv3→3, Lv4→4.
--   파생 라벨(difficulty / difficulty_level)을 4단계 기준으로 재정의한다.
--
-- 라벨 4종 (medium 폐기):
--   1 → very_easy (Lv1, 쉬움)
--   2 → easy      (Lv2, 보통)
--   3 → hard      (Lv3, 어려움)
--   4 → very_hard (Lv4, 최상위)
--
-- 기존 데이터 보존: DB 의 옛 1~10 점수는 UPDATE 하지 않는다(사용자 결정). 따라서 파생
--   CASE 는 옛값(5~10)이 들어와도 깨지지 않게 "가장 가까운 상위 라벨로 흡수"한다.
--   구체적으로 score>=4 는 모두 very_hard, 3→hard, 2→easy, 1→very_easy 로 본다.
--   (옛 medium(5~6)/hard(7~8)/very_hard(9~10) 은 전부 very_hard 로 흡수 — 옛 데이터
--    표시가 깨지지 않는 게 목적이고, 정확한 재분류는 재태깅 시 새 1~4 값으로 갱신된다.)
--
-- GENERATED 컬럼은 CREATE OR REPLACE 불가 → DROP COLUMN + ADD COLUMN 으로 재정의.
-- DEFAULT 5 (옛 medium) 도 4단계 중간값 2 (Lv2) 로 변경.

BEGIN;

-- ── problems ────────────────────────────────────────────────────────────────
ALTER TABLE public.problems ALTER COLUMN difficulty_score SET DEFAULT 2;

ALTER TABLE public.problems DROP COLUMN IF EXISTS difficulty;
ALTER TABLE public.problems ADD COLUMN difficulty TEXT GENERATED ALWAYS AS (
  CASE
    WHEN difficulty_score = 1 THEN 'very_easy'::text
    WHEN difficulty_score = 2 THEN 'easy'::text
    WHEN difficulty_score = 3 THEN 'hard'::text
    WHEN difficulty_score >= 4 THEN 'very_hard'::text
    ELSE NULL::text
  END
) STORED;

-- ── problem_staging ─────────────────────────────────────────────────────────
ALTER TABLE public.problem_staging DROP COLUMN IF EXISTS difficulty;
ALTER TABLE public.problem_staging ADD COLUMN difficulty TEXT GENERATED ALWAYS AS (
  CASE
    WHEN difficulty_score = 1 THEN 'very_easy'::text
    WHEN difficulty_score = 2 THEN 'easy'::text
    WHEN difficulty_score = 3 THEN 'hard'::text
    WHEN difficulty_score >= 4 THEN 'very_hard'::text
    ELSE NULL::text
  END
) STORED;

-- ── problem_sets (세트 평균 난이도 라벨) ──────────────────────────────────────
ALTER TABLE public.problem_sets DROP COLUMN IF EXISTS difficulty_level;
ALTER TABLE public.problem_sets ADD COLUMN difficulty_level TEXT GENERATED ALWAYS AS (
  CASE
    WHEN difficulty_score_avg = 1 THEN 'very_easy'::text
    WHEN difficulty_score_avg = 2 THEN 'easy'::text
    WHEN difficulty_score_avg = 3 THEN 'hard'::text
    WHEN difficulty_score_avg >= 4 THEN 'very_hard'::text
    ELSE NULL::text
  END
) STORED;

COMMIT;
