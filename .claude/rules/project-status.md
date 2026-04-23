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
- **Call B per-step loop** (2026-04-23 5차) — gemma4 repetition 폭주 근본 대응. 한방 호출 대신 "step 하나씩 N회 호출, 매번 이미지+누적 steps 재전송" 구조로 전환. 출력 토큰 짧아져 폭주 확률 급감. `{"done": true}` 신호로 루프 종료. 상세: `backend/pdf_pipeline/docs/CALL_B_ROUTING.md`
- **Call B / 검증 OpenAI 분기** (2026-04-22, 4차) — `difficulty_score >= CALL_B_HARD_THRESHOLD` (기본 7) 면 `gpt-5.4-mini` 강제. 검증도 같은 임계값 공유. `_retagged` 마커 + CMS "전체 재태깅" 버튼 추가. 상세: `backend/pdf_pipeline/docs/CALL_B_ROUTING.md`
- 3-layer 태깅 검증 (`tag_validator.py` — rule / LLM cross-check / 임베딩 자가체크). Layer 2 도 OpenAI 분기. 상세: `backend/pdf_pipeline/docs/TAG_VALIDATOR.md`
- Provider 시간대 자동 선택 (`provider_selector.py` — 평일 09-19 KST Ollama, 그 외 OpenAI)
- YOLO11n 기본 가중치 (`promote_model` 의존 제거 — 커밋 `56ecdd0`). 재학습은 11m + Optuna (`dev-rules.md` 참조)

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

### Provider 전략

| 호출 | 조건 | Provider | 모델 |
|------|------|----------|------|
| 시간대 기본 (서버) | 평일 09-19 KST | Ollama | gemma4:26b |
| 시간대 기본 (집) | 그 외 | OpenAI | gpt-4o (provider_selector 기본) |
| Call A (메타) | 항상 | 시간대 기본 | gemma4:26b 우선 |
| Call B (steps) | difficulty < 7 | ollama | gemma4:26b |
| **Call B (steps)** | **difficulty >= 7** | **OpenAI 강제** | **gpt-5.4-mini** |
| 검증 Layer 2 | difficulty < 7 | 시간대 기본 | gemma4:26b |
| **검증 Layer 2** | **difficulty >= 7** | **OpenAI 강제** | **gpt-5.4-mini** |
| Embed | 시간대 기본 | bge-m3 / text-embedding-3-small | |

- `VL_PROVIDER` / `EMBED_PROVIDER` env 로 시간대 무시 강제 override 가능
- `CALL_B_HARD_THRESHOLD` env 로 OpenAI 분기 임계값 조정 (기본 7)
- 서버 Ollama 모델: `gemma4:26b` (19GB, RTX 4090 24GB) — 이전 `gemma3:27b` 는 2026-04-21 교체 → gemma4 운영 중
- Gemini 는 코드에 분기 잔존하지만 운영에서 빠짐 (free tier 한도)
- 상세: `backend/pdf_pipeline/docs/CALL_B_ROUTING.md`

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
