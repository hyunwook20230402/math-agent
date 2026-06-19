# 프로젝트 현황

## 완성된 기능

### CMS / 검수 UI
- CMS 탭 기반 레이아웃 (교재 목록, 문제 검수, 상세 입력)
- 교재 폴더 관리 (계층 구조, 드래그 이동)
- PDF 교재 문제 자동 추출 (YOLO 단일화, OCR 레거시 제거 — 커밋 `0f633eb`)
- bbox 편집기 (크롭 검수 UI, 수동 편집 전용)
- SolutionReview 같은 번호 묶기 + 그룹 확정 UI + 번호 인라인 편집
- 재태깅 UI (개별/일괄 재실행) + LaTeX 수식 렌더링 (KaTeX)
- 해설 이미지 라이트박스 + 편집 모드 UI 개편

### 파이프라인
- 해설지 PDF 파이프라인 (정답 파싱 + 해설 크롭 + AI 태깅)
- 문제별 개념/스킬 태그 (`problem_tags` 테이블, VL 모델 + bge-m3 정규화)
- 해설 태깅 샘플/이어서 모드 (4개 먼저 → 나머지)
- 단원 계통도 (공통수학1/2, 대수, 미적분I, 확률과 통계 — concepts 375 / skills 359 / units 15)
- unit 자동 매핑 (`unit_matcher.py` bge-m3 cosine) + difficulty_score/pitfall/solution_steps/common_mistakes AI 추출
- **난이도 (difficulty_score) 구조 신호 기반 판정** (2026-04-22) — "수능 21/29/30번류" 번호 고정 제거. 경우분리 개수·중첩 깊이·개념 복합도로 1~10 스코어링. 시대 무관.
- **solution_steps 3단 구조** (2026-04-23 필드명 통일) — `hint` (학생에게 보여주는 힌트 문장) + `formula` (핵심 식 \\( ... \\)) + `concept` (이 힌트가 짚는 개념명) 3필드 모두 필수 (null 금지). **개수 강제 폐지** (4차) — 모델이 풀이 복잡도에 맞춰 자유 결정, `CALL_B_MAX_STEPS` (기본 15) 만 상한 안전장치. 이전 이름 `description/formula/reason` 은 코드·문서·UI 5축에서 모두 `hint/formula/concept` 로 통일됨.
- **VL = OpenAI 단일** (2026-06-19) — gemma4(ollama)/gemini 폐기. Call A·Call B·검증·튜터 모두 OpenAI. 옛 시간대 분기(`provider_selector`)·난이도 분기(`_route_call_b_provider`)·gemma4 폭주 방어 코드 제거. 임베딩만 bge-m3(ollama) 유지.
- **Call B 2-Pass** — Pass 1 스켈레톤(role/produces/uses DAG) + Pass 2 step 내용 채움. (과거 per-step 은 gemma4 폭주 방어였으나 OpenAI 단일화로 명분 소멸 — 구조는 그대로 유지.)
- 3-layer 태깅 검증 (`tag_validator.py` — rule / LLM cross-check / 임베딩 자가체크). Layer 2 OpenAI. 상세: `backend/pdf_pipeline/docs/TAG_VALIDATOR.md`
- YOLO11n 기본 가중치 (`promote_model` 의존 제거 — 커밋 `56ecdd0`). 재학습은 11m + Optuna (`dev-rules.md` 참조)

### 막힌 지점 도우미 — 풀이 그래프 위치추적 RAG (`backend/pdf_pipeline`) ✅ 구현
- **deeptutor(LangGraph 대화튜터) 폐기 (2026-06-18)** — `backend/deeptutor/` 삭제. 막힌 지점 도우미만 pdf_pipeline 으로 이전·개선.
- API: `POST /api/tutor/hint` (`pdf_pipeline/routers/tutor.py`, `main.py include_router(prefix=/api/tutor)`)
- 흐름: localize(현재 위치 추정) → retrieve(다음 노드+유사 기출 pgvector) → generate(다음 한 스텝 힌트). 서버 무상태(클라이언트가 `revealed_node_index` 보유).
- 핸들러 `handlers/stuck_helper.py`, 노드 추출 `pipeline/rag_node_extractor.py`(해설 2-pass VL 분해), 인증 `auth.py`, 모델 `models.py`
- 데이터: `solution_nodes` 테이블(role/key_concept/output_formula/figure_description/embedding 1024) + RPC `search_solution_nodes_for_hint`
- 백필: `python -m scripts.backfill_solution_nodes --limit N` (VL=OpenAI, 임베딩=bge-m3 ollama)
- 도형: 자동 crop 없음 — `figure_description` 언어화만, crop URL 은 CMS 수동 bbox 로 후속. 상세 `dev-rules.md`
- 프론트: `apps/student/SolveProblem.tsx` → `components/tutor/StuckHelperModal.tsx` → `ragHintApi`

