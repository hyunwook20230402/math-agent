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
- **풀이 노드 편집기** (2026-06-20, 4차) — 교재 화면(`TextbookManagementNew.tsx`) 문제 카드의 "풀이 노드" 버튼 → `SolutionNodeEditorModal.tsx`(순수 HTML/CSS 모달). 노드 조회·수정·추가·삭제·AI 재추출. 수식은 기존 LaTeX 편집/렌더 부품 재사용. 옛 해설 4섹션(요약/오답포인트/단계별풀이/자주하는실수)은 제거됨.

### 파이프라인
- 해설지 PDF 파이프라인 (정답 파싱 + 해설 크롭 + AI 태깅)
- 문제별 개념/스킬 태그 (`problem_tags` 테이블, VL 모델 + bge-m3 정규화)
- 해설 태깅 샘플/이어서 모드 (4개 먼저 → 나머지)
- 단원 계통도 (공통수학1/2, 대수, 미적분I, 확률과 통계 — concepts 375 / skills 359 / units 15)
- unit 자동 매핑 (`unit_matcher.py` bge-m3 cosine) + difficulty_score AI 추출 (정답률 있으면 구간매핑 우선)
- **난이도 (difficulty_score) Lv 라벨/정답률 우선 / 구조 신호 보조** (2026-06-21 4단계 전환) — 해설 PDF 의 인쇄된 **Lv 라벨(Lv1~Lv4)** 이 1순위(Call A 가 읽어 `difficulty_level`→`1~4` 환산), 없으면 정답률(`problems.correct_rate`) 구간매핑(`difficulty_resolver.py`), 둘 다 없으면 구조 신호로 1~4 추정. 옛 1~10 데이터는 미변환·파생 라벨이 5~10 을 `very_hard`(Lv4)로 흡수. 매핑 코드 `difficulty_resolver.py`. 둘 다 "수능 21/29/30번류" 번호 고정 안 함 — 시대 무관.
- **VL = OpenAI** (2026-06-19) — gemma4(ollama)/gemini 폐기. 메타 Call A 와 튜터는 OpenAI. 옛 시간대 분기(`provider_selector`)·난이도 분기(`_route_call_b_provider`)·gemma4 폭주 방어 코드 제거. 임베딩만 bge-m3(ollama) 유지.
- **모델 분리 (2026-06-22)** — 메타 Call A 는 `META_MODEL`(기본 **gpt-4o**). 풀이 노드 추출(`rag_node_extractor.py`)은 **난이도 분기**: Lv1~2(score 1~2)→**gpt-4o**(`NODE_MODEL_EASY`), Lv3~4(score 3~4)→**gpt-5.2**(`NODE_MODEL_HARD`), score 불명/범위밖이면 상위(gpt-5.2). `call_vl(model=...)` 명시 주입이라 `OPENAI_MODEL` env 무관.
- **해설 태깅 = Call A(메타)만** (2026-06-20, 4차) — 옛 단계별풀이(Call B 2-Pass)와 4필드(solution_summary/pitfall/solution_steps/common_mistakes)는 추출·저장·검증·DB컬럼까지 전부 제거. `solution_tagger.py` 는 Call A 한 번으로 메타(unit/difficulty/concept_tags/skill_tags/correct_rate)만 뽑는다. 풀이 그래프는 별도 추출기 `rag_node_extractor.py`(노드 1회 통합)가 담당.
- **태깅 검증 폐기 (2026-06-22)** — 옛 2-layer 검증(`tag_validator.py` + `_apply_suggested_fixes`)은 제거. 파일·호출부·CMS 검증 배너 삭제. `problem_staging` 의 `validation_status/score/issues` 컬럼은 DB 보존이나 항상 NULL. 메타는 Call A 결과를 그대로 저장. ("검수완료 - 전체 AI" → 메타 gpt-4o + 백그라운드 노드 추출(난이도 분기: Lv1~2 gpt-4o / Lv3~4 gpt-5.2) 만 수행.)
- YOLO11n 기본 가중치 (`promote_model` 의존 제거 — 커밋 `56ecdd0`). 재학습은 11m + Optuna (`dev-rules.md` 참조)

