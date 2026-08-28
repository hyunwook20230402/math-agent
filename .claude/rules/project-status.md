# 프로젝트 현황

## 완성된 기능

### CMS / 검수 UI
- CMS 탭 기반 레이아웃 (교재 목록, 문제 검수, 상세 입력)
- 교재 폴더 관리 (계층 구조, 드래그 이동)
- PDF 교재 문제 자동 추출 — **문제번호 앵커 기반 분할**(YOLO 는 폴백). 디지털 PDF 는 텍스트
  span 좌표, 스캔본은 **색 라벨로 위치 + OCR 로 번호**(2026-08-26 개편). 실측: 쎈 17쪽
  120/120(옛 방식 70~75), 교사 수정본과 15/15 일치(평균 오차 5.3pt), 디지털 4종 회귀 0.
  상세·함정은 `dev-rules.md` "문제 PDF 크롭".
- **2차 개선 (2026-08-26)** — 교사가 검수한 120개를 정답으로 삼아 반복 오류 제거. 단 경계를
  잉크가 아니라 **문제번호 라벨**에서 잡고(세로 괘선 회피), 탈락 라벨(☆사고의 기술)을 다음
  문제의 시작으로 병합. 실적: 손봐야 할 박스 50→1개, 내용 손실 2→0건, 디지털 4종 회귀 0.
  회귀 검사: `python -m scripts.crop_regression` (고정 데이터 `tests/fixtures/ssen_user_boxes.json`).
- bbox 편집기 (크롭 검수 UI, 수동 편집 전용)
- SolutionReview 같은 번호 묶기 + 그룹 확정 UI + 번호 인라인 편집
- 재태깅 UI (개별/일괄 재실행) + LaTeX 수식 렌더링 (KaTeX)
- 해설 이미지 라이트박스 + 편집 모드 UI 개편
- **풀이 노드 편집기** (2026-06-20, 4차) — 교재 화면(`TextbookManagementNew.tsx`) 문제 카드의 "풀이 노드" 버튼 → `SolutionNodeEditorModal.tsx`(순수 HTML/CSS 모달). 노드 조회·수정·추가·삭제·AI 재추출. 수식은 기존 LaTeX 편집/렌더 부품 재사용. 옛 해설 4섹션(요약/오답포인트/단계별풀이/자주하는실수)은 제거됨.
- **빠른정답 PDF 로 정답 자동 입력** (2026-08-27) — 교재 관리(교재·폴더 행의 ☑)와 상세 입력
  두 곳에서 답지 PDF 를 넣는다. **첫 쪽만 시험 읽기(probe)** 로 판형·견적을 확인한 뒤 전체를
  읽고, 검수 표(지면번호·썸네일·정답)에서 확인 후 일괄 적용. 같은 PDF 재업로드는
  `source_hash` 로 되묻는다. 매칭 기준은 순번이 아니라 **지면번호(`source_label`)**.
  상세·판형별 함정은 `dev-rules.md` "빠른정답", 사용법은 `problem-registration.md`.
- **PDF 업로드 창의 단계 구간 선택** — 파일을 고르면 단계 배너를 찾아 `1~13쪽`·`14~17쪽`
  같은 구간을 **배너 그림과 함께** 보여준다. 누르면 시작/끝 쪽이 채워지므로 B단계 폴더에는
  B단계만 크롭된다. 배너 글자는 안 읽고(OCR 불가) 사람이 그림을 보고 고른다.
- **폴더 드래그 순서 변경** (2026-08-27) — 한 줄을 삼등분해 위/아래 가장자리는 순서 바꾸기,
  가운데는 그 폴더 안으로. 놓을 때 형제 `sort_order` 를 1부터 다시 매긴다(값 중복 해소).
  **교재 경계는 못 넘는다** — 다른 교재 위에서는 드롭 표시선도 안 뜬다.

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
- **답안유형 검출 범위 확대 (2026-08-26)** — 옛 코드는 `내신` 만 보기기호(①~⑤)를 읽고 나머지는
  `short_answer` 고정이었다. 이제 `모의고사`(번호 규칙)를 뺀 모든 카테고리가 검출기를 탄다.
  ⚠️ 단 `answer_type_detector` 는 **텍스트 레이어를 읽으므로 스캔본(쎈)에선 여전히 None** →
  주관식 폴백. 스캔본 객관식 판정은 미해결(시각 검출 시도 결과 정확도 8/16 — 별건).
