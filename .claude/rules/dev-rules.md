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

## VL 모델 정책 (2026-04-22 갱신, 4차 반영)

- **기본 VL 모델은 gemma4:26b 로 고정**. qwen2.5-vl (7B/32B/72B 전부) 은 실측에서 gemma4 대비 품질 낮아 검토 대상 아님
- **OpenAI gpt-5.4-mini 는 어려운 문제 (Call B / 검증 Layer 2) 한정 허용** (4차 도입). 비용 (1문제 ₩25, 모의고사 1회분 ₩152) 부담 작아 가성비 통과
  - 정책: `difficulty_score >= CALL_B_HARD_THRESHOLD` (기본 7) 만 OpenAI, 나머지는 ollama gemma4:26b
  - 같은 임계값을 Call B 와 검증이 공유 → 어려운 문제 일관성
  - 상세: `backend/pdf_pipeline/docs/CALL_B_ROUTING.md`, `docs/TAG_VALIDATOR.md`
- 그 외 유료 API (Gemini / Anthropic / 다른 OpenAI 모델 전체) 도입은 금지 (비용 이유)
- 품질 개선은 VL 교체 대신 프롬프트 튜닝, 후처리 강화, 구조화 스키마 (Pydantic structured output) 로 접근
- **비용 모델 선호**: gemma4:26b 로컬/서버 ollama 는 호출 수 부담 없음. OpenAI API 는 호출당 과금되므로 부담. 따라서 **"호출 수 줄이기 위해 OpenAI 쓰기" 보다 "호출 수 늘어도 gemma4 여러 번 돌리기" 가 선호되는 방향**. 설계 시 2-Pass / 다단계 loop / per-step 쪼개기처럼 gemma4 호출이 늘어나는 구조는 비용 관점에서 문제 없음 (2026-04-23 확정)
- **2026-04-24 Call B step role 라벨링**: Pass 1 (skeleton) 에 `role` 필드 (5종: condition_analysis / equation_setup / case_split / computation / conclusion) 추가. Pass 2 는 target step 의 role 에 맞춰 hint·formula·whys 톤을 조정 (role-conditional 프롬프트). `_dedupe_skeleton()` 은 "연속 produces/uses 동일 병합" 에 "동일 role 3+ 연속 + produces=[] 조건" 추가. validator 는 **일반론 맞는 것만 유지** — hint 완전일치/LaTeX cases 짝/한국어 비율 0.5 + role 연속·conclusion 분포 warning. 이전에 특정 4문제 맞춤으로 추가했던 "formula 3회+ 반복"·"한국어 비율 0.6" 은 일반론에 안 맞아 제거/복귀. reject 시 재시도 없음 (CMS 수동 재태깅)

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

## 로컬 → 서버 Ollama 사용 (2026-04-21 확정)

로컬에서 파이프라인 돌리되 VL/embed 는 서버 GPU 사용하는 방식. 서버 근무시간 외에도 서버 GPU 가용할 때 OpenAI 비용 아낄 수 있음.

**준비물**
- 서버 ollama 는 `127.0.0.1:11434` 만 바인딩 (`ollama` 유저 소유 프로세스라 건드리지 말 것)
- Tailscale 로 로컬 ↔ 서버 연결 (`100.95.34.69`)
- 로컬 PC 에도 ollama 가 돌고 있어 11434 포트 충돌 — 우회 포트 `21434` 사용

**1. SSH 포트포워딩 (로컬 PowerShell 새 창, 닫으면 터널 끊김)**
```
ssh -N -L 21434:localhost:11434 wanted-server
```
비번 입력 후 멈춘 듯 가만히 있으면 성공. `curl http://localhost:21434/api/tags` 로 모델 목록 뜨면 OK.

**2. 서버 설치된 모델 확인** — `gemma3:27b` 없으면 `gemma4:26b` 사용 (프롬프트는 gemma3 기준 튜닝이라 샘플 4개로 품질 먼저 검증)

**3. `backend/pdf_pipeline/.env` 패치**
```
OLLAMA_BASE_URL=http://localhost:21434
VL_OLLAMA_URL=http://localhost:21434
OLLAMA_URL=http://localhost:21434
VL_MODEL=gemma4:26b
OLLAMA_MODEL=gemma4:26b
VL_PROVIDER=ollama    # off-hours 자동 OpenAI fallback 차단
EMBED_PROVIDER=ollama
```

**4. uvicorn 재기동 후 CMS "샘플 태깅 (앞 4개)" 로 품질 확인 → 문제없으면 전체**

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
  - 핸들러 `handlers/stuck_helper.py` — localize → retrieve → generate 3단
  - 노드 추출 `pipeline/rag_node_extractor.py` — 해설 이미지 **1회 통합** VL 분해(전체 노드 배열 1회 structured output). 각 노드에 `uses`(이전 node_index 참조=전이 근거 DAG)+`whys`({question,reason}=논리 완결성) 포함. 2-pass(1+N회)는 gemma4 폭주 방어 잔재라 폐기 — OpenAI는 폭주 없어 1회로 충분. (※ `solution_tagger`의 Call B per-step loop는 ollama 폭주 방어로 정당, 그대로 유지)
  - **answer leakage 방지**: `stuck_helper`가 whys.question만 소크라테스 질문으로 노출(reason은 배경 근거), conclusion 노드 최종 수식 제외, 힌트 보기기호/정답 패턴 경고. 마이그레이션 `012`(uses/whys 컬럼+RPC). LaTeX 조합기호 `{}_nC_r` 프롬프트 강화 + `_fix_latex_subscript_escapes`(저장 직전 `\_`→`_`).
  - **RAG 배포 의존성 순서: 마이그레이션 → 코드 → 테스트.** RPC `RETURNS TABLE` 시그니처 변경은 `CREATE OR REPLACE` 불가 → `DROP FUNCTION ... CASCADE` 먼저. 코드 먼저 배포하면 RPC 시그니처 불일치로 런타임 500.
  - 인증 `auth.py` — `get_student_id`(Bearer JWT → profiles.id, student role 강제). `SUPABASE_ANON_KEY` 필요
  - 모델 `models.py` — `HintRequest`/`HintResponse`/`NodeReference`
- **DB**: `solution_nodes` 테이블(마이그레이션 `add_solution_nodes`) + RPC `search_solution_nodes_for_hint`. 임베딩 **bge-m3 1024차원**(problems.embedding 과 동일 — OpenAI 1536 혼입 금지).
- **VL**: `call_vl(provider="openai")` 통일(localize/generate/노드추출 멀티모달). 한국어/도형 품질 위해 기본 OpenAI. `TUTOR_VL_PROVIDER` env 로 ollama 전환 가능.
- **백필**: `cd backend/pdf_pipeline && venv\Scripts\activate && python -m scripts.backfill_solution_nodes --limit 5` (`OLLAMA_URL` 이 서버 터널 21434 면 임베딩 위해 로컬 11434 로 override 필요. `OPENAI_API_KEY` 필수).
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
