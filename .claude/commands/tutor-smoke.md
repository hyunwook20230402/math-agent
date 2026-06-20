막힌 지점 도우미(풀이 그래프 위치추적 RAG)를 샘플 문제로 end-to-end 1발 검증한다. 실전 핸들러 `generate_hint` 를 그대로 import 해 호출한다(손코딩 smoke 금지 — `feedback_smoke_must_match_production`).

## 사전 조건

- `solution_nodes` 에 노드가 1개 이상 있어야 함(없으면 먼저 `/solution-nodes-status` → 백필).
- `OPENAI_API_KEY`(막힌 지점 찾기/힌트 만들기 VL) + ollama bge-m3(임베딩) 가동.
- 서버 터널 `OLLAMA_URL=21434` 면 임베딩 위해 로컬 `11434` override.

## 절차

### 1. 노드 있는 샘플 문제 확보

`mcp__supabase__execute_sql`:
```sql
SELECT sn.problem_id, p.title, count(*) AS nodes
FROM solution_nodes sn JOIN problems p ON p.id = sn.problem_id
GROUP BY sn.problem_id, p.title ORDER BY nodes DESC LIMIT 5;
```

### 2. 임시 스모크 스크립트 작성

`/tmp/tutor_smoke.py` (실행 후 삭제):
```python
import sys, os
from pathlib import Path
PIPE = Path("C:/Users/user/workspaces/math/backend/pdf_pipeline")
sys.path.insert(0, str(PIPE))
from dotenv import load_dotenv
load_dotenv(PIPE / ".env")
os.environ["OLLAMA_URL"] = "http://localhost:11434"  # 서버터널 21434 대신 로컬 임베딩

from storage.supabase_client import get_client
from handlers import stuck_helper

client = get_client()
pid = client.table("solution_nodes").select("problem_id").limit(1).execute().data[0]["problem_id"]
title = client.table("problems").select("title").eq("id", pid).single().execute().data["title"]
print(f"=== {title} (id={pid[:8]}) ===")

# 턴1: 첫 호출(막힌 지점 찾기 = _localize) — "아예 모르겠어요"
r1 = stuck_helper.generate_hint(pid, "아예 모르겠어요", revealed_node_index=-1)
print("턴1 힌트:", r1["hint_text"])
print("  개념:", r1["next_step_concept"], "| 다음idx:", r1["next_revealed_node_index"],
      "| 근거:", len(r1["reference_nodes"]), "| figure:", r1["figure_urls"], "| has_nodes:", r1["has_solution_nodes"])

# 턴2: 멀티턴
r2 = stuck_helper.generate_hint(pid, "다음 단계도 알려주세요", revealed_node_index=r1["next_revealed_node_index"])
print("턴2 힌트:", r2["hint_text"], "| 다음idx:", r2["next_revealed_node_index"])
print("=== SMOKE OK ===")
```

### 3. 실행

```bash
cd backend/pdf_pipeline && ./venv/Scripts/python.exe -u /tmp/tutor_smoke.py
rm -f /tmp/tutor_smoke.py
```

### 4. 합격 기준 (육안 검증)

| 체크 | 합격 |
|------|------|
| 힌트가 **다음 한 스텝만** 안내 | 전체 풀이/최종 정답을 쏟아내지 않음 |
| 정답 미노출 | conclusion 노드의 최종 수치가 힌트에 안 나옴 |
| 멀티턴 진행 | 턴2의 `다음idx` > 턴1의 `다음idx` |
| 수식 형식 | `\( ... \)` 인라인 LaTeX(KaTeX 렌더 가능) |
| figure_urls | 1차 정책상 `[]`(도형 crop 미사용) |

하나라도 어긋나면 → `handlers/stuck_helper.py` 프롬프트(`_localize`/`_generate`) 또는 노드 품질(`/solution-nodes-status`) 점검.

## 참고

- 핸들러: `backend/pdf_pipeline/handlers/stuck_helper.py` (막힌 지점 찾기→유사 풀이 끌어오기→힌트 만들기)
- API 라우터: `backend/pdf_pipeline/routers/tutor.py` (`POST /api/tutor/hint`)
- 인증까지 포함한 실제 HTTP 검증은 `SUPABASE_ANON_KEY` + uvicorn 기동 + JWT 필요. 이 스모크는 인증 레이어를 건너뛰고 RAG 핵심만 본다.