### DB 마이그레이션
- 원격 DB 기준 **add_solution_nodes** 까지 적용 (Supabase MCP `list_migrations` 확인)
  - 009 `add_validation_columns`
  - 010 `add_difficulty_score` — `difficulty_score` INT 1~10 + 5단계 GENERATED 라벨
  - `add_solution_nodes` (20260618) — `solution_nodes` 테이블 + RPC `search_solution_nodes_for_hint` (튜터 RAG)
- ⚠️ 로컬 `supabase/migrations/` 폴더에는 **008 까지만** 파일 존재. 009/010/011 은 원격 DB 에만 반영된 상태(드리프트). 011 은 로컬에 `011_add_solution_nodes.sql` 파일은 있으나 번호 동기화는 미정. 로컬 재생성 필요 시 Supabase MCP 로 조회
- ℹ️ `student_conversations`/`student_attempts`/`search_similar_problems`(구 deeptutor) 는 **원격에 적용된 적 없음** (로컬 007 파일만 존재 → deeptutor 폐기로 무의미)
- `problem_sets` 3지표 avg/p75/max, `recalc_set_difficulty` RPC 포함

## 향후 작업

- **튜터 고도화** — CMS 해설 도형 수동 bbox 입력 UI(`solution_nodes.figure_image_crop_url` 채우기), 난이도 기반 VL provider 분기(비용), 대화 이력 저장 여부
- **teacher 앱** 숙제 배포/분석 완성도 ↑ (현재 기초 구현 60~70%)
- **student 앱** 오답노트 고도화 (막힌 지점 도우미 연계 UI 포함)
- **로컬 migrations/ 폴더** 에 009/010 SQL 파일 역추출해 커밋 (드리프트 해소)

## 파이프라인 운영 정보

### Provider 전략

| 호출 | Provider | 모델 |
|------|----------|------|
| Call A (메타) | OpenAI | `OPENAI_MODEL` (기본 gpt-4o) |
| Call B (steps) | OpenAI | 2-Pass(스켈레톤 + per-step) |
| 검증 Layer 2 | OpenAI | 난이도 무관 항상 OpenAI |
| 막힌 지점 도우미 (튜터) | OpenAI | localize / generate / 노드추출 |
| Embed | Ollama | bge-m3 (1024d 고정) |

- VL 은 OpenAI 단일(2026-06-19 gemma4 폐기). 시간대·난이도 분기 모두 제거됨.
- 임베딩만 bge-m3(ollama) 유지 — `EMBED_PROVIDER=openai` 로만 강제 전환 가능(차원 1024→1536 주의).

### UPLOAD_DIR

`.env` 의 `UPLOAD_DIR` 가 실제 경로. `config.py` 기본값(`/tmp/pdf_pipeline`) 보지 말 것.
실제: `C:/Users/user/workspaces/math/backend/pdf_pipeline/uploads`

### 데이터 파이프라인 상세

`backend/pdf_pipeline/ARCHITECTURE.md` 참조 — AI 튜터용 데이터 구조 전체 설명.

### YOLO 학습 데이터 경로

현재 UI(CMS) 기반 워크플로우만 사용. GUI 툴은 제거됨(2026-04-19).

| 용도 | 경로 |
|------|------|
| 문제 박스 학습 데이터 | `uploads/problems/dataset/images/`, `labels/` |
| 해설 박스 학습 데이터 | `uploads/solutions/dataset/images/`, `labels/` |
| 학습 스크립트 | `yolo_training/train_finetune.py`, `train_solution_finetune.py` |
| 현재 모델 | YOLO11n 기본 가중치 (`promote_model` 의존 제거) |

**제거된 GUI 툴 (복원 필요 시 git log 참조):**
- `yolo_training/bbox_tool.py`, `bbox_tool_new.py` — tkinter 기반 bbox 수동 라벨링 GUI
- `apply_user_labels.py`, `add_hard_negatives.py`, `labels_new.py`, `labels_output.py`, `visualize_labels.py`, `promote_model.py`, `debug_user_labels/`
