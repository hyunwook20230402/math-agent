# 수학 학원 LMS

고등학생 대상 수학 과외/학원 운영 LMS. 선생님이 교재 문제를 등록하고, 학생에게 숙제를 배포하며, 학습 현황을 분석한다.

> 내부용 비공개 프로젝트.

---

## 기술 스택

- **Frontend**: React 18, TypeScript, Vite, Tailwind CSS, Radix UI, TanStack Query v5, React Router v6
- **Backend (DB/Auth)**: Supabase (PostgreSQL, Auth, Storage)
- **Backend (PDF 파이프라인)**: Python 3.11, FastAPI, YOLO11 (ultralytics, OCR 레거시 제거), **VL=OpenAI 단일**(2026-06-19 gemma4 폐기), 임베딩=bge-m3(Ollama). 난이도는 해설 PDF 정답률 우선(없으면 GPT 추정).
- **막힌 지점 도우미 (AI 튜터)**: 풀이 그래프 위치추적 RAG. `pdf_pipeline` 내 `POST /api/tutor/hint` (막힌 지점 찾기 → 유사 풀이 끌어오기 → 힌트 만들기). 데이터: `solution_nodes` + RPC. _구 deeptutor(LangGraph 대화) 폐기 — 2026-06-18._
- **개발 환경**: Windows 11, 로컬 RTX 4070 8GB / 서버 RTX 4090 24GB

---

## 모노레포 구조

```
math/
├── apps/
│   ├── cms/          # 컨텐츠 관리 (8081)
│   ├── teacher/      # 학생/배포 관리 (8082)
│   └── student/      # 학생용 (8083)
├── shared/           # ui, supabase, hooks, types, lib
├── backend/
│   └── pdf_pipeline/ # PDF 문제·해설 추출 + 막힌 지점 도우미 RAG 튜터 (운영 중)
└── supabase/migrations/
```

---

## 빠른 시작

필수 환경변수 (각 앱 `.env.local`):
- `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`

PDF 파이프라인 `.env` (`backend/pdf_pipeline/.env`):
- `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `UPLOAD_DIR`

```bash
# 1. 의존성
npm install

# 2. CMS 개발 서버
cd apps/cms && npm run dev       # http://localhost:8081

# 3. PDF 파이프라인 백엔드
cd backend/pdf_pipeline
pip install -r requirements.txt
uvicorn main:app --reload --port 8001

# 4. VL=OpenAI (OPENAI_API_KEY 필요), 임베딩=bge-m3 (ollama pull bge-m3)
```

---

## 주요 흐름

### 문제 PDF 자동 추출
1. CMS `/pdf-import` 에서 PDF 업로드 (쎈/모의고사).
2. YOLO11 이 문제 박스를 검출 → `problem_staging` 에 저장.
3. `/pdf-review` 에서 bbox/번호 검수 (수동).
4. 승인 → `problems` 테이블 이관.

### 해설지 태깅
1. CMS `/solution-review` 에서 해설 PDF 업로드.
2. 해설 크롭 + 정답·정답률 파싱.
3. "샘플 (앞 4개)" → "이어서" → "전체 재태깅" 으로 메타 태깅 (unit, difficulty, concept_tags, skill_tags, correct_rate). **Call A 한 번**(VL=OpenAI 단일).
   - 옛 단계별풀이(Call B 2-Pass)와 4필드(summary/pitfall/solution_steps/common_mistakes)는 4차에서 제거 — 풀이 그래프는 별도 추출기 `rag_node_extractor.py` 가 담당.
   - 옛 2-layer 태깅 검증(`tag_validator`)은 2026-06-22 폐기 — Call A 결과를 그대로 저장.
4. "문제에 적용" → `problem_staging` 에 병합.

### 풀이 노드 (CMS 편집)
- 교재 화면 문제 카드 "풀이 노드" 버튼 → 노드 편집 모달. 조회·수정·추가·삭제·AI 재추출. 노드는 막힌 지점 도우미 RAG 의 코퍼스(`solution_nodes`). 노드 추출/편집 통로: `pipeline/rag_node_extractor.py`(1회 통합) + `routers/nodes.py`(교사 CRUD).

### 막힌 지점 도우미 (풀이 그래프 위치추적 RAG)
1. 학생이 문제 풀다 막힘 → SolveProblem "막혔어요" → `POST /api/tutor/hint` (problem_id, 막힌 서술, revealed_node_index).
2. **막힌 지점 찾기**: 학생 서술 + 문제 이미지 + 노드 목록으로 "이해한 마지막 노드" 추정 → **유사 풀이 끌어오기**: 다음 노드 + 유사 기출 노드를 `solution_nodes` pgvector 검색(RPC `search_solution_nodes_for_hint`) → **힌트 만들기**: 답을 가린 채 다음 한 스텝만 힌트.
3. 서버 무상태 — 클라이언트가 `revealed_node_index`(+ 최근 대화 7턴)를 들고 멀티턴. `solution_nodes` 는 `python -m scripts.backfill_solution_nodes --limit N` 으로 적재.

---

## 상세 문서

- **개발 규칙 / 컨벤션** — `CLAUDE.md`, `.claude/rules/`
- **슬래시 커맨드** — `.claude/commands/` (`/pdf-import`, `/register-problems`, `/solution-tagging-status`, `/solution-nodes-status`, `/tutor-smoke`, `/migration-safety`, `/bbox-verify`, `/cms-dev-check`, `/server-check`)
- **에이전트** — `.claude/agents/pdf-extractor.md`
- **Supabase 마이그레이션** — **baseline 리셋(2026-06-20)**: 현재 원격 구조를 `baseline_20260620.sql` 한 장으로 스냅샷, 이후 `017_` 부터 순번. 옛 001~016 은 `_archive/`. 상세 `supabase/migrations/README.md`

---

## 포트 요약

| 앱/서비스 | 포트 |
|-----------|------|
| CMS | 8081 |
| Teacher | 8082 |
| Student | 8083 |
| PDF 파이프라인 API + 막힌 지점 도우미 (`/api/tutor/hint`) | 8001 |
| Ollama | 11434 |
