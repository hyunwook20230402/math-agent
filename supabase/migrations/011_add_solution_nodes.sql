-- 011: RAG "막힌 지점 도우미" — 해설 풀이를 추론 노드(step) 단위로 쪼갠 코퍼스
--
-- 학생이 문제를 풀다 막혔을 때, 현재 위치를 추론 노드 그래프 위에 위치추적(localize)하고
-- 다음 노드 1개만 근거 기반으로 끌어주기 위한 검색 단위 테이블.
-- 문제/해설이 이미지에만 존재하므로 VLM(GPT-4o)이 풀이를 노드로 분해하고
-- 도형/그래프를 언어화(figure_description)한 뒤 그 서술을 임베딩한다(검색용).
-- 원본 crop 이미지(figure_image_crop_url)는 최종 힌트 생성 시 GPT-4o 멀티모달에 직접 전달한다.
--
-- 임베딩은 problems.embedding 과 동일하게 bge-m3 vector(1024) 로 통일한다
-- (OpenAI 1536 과 섞이면 cosine 검색이 깨짐).

CREATE TABLE IF NOT EXISTS solution_nodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  problem_id UUID NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  node_index INT NOT NULL,                 -- 문제 내 풀이 step 순서 (0-indexed)

  -- 노드의 역할 분류 (localize 시 학생 위치 추정 보조)
  role TEXT NOT NULL CHECK (role IN (
    'condition_analysis',   -- 조건 해석
    'equation_setup',       -- 식 세우기
    'case_split',           -- 경우 분리
    'computation',          -- 계산 실행
    'conclusion'            -- 결론 도출
  )),

  -- 노드 내용
  entry_conditions TEXT,                   -- 이전 단계까지의 상태 (첫 노드는 NULL)
  key_concept TEXT NOT NULL,               -- 이 노드가 쓰는 핵심 개념 (임베딩 핵심)
  output_formula TEXT NOT NULL,            -- 이 단계의 산출물 수식 (LaTeX)

  -- 도형/그래프 언어화 + 원본 참조
  figure_description TEXT,                  -- VLM 이 도형을 언어화한 서술 (도형 없으면 NULL)
  figure_image_crop_url TEXT,              -- 원본 crop 이미지 URL (도형 없으면 NULL)

  -- 검색용
  embedding_text TEXT NOT NULL,            -- key_concept + output_formula + figure_description 합성
  embedding VECTOR(1024),                  -- bge-m3 (problems.embedding 과 동일 차원)

  created_at TIMESTAMPTZ DEFAULT now(),

  UNIQUE (problem_id, node_index)
);

CREATE INDEX IF NOT EXISTS idx_solution_nodes_problem ON solution_nodes(problem_id);
CREATE INDEX IF NOT EXISTS idx_solution_nodes_role    ON solution_nodes(role);
CREATE INDEX IF NOT EXISTS idx_solution_nodes_embedding
  ON solution_nodes USING ivfflat (embedding vector_cosine_ops) WITH (lists = 20);


-- 노드 검색 RPC — 학생 막힌 지점 임베딩으로 다음 노드 + 같은 개념 타 기출 유사 노드 retrieve
-- <=> 는 cosine 거리 (0=동일, 2=정반대). similarity = 1 - distance.
-- 현재 문제의 노드를 우선 정렬해 "이 문제의 다음 단계" 를 먼저 노출하고,
-- 같은 개념의 다른 기출 노드를 보조 근거로 함께 반환한다.
CREATE OR REPLACE FUNCTION search_solution_nodes_for_hint(
  query_embedding vector(1024),
  current_problem_id UUID,
  current_node_index INT DEFAULT -1,
  match_limit INT DEFAULT 5
)
RETURNS TABLE (
  node_id UUID,
  problem_id UUID,
  node_index INT,
  role TEXT,
  key_concept TEXT,
  output_formula TEXT,
  figure_description TEXT,
  figure_image_crop_url TEXT,
  similarity FLOAT,
  is_same_problem BOOLEAN
)
LANGUAGE SQL STABLE AS $$
  SELECT
    sn.id,
    sn.problem_id,
    sn.node_index,
    sn.role,
    sn.key_concept,
    sn.output_formula,
    sn.figure_description,
    sn.figure_image_crop_url,
    (1 - (sn.embedding <=> query_embedding))::FLOAT AS similarity,
    (sn.problem_id = current_problem_id) AS is_same_problem
  FROM solution_nodes sn
  WHERE sn.embedding IS NOT NULL
    -- 현재 문제에서는 아직 공개 안 한(다음) 노드만, 타 문제는 전부 후보
    AND (sn.problem_id <> current_problem_id OR sn.node_index > current_node_index)
  ORDER BY
    CASE WHEN sn.problem_id = current_problem_id THEN 0 ELSE 1 END,
    sn.embedding <=> query_embedding
  LIMIT match_limit;
$$;
