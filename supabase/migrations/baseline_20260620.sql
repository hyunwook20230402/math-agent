-- baseline_20260620.sql
-- 원격 Supabase DB 현재 구조 스냅샷 (2026-06-20)
-- 엉킨 001~016 마이그레이션을 대체하는 baseline
-- 이미 원격에 적용된 상태. 새 환경 재구축 시 이 파일 하나로 전체 스키마 재현
-- 이후 변경은 017_ 부터 새로 쌓는다
-- RLS 정책 제외 (프로젝트 RLS 비활성)
-- pgvector 확장 자동생성 함수 제외 (125개)

-- ============================================================================
-- 1. 확장(Extensions)
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" SCHEMA extensions VERSION '1.1';
CREATE EXTENSION IF NOT EXISTS "pgcrypto" SCHEMA extensions VERSION '1.3';
CREATE EXTENSION IF NOT EXISTS "vector" SCHEMA public VERSION '0.8.0';
CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" SCHEMA extensions VERSION '1.11';
CREATE EXTENSION IF NOT EXISTS "supabase_vault" SCHEMA vault VERSION '0.3.1';

-- ============================================================================
-- 2. 사용자 정의 함수 (테이블 비참조, 트리거 호출용)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    NEW.updated_at = timezone('utc'::text, now());
    RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.profiles (user_id, email, name, role)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'name', 'User'),
    'student'
  );
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.create_default_folders_for_teacher()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    INSERT INTO public.folders (name, folder_type, textbook_type, grade_level, semester, subject, sort_order, created_by)
    VALUES
        ('중학교 3학년 1학기', 'textbook', '쎈', '중3', '1학기', '수학', 1, NEW.id),
        ('고등학교 1학년 1학기', 'textbook', '쎈', '고1', '1학기', '수학', 2, NEW.id),
        ('고등학교 2학년 1학기', 'textbook', '쎈', '고2', '1학기', '수학', 3, NEW.id),
        ('고등학교 3학년 1학기', 'textbook', '쎈', '고3', '1학기', '수학', 4, NEW.id)
    ON CONFLICT DO NOTHING;

    RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.prevent_role_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.role <> OLD.role AND auth.role() <> 'service_role' THEN
    RAISE EXCEPTION '권한 없음: role 변경은 허용되지 않습니다.';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.apply_teacher_code(p_code text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_profile_id UUID;
BEGIN
  SELECT id INTO v_profile_id FROM public.profiles WHERE user_id = auth.uid();
  IF v_profile_id IS NULL THEN
    RAISE EXCEPTION '프로필을 찾을 수 없습니다.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.teacher_invite_codes
    WHERE code = p_code AND used_by IS NULL
  ) THEN
    RAISE EXCEPTION '유효하지 않거나 이미 사용된 코드입니다.';
  END IF;

  UPDATE public.profiles
    SET role = 'teacher'
    WHERE id = v_profile_id;

  UPDATE public.teacher_invite_codes
    SET used_by = v_profile_id, used_at = now()
    WHERE code = p_code;
END;
$function$;

-- ============================================================================
-- 3. 테이블 (FK 의존 순서 고려)
-- ============================================================================

-- 최상위 테이블: 외부 참조 없음
CREATE TABLE public.profiles (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  avatar_url TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  teacher_id UUID,
  grade TEXT,
  school TEXT
);

