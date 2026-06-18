막힌 지점 도우미 RAG 코퍼스(`solution_nodes`)의 백필 진행도와 노드 품질을 조회하고, 이어서 백필 명령을 제안한다.

## 절차

### 1. 전체 백필 커버리지

`mcp__supabase__execute_sql` 로 실행:

```sql
SELECT
  (SELECT count(*) FROM problems WHERE solution_image_url IS NOT NULL) AS 해설있는문제,
  (SELECT count(DISTINCT problem_id) FROM solution_nodes) AS 노드있는문제,
  (SELECT count(*) FROM solution_nodes) AS 전체노드,
  (SELECT count(*) FROM solution_nodes WHERE embedding IS NULL) AS 임베딩누락;
```

- `노드있는문제 < 해설있는문제` → 아직 백필 안 된 문제가 있음.
- `임베딩누락 > 0` → **위험**. 임베딩 없는 노드는 RPC 검색에서 빠짐. ollama(bge-m3) 미가동 상태로 백필했을 가능성 → 재백필 필요.

### 2. 아직 백필 안 된 문제 식별

```sql
SELECT p.id, p.title, p.unit, p.difficulty_score
FROM problems p
WHERE p.solution_image_url IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM solution_nodes sn WHERE sn.problem_id = p.id)
ORDER BY p.difficulty_score NULLS LAST
LIMIT 20;
```

### 3. 노드 품질 점검 (이상치 탐지)

```sql
-- 문제당 노드 수 분포 (너무 적거나 RAG_MAX_NODES 상한에 붙은 것 의심)
SELECT problem_id, count(*) AS n,
       bool_or(role = 'conclusion') AS has_conclusion,
       count(*) FILTER (WHERE key_concept IS NULL OR output_formula IS NULL) AS null_fields
FROM solution_nodes
GROUP BY problem_id
ORDER BY n;
```

판단:
- `n = 1` 또는 `n >= 15`(RAG_MAX_NODES) → 추출이 뭉개졌거나 폭주. 해당 문제 재백필 후 육안 확인.
- `has_conclusion = false` → 결론 노드 누락. 위치추적이 끝까지 못 갈 수 있음.
- `null_fields > 0` → key_concept/output_formula 누락(스키마상 NOT NULL이지만 방어 확인).

### 4. 정답 노출 위험 점검 (1차 정책)

```sql
SELECT count(*) AS crop_url_채워진노드
FROM solution_nodes WHERE figure_image_crop_url IS NOT NULL;
```

- 1차 정책상 `rag_node_extractor` 는 `figure_image_crop_url = NULL` 로 둔다(해설 통째 폴백 = 정답 노출 방지).
- 0이 아니면 → CMS 수동 bbox 로 채운 것이거나 구버전 데이터. `is_same_problem` crop 이 학생에게 노출되지 않는지 `handlers/stuck_helper.py` 의 figure 필터를 재확인.

### 5. 이어서 백필 명령 제안

```
solution_nodes 현황:
  해설있는문제 30 / 노드있는문제 5 / 전체노드 56 / 임베딩누락 0

→ 남은 25문제 백필 (서버 터널 21434 면 임베딩 위해 로컬 11434 override):
cd backend/pdf_pipeline && venv\Scripts\activate
OLLAMA_URL=http://localhost:11434 python -m scripts.backfill_solution_nodes

→ 특정 문제만:
python -m scripts.backfill_solution_nodes --problem-id <uuid>
```

## 참고

- 백필 스크립트: `backend/pdf_pipeline/scripts/backfill_solution_nodes.py`
- 노드 추출 로직: `backend/pdf_pipeline/pipeline/rag_node_extractor.py` (해설 2-pass VL)
- 검색 RPC: `search_solution_nodes_for_hint` (마이그레이션 `011_add_solution_nodes.sql`)
- 임베딩은 bge-m3 1024 — `OPENAI_API_KEY`(VL) + ollama(임베딩) 필요. 상세 `.claude/rules/dev-rules.md`
