# DeepTutor — AI 학습 튜터

LangGraph 기반 다중턴 대화 백엔드. 학생이 문제를 풀고 막혔을 때 단계별 힌트, 오답 진단, 유사 문제 추천을 제공한다.

## 상태: ✅ 운영 중

데이터 소스는 `pdf_pipeline` 이 채운 `problems.solution_steps` / `common_mistakes` / `problem_tags` (개념·스킬 정규화). pdf_pipeline 의 데이터 흐름은 `backend/pdf_pipeline/ARCHITECTURE.md` 참조.

---

## 실행

```bash
cd backend/deeptutor
uvicorn main:app --reload --port 8001
```

> ⚠️ pdf_pipeline 도 8001 사용 — **동시 구동 시 한쪽 포트 변경 필요** (운영에선 분리 배포 가정).

`config.py` 의 `GEMMA_MODEL` / `GEMMA_OLLAMA_URL` 로 LLM 백엔드 지정. 기본은 ollama gemma4:26b 와 동일 서버 풀 공유.

---

## API

| 메서드 | 경로 | 설명 |
|--------|------|------|
| `POST` | `/api/tutor/start` | `{problem_id, student_answer}` → 정오답 판정 + 첫 힌트 + `conversation_id` |
| `POST` | `/api/tutor/chat/{conversation_id}` | `{message}` → LangGraph 노드가 `solution_steps` 단계 진행 / 오답 진단 / 유사 문제 추천 응답 |

상세는 `routers/tutor.py`. 대화 상태는 `student_conversations` 테이블 (마이그레이션 007) 에 저장 — `handlers/conversation_db.py` 가 CRUD.

---

## 구조

```
deeptutor/
├── main.py                       # FastAPI 앱 (포트 8001)
├── config.py                     # 환경변수 (GEMMA_MODEL, OLLAMA_URL 등)
├── auth.py                       # 인증 미들웨어
├── models.py                     # Pydantic API 스키마
├── graph/
│   ├── builder.py                # LangGraph 상태기계 조립
│   ├── nodes.py                  # 노드별 로직 (정오답 판정, 힌트, 진단, ...)
│   ├── state.py                  # GraphState (대화 누적 상태)
│   └── prompts.py                # 노드별 프롬프트 템플릿
├── handlers/
│   ├── conversation_db.py        # student_conversations CRUD
│   └── similar_problems.py       # bge-m3 임베딩 유사 문제 검색
├── routers/
│   └── tutor.py                  # POST /api/tutor/start, /chat/{id}
├── llm/                          # gemma_client 등 LLM 호출 래퍼
├── storage/                      # Supabase 클라이언트
└── scripts/                      # 운영 스크립트 (있다면)
```

LangGraph + 노드 기반 ~800 LOC 규모.

---

## 데이터 활용 패턴

- **단계별 힌트** — `problems.solution_steps` 에서 `step → hint → formula → concept` 순서로 점진 공개
- **오답 진단** — `common_mistakes.text` + `bug_id` 로 taxonomy bugs 카테고리 매칭
- **유사 문제 추천** — `problem_tags.canonical` (concepts/skills) + `unit` + `difficulty` 조합으로 같은 결의 문제 검색. bge-m3 임베딩으로 cosine 보강 (`handlers/similar_problems.py`)

쿼리 패턴 예시는 `backend/pdf_pipeline/ARCHITECTURE.md` §8 참조.

---

## DB 스키마

| 테이블 | 역할 |
|--------|------|
| `student_conversations` | 학생-튜터 대화 (마이그레이션 007) |
| `problems` | 데이터 소스 (solution_steps / common_mistakes 컬럼) |
| `problem_tags` | concept/skill/bug 정규화 |

---

## 운영 메모

- 데이터 품질은 pdf_pipeline 의 태깅 결과에 100% 의존. 태깅 품질이 떨어지면 튜터 답변도 떨어짐 → 검증 에이전트 (`backend/pdf_pipeline/docs/TAG_VALIDATOR.md`) 결과 참조
- 모델 백엔드는 pdf_pipeline 과 동일 ollama 서버 공유 — 동시 부하 시 응답 지연 가능