- **빠른정답 읽기** (2026-08-27) — `pipeline/answer_key_reader.py`. 교재 답지는 텍스트 레이어가
  없거나(스캔본) 있어도 **PUA·DRM 로 깨져** 있어 **단(column) 단위 이미지로 VL 이 읽는다**.
  정답 오독은 학생 오채점으로 이어지므로 **두 번 읽어 대조**(`cross_check`)하고 다른 것만
  검수 표에 표시한다. 모델은 `ANSWER_KEY_MODEL`(gpt-5.2) **명시 주입** — 튜터 모델 변경에
  안 딸려간다. 판형 4종 실측: 교육청 23/23·낙생고 22/22·야탑고 21/21·쎈 120/120.
- **단계 배너 검출** — `pipeline/stage_sections.py` + `POST /api/pdf/sections`. 왼쪽 위 색
  덩어리의 **이어진 높이**로 단계 시작 쪽을 찾는다(배너 6.4% vs 문제번호 라벨 1.0~2.1%).
  **VL 을 안 부른다 → 비용 0.** 배너가 1개 이하면 빈 목록(수동 입력으로 폴백).
- **`scripts/split_folder_by_label.py`** — 지면번호 범위로 폴더를 갈라 담는다.
  `problems` 와 `problem_staging` 을 **둘 다** 갱신한다(CMS 의 폴더 이동은 `problems` 만
  고쳐서 답지 스코프가 어긋난다).

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

### 선생님 앱(teacher, 8082) 대개편 (2026-08-27)

상단 탭 6개로 재편: **대시보드 / 배포하기 / 오답 관리 / 학습보고서 / 출석 / 메시지**
(CMS 는 탭에서 빼고 헤더 우측 작은 버튼만 유지). `TeacherTabNavigation.tsx`(CMS 탭 패턴 복제)
+ `RequireTeacher.tsx`(그전까지 **학생 계정으로도 선생님 화면이 통째로 열렸다**).

- **학생 등록** `/teacher/students` (036) — 이름·학년·학교(필수) + **반 이름 · 등록경로 ·
  등록이유** + 학부모/학생 연락처. **등록경로는 코드로 저장**(`instagram/youtube/referral/blog/
  karrot/etc`, 라벨은 `ENROLL_SOURCE_LABEL`) — 자유 입력이면 표기가 갈려 경로별로 못 센다.
  DB `ck_profiles_enroll_source` 가 같은 목록을 강제. 반 이름은 **이미 쓴 반 목록 + 새로 입력**.
  등록 폼과 목록의 편집 패널이 **같은 `StudentFields` 컴포넌트**를 쓴다 — 두 벌로 두면 한쪽에만
  칸이 생겨 갈라진다(예전에 편집이 연락처만 됐던 이유). 기존 학생도 전체 항목 수정 가능.
- **오답 관리** `/teacher/wrong-answers` — 학생별 오답 목록(**진행도 n/5**·오답 횟수·회차별
  날짜 5칸) + **복습 예약(숙제/다음수업/2주/4주)** + **보충 배포** + **A4 시험지 인쇄**.
  기본 정렬 번호순, 기본 필터 "5회 미달".
  필터 4종: 기간 / **첫 오답일** / 상태 / 다음 회차 예정일. **첫 오답일**은
  **달력에서 고른다**(`FirstWrongDayPicker.tsx`) — 처음엔 날짜 목록 select 였는데 수업이 쌓이면
  항목이 계속 늘어 한눈에 안 들어온다. 달력은 항목 수와 무관하게 크기가 일정하다.
  **오답이 없는 날은 못 고르고**(`disabled`), 고를 수 있는 날엔 칸 안에 문제 수를 같이 찍는다
  (`27` 아래 작게 `17`). 달 이동은 오답이 있는 달 범위로 제한(`fromMonth`/`toMonth`) — 빈 달을
  헤매지 않게. 하루치를 통째로 보는 게 실제 작업 단위라서 넣었다.
  묶는 기준은 `toDateStr(new Date(first_wrong_at))` 로 **표의 `첫 오답` 열과 같은 로컬 날짜**다
  (실측 17/17 일치 — 여기서 어긋나면 "8/27 오답인데 왜 안 보임" 이 된다).
  오답 원천은 **`student_answers`(append-only)** 다. `wrong_answers` 는 정답 시 DELETE 로
  이력이 소실되고 `updated_at` 컬럼이 없어 UPDATE 가 무음 실패하므로 **신규 코드에서 안 쓴다**.
