# 수학 학원 LMS

고등학생 대상 수학 과외/학원 운영 LMS. 선생님이 교재 문제를 등록하고, 학생에게 숙제를 배포하며, 학습 현황을 분석한다.

> 내부용 비공개 프로젝트.

---

## 기술 스택

- **Frontend**: React 18, TypeScript, Vite, Tailwind CSS, Radix UI, TanStack Query v5, React Router v6
- **Backend (DB/Auth)**: Supabase (PostgreSQL, Auth, Storage)
- **Backend (PDF 파이프라인)**: Python 3.11, FastAPI, EasyOCR + YOLO11 (ultralytics), **VL=OpenAI 단일**(2026-06-19 gemma4 폐기), 임베딩=bge-m3(Ollama). 난이도는 해설 PDF 정답률 우선(없으면 GPT 추정).
- **막힌 지점 도우미 (AI 튜터)**: 풀이 그래프 위치추적 RAG. `pdf_pipeline` 내 `POST /api/tutor/hint` (localize→retrieve→generate). 데이터: `solution_nodes` + RPC. _구 deeptutor(LangGraph 대화) 폐기 — 2026-06-18._
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
2. OCR 또는 YOLO 가 문제 박스를 검출 → `problem_staging` 에 저장.
3. `/pdf-review` 에서 bbox/번호 검수 (수동).
4. 승인 → `problems` 테이블 이관.

### 해설지 태깅
1. CMS `/solution-review` 에서 해설 PDF 업로드.
2. 해설 크롭 + 정답 파싱.
3. "샘플 (앞 4개)" → "이어서" → "전체 재태깅" 으로 VL 태깅 (unit, difficulty, concept/skill, summary, pitfall, solution_steps, common_mistakes).
   - 메타 (Call A) 는 항상 Gemma4 26B
   - solution_steps (Call B) 는 어려운 문제만 OpenAI gpt-5.4-mini, 나머지는 Gemma4
   - 3-layer 검증 (`tag_validator`) 도 같은 임계값으로 OpenAI 분기
4. "문제에 적용" → `problem_staging` 에 병합.

### 막힌 지점 도우미 (풀이 그래프 위치추적 RAG)
1. 학생이 문제 풀다 막힘 → SolveProblem "막혔어요" → `POST /api/tutor/hint` (problem_id, 막힌 서술, revealed_node_index).
2. **localize**: 학생 서술 + 문제 이미지 + 노드 목록으로 "이해한 마지막 노드" 추정 → **retrieve**: 다음 노드 + 유사 기출 노드를 `solution_nodes` pgvector 검색(RPC `search_solution_nodes_for_hint`) → **generate**: 답을 가린 채 다음 한 스텝만 힌트.
3. 서버 무상태 — 클라이언트가 `revealed_node_index` 를 들고 멀티턴("다음 힌트"). `solution_nodes` 는 `backfill_solution_nodes.py` 로 적재.

---

## 상세 문서

- **개발 규칙 / 컨벤션** — `CLAUDE.md`, `.claude/rules/`
- **슬래시 커맨드** — `.claude/commands/` (`/pdf-import`, `/solution-tagging-status`, `/migration-safety`, `/bbox-verify`, `/cms-dev-check`)
- **에이전트** — `.claude/agents/pdf-extractor.md`
- **Supabase 마이그레이션** — 원격 DB 기준 **add_solution_nodes 까지 적용**. 로컬 `supabase/migrations/` 폴더는 **008 + 011_add_solution_nodes** 파일 존재 (009·010 은 원격 직접 적용 — Supabase MCP `list_migrations` 로 확인)

---

## 포트 요약

| 앱/서비스 | 포트 |
|-----------|------|
| CMS | 8081 |
| Teacher | 8082 |
| Student | 8083 |
| PDF 파이프라인 API + 막힌 지점 도우미 (`/api/tutor/hint`) | 8001 |
| Ollama | 11434 |
