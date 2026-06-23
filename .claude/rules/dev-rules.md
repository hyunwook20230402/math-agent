# 개발 규칙

## UI 컴포넌트 주의사항

**Radix Portal 컴포넌트 (Dialog, Select, DropdownMenu) 사용 금지.**
Vite + React 18 환경에서 Portal 이 DOM 에 렌더링되나 시각적으로 안 보이는 버그. 이벤트도 안 전달됨.

대신:
```tsx
// Dialog → 순수 HTML/CSS 모달
{isOpen && (
  <div className="fixed inset-0 z-[9999] flex items-center justify-center">
    <div className="fixed inset-0 bg-black/80" onClick={() => setIsOpen(false)} />
    <div className="relative z-[10000] bg-background border rounded-lg shadow-lg w-full max-w-lg p-6">
      {/* 내용 */}
    </div>
  </div>
)}

// Select → native <select>
```

Button, Input, Card 등 Portal 안 쓰는 Radix 컴포넌트는 정상 동작.

## 프로젝트 격리 원칙 (필수)

- **`math/` 외부 파일 절대 수정/삭제 금지** — 읽기/복사만 허용
- `C:\potenup3\pj3_deep_learning\` 는 특히 절대 금지 (YOLO 학습 결과물 — 삭제 시 복구 불가)
- 외부 파일 건드려야 할 것 같으면 **반드시 사용자에게 먼저 확인**
- YOLO predict/train 시 `project` 파라미터에 반드시 절대경로 사용 (글로벌 runs_dir 이 외부 경로를 가리킴)

## YOLO / bbox 규칙

- **bbox 자동 보정 코드 추가 금지** — 사용자가 CMS 편집기에서 수동 수정
- YOLO 추론 conf 현재 0.3 (main.py L141)

## YOLO 재학습 기본 방침 (2026-04-21 결정)

- 기본 모델: **YOLO11m** (11n 대비 mAP50-95 소폭 우위, 레거시와 동급 capacity)
- HP 튜닝: **Optuna TPE + MedianPruner** 로 소량 데이터 파인튠 lr 발산 방지
- 이유: 11m 은 소량 데이터 (<200장) 에서 ultralytics 기본 `optimizer='auto'` (AdamW lr=0.002) 로 epoch 2~5 에 발산 — 감으로 lr 잡기 어려움
- 데이터셋별 best HP 영역 다름 — 문제(~102장): AdamW lr~1e-5 wd~4e-2 / 해설(~19장): AdamW lr~1e-3 wd~1e-4. **새 데이터 분포 크게 바뀌면 Optuna 재실행**
- 템플릿 스크립트 (모두 `backend/pdf_pipeline/yolo_training/`):
  - `optuna_search_problem.py`, `optuna_search_solution.py` — HP search (SQLite 에 study 저장)
  - `train_problem_11m.py`, `train_solution_11m.py` — best HP 고정 full train
- 실행 시 반드시 `cd backend/pdf_pipeline/yolo_training` — yaml 내 `../uploads/...` 가 CWD 기준으로 해석됨
- 학습 후 `models/problem_detector.pt` / `solution_detector.pt` **자동 덮어쓰기 금지** — metric 확인 후 수동 `cp`

## VL 모델 정책 (2026-06-22 갱신 — 모델 분리, 검증 폐기 / 2026-06-19 gemma4 폐기·OpenAI화)

- **VL 은 OpenAI.** gemma4(ollama)·gemini 는 폐기. Call A(메타)·튜터(막힌 지점 찾기/힌트 만들기/노드추출) 모두 OpenAI.
  - 옛 시간대 분기(`provider_selector`)·난이도 분기(`_route_call_b_provider`, `CALL_B_HARD_THRESHOLD`)·gemma4 반복 폭주 방어 코드는 모두 제거됨.
- **모델 분리 (2026-06-22).** 메타 Call A 는 `META_MODEL`(기본 **gpt-4o**, `solution_tagger.py`). 풀이 노드 추출(`rag_node_extractor.py`)은 **난이도(`difficulty_score`)로 분기** — `_pick_node_model()`: **Lv1~2(score 1~2)→gpt-4o(`NODE_MODEL_EASY`)**, **Lv3~4(score 3~4)→gpt-5.2(`NODE_MODEL_HARD`)**. score 가 없거나(None)·범위 밖(옛 1~10 데이터의 5~10 등)이면 안전하게 **상위(hard=gpt-5.2)**. `call_vl(model=...)` 로 분기 결과를 명시 주입하므로 `OPENAI_MODEL` env 무관. env(`META_MODEL`/`NODE_MODEL_EASY`/`NODE_MODEL_HARD`)로 덮어쓸 수 있다(옛 `NODE_MODEL` env 는 hard 기본값으로 하위호환 흡수). 난이도 분기 근거: 쉬운 문제는 논리 분해가 단순해 gpt-4o 로 충분, 어려운 문제만 도형 언어화·경우분리가 무거워 gpt-5.2 필요.
- **태깅 검증 폐기 (2026-06-22).** 옛 2-layer 검증(`tag_validator.py` + `solution_tagger._apply_suggested_fixes`)은 통째 제거. 파일 삭제 + 호출부 제거(`solution_tagger`/`solution_matcher`) + CMS 검증 배너 제거(`ProblemDetail.tsx`). `problem_staging` 의 `validation_status/score/issues` 컬럼은 **DB 보존이나 항상 NULL**(되돌리기 쉽게 DROP 안 함). 메타는 Call A 결과를 그대로 저장. "검수완료 - 전체 AI" 한 번에 메타(gpt-4o) + 백그라운드 노드 추출(난이도 분기: Lv1~2 gpt-4o / Lv3~4 gpt-5.2)이 같이 돈다(노드 자동추출은 이미 `approve_all` 에 묶여 있음).
- **해설 태깅 = Call A(메타) 한 번** (2026-06-20, 4차). 옛 단계별풀이 Call B(2-Pass)와 4필드(solution_summary/pitfall/solution_steps/common_mistakes)는 추출·저장·검증·DB컬럼까지 전부 제거. 풀이 그래프는 별도 추출기 `rag_node_extractor.py` 가 담당.
- **임베딩은 그대로** — bge-m3(ollama, 1024차원) 유지. OpenAI 임베딩(1536)으로 바꾸면 전체 재임베딩 필요라 안 바꿈. `EMBED_PROVIDER=openai` 로만 강제 전환 가능.
- 그 외 유료 API (Gemini / Anthropic / 다른 모델) 도입은 금지.
- 품질 개선은 VL 교체 대신 프롬프트 튜닝, 후처리 강화, 구조화 스키마 (Pydantic structured output) 로 접근.
- **노드 role 라벨링**(`rag_node_extractor.py`): 각 노드에 `role` 필드 (5종: condition_analysis / equation_setup / case_split / computation / conclusion). 1회 통합 추출로 전체 노드 배열을 받고, 노드마다 `uses`(이전 node_index 참조 = 전이 근거 DAG)·`whys`({question,reason} = 논리 완결성)를 포함. role 별로 hint·formula·whys 톤을 조정(유형별 프롬프트 라우팅). reject 시 재시도 없음 (CMS 노드 편집기에서 수동 보정).

## 모델 파일 동기화

- 학습 기본은 **서버** (평일 GPU 접근 가능). 주말 등 서버 미사용 시 **로컬 학습** 허용 — 기능적으로 동일
- `backend/pdf_pipeline/yolo_training/models/` 에 **문제/해설 2개 .pt 파일만 존재** — .gitignore 대상 (git 동기화 불가)
- 재학습 직후 반대편으로 `scp` 덮어쓰기:
  - 서버→로컬 (PowerShell): `scp wanted-1@wanted-1:/home/wanted-1/WantedPotenUp/personal/hyunwook/math/math-agent/backend/pdf_pipeline/yolo_training/models/*.pt C:\Users\user\workspaces\math\backend\pdf_pipeline\yolo_training\models\`
  - 로컬→서버: 경로 반대로
- 학습 위치는 커밋 메시지나 `runs/` 디렉토리명에 기록 (혼선 방지)

## 의사결정 규칙

- **근본 해결 우선** — 휴리스틱 땜질 지양. 구조/모델/아키텍처 교체를 중심축으로 두고, 시간/비용 클 때만 단기 완화책 병기
- **UX 결정은 확인받기** — 디렉토리 구조, 폴더명, 파일 경로, UI 텍스트 등 사용자 눈에 보이는 것은 임의 결정 금지. 함수명/정규식/알고리즘은 알아서 판단
- 제안 시 옵션 나열보다 **추천안 + 이유** 명확히 제시

## 서버 규칙

- 서버(`wanted-1@wanted-1`)에서 **Claude Code 사용 금지** — 공용 서버라 다른 유저 코드 파일 건드릴 위험
- 로컬에서만 코드 수정 → commit → push. 서버는 `git pull` + 런타임 명령만
- 예외: `ollama pull`, `pip install`, `uvicorn` 기동 등 런타임 명령은 서버 셸에서 직접 가능

## 로컬 → 서버 Ollama 임베딩 사용 (2026-06-19 갱신)

VL 은 OpenAI 단일이라 더 이상 ollama 터널이 필요 없다. **임베딩(bge-m3)만** 로컬 GPU 대신 서버 GPU 를 쓰고 싶을 때 아래 터널을 건다.

**준비물**
- 서버 ollama 는 `127.0.0.1:11434` 만 바인딩 (`ollama` 유저 소유 프로세스라 건드리지 말 것)
- Tailscale 로 로컬 ↔ 서버 연결 (`100.95.34.69`)
- 로컬 PC 에도 ollama 가 돌고 있어 11434 포트 충돌 — 우회 포트 `21434` 사용

**1. SSH 포트포워딩 (로컬 PowerShell 새 창, 닫으면 터널 끊김)**
```
ssh -N -L 21434:localhost:11434 wanted-server
```
비번 입력 후 멈춘 듯 가만히 있으면 성공. `curl http://localhost:21434/api/tags` 로 모델 목록 뜨면 OK.

**2. `backend/pdf_pipeline/.env` 패치 (임베딩만)**
```
OLLAMA_URL=http://localhost:21434
EMBED_MODEL=bge-m3
```

**3. VL 은 OpenAI 키만 있으면 됨**
```
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-4o
```

## 알려진 이슈 및 해결책

### Ollama embedder 500 에러 (2026-04-21 해결)
- 증상: `Ollama 접속 실패 → OpenAI fallback (batch): 500 Server Error for url: .../api/embeddings`
- 원인 1: 신버전 ollama 는 `/api/embeddings` (구) 가 긴 한글 텍스트에서 500 — `/api/embed` (신) 사용해야 함
- 원인 2: 파이프라인이 한 번에 수백 개 텍스트 배치 → 서버 OOM
- 해결: `pipeline/embedder.py` 에서 `/api/embed` + 32개 청크 분할

### solution_jobs status 박제 (재발 가능)
- 증상: 태깅 실패/중단 후 `upload-and-tag` 가 400 `태깅 가능 상태 아님: tagging` 반환
- 원인: 실패 경로에서 `status='error'` 복구 업데이트 없음 + uvicorn 메모리 dict 에 상태 남음
- 해결:
  1. Supabase MCP `execute_sql` 로 `UPDATE solution_jobs SET status='reviewing' WHERE id='...'`
  2. `taskkill /F /IM python.exe` (Ctrl+C 안 먹을 때) — **주의: 모든 python 프로세스 죽음**
  3. uvicorn 재기동 (메모리 초기화 필수 — `--reload` 만으론 `solution_jobs` dict 안 비워지는 경우 있음)
  4. 재기동 직후 status 가 `reviewing` 인지 확인 후 샘플 태깅 재시도

### uvicorn 종료 안 됨 (백그라운드 태스크 대기)
- 증상: Ctrl+C 여러 번 눌러도 `Waiting for background tasks to complete. (CTRL+C to force quit)` 에서 멈춤
- 원인: OpenAI fallback 호출 등 긴 요청 대기 중
- 해결: 새 PowerShell 창에서 `taskkill /F /IM python.exe`

## 로컬 실행 환경 (자주 묻는 것)

터미널 2개로 나눠 실행. 혼동 금지.

**백엔드 (Python, venv 필요)**
```
cd backend/pdf_pipeline
venv\Scripts\activate        # (venv) 프롬프트 확인
uvicorn main:app --reload --port 8001
```
- `(venv)` 프리픽스 없으면 전역 Python 으로 돌아 Pillow/ultralytics 꼬임
- `Uvicorn running on http://127.0.0.1:8001` + `Started reloader process` 두 줄 뜨면 정상 기동

**CMS (Node.js, venv 무관)**
```
cd apps/cms
npm run dev                  # http://localhost:8081
```
- Node 앱이므로 venv activate 불필요. 브라우저 접속도 venv 와 무관
- teacher=8082, student=8083 동일 원칙

### ⚠️ 에이전트(Claude)가 서버 띄울 때 — 백그라운드 금지, 독립 창으로 (2026-06-21)

**서버(uvicorn·vite)를 Bash `run_in_background` 로 띄우지 말 것.** 백그라운드 셸은 에이전트
턴이 끝나거나 다음 명령을 시작할 때 harness 가 정리하며 **서버까지 같이 종료**시킨다 → 작업할
때마다 서버가 죽어 "중지됨" 이 반복된다(2026-06-21 다회 발생). 에이전트가 죽인 게 아니라 실행
방식 문제.

**반드시 `Start-Process` 로 세션과 분리된 독립 창에 띄운다:**
```powershell
Start-Process cmd -ArgumentList '/k','cd /d C:\Users\user\workspaces\math\apps\cms && npm run dev' -WindowStyle Minimized
Start-Process cmd -ArgumentList '/k','cd /d C:\Users\user\workspaces\math\backend\pdf_pipeline && call venv\Scripts\activate.bat && uvicorn main:app --reload --port 8001' -WindowStyle Minimized
```
- 이러면 에이전트가 다른 명령을 돌려도 안 죽는다. 작업표시줄 최소화 cmd 창 = 서버.
- 끄려면 그 창을 닫는다. **`taskkill`·`Stop-Process` 등 강제 종료 금지**(사용자 명시 요청).
- 기동 확인은 `netstat` 리스닝 + `Invoke-WebRequest` HTTP 200 으로.

### ⚠️ 에이전트(Claude) 도구 호출 형식 — `antml:` 접두어 필수 (2026-06-21)

**도구 호출 태그는 반드시 `antml:invoke`/`antml:parameter` 정식 형식으로 써야 한다.**
접두어 없이 `<invoke ...>` 로 쓰면 harness 가 파싱 못 해 `malformed and could not be
parsed` 에러가 나고 그 턴이 멈춘다("또 멈췄다" 의 진짜 원인). 서버·환경 문제가 아니라 순전히
출력 형식 실수다(2026-06-21 다회 발생).

재발 방지: 도구를 부를 때 한 호출씩, 접두어를 눈으로 확인하고 보낸다. 여러 도구를 빠르게
연속으로 칠 때 접두어를 빠뜨리기 쉬우니 속도를 줄인다.

## 비용 절감 규칙

- 파일 탐색/검색 → Explore subagent 위임
- 단순 CRUD, 컴포넌트 작성에 Opus 사용 금지 (Sonnet으로 충분)
- 대규모 탐색 완료 후 구현 시작 전 `/compact` 실행
- `--no-verify` 사용 금지 (hook으로 차단됨)

## 해설지 파이프라인 — 재발 방지 체크리스트

(2026-04-19 다회 발생한 버그들 → 해결 완료. 자세한 원인/해결은 git log + 커밋 메시지)

- **uvicorn 재시작 전 좀비 확인**: `netstat -ano | findstr :8001` → `Stop-Process -Id <PID> -Force`
- **dict 키 타입 불일치**: page_bboxes 같은 key 일치 필수. `dict.get(int) or dict.get(str(int))` 패턴
- **PIL ↔ numpy 변환**: `_trim_whitespace` 같은 cv2/numpy 기대 함수에 PIL Image 직접 전달 금지
- **React useCallback stale closure**: state 의존하는 콜백은 `useRef` 동기화 패턴
- **stage 복구 분기**: 빈 결과여도 stage 업데이트는 early return 전에 호출

(백엔드 포트 8001 / CORS 정책은 루트 README + ARCHITECTURE 참조 — 한 곳에서만 관리)

## 막힌 지점 도우미 — 풀이 그래프 위치추적 RAG 튜터 (2026-06-18 재설계)

**deeptutor 폐기.** LangGraph 다중턴 대화튜터(`backend/deeptutor/`)는 전부 삭제. 그 코드/프롬프트는 참고하지 않는다. 막힌 지점 도우미 기능은 `pdf_pipeline` 으로 이전·개선됨.

- **목적**: 학생이 풀다 막힌 "그 지점"을 풀이 노드 그래프 위에 위치추적하고 다음 한 노드만 끌어준다. 막힌 원인 4분류(독해/인출/전이/실행)를 한 흐름으로 흡수. 등록 대상은 수능/모의고사 2점·3점·쉬운 4점.
- **위치**: `backend/pdf_pipeline` FastAPI(포트 8001)에 통합. 별도 서버 없음.
  - 라우터 `routers/tutor.py` → `POST /api/tutor/hint` (`main.py` 에 `include_router(prefix="/api/tutor")`)
  - 핸들러 `handlers/stuck_helper.py` — 막힌 지점 찾기 → 유사 풀이 끌어오기 → 힌트 만들기 3단
  - 노드 추출 `pipeline/rag_node_extractor.py` — 해설 이미지 **1회 통합** VL 분해(전체 노드 배열 1회 structured output). 각 노드에 `uses`(이전 node_index 참조=전이 근거 DAG)+`whys`({question,reason}=논리 완결성) 포함. VL=OpenAI 단일. (`solution_tagger` 의 옛 단계별풀이 Call B 는 4차에서 통째 제거 — 이제 메타 Call A 한 번뿐. 풀이 그래프는 이 추출기만 담당.)
  - 노드 편집(교사) `routers/nodes.py` — CMS `SolutionNodeEditorModal` 용 CRUD(조회·수정·추가·삭제·재추출). 수정 시 `compose_embedding_text()` 재합성 + bge-m3 재임베딩, `uses` DAG acyclic 정제, `node_index` 순번 재매김. 인증 `get_teacher_id`(teacher role 강제).
  - **유형별 프롬프트 라우팅(2026-06-19)**: `_compose_extraction_prompt()` 가 베이스 프롬프트에 [과목 조각 또는 혼합형 패턴 조각] + (difficulty>=7 이면) 난이도 조각을 1개씩 덧붙인다. 거대 프롬프트도 과목별 서브에이전트도 아님 — `problem.unit`(첫 토큰=과목)·`difficulty_score` 가 이미 있어 분류 비용 0. 혼합형 판정은 1차 단순 규칙(difficulty>=8). unit 무매핑/패턴 없음이면 베이스만(graceful). few-shot 예시 주입은 검증 노드 표본이 쌓인 뒤(후속).
  - **answer leakage 방지**: `stuck_helper`가 whys.question만 소크라테스 질문으로 노출(reason은 배경 근거), conclusion 노드 최종 수식 제외, 힌트 보기기호/정답 패턴 경고. uses/whys 컬럼+RPC 는 baseline 에 포함. LaTeX 조합기호 `{}_nC_r` 프롬프트 강화 + `_fix_latex_subscript_escapes`(저장 직전 `\_`→`_`).
  - **RAG 배포 의존성 순서: 마이그레이션 → 코드 → 테스트.** RPC `RETURNS TABLE` 시그니처 변경은 `CREATE OR REPLACE` 불가 → `DROP FUNCTION ... CASCADE` 먼저. 코드 먼저 배포하면 RPC 시그니처 불일치로 런타임 500.
  - 인증 `auth.py` — `get_student_id`(Bearer JWT → profiles.id, student role 강제). `SUPABASE_ANON_KEY` 필요
  - 모델 `models.py` — `HintRequest`/`HintResponse`/`NodeReference`
- **DB**: `solution_nodes` 테이블(uses/whys 포함, baseline 에 반영) + RPC `search_solution_nodes_for_hint`. 임베딩 **bge-m3 1024차원**(problems.embedding 과 동일 — OpenAI 1536 혼입 금지).
- **VL**: `call_vl()` 통일(막힌 지점 찾기/힌트 만들기/노드추출 멀티모달). OpenAI 단일.
- **튜터 힌트 모델·타임아웃 정책 (2026-06-23)**: 힌트(`stuck_helper` _localize/_generate)는 **`OPENAI_MODEL`(gpt-5.2) 유지**(품질 우선, 사용자 결정). 추론 모델이라 느려서 다음으로 대응 — ① VL timeout **90초**(`_VL_TIMEOUT`), `_call_openai` 가 `with_options(timeout=)` 로 실제 적용. ② `_generate` 재시도는 **timeout 예외엔 즉시 실패**(2배 대기 방지), rate limit/5xx 만 1회 재시도. ③ 프론트 `ragHintApi.getHint` 는 AbortController **95초** timeout + 친화 에러. 단계별 시간은 `[TUTOR] ... total=Xs` 로그로 관찰.
- **튜터 gpt-5.2 안정화 (2026-06-23, 8차)**: gpt-5.2(추론 모델)는 **structured output(JSON 강제)에서 같은 문자 반복 디코딩 루프**에 빠져 출력이 깨짐(제어문자·` ` 무한반복→JSON 잘림). 해결:
  - **힌트 생성(_generate)은 structured output 폐기 → 자유 텍스트** `call_vl_text()`(vl_providers, `responses.create`, text_format 없음). 반환 텍스트를 `_fix_latex_subscript_escapes` 후처리 후 `_Hint(hint_text=…, next_step_concept=None)` 로 감쌈(호출부 호환). 자유 텍스트는 루프가 없어 한 방에 정상. `next_step_concept` 는 모델이 안 주므로 None(프론트 개념 배지 생략).
  - **reasoning effort**: 힌트 `low`(짧은 출력, thinking 최소), 위치추적 `_localize` `medium`(대조 추론 정확도). `call_vl(..., reasoning_effort=…)` → `responses.parse` 에 `reasoning={"effort":…}` 주입. `max_tokens=2000`(thinking+출력 합산 여유).
  - **verbosity 미사용**: Responses API 가 `text.verbosity` 로 받는데 `text_format` 과 병합이 까다로워 적용 안 함(프롬프트 "1~2문장" 으로 길이 제어). call_vl 의 verbosity 인자는 받아두되 무시.
  - **_localize 는 structured 유지**(index 정수 짧아 루프 안 깨짐) + CoT 프롬프트(reasoning 필드에 단계 결과식 대조 먼저).
  - 근거 노드 `_retrieve(limit=4)`(5→4 경량화). 7차 재생성 방어·끝 도달 종료 안내는 보조로 유지.
- **튜터 잔존 버그 2종 (2026-06-23, 9차)**: 8차 배포 후 학생 화면(평가원 6월 26년 1번, 5노드)에서 재현된 두 갭 수정.
  - **대문자 `W` 수식 깨짐**: gpt-5.2 가 `\(` 를 소문자 `\w(` 뿐 아니라 **대문자 `\W(`** 로도 깨뜨린다. 8차 보정 정규식 `_LATEX_BROKEN_DELIM`(`vl_providers.py`)이 소문자만 잡아 `\W(` 가 통과→raw 노출→화면에 'W' 만 남음. 정규식을 `r'\\w(?=[\(\[])'` → **`r'\\[wW](?=[\(\[])'`** 로 확대(백엔드 + 프론트 `StuckHelperModal.tsx` renderMath 일괄). lookahead 라 정상 텍스트·정상 명령(`\frac` 등 뒤에 괄호 없음)·영어 단어는 안 건드림. (백슬래시가 통째로 사라지는 변형은 이 정규식으로 못 잡으니, 재발 시 로그 `[latex] 깨진 구분자 복원` 으로 실제 출력 확인.) CMS(`SolutionNodeEditorModal`/`ProblemDetail`)는 노드가 DB 저장 전 백엔드 보정을 거쳐 정상이라 미수정(선택).
  - **멀티턴 마지막 직전 무응답(timeout)**: 끝 도달 가드(`stuck_helper.generate_hint`)가 `current_index >= last_idx`(이미 마지막)만 막아, **마지막 직전**(다음이 conclusion=정답)이면 VL 호출 → conclusion 근거는 output_formula(정답) 제외라 빈약 → gpt-5.2 가 "정답 금지+근거 없음" 모순에서 thinking 폭주 → 90초 timeout → 무응답. 가드를 **`current_index >= last_idx - 1`** 로 확대 → VL 호출 없이 종료 안내로 전환. `revealed_node_index >= 0` 체크 유지로 첫 호출(노드 1개 문제 포함) 보호. 종료 문구를 사용자 결정대로 **"거의 다 왔어요! 마지막 한 걸음만 남았는데, 정답은 직접 알려줄 수 없어요…"** 톤으로 교체(정답 직전이면 마무리). 부작용: 마지막 직전 힌트 1개 덜 주지만 정답 노출/timeout 회피 우선(사용자 명시). 검증: 5노드 문제 멀티턴이 turn별 next_idx 0→1→2→3 정상 힌트, revealed=3 도달 turn에서 종료 안내(ref=0, VL 호출 없음).
- **튜터 정답 인정 + 특수문자 깨짐 (2026-06-23, 10차)**: 9차 후에도 (1) 학생이 정답("1/a라 1/3이네요")을 말해도 인정 안 하고 같은 질문 반복, (2) 힌트에 `▲▲▲`·NBSP(` `) 등 특수문자 노출. 두 갭 수정.
  - **학생 정답 인정(옵션 B)**: 근본 원인 — 멀티턴에서 `_localize` 가 안 돌고(`revealed_node_index` 만 그대로 current_index 로 씀) 학생 발화 판정 로직이 전무. 해결: **매 턴 `_localize` 실행**(첫/멀티 구분 제거)해 학생 발화를 노드 결과식과 대조. `_Localized` 스키마에 **`reached_answer: bool`** 추가(마지막 노드 output_formula 를 프롬프트에 주고 "정답 도달했으면 true, 애매하면 false 보수적"). `generate_hint`: ① 퇴행 방지(localize 결과 < revealed & not reached → revealed 유지, 단 reached 면 정답 점프 허용), ② **정답 인정 경로**(reached_answer & revealed>=0 → VL `_generate` 없이 "정확해요! 잘 따라왔어요…" 마무리, ref=0, 정답 수치 직접 안 말함), ③ 9차 끝 가드 유지(reached 아닐 때). `_generate` 프롬프트에도 "학생 말이 이미 맞으면 또 묻지 말고 인정" 보조 지시. 비용: 멀티턴 매 턴 _localize +5~10s(medium), 정답 도달 턴은 _generate 스킵으로 상쇄. 검증: 평가원 6월 26년 1번 멀티턴에서 턴2 "3^(2/3)까지" → 위치 점프+인정, 턴3 "1/3이 답" → reached_answer 인정+마무리(ref=0).
  - **특수문자 강제 제거 + 프롬프트**: `_strip_control_chars`(vl_providers.py) 확장 — NBSP(`\xa0`)→일반 공백, 제로폭(`​-‏` 등)·방향제어(`‪-‮`,`⁦-⁩`)·BOM 제거, 화살표 `↑↓←→`(U+2190/2/1/3) **4개만** 제거(정상 수식은 `\rightarrow` LaTeX, ▲ 등 도형문자는 보존 — 과잉제거 방지). `_localize`/`_generate` 프롬프트에 "특수공백·화살표·제로폭 금지, 일반 ASCII·LaTeX 명령만" 명시. 프론트 renderMath 도 동일 정리(이중 안전, 캐시 옛 대화 방어). 한글·정상 LaTeX 무손상 단위테스트 통과. 재발 시 로그 `[latex] 제어/특수문자 제거·정규화` 로 실제 문자 확인 후 확대.
- **튜터 힌트 LaTeX 렌더 KaTeX→MathJax 전환 (2026-06-23, 11차)**: 9·10차 후에도 `\sqrt[3]{9}`(세제곱근)가 `✓[3]9` 로 raw 노출. **근본 원인**: gpt-5.2 가 자유텍스트 힌트에서 수식 구분자 `\(...\)` 를 **일관되게 안 붙임**(일부 평문·일부 raw LaTeX). student `StuckHelperModal.renderMath` 가 **KaTeX + 정규식 직접 파싱**이라 구분자 빠진 raw 수식을 못 잡아 `escapeHtml` 로 평문 노출 → `\sqrt`가 `✓`로 보임. 9·10차 정규식 땜질은 표면만 가림. **이중 방어로 근본 해결(사용자 "절대 안 나오게")**:
  - **프론트: KaTeX 정규식 → MathJax(`shared/ui/MathText`) 전환.** MathJax 는 구분자 빠진 raw 수식도 관대하게 렌더(CMS 가 이미 쓰던 컴포넌트). `apps/student/package.json` 에 `better-react-mathjax@^2.3.0` 추가, `App.tsx` 에 CMS 와 동일한 `MathJaxContext`(inline `\(\)`/block `\[\]`/ams) Provider 추가. `StuckHelperModal`: `renderMath`(KaTeX 정규식)·`katex` import 제거 → 경량 `sanitizeHintText`(NBSP/제로폭/화살표만, 캐시 옛 대화 방어) + `<MathText text={...} inline={false} />`. `MathText` 에 `inline` optional prop 추가(기본 true=인라인전용, 힌트는 `inline={false}`=블록허용). EditableMath(유일 기존 사용처)는 인자 안 줘서 무영향. **번들 859kB→606kB 감소**(KaTeX+CSS 제거, MathJax 런타임 로드).
  - **백엔드: `_generate` 프롬프트로 모든 수식 `\(...\)` 강제 + few-shot.** "평문 수식 절대 금지, 답변 뒤 모든 수식에 `\(...\)` 붙었는지 재확인" + 근호/분수/지수/첨자 좋은·나쁜 예. 검증: 평가원 6월 26년 1번 힌트가 `\(\sqrt[3]{9}\)`·`\(3^2\)`·`\((3^2)^{\frac{1}{3}}\)` 등 **모든 수식을 `\(...\)` 로 감쌈**(이전엔 raw 노출).
  - **유지**: 백엔드 `_fix_latex_subscript_escapes` 전체(MathJax 도 `\W(` 는 못 읽고 NBSP 는 공백처리 안 함 — 이중 안전). 프론트 `sanitizeHintText`(특수문자만). **제거**: 프론트 KaTeX 정규식 파싱(`renderMath`).
  - ⚠️ **11차는 잘못된 가정에 기반 — 12차에서 롤백됨(아래 참조).** "MathJax 가 구분자 빠진 raw 도 관대하게 렌더"가 **틀렸다**(실측 반증). 이 항목의 전제·"재발 방지 원칙(MathJax 통일)"은 무효.
- **튜터 힌트 LaTeX — 11차 MathJax 롤백 + 제어문자 차단 (2026-06-23, 12차)**: 11차 MathJax 전환 후 학생 화면이 `▮!19¶` 무한반복·`▲ile000` 로 **완전히 깨짐**. **Preview MCP 로 실제 브라우저 진단(추측 아님, 실측)**:
  - **MathJax 는 KaTeX 보다 관대하지 않다(핵심 반증).** 실측 — 정상 `\(\sqrt[3]{9}\)` 는 둘 다 렌더하지만, **구분자 빠진 raw·중괄호 불균형·제어문자 오염은 KaTeX·MathJax 둘 다 mjx/katex 생성 0, raw 노출**. `\(...\)` 가 정확할 때만 렌더하는 건 동일. → **11차 전환은 이득 0**(MathText.tsx 주석 "KaTeX 보다 관대"도 오류).
  - **화면 깨짐의 `▮`(U+0001)·`¶`(U+0019) 은 제어문자.** 백엔드 `_strip_control_chars` 는 제어문자를 100% 거름(검증). 그런데 보였다 = **localStorage 에 캐시된 옛 대화**(sanitize 적용 전 백엔드 생성분) + 프론트 `sanitizeHintText` 가 제어문자를 안 거름(NBSP/제로폭/화살표만)이 원인.
  - **해결(사용자 결정)**: ① **11차 MathJax 롤백 → KaTeX 복귀**(`git checkout 5956dac` 로 App.tsx·package.json·MathText·StuckHelperModal 4파일 되돌림 + 9차 대문자 `\W` 보정 재적용). better-react-mathjax 의존성 제거, CMS 와 렌더 방식 일관성 회복(student=KaTeX renderMath, CMS=각자). ② **프론트 `sanitizeHintText` 에 제어문자 strip 추가**(`/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/` = C0+C1, `\t\n\r` 보존) — renderMath 맨 앞에서 적용. ③ **localStorage 캐시 version=2**: 복구 시 version 불일치면 폐기(옛 제어문자 캐시 무력화), 저장 시 각 turn.text sanitize. 검증: Preview 실측 — KaTeX `\sqrt[3]{9}` 정상 렌더, 제어문자(U+0001/0019/00a0/200b) sanitize 후 0개, 한글 무손상, window.MathJax=undefined(롤백 확인).
  - **유지**: 11차 백엔드 프롬프트 few-shot(모든 수식 `\(...\)` 강제)은 KaTeX 에도 도움이라 유지. 백엔드 `_fix_latex_subscript_escapes`·`_strip_control_chars` 유지.
  - **올바른 재발 방지 원칙(11차 것 대체)**: **KaTeX·MathJax 둘 다 `\(...\)` 구분자가 정확해야 렌더**한다(렌더러 교체는 구분자 문제 해법 아님). 구분자 누락 대응 = 백엔드 프롬프트 강제 + 백엔드 보정(`_fix_latex_broken_delimiters`). **제어문자는 백엔드+프론트 양쪽 strip**, localStorage 는 sanitize 버전 키로 관리. 미검증 가정("X 가 관대하다") 금지 — Preview 로 실측 후 결론.
- **임베딩 로컬 fallback (2026-06-23)**: `embedder._generate_embedding_ollama` 가 `OLLAMA_URL`(서버 터널 21434) 접속 실패 시 **로컬 `http://localhost:11434` 자동 재시도**(같은 bge-m3 1024차원, 차원 호환). timeout 15초. 둘 다 죽으면 예외 → stuck_helper same-problem fallback. OpenAI 임베딩(1536) fallback 은 RAG 검색용으론 부적합이라 차단 유지.
- **백필**: `cd backend/pdf_pipeline && venv\Scripts\activate && python -m scripts.backfill_solution_nodes --limit 5` (`OPENAI_API_KEY` 필수. 임베딩은 OLLAMA_URL 실패 시 로컬 11434 자동 fallback 하므로 수동 override 불필요).
- **도형/그래프 (2026-06-18 결정)**: 해설 도형 자동 crop 안 함. `rag_node_extractor` 는 `figure_image_crop_url=None` 으로 두고(해설 통째 폴백은 정답 노출 위험), `figure_description`(VL 언어화)만 검색·근거로 사용. 정확한 도형 영역은 **CMS 수동 bbox 로 채운다(후속)**. 1차는 도형 이미지 없이 텍스트 힌트만(graceful). stuck_helper 는 같은 문제(`is_same_problem`) crop 은 학생에게 안 보여줌(정답 노출 방어).
- **프론트**: `apps/student` `SolveProblem.tsx` → `components/tutor/StuckHelperModal.tsx` → `shared/lib/api.ts:ragHintApi.getHint`. base URL env `VITE_TUTOR_API_URL`(구 `VITE_DEEPTUTOR_URL` 하위호환 fallback), 기본 `http://localhost:8001`.
- **하네스**:
  - `/solution-nodes-status` — 백필 커버리지·노드 품질·정답노출 위험 조회 + 이어서 백필 명령 (`.claude/commands/solution-nodes-status.md`)
  - `/tutor-smoke` — 샘플 문제로 `generate_hint` end-to-end 1발 검증(실전 핸들러 import) (`.claude/commands/tutor-smoke.md`)
  - PostToolUse hook `.claude/tutor_import_hook.py` — 튜터 스택 파일(stuck_helper/tutor/auth/models/rag_node_extractor) Edit·Write 시 import 스모크 자동 실행, 깨지면 즉시 경고. settings.json `PostToolUse[Edit|Write]` 등록.
  - `vl_raw_dumps/` 는 `.gitignore` 등록됨(`VL_DUMP_RAW=1` 디버그 덤프 — 커밋 금지).

## 메모리 규칙

새 세션에서 기억해야 할 내용은 `~/.claude/projects/.../memory/` 가 아닌 **이 프로젝트의 `.claude/rules/` 파일에 기록**한다.
- 장기 피드백/규칙 → `rules/dev-rules.md` (이 파일)
- 프로젝트 현황/서버 세팅 → `rules/project-status.md`
- DB 규칙 → `rules/db-conventions.md`
- 문제 등록 규칙 → `rules/problem-registration.md`
- 코드 스타일 → `rules/code-style.md`