- **오답은 무조건 총 5회**(최초 1회 + 복습 4회, 정답 여부 무관). 학원 현실(결석·숙제 미이행·보강)
  때문에 날짜가 아니라 **횟수**를 추적한다 — 진행도 `total_attempts`, 선생님 신호 `under_target`,
  빈 회차는 `kind='makeup'` 보충 배포로 메운다. 상세 `dev-rules.md` "오답 복습 = 날짜가 아니라 횟수".
- **복습 배포 자동 생성 (2026-08-28)** — 5회는 그대로지만 **배포는 4개**다:
  원본(1회차 + 그 안에서 2회차 당일 재풀이) + **자동 생성 3개**(다음수업 빨 / 2주 주 / 4주 노).
  학생이 과제를 다 풀어 자동 채점되는 순간 `auto_create_reviews_for_distribution`(035)이
  **첫 시도에서 틀린 문제**로 3개를 만든다(멱등). **[복습 예약] 버튼은 화면에서 제거**
  (모달·API 는 보존). 못 만든 경우는 `find_missing_review_batches` 가 오답 관리 배너로 알린다.
  색 팔레트는 `REVIEW_KIND_STYLE`(reviewSchedule.ts) 한 곳 — 배포하기 달력 칩·겹침 색점에 쓴다.
- **복습 예약 = 미래 날짜 배포를 미리 생성**(스케줄러 없음). 그날이 되면 학생 화면에 뜬다.
  밀리면 예약 현황 date input 또는 **배포하기 달력 드래그**로 옮긴다(월 경계 이동 지원).
  생성은 `create_review_distributions` RPC 한 방(부분 실패로 유령 예약이 남지 않게).
  미래 배포 숨김은 프론트(`getStudentDistributions(_, {hideScheduled:true})`,
  `getDistributionById` 날짜 가드)와 **RPC 양쪽**에 있어야 한다(031).
- **학생이 회차를 직접 진행한다 — "오답 숙제하기 (N회차)"** (2026-08-28). 학생 대시보드
  문제집 카드의 버튼 3개(전체 다시 풀기 / 오답만 다시 풀기 / 오답 분석)를 이 버튼 하나로
  바꿨다. 월요일에 틀린 것을 그날 바로 숙제로 내보내려는 것 — 선생님이 예약을 걸지 않아도
  회차가 돈다. 상세 `dev-rules.md` "학생 오답 숙제".
- **학습보고서** `/teacher/reports` — 학생×월. 배포 내역 / 오답 추이(recharts 첫 실사용) /
  출석률 / 선생님 피드백 → **학부모에게 문자 발송**. 저장 시 `snapshot` jsonb 에 집계를
  박제한다(나중에 재풀이해도 보낸 보고서가 안 흔들리게).
- **출석** `/teacher/attendance` — 날짜별 1일 1회, 출석/지각/결석 토글(즉시 upsert) +
  학부모 문자([지각·결석 일괄 알림] 포함).
- **메시지** `/teacher/messages` — 수신자 다중 선택 + `#{학생이름}` 치환 + 미리보기(byte/LMS)
  + 전송 로그. 백엔드 `routers/messages.py`.
- **삭제**: `DistributionPage`(존재하지 않는 컬럼에 insert — 실제로 깨져 있었다),
  `AnalysisPage`(진입점 없는 고아), `ProblemSetManagement`/`FolderManagement`(`folderApi`
  미import 로 렌더 즉시 크래시), `AddProblem`, `NotFound`. 배포 내역은 **배포하기 하단 섹션**으로.
