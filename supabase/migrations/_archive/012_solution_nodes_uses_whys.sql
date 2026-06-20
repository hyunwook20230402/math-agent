-- 012: solution_nodes 에 uses/whys 추가 — 노드 전이의 "논리적 완결성" 보강
--
-- 배경: 1회 통합 노드 추출(rag_node_extractor)로 전환하면서, 긴 풀이의 노드가 얕아져
-- "왜 이 노드에서 다음으로 넘어갈 수 있는가"가 빠질 우려가 있다. solution_tagger 의
-- produces/uses/whys(DAG) 설계를 RAG 용으로 경량 차용한다.
--   uses : 이 노드가 성립하려고 참조하는 이전 node_index 들 (전이 근거 = DAG 엣지)
--   whys : 학생이 "왜 이 다음 단계로?" 막힐 지점의 {question, reason} (논리 보강)
--
-- whys.question 은 학생에게 소크라테스식 질문으로 유도, whys.reason 은 힌트 생성의
-- 배경 근거로만 쓴다(정답값 직접 노출 방지 — answer leakage).

ALTER TABLE solution_nodes
  ADD COLUMN IF NOT EXISTS uses INT[]   DEFAULT '{}',     -- 이전 node_index 배열 (DAG 엣지)
  ADD COLUMN IF NOT EXISTS whys JSONB   DEFAULT '[]';     -- [{question, reason}, ...]

-- 기존 행(56개)은 default 빈 배열 → 재백필 전까지 stuck_helper 가 빈 whys 에 graceful.


-- ── RPC 갱신 — RETURNS TABLE 에 uses/whys 추가 ────────────────────────────────
-- Postgres 제약: RETURNS TABLE 시그니처(반환 컬럼) 변경은 CREATE OR REPLACE 불가.
-- 반드시 DROP 후 CREATE. 인자 시그니처는 011 과 동일하므로 CASCADE 불필요하나, 안전하게 명시.
DROP FUNCTION IF EXISTS search_solution_nodes_for_hint(vector, UUID, INT, INT);

CREATE FUNCTION search_solution_nodes_for_hint(
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
  uses INT[],
  whys JSONB,
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
    sn.uses,
    sn.whys,
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
