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
- unit 자동 매핑 (`unit_matcher.py` bge-m3 cosine) + difficulty/pitfall/solution_steps/common_mistakes AI 추출
- 3-layer 태깅 검증 (`tag_validator.py` — rule / LLM cross-check / 임베딩 자가체크)
- Provider 시간대 자동 선택 (`provider_selector.py` — 평일 09-19 KST Ollama, 그 외 OpenAI)
- YOLO11n 기본 가중치 (`promote_model` 의존 제거 — 커밋 `56ecdd0`)

### DeepTutor (`backend/deeptutor/`) ✅ 운영
- LangGraph 상태기계: `graph/builder.py` + `graph/nodes.py` (~800 LOC)
- API: `POST /api/tutor/start`, `POST /api/tutor/chat/{conversation_id}` (`routers/tutor.py`)
- 데이터 소스: `problems.solution_steps` / `common_mistakes` / `problem_tags`
- 대화 DB: `student_conversations` 테이블 (마이그레이션 007)
- 유사 문제 검색: `handlers/similar_problems.py`
- 프롬프트: `graph/prompts.py`

### DB 마이그레이션
- 원격 DB 기준 **010** 까지 적용 (Supabase MCP `list_migrations` 확인)
  - 009 `add_validation_columns`
  - 010 `add_difficulty_score` — `difficulty_score` INT 1~10 + 5단계 GENERATED 라벨
- ⚠️ 로컬 `supabase/migrations/` 폴더에는 **008 까지만** 파일 존재. 009/010 은 원격 DB 에만 반영된 상태(드리프트). 로컬 재생성 필요 시 Supabase MCP 로 조회
- `problem_sets` 3지표 avg/p75/max, `recalc_set_difficulty` RPC 포함

## 향후 작업

- **DeepTutor 고도화** — LangGraph 노드 추가 (오답 진단 세분화), 프롬프트 튜닝, 대화 히스토리 요약/압축
- **teacher 앱** 숙제 배포/분석 완성도 ↑ (현재 기초 구현 60~70%)
- **student 앱** 오답노트 고도화 (DeepTutor 연계 UI 포함)
- **로컬 migrations/ 폴더** 에 009/010 SQL 파일 역추출해 커밋 (드리프트 해소)

## 파이프라인 운영 정보

### VL Provider 전략

| 시간대 | VL Provider | Embed Provider |
|--------|-------------|----------------|
| 평일 09-19 KST (서버) | Ollama Gemma4 26B | bge-m3 (Ollama) |
| 그 외 (집) | OpenAI gpt-4o | OpenAI text-embedding-3-small |

- 환경변수 `VL_PROVIDER` / `EMBED_PROVIDER` 로 강제 override 가능
- 서버 Ollama 모델: `gemma4:26b` (19GB, RTX 4090 24GB) — 이전 `gemma3:27b` 는 2026-04-21 교체
- 오프시간 OpenAI 전환은 커밋 `57aff12` 에서 도입. Gemini 는 현재 스택에서 빠짐(README 참고)
- 근무시간은 09~18 → **09~19 KST** 로 확장됨 (커밋 `dd436d6`)

### UPLOAD_DIR

`.env` 의 `UPLOAD_DIR` 가 실제 경로. `config.py` 기본값(`/tmp/pdf_pipeline`) 보지 말 것.
실제: `C:/Users/user/workspaces/math/backend/pdf_pipeline/uploads`

### 서버 세팅 계획 (2026-04-20 기준, 미진행)

- 로컬 push 완료: 커밋 `3326b45`
- 서버에서 실행 예정:
  1. `git pull`
  2. `ollama pull gemma3:27b` (17GB, 10~20분)
  3. Vision ping 검증 후 서버 `.env` 설정 (`VL_MODEL=gemma3:27b`)
  4. `scripts/smoke_test_gemini.py` 로 스모크 테스트
- 완료 시 이 섹션은 삭제 예정

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
