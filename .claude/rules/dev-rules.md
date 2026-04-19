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

## 메모리 규칙

새 세션에서 기억해야 할 내용은 `~/.claude/projects/.../memory/` 가 아닌 **이 프로젝트의 `.claude/rules/` 파일에 기록**한다.
- 장기 피드백/규칙 → `rules/dev-rules.md` (이 파일)
- 프로젝트 현황/서버 세팅 → `rules/project-status.md`
- DB 규칙 → `rules/db-conventions.md`
- 문제 등록 규칙 → `rules/problem-registration.md`
- 코드 스타일 → `rules/code-style.md`
