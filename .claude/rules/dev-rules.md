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

## 의사결정 규칙

- **근본 해결 우선** — 휴리스틱 땜질 지양. 구조/모델/아키텍처 교체를 중심축으로 두고, 시간/비용 클 때만 단기 완화책 병기
- **UX 결정은 확인받기** — 디렉토리 구조, 폴더명, 파일 경로, UI 텍스트 등 사용자 눈에 보이는 것은 임의 결정 금지. 함수명/정규식/알고리즘은 알아서 판단
- 제안 시 옵션 나열보다 **추천안 + 이유** 명확히 제시

## 서버 규칙

- 서버(`wanted-1@wanted-1`)에서 **Claude Code 사용 금지** — 공용 서버라 다른 유저 코드 파일 건드릴 위험
- 로컬에서만 코드 수정 → commit → push. 서버는 `git pull` + 런타임 명령만
- 예외: `ollama pull`, `pip install`, `uvicorn` 기동 등 런타임 명령은 서버 셸에서 직접 가능

## 비용 절감 규칙

- 파일 탐색/검색 → Explore subagent 위임
- 단순 CRUD, 컴포넌트 작성에 Opus 사용 금지 (Sonnet으로 충분)
- 대규모 탐색 완료 후 구현 시작 전 `/compact` 실행
- `--no-verify` 사용 금지 (hook으로 차단됨)

## 해설지 파이프라인 버그 이력 (2026-04-19 해결)

### 증상
저장 버튼을 눌러도 초록 ✓ 미표시, PUT 요청이 안 가거나 500 에러 반복.

### 원인 및 해결책

**1. Windows 포트 충돌 — uvicorn 좀비 프로세스**
- 증상: PUT 요청이 서버 터미널에 안 찍힘
- 원인: 이전 uvicorn(127.0.0.1:8000)이 좀비로 살아있고, 새 uvicorn(0.0.0.0:8001)과 공존. 브라우저가 구버전 프로세스로 연결
- 해결: `powershell -Command "Stop-Process -Id <PID> -Force"` 또는 포트 변경(`8001`)
- **향후**: uvicorn 재시작 전 `netstat -ano | findstr :8000`으로 좀비 확인

**2. page_bboxes 키 타입 불일치 (str vs int)**
- 원인: DB hydrate 시 `page_bboxes` 키가 문자열(`"1"`)인데 `body.page_number`는 정수(`1`) → dict lookup 실패 → 404
- 해결: `page_bboxes.get(body.page_number) or page_bboxes.get(str(body.page_number))`
- 위치: `main.py` `solution_update_bboxes` 함수

**3. PIL Image를 numpy array 기대 함수에 직접 전달**
- 원인: `img.crop()` → PIL Image → `_trim_whitespace()`(cv2/numpy 기대) 직접 전달 → cv2.error
- 해결: PIL→numpy(`cv2.cvtColor(np.array(pil), COLOR_RGB2BGR)`) → trim → numpy→PIL(`PILImage.fromarray(cv2.cvtColor(..., COLOR_BGR2RGB))`)
- 위치: `main.py` `solution_update_bboxes` L1367~

**4. React useCallback 클로저 stale 문제 (solutionJobId)**
- 원인: `saveBboxForPage`가 `useCallback([solutionJobId])`로 정의돼 있어 state 업데이트 직후 클로저가 null을 참조
- 해결: `solutionJobIdRef = useRef(null)` 추가, `setCleanSolutionJobId`에서 ref도 동기화, `saveBboxForPage`에서 ref 참조
- **향후**: 저장/fetch 함수에서 state 직접 참조 대신 ref 패턴 사용

**5. status 복구 시 pageNums=0이면 stage가 'idle' 고착**
- 원인: `if (pageNums.length === 0) return` 에서 `setStage('reviewing')` 전에 return → 저장 버튼 렌더 안 됨
- 해결: `setStage(newStage)`를 `pageNums` 체크 전에 호출

## 백엔드 포트 현황
- 로컬 개발: **8001** (SolutionReview, PdfReview, PdfUploadDialog, ProblemDetail 모두 8001로 변경됨)
- CORS allowlist: main.py에 8001 추가 필요 여부 확인

## 메모리 규칙

새 세션에서 기억해야 할 내용은 `~/.claude/projects/.../memory/` 가 아닌 **이 프로젝트의 `.claude/rules/` 파일에 기록**한다.
- 장기 피드백/규칙 → `rules/dev-rules.md` (이 파일)
- 프로젝트 현황/서버 세팅 → `rules/project-status.md`
- DB 규칙 → `rules/db-conventions.md`
- 문제 등록 규칙 → `rules/problem-registration.md`
- 코드 스타일 → `rules/code-style.md`
