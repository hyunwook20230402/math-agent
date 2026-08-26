-- 027_unified_problem_folders.sql
-- 폴더 구조를 무한 깊이로 (2026-08-26)
--
-- 문제: 폴더가 chapters(1단계) / subchapters(2단계) 두 테이블로 나뉘어 있어
--   깊이가 3단(교재 > 챕터 > 서브챕터)에 고정돼 있었다. 더 깊게 가려면
--   테이블을 계속 추가해야 하고, 1단계와 2단계 코드가 계속 갈라진다.
--   요구: "내신 1학년 > 공통수학1 > 야탑고 > 2026년" 처럼 제한 없이.
--
-- 해결: 자기참조(parent_id) 폴더 테이블 하나로 통합한다.
--   problems/problem_staging 은 **가장 깊은 폴더 하나**만 folder_id 로 가리킨다.
--   조상 경로는 parent_id 를 타고 올라가면 나오므로 중복 컬럼을 두지 않는다.
--
-- 되돌리기: 옛 컬럼(chapter_id/subchapter_id)과 옛 테이블(chapters/subchapters)을
--   지우지 않는다. 문제가 생기면 코드만 되돌리면 옛 경로가 그대로 동작한다.
--   안정화된 뒤 별도 마이그레이션으로 정리할 것.

-- ── 1. 통합 폴더 테이블 ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.problem_folders (
  id UUID NOT NULL DEFAULT uuid_generate_v4() PRIMARY KEY,
  textbook_id UUID NOT NULL REFERENCES public.textbooks(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES public.problem_folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX IF NOT EXISTS idx_problem_folders_textbook ON public.problem_folders(textbook_id);
CREATE INDEX IF NOT EXISTS idx_problem_folders_parent   ON public.problem_folders(parent_id);

-- 같은 부모 아래 같은 이름 금지. 부모가 NULL(최상위)인 경우도 막아야 해서 인덱스를 나눈다.
CREATE UNIQUE INDEX IF NOT EXISTS uq_problem_folders_child
  ON public.problem_folders(parent_id, name) WHERE parent_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_problem_folders_root
  ON public.problem_folders(textbook_id, name) WHERE parent_id IS NULL;

-- ── 2. 기존 폴더 이전 (id 를 그대로 써서 매핑 없이 옮긴다) ────────
-- chapters → 최상위 폴더
INSERT INTO public.problem_folders (id, textbook_id, parent_id, name, description, sort_order, created_at, updated_at)
SELECT c.id, c.textbook_id, NULL, c.name, c.description, c.sort_order, c.created_at, c.updated_at
FROM public.chapters c
WHERE c.textbook_id IS NOT NULL
ON CONFLICT (id) DO NOTHING;

-- subchapters → 그 chapter 의 자식 폴더
INSERT INTO public.problem_folders (id, textbook_id, parent_id, name, description, sort_order, created_at, updated_at)
SELECT s.id, c.textbook_id, s.chapter_id, s.name, s.description, s.sort_order, s.created_at, s.updated_at
FROM public.subchapters s
JOIN public.chapters c ON c.id = s.chapter_id
WHERE c.textbook_id IS NOT NULL
ON CONFLICT (id) DO NOTHING;

-- ── 3. problems / problem_staging 에 folder_id ───────────────────
ALTER TABLE public.problems
  ADD COLUMN IF NOT EXISTS folder_id UUID REFERENCES public.problem_folders(id) ON DELETE SET NULL;
ALTER TABLE public.problem_staging
  ADD COLUMN IF NOT EXISTS folder_id UUID REFERENCES public.problem_folders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_problems_folder        ON public.problems(folder_id);
CREATE INDEX IF NOT EXISTS idx_problem_staging_folder ON public.problem_staging(folder_id);

-- 가장 깊은 폴더로 채운다. id 를 보존했기에 그대로 대입하면 된다.
UPDATE public.problems
SET folder_id = COALESCE(subchapter_id, chapter_id)
WHERE folder_id IS NULL AND COALESCE(subchapter_id, chapter_id) IS NOT NULL;

-- problem_staging 에는 subchapter_id 가 없다 — 추출 단계에선 1단계 폴더까지만 쓰기 때문.
-- (problems 만 subchapter_id 를 가진다. 컬럼 구성을 확인 안 하고 같다고 가정했던 것을 바로잡음.)
UPDATE public.problem_staging
SET folder_id = chapter_id
WHERE folder_id IS NULL AND chapter_id IS NOT NULL;

-- ── 4. 조상 경로 조회용 (브레드크럼·하위 포함 조회에 쓴다) ─────────
CREATE OR REPLACE FUNCTION public.folder_path(p_folder_id UUID)
RETURNS TABLE(id UUID, name TEXT, depth INT)
LANGUAGE sql STABLE
AS $$
  WITH RECURSIVE up AS (
    SELECT f.id, f.name, f.parent_id, 0 AS depth
    FROM public.problem_folders f WHERE f.id = p_folder_id
    UNION ALL
    SELECT f.id, f.name, f.parent_id, up.depth + 1
    FROM public.problem_folders f JOIN up ON f.id = up.parent_id
  )
  SELECT up.id, up.name, up.depth FROM up ORDER BY up.depth DESC;
$$;

-- 자기 자신 + 모든 하위 폴더 id. 폴더를 고르면 그 아래 문제까지 같이 보이게 하는 데 쓴다.
CREATE OR REPLACE FUNCTION public.folder_descendants(p_folder_id UUID)
RETURNS TABLE(id UUID)
LANGUAGE sql STABLE
AS $$
  WITH RECURSIVE down AS (
    SELECT f.id FROM public.problem_folders f WHERE f.id = p_folder_id
    UNION ALL
    SELECT f.id FROM public.problem_folders f JOIN down ON f.parent_id = down.id
  )
  SELECT down.id FROM down;
$$;

-- 순환 방지: 자기 조상을 부모로 삼지 못하게 한다(폴더 이동에서 실수로 만들 수 있다).
CREATE OR REPLACE FUNCTION public.problem_folders_no_cycle()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.parent_id IS NOT NULL THEN
    IF NEW.parent_id = NEW.id THEN
      RAISE EXCEPTION '폴더를 자기 자신 아래로 옮길 수 없습니다';
    END IF;
    IF EXISTS (SELECT 1 FROM public.folder_descendants(NEW.id) d WHERE d.id = NEW.parent_id) THEN
      RAISE EXCEPTION '폴더를 자기 하위 폴더 아래로 옮길 수 없습니다';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_problem_folders_no_cycle ON public.problem_folders;
CREATE TRIGGER trg_problem_folders_no_cycle
  BEFORE INSERT OR UPDATE OF parent_id ON public.problem_folders
  FOR EACH ROW EXECUTE FUNCTION public.problem_folders_no_cycle();