- **배포하기 폴더 이전(실버그 수정)** — `chapters` 를 보고 있어 027 폴더 개편 이후 등록한
  교재가 회차 목록에 **아예 안 떴다**. `problem_folders` + `folderIds`(하위 폴더 포함)로 전환.
- Radix Portal 위반 0건(`StudentAnalysis` 의 기간 Popover 도 native date input 으로 교체).

### DB 마이그레이션
- ✅ **baseline 리셋(2026-06-20)** — 드리프트 해소. 엉킨 001~016 은 `_archive/` 로 치우고, 현재 원격 DB 구조를 `baseline_20260620.sql` 한 장으로 스냅샷(테이블 18 + FK·UNIQUE·인덱스·트리거 + RPC 2개). 이후 변경은 `017_` 부터 순번. 상세 `supabase/migrations/README.md`
  - baseline 에 포함: `solution_nodes`(uses/whys 포함) + RPC `search_solution_nodes_for_hint`, `difficulty_score`/`correct_rate`, `problem_sets` 3지표 avg/p75/max + `recalc_set_difficulty` RPC.
  - `017_fix_recalc_set_difficulty_column.sql` — baseline 이후 첫 변경(세트 난이도 함수 버그 수정).
  - `028_answer_keys.sql` / `029_answer_key_scope.sql` — 빠른정답표(`answer_keys`). 유일성은
    교재가 아니라 **스코프**로 건다: `scope_id GENERATED ALWAYS AS (COALESCE(folder_id,
    textbook_id))` + `uq_answer_keys_scope_label`. `(textbook_id, folder_id, label)` 로 걸면
    Postgres 가 NULL 을 서로 다르게 봐서 교재 전체 답지에 제약이 **전혀 안 먹는다**.
- 4차 정리(015/016 — `_archive/`에 기록): 옛 해설 4컬럼 DROP(problems·problem_staging), `tags`·`problem_sets_new` 테이블 DROP. 결과는 baseline 에 반영됨.
- ℹ️ `student_conversations`/`student_attempts`/`search_similar_problems`(구 deeptutor) 는 **원격에 적용된 적 없음** — deeptutor 폐기로 무의미.

## 향후 작업

- **튜터 고도화** — CMS 해설 도형 수동 bbox 입력 UI(`solution_nodes.figure_image_crop_url` 채우기), 노드 전이 자동 검증(논리 비약 탐지). (대화맥락 주입은 15차에 완료 — `conversation_history` 7턴.)
- **teacher 앱** — 대개편 완료(2026-08-27). 남은 것: 솔라피 계정 발급 후 실발송 전환,
  학습보고서 A4 인쇄(현재 화면+문자만), 출석 → 수업(강의) 단위 확장 여지.
- **student 앱** 오답노트 고도화 (막힌 지점 도우미 연계 UI 포함)
- ~~로컬 migrations 드리프트 해소~~ ✅ 완료(2026-06-20 baseline 리셋)

## 파이프라인 운영 정보

### Provider 전략

| 호출 | Provider | 모델 |
|------|----------|------|
| Call A (메타) | OpenAI | `META_MODEL` (기본 gpt-4o). 해설 태깅은 Call A 한 번뿐(Call B 제거, 4차) |
| 노드 추출 (풀이 그래프) | OpenAI | **난이도 분기**: Lv1~2→gpt-4o(`NODE_MODEL_EASY`) / Lv3~4·불명→gpt-5.2(`NODE_MODEL_HARD`). `call_vl(model=...)` 명시 주입 — OPENAI_MODEL env 무관 |
| 막힌 지점 도우미 (튜터) | OpenAI | **gpt-5.2**(`OPENAI_MODEL`, 품질 우선 유지). 위치추적 effort=medium / 힌트생성 effort=low(자유텍스트). VL timeout 50초 |
| 빠른정답 읽기 | OpenAI | **gpt-5.2**(`ANSWER_KEY_MODEL`). `call_vl(model=...)` 명시 주입 — OPENAI_MODEL env 무관. 실측상 gpt-4o 는 2배 느리고 출력 1.8배, gpt-4o-mini 는 입력 25배 + LaTeX 깨짐 → **싼 모델로 교체 금지**(`dev-rules.md`) |
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
