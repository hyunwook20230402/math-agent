-- 007: DeepTutor 대화형 튜터 — 대화 이력/오답 이력 테이블 + 유사 문제 검색 RPC
-- 학생이 문제를 틀렸을 때 AI와 다중 턴 대화로 도움받는 기능을 위한 스키마.

-- 1) 대화 이력 테이블
-- LangGraph state 와 messages 배열을 JSONB 로 저장.
CREATE TABLE IF NOT EXISTS student_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  problem_id UUID NOT NULL REFERENCES problems(id) ON DELETE CASCADE,

  -- 대화 시작 정보 (immutable)
  student_answer TEXT,           -- 학생 최초 답 (예: "3", "42")
  correct_answer TEXT,           -- 정답 snapshot (문제 수정되어도 유지)

  -- LangGraph 상태 (hint_level, current_intent, turn_count 등)
  state JSONB DEFAULT '{}'::jsonb,

  -- 대화 본문 — [{role: 'student'|'tutor', content: str, timestamp: ISO, node?: str}, ...]
  messages JSONB DEFAULT '[]'::jsonb,

  -- 추천 유사 문제 snapshot
  similar_problems JSONB,

  status TEXT DEFAULT 'active'
    CHECK (status IN ('active', 'completed', 'abandoned')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_student_conv_student ON student_conversations(student_id);
CREATE INDEX IF NOT EXISTS idx_student_conv_problem ON student_conversations(problem_id);
CREATE INDEX IF NOT EXISTS idx_student_conv_status  ON student_conversations(status);
CREATE INDEX IF NOT EXISTS idx_student_conv_created ON student_conversations(created_at DESC);

-- 2) 오답 이력 테이블 — 대화 없이 답만 제출한 경우도 기록
CREATE TABLE IF NOT EXISTS student_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  problem_id UUID NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES student_conversations(id) ON DELETE SET NULL,

  student_answer TEXT NOT NULL,
  correct_answer TEXT NOT NULL,
  is_correct BOOLEAN DEFAULT FALSE,

  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_student_attempts_student ON student_attempts(student_id);
CREATE INDEX IF NOT EXISTS idx_student_attempts_problem ON student_attempts(problem_id);
CREATE INDEX IF NOT EXISTS idx_student_attempts_correct ON student_attempts(is_correct);

-- 3) 유사 문제 검색 RPC (pgvector cosine 거리 기반)
-- problems.embedding (vector(1024), bge-m3) 이 채워져 있어야 동작.
-- <=> 는 pgvector 의 cosine 거리 연산자 (0=동일, 2=정반대)
-- similarity = 1 - distance (0~1 범위로 정규화)
CREATE OR REPLACE FUNCTION search_similar_problems(
  query_embedding vector(1024),
  exclude_id UUID,
  match_limit INT DEFAULT 3
)
RETURNS TABLE (
  id UUID,
  image_url TEXT,
  unit TEXT,
  difficulty TEXT,
  similarity FLOAT
)
LANGUAGE SQL STABLE AS $$
  SELECT
    p.id,
    p.image_url,
    p.unit,
    p.difficulty,
    (1 - (p.embedding <=> query_embedding))::FLOAT AS similarity
  FROM problems p
  WHERE p.id != exclude_id
    AND p.embedding IS NOT NULL
  ORDER BY p.embedding <=> query_embedding
  LIMIT match_limit;
$$;