CREATE TABLE public.textbooks (
  id UUID NOT NULL DEFAULT uuid_generate_v4() PRIMARY KEY,
  name TEXT NOT NULL,
  grade TEXT NOT NULL,
  semester TEXT NOT NULL,
  description TEXT,
  created_by UUID,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE TABLE public.chapters (
  id UUID NOT NULL DEFAULT uuid_generate_v4() PRIMARY KEY,
  textbook_id UUID,
  name TEXT NOT NULL,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE TABLE public.subchapters (
  id UUID NOT NULL DEFAULT uuid_generate_v4() PRIMARY KEY,
  chapter_id UUID,
  name TEXT NOT NULL,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE TABLE public.folders (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  folder_type TEXT NOT NULL,
  textbook_type TEXT,
  grade_level TEXT,
  semester TEXT,
  subject TEXT,
  parent_id UUID,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  created_by UUID
);

CREATE TABLE public.problems (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  teacher_id UUID NOT NULL,
  title TEXT NOT NULL,
  problem_number INTEGER NOT NULL,
  unit TEXT NOT NULL,
  image_url TEXT,
  answer_type TEXT NOT NULL,
  correct_answer TEXT NOT NULL,
  choices JSONB,
  explanation TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  category TEXT DEFAULT '수학'::text,
  tags TEXT[],
  problem_type TEXT,
  explanation_image_url TEXT,
  multiple_answers TEXT[],
  problem_text TEXT,
  problem_latex TEXT,
  topic_tags TEXT[],
  source_info JSONB,
  structuring_status TEXT DEFAULT 'pending'::text,
  embedding vector(1024),
  textbook_id UUID,
  chapter_id UUID,
  subchapter_id UUID,
  solution_image_url TEXT,
  difficulty_score INTEGER NOT NULL DEFAULT 5,
  difficulty TEXT GENERATED ALWAYS AS (
    CASE
      WHEN ((difficulty_score >= 1) AND (difficulty_score <= 2)) THEN 'very_easy'::text
      WHEN ((difficulty_score >= 3) AND (difficulty_score <= 4)) THEN 'easy'::text
      WHEN ((difficulty_score >= 5) AND (difficulty_score <= 6)) THEN 'medium'::text
      WHEN ((difficulty_score >= 7) AND (difficulty_score <= 8)) THEN 'hard'::text
      WHEN ((difficulty_score >= 9) AND (difficulty_score <= 10)) THEN 'very_hard'::text
      ELSE NULL::text
    END
  ) STORED,
  correct_rate NUMERIC
);

CREATE TABLE public.problem_staging (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id UUID NOT NULL,
  teacher_id UUID NOT NULL,
  problem_number INTEGER,
  title TEXT,
  unit TEXT,
  answer_type TEXT,
  correct_answer TEXT,
  choices JSONB,
  explanation TEXT,
  problem_text TEXT,
  source_image_url TEXT,
  source_pdf TEXT,
  source_page INTEGER,
  confidence DOUBLE PRECISION DEFAULT 0,
  status TEXT DEFAULT 'pending'::text,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  category TEXT,
  textbook_id UUID,
  chapter_id UUID,
  page_start INTEGER,
  page_end INTEGER,
  bbox JSONB,
  source_page_image_url TEXT,
  page_number INTEGER,
  solution_image_url TEXT,
  solution_job_id UUID,
  match_confidence REAL,
  validation_status TEXT,
  validation_score DOUBLE PRECISION,
  validation_issues JSONB DEFAULT '[]'::jsonb,
  difficulty_score INTEGER,
  difficulty TEXT GENERATED ALWAYS AS (
    CASE
      WHEN ((difficulty_score >= 1) AND (difficulty_score <= 2)) THEN 'very_easy'::text
      WHEN ((difficulty_score >= 3) AND (difficulty_score <= 4)) THEN 'easy'::text
      WHEN ((difficulty_score >= 5) AND (difficulty_score <= 6)) THEN 'medium'::text
      WHEN ((difficulty_score >= 7) AND (difficulty_score <= 8)) THEN 'hard'::text
      WHEN ((difficulty_score >= 9) AND (difficulty_score <= 10)) THEN 'very_hard'::text
      ELSE NULL::text
    END
  ) STORED,
  correct_rate NUMERIC
);

CREATE TABLE public.problem_sets (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  folder_id UUID,
  teacher_id UUID,
  description TEXT,
  set_type TEXT DEFAULT 'quiz'::text,
  total_problems INTEGER DEFAULT 0,
  estimated_time INTEGER DEFAULT 30,
  sort_order INTEGER DEFAULT 0,
  is_favorite BOOLEAN DEFAULT false,
  is_published BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  subchapter_id UUID,
  difficulty_score_avg INTEGER,
  difficulty_score_p75 INTEGER,
  difficulty_score_max INTEGER,
  difficulty_level TEXT GENERATED ALWAYS AS (
    CASE
      WHEN ((difficulty_score_avg >= 1) AND (difficulty_score_avg <= 2)) THEN 'very_easy'::text
      WHEN ((difficulty_score_avg >= 3) AND (difficulty_score_avg <= 4)) THEN 'easy'::text
      WHEN ((difficulty_score_avg >= 5) AND (difficulty_score_avg <= 6)) THEN 'medium'::text
      WHEN ((difficulty_score_avg >= 7) AND (difficulty_score_avg <= 8)) THEN 'hard'::text
      WHEN ((difficulty_score_avg >= 9) AND (difficulty_score_avg <= 10)) THEN 'very_hard'::text
      ELSE NULL::text
    END
  ) STORED
);

CREATE TABLE public.problem_set_items (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  problem_set_id UUID,
  problem_id UUID,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE TABLE public.problem_tags (
  id UUID NOT NULL DEFAULT uuid_generate_v4() PRIMARY KEY,
  problem_id UUID,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT timezone('utc'::text, now()),
  tag TEXT,
  tag_type TEXT,
  staging_id UUID,
  confidence REAL DEFAULT 1.0,
  source TEXT DEFAULT 'ai'::text
);

CREATE TABLE public.distributions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL,
  problem_set_id UUID,
  teacher_id UUID,
  description TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  distribution_date TIMESTAMP WITH TIME ZONE NOT NULL
);

CREATE TABLE public.distribution_students (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  distribution_id UUID,
  student_id UUID,
  assigned_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE TABLE public.distribution_attempts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  student_id UUID NOT NULL,
  distribution_id UUID NOT NULL,
  attempt_type TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE TABLE public.student_answers (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  student_id UUID NOT NULL,
  problem_id UUID NOT NULL,
  answer TEXT NOT NULL,
  is_correct BOOLEAN NOT NULL,
  submitted_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  attempt_number INTEGER NOT NULL DEFAULT 1,
  distribution_id UUID
);

CREATE TABLE public.wrong_answers (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  student_id UUID NOT NULL,
  problem_id UUID NOT NULL,
  wrong_answer TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  reviewed BOOLEAN NOT NULL DEFAULT false,
  attempt_number INTEGER DEFAULT 1
);

CREATE TABLE public.solution_jobs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  problem_job_id UUID,
  teacher_id UUID NOT NULL,
  pdf_path TEXT,
  status TEXT DEFAULT 'pending'::text,
  progress JSONB DEFAULT '{}'::jsonb,
  error TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE TABLE public.solution_nodes (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  problem_id UUID NOT NULL,
  node_index INTEGER NOT NULL,
  role TEXT NOT NULL,
  entry_conditions TEXT,
  key_concept TEXT NOT NULL,
  output_formula TEXT NOT NULL,
  figure_description TEXT,
  figure_image_crop_url TEXT,
  embedding_text TEXT NOT NULL,
  embedding vector(1024),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  uses INTEGER[] DEFAULT '{}'::integer[],
  whys JSONB DEFAULT '[]'::jsonb
);

CREATE TABLE public.teacher_invite_codes (
  code TEXT NOT NULL PRIMARY KEY,
  issued_to_email TEXT,
  used_by UUID,
  used_at TIMESTAMP WITH TIME ZONE
);

-- ============================================================================
-- 4. 외래키 제약 (순환 참조 방지)
-- ============================================================================

ALTER TABLE public.profiles
  ADD CONSTRAINT fk_profiles_teacher_id FOREIGN KEY (teacher_id) REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_profiles_user_id FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.textbooks
  ADD CONSTRAINT fk_textbooks_created_by FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE CASCADE;

ALTER TABLE public.chapters
  ADD CONSTRAINT fk_chapters_textbook_id FOREIGN KEY (textbook_id) REFERENCES public.textbooks(id) ON DELETE CASCADE;

ALTER TABLE public.subchapters
  ADD CONSTRAINT fk_subchapters_chapter_id FOREIGN KEY (chapter_id) REFERENCES public.chapters(id) ON DELETE CASCADE;

ALTER TABLE public.folders
  ADD CONSTRAINT fk_folders_parent_id FOREIGN KEY (parent_id) REFERENCES public.folders(id) ON DELETE CASCADE,
  ADD CONSTRAINT fk_folders_created_by FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE CASCADE;

ALTER TABLE public.problems
  ADD CONSTRAINT fk_problems_teacher_id FOREIGN KEY (teacher_id) REFERENCES public.profiles(id) ON DELETE CASCADE,
  ADD CONSTRAINT fk_problems_textbook_id FOREIGN KEY (textbook_id) REFERENCES public.textbooks(id) ON DELETE NO ACTION,
  ADD CONSTRAINT fk_problems_chapter_id FOREIGN KEY (chapter_id) REFERENCES public.chapters(id) ON DELETE NO ACTION,
  ADD CONSTRAINT fk_problems_subchapter_id FOREIGN KEY (subchapter_id) REFERENCES public.subchapters(id) ON DELETE NO ACTION;

ALTER TABLE public.problem_staging
  ADD CONSTRAINT fk_problem_staging_teacher_id FOREIGN KEY (teacher_id) REFERENCES public.profiles(id) ON DELETE NO ACTION,
  ADD CONSTRAINT fk_problem_staging_textbook_id FOREIGN KEY (textbook_id) REFERENCES public.textbooks(id) ON DELETE NO ACTION,
  ADD CONSTRAINT fk_problem_staging_chapter_id FOREIGN KEY (chapter_id) REFERENCES public.chapters(id) ON DELETE NO ACTION;

ALTER TABLE public.problem_sets
  ADD CONSTRAINT fk_problem_sets_folder_id FOREIGN KEY (folder_id) REFERENCES public.folders(id) ON DELETE CASCADE,
  ADD CONSTRAINT fk_problem_sets_teacher_id FOREIGN KEY (teacher_id) REFERENCES public.profiles(id) ON DELETE CASCADE,
  ADD CONSTRAINT fk_problem_sets_subchapter_id FOREIGN KEY (subchapter_id) REFERENCES public.subchapters(id) ON DELETE CASCADE;

ALTER TABLE public.problem_set_items
  ADD CONSTRAINT fk_problem_set_items_problem_set_id FOREIGN KEY (problem_set_id) REFERENCES public.problem_sets(id) ON DELETE CASCADE,
  ADD CONSTRAINT fk_problem_set_items_problem_id FOREIGN KEY (problem_id) REFERENCES public.problems(id) ON DELETE CASCADE;

ALTER TABLE public.problem_tags
  ADD CONSTRAINT fk_problem_tags_problem_id FOREIGN KEY (problem_id) REFERENCES public.problems(id) ON DELETE CASCADE,
  ADD CONSTRAINT fk_problem_tags_staging_id FOREIGN KEY (staging_id) REFERENCES public.problem_staging(id) ON DELETE CASCADE;

ALTER TABLE public.distributions
  ADD CONSTRAINT fk_distributions_problem_set_id FOREIGN KEY (problem_set_id) REFERENCES public.problem_sets(id) ON DELETE CASCADE,
  ADD CONSTRAINT fk_distributions_teacher_id FOREIGN KEY (teacher_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

ALTER TABLE public.distribution_students
  ADD CONSTRAINT fk_distribution_students_distribution_id FOREIGN KEY (distribution_id) REFERENCES public.distributions(id) ON DELETE CASCADE,
  ADD CONSTRAINT fk_distribution_students_student_id FOREIGN KEY (student_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

ALTER TABLE public.distribution_attempts
  ADD CONSTRAINT fk_distribution_attempts_distribution_id FOREIGN KEY (distribution_id) REFERENCES public.distributions(id) ON DELETE CASCADE,
  ADD CONSTRAINT fk_distribution_attempts_student_id FOREIGN KEY (student_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

ALTER TABLE public.student_answers
  ADD CONSTRAINT fk_student_answers_student_id FOREIGN KEY (student_id) REFERENCES public.profiles(id) ON DELETE CASCADE,
  ADD CONSTRAINT fk_student_answers_problem_id FOREIGN KEY (problem_id) REFERENCES public.problems(id) ON DELETE CASCADE,
  ADD CONSTRAINT fk_student_answers_distribution_id FOREIGN KEY (distribution_id) REFERENCES public.distributions(id) ON DELETE CASCADE;

ALTER TABLE public.wrong_answers
  ADD CONSTRAINT fk_wrong_answers_student_id FOREIGN KEY (student_id) REFERENCES public.profiles(id) ON DELETE CASCADE,
  ADD CONSTRAINT fk_wrong_answers_problem_id FOREIGN KEY (problem_id) REFERENCES public.problems(id) ON DELETE CASCADE;

ALTER TABLE public.solution_nodes
  ADD CONSTRAINT fk_solution_nodes_problem_id FOREIGN KEY (problem_id) REFERENCES public.problems(id) ON DELETE CASCADE;

ALTER TABLE public.teacher_invite_codes
  ADD CONSTRAINT fk_teacher_invite_codes_used_by FOREIGN KEY (used_by) REFERENCES public.profiles(id) ON DELETE NO ACTION;

-- ============================================================================
-- 5. UNIQUE 제약
-- ============================================================================

ALTER TABLE public.distribution_students
  ADD CONSTRAINT uk_distribution_students_distribution_student UNIQUE (distribution_id, student_id);

ALTER TABLE public.problem_set_items
  ADD CONSTRAINT uk_problem_set_items_set_problem UNIQUE (problem_set_id, problem_id);

ALTER TABLE public.solution_nodes
  ADD CONSTRAINT uk_solution_nodes_problem_node_index UNIQUE (problem_id, node_index);

ALTER TABLE public.wrong_answers
  ADD CONSTRAINT uk_wrong_answers_student_problem UNIQUE (student_id, problem_id);

-- ============================================================================
-- 6. 인덱스
-- ============================================================================

CREATE INDEX idx_distribution_attempts_created_at ON public.distribution_attempts USING btree (created_at);
CREATE INDEX idx_distribution_attempts_student_distribution ON public.distribution_attempts USING btree (student_id, distribution_id);
CREATE INDEX idx_distribution_students_distribution_id ON public.distribution_students USING btree (distribution_id);
CREATE INDEX idx_distribution_students_student_id ON public.distribution_students USING btree (student_id);
CREATE INDEX idx_distributions_distribution_date ON public.distributions USING btree (distribution_date);
CREATE INDEX idx_distributions_problem_set_id ON public.distributions USING btree (problem_set_id);
CREATE INDEX idx_distributions_teacher_id ON public.distributions USING btree (teacher_id);
CREATE INDEX idx_folders_created_by ON public.folders USING btree (created_by);
CREATE INDEX idx_folders_folder_type ON public.folders USING btree (folder_type);
CREATE INDEX idx_folders_parent_id ON public.folders USING btree (parent_id);
CREATE INDEX idx_problem_set_items_problem_id ON public.problem_set_items USING btree (problem_id);
CREATE INDEX idx_problem_set_items_problem_set_id ON public.problem_set_items USING btree (problem_set_id);
CREATE INDEX idx_problem_sets_folder_id ON public.problem_sets USING btree (folder_id);
CREATE INDEX idx_problem_sets_teacher_id ON public.problem_sets USING btree (teacher_id);
CREATE INDEX idx_problem_staging_job_id ON public.problem_staging USING btree (job_id);
CREATE INDEX idx_problem_staging_status ON public.problem_staging USING btree (status);
CREATE INDEX idx_problem_staging_teacher_id ON public.problem_staging USING btree (teacher_id);
CREATE INDEX idx_staging_textbook ON public.problem_staging USING btree (textbook_id);
CREATE INDEX idx_problem_tags_problem ON public.problem_tags USING btree (problem_id);
CREATE INDEX idx_problem_tags_staging ON public.problem_tags USING btree (staging_id);
CREATE INDEX idx_problem_tags_tag ON public.problem_tags USING btree (tag, tag_type);
CREATE INDEX idx_problems_category ON public.problems USING btree (category);
CREATE INDEX idx_problems_chapter ON public.problems USING btree (chapter_id);
CREATE INDEX idx_problems_embedding ON public.problems USING ivfflat (embedding vector_cosine_ops) WITH (lists='20');
CREATE INDEX idx_problems_structuring_status ON public.problems USING btree (structuring_status);
CREATE INDEX idx_problems_subchapter ON public.problems USING btree (subchapter_id);
CREATE INDEX idx_problems_textbook ON public.problems USING btree (textbook_id);
CREATE INDEX idx_solution_jobs_problem_job ON public.solution_jobs USING btree (problem_job_id);
CREATE INDEX idx_solution_jobs_teacher ON public.solution_jobs USING btree (teacher_id);
CREATE INDEX idx_solution_nodes_embedding ON public.solution_nodes USING ivfflat (embedding vector_cosine_ops) WITH (lists='20');
CREATE INDEX idx_solution_nodes_problem ON public.solution_nodes USING btree (problem_id);
CREATE INDEX idx_solution_nodes_role ON public.solution_nodes USING btree (role);

-- ============================================================================
-- 7. 트리거
-- ============================================================================

CREATE TRIGGER on_auth_user_created
 AFTER INSERT ON auth.users
 FOR EACH ROW
 EXECUTE FUNCTION public.handle_new_user();

CREATE TRIGGER update_profiles_updated_at
 BEFORE UPDATE ON public.profiles
 FOR EACH ROW
 EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER create_default_folders_for_teacher_trigger
 AFTER INSERT ON public.profiles
 FOR EACH ROW
 WHEN ((new.role = 'teacher'::text))
 EXECUTE FUNCTION public.create_default_folders_for_teacher();

CREATE TRIGGER trg_prevent_role_change
 BEFORE UPDATE ON public.profiles
 FOR EACH ROW
 EXECUTE FUNCTION public.prevent_role_change();

CREATE TRIGGER update_folders_updated_at
 BEFORE UPDATE ON public.folders
 FOR EACH ROW
 EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_problem_sets_updated_at
 BEFORE UPDATE ON public.problem_sets
 FOR EACH ROW
 EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_problems_updated_at
 BEFORE UPDATE ON public.problems
 FOR EACH ROW
 EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_chapters_updated_at
 BEFORE UPDATE ON public.chapters
 FOR EACH ROW
 EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_subchapters_updated_at
 BEFORE UPDATE ON public.subchapters
 FOR EACH ROW
 EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_textbooks_updated_at
 BEFORE UPDATE ON public.textbooks
 FOR EACH ROW
 EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_distributions_updated_at
 BEFORE UPDATE ON public.distributions
 FOR EACH ROW
 EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================================================
-- 8. 테이블 참조 RPC (마지막에 정의 — 테이블 존재 필수)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.recalc_set_difficulty(p_set_id uuid)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
BEGIN
  UPDATE problem_sets ps
  SET
    difficulty_score_avg = sub.avg_score,
    difficulty_score_p75 = sub.p75_score,
    difficulty_score_max = sub.max_score
  FROM (
    SELECT
      ROUND(AVG(p.difficulty_score))::INT AS avg_score,
      PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY p.difficulty_score)::INT AS p75_score,
      MAX(p.difficulty_score) AS max_score
    FROM problem_set_items psi
    JOIN problems p ON p.id = psi.problem_id
    WHERE psi.problem_set_id = p_set_id
  ) sub
  WHERE ps.id = p_set_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.search_solution_nodes_for_hint(query_embedding vector, current_problem_id uuid, current_node_index integer DEFAULT '-1'::integer, match_limit integer DEFAULT 5)
 RETURNS TABLE(node_id uuid, problem_id uuid, node_index integer, role text, key_concept text, output_formula text, figure_description text, figure_image_crop_url text, uses integer[], whys jsonb, similarity double precision, is_same_problem boolean)
 LANGUAGE sql
 STABLE
AS $function$
  SELECT
    sn.id,
    sn.problem_id,
    sn.node_index,
    sn.role,
    sn.key_concept,
    sn.output_formula,
    sn.figure_description,
    sn.figure_image_crop_url,
    sn.uses,
    sn.whys,
    (1 - (sn.embedding <=> query_embedding))::FLOAT AS similarity,
    (sn.problem_id = current_problem_id) AS is_same_problem
  FROM solution_nodes sn
  WHERE sn.embedding IS NOT NULL
    AND (sn.problem_id <> current_problem_id OR sn.node_index > current_node_index)
  ORDER BY
    CASE WHEN sn.problem_id = current_problem_id THEN 0 ELSE 1 END,
    sn.embedding <=> query_embedding
  LIMIT match_limit;
$function$;