### 막힌 지점 도우미 — 풀이 그래프 위치추적 RAG (`backend/pdf_pipeline`) ✅ 구현
- **deeptutor(LangGraph 대화튜터) 폐기 (2026-06-18)** — `backend/deeptutor/` 삭제. 막힌 지점 도우미만 pdf_pipeline 으로 이전·개선.
- API: `POST /api/tutor/hint` (`pdf_pipeline/routers/tutor.py`, `main.py include_router(prefix=/api/tutor)`)
- 흐름: 막힌 지점 찾기(현재 위치 추정) → 유사 풀이 끌어오기(다음 노드+유사 기출 pgvector) → 힌트 만들기(다음 한 스텝 힌트). 서버 무상태(클라이언트가 `revealed_node_index` 보유).
- 핸들러 `handlers/stuck_helper.py`, 노드 추출 `pipeline/rag_node_extractor.py`(해설 1회 통합 VL 분해 + uses/whys), 인증 `auth.py`(`get_student_id`/`get_teacher_id`), 모델 `models.py`
- 노드 CRUD(교사 전용): `routers/nodes.py` — 조회·수정·추가·삭제·재추출. 수정 시 임베딩 자동 재생성, uses(DAG) acyclic 정제, node_index 순번 재매김.
- 데이터: `solution_nodes` 테이블(role/key_concept/output_formula/uses INT[]/whys JSONB/figure_description/embedding 1024) + RPC `search_solution_nodes_for_hint`
- 백필: `python -m scripts.backfill_solution_nodes --limit N` (VL=OpenAI, 임베딩=bge-m3 ollama)
- 도형: 자동 crop 없음 — `figure_description` 언어화만, crop URL 은 CMS 수동 bbox 로 후속. 상세 `dev-rules.md`
- 프론트: `apps/student/SolveProblem.tsx` → `components/tutor/StuckHelperModal.tsx` → `ragHintApi`
- **힌트 품질·안정화 (8~19차, 2026-06-23~24)** — 핵심만(상세 차수별은 `dev-rules.md`):
  - **힌트 모델 gpt-5.2 유지**(품질 우선, 교체 금지). `reasoning_effort`: 위치추적(`_localize`) medium / 힌트생성(`_generate`) low. VL timeout **50초**(프론트 `getHint` 50초와 정합). 힌트 생성은 자유텍스트(`call_vl_text`)로 디코딩 루프 회피.
  - **멀티턴 대화맥락 7턴 주입(15차)** — 프론트가 `conversation_history`(role+text) 전송 → `_localize`/`_generate` 프롬프트에 맥락 주입. 서버는 여전히 무상태(이력은 매 요청 클라가 보냄).
  - **마무리 가드(17~19차)** — 학생이 정답/정답직전 도달 시 VL 없이 종료 유도. 4신호 OR: `revealed≥last-1`(선형 결정론) / `current_index≥last-1`(분기 위치 index 결정론, 19차) / `reached_answer` / `reached_near_answer`(LLM). 노드 index 는 진행순서가 아니라 `uses` DAG 위치라, `_localize` 에 role·uses(DAG)+revealed 를 주입해 case_split 갈래 전환을 퇴행으로 오인 안 함(18차).
  - **수식 렌더(12~14차)** — 프론트 KaTeX + 구분자 밖 평문 LaTeX 폴백(`renderBareSegment`, strict:true → 한글 섞이면 평문). 제어문자·NBSP·화살표 sanitize 양쪽 + localStorage 옛 대화 캐시 자동 정리(`purgeStaleTutorChatCache`, CHAT_CACHE_VERSION). 임베딩 OLLAMA_URL 11434 통일(죽은 21434 터널 제거, 13차).
  - **UI(19차)** — 입력 영역의 "다음 힌트 →"·"아예 모르겠어요 — 처음부터 도와주세요" 버튼 제거(입력창+전송 버튼만).
  - **★8~18차 화면 실패의 진짜 원인(19차 발견)**: 옛 uvicorn 이 포트 8001 점유 → 새 서버 조용히 바인딩 실패 → 수정이 화면 미반영. `/server-check` 로 진단·정리. ("화면 실패" = 코드 아닌 서버부터, `dev-rules.md` ★체크리스트.)

### DB 마이그레이션
- ✅ **baseline 리셋(2026-06-20)** — 드리프트 해소. 엉킨 001~016 은 `_archive/` 로 치우고, 현재 원격 DB 구조를 `baseline_20260620.sql` 한 장으로 스냅샷(테이블 18 + FK·UNIQUE·인덱스·트리거 + RPC 2개). 이후 변경은 `017_` 부터 순번. 상세 `supabase/migrations/README.md`
  - baseline 에 포함: `solution_nodes`(uses/whys 포함) + RPC `search_solution_nodes_for_hint`, `difficulty_score`/`correct_rate`, `problem_sets` 3지표 avg/p75/max + `recalc_set_difficulty` RPC.
  - `017_fix_recalc_set_difficulty_column.sql` — baseline 이후 첫 변경(세트 난이도 함수 버그 수정).
- 4차 정리(015/016 — `_archive/`에 기록): 옛 해설 4컬럼 DROP(problems·problem_staging), `tags`·`problem_sets_new` 테이블 DROP. 결과는 baseline 에 반영됨.
- ℹ️ `student_conversations`/`student_attempts`/`search_similar_problems`(구 deeptutor) 는 **원격에 적용된 적 없음** — deeptutor 폐기로 무의미.

## 향후 작업

- **튜터 고도화** — CMS 해설 도형 수동 bbox 입력 UI(`solution_nodes.figure_image_crop_url` 채우기), 노드 전이 자동 검증(논리 비약 탐지). (대화맥락 주입은 15차에 완료 — `conversation_history` 7턴.)
- **teacher 앱** 숙제 배포/분석 완성도 ↑ (현재 기초 구현 60~70%)
- **student 앱** 오답노트 고도화 (막힌 지점 도우미 연계 UI 포함)
- ~~로컬 migrations 드리프트 해소~~ ✅ 완료(2026-06-20 baseline 리셋)

## 파이프라인 운영 정보

### Provider 전략

| 호출 | Provider | 모델 |
|------|----------|------|
| Call A (메타) | OpenAI | `META_MODEL` (기본 gpt-4o). 해설 태깅은 Call A 한 번뿐(Call B 제거, 4차) |
| 노드 추출 (풀이 그래프) | OpenAI | **난이도 분기**: Lv1~2→gpt-4o(`NODE_MODEL_EASY`) / Lv3~4·불명→gpt-5.2(`NODE_MODEL_HARD`). `call_vl(model=...)` 명시 주입 — OPENAI_MODEL env 무관 |
| 막힌 지점 도우미 (튜터) | OpenAI | **gpt-5.2**(`OPENAI_MODEL`, 품질 우선 유지). 위치추적 effort=medium / 힌트생성 effort=low(자유텍스트). VL timeout 50초 |
| Embed | Ollama | bge-m3 (1024d 고정) |

- VL 은 OpenAI(2026-06-19 gemma4 폐기). 옛 시간대 분기(`provider_selector`)·옛 Call B 난이도 provider 분기(`_route_call_b_provider`)는 제거됨.
- 모델 분리(2026-06-22): 메타=gpt-4o(`META_MODEL`), 노드 추출=난이도 분기(Lv1~2 gpt-4o / Lv3~4 gpt-5.2, `_pick_node_model`). 옛 검증 Layer 2 는 폐기.
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
