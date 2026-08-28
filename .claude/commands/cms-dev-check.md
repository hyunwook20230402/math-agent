CMS 코드 변경 후 빌드 오류 및 프로젝트 규칙 위반을 점검한다.

## 절차

### 1. TypeScript 빌드 검증

```bash
cd apps/cms && npm run build
```

에러/경고 집계. 실패하면 에러 상위 5건만 요약.

### 2. Radix Portal 컴포넌트 감지

CLAUDE.md 금지 규칙: Radix `Dialog` / `Select` / `DropdownMenu` 사용 시 클릭 이벤트 버그. 순수 HTML/CSS 모달 + native `<select>` 로 대체해야 함.

```
Grep pattern: "from ['\"]@radix-ui/react-(dialog|select|dropdown-menu)['\"]"
path: apps/cms/src
```

발견 시 파일:라인 나열하고 대체 안내.

### 3. user.id 외래키 오용 감지

`.claude/rules/db-conventions.md`: `teacher_id` 등은 **반드시 `profile.id`**. `user.id` (auth.users.id) 직접 사용 금지.

```
Grep pattern: "teacher_id:\s*user\.id|student_id:\s*user\.id"
path: apps/cms/src
```

발견 시 수정 필요.

### 4. 디버그 출력 잔존

```
Grep pattern: "console\.(log|debug)"
path: apps/cms/src
-n
```

배포 전 제거 권장.

### 5. 선언 전 참조(TDZ) 스캔 — 백지 화면 방지

`tsc` 도 빌드도 **못 잡는** 오류다. 파생 `const` 가 자기보다 아래에서 선언된
`useState`/`useRef` 를 참조하면 렌더 때 `ReferenceError` 로 **화면이 통째로 백지**가 된다
(2026-08-27 실제 사고, `dev-rules.md` "화면이 통째로 백지면").

```bash
python .claude/tsx_tdz_hook.py --scan apps/cms/src
```

`[TDZ] OK (N files, 0 hits)` 여야 통과. hits 가 있으면 그 파생 const 를 해당 상태 선언
**아래**로 옮긴다. (`.tsx` 를 고칠 때마다 같은 검사가 PostToolUse 훅으로 자동 실행된다.)

### 6. 리포트 포맷

```
[Build]          OK  (0 errors, 3 warnings)
[Radix Portal]   OK  (0 hits)
[user.id 오용]   OK  (0 hits)
[TDZ]            OK  (127 files, 0 hits)
[console.log]    WARN (5 hits — 파일:line 나열)

전체: 통과 가능 / 수정 권장
```

## 참고

- 프로젝트 규칙: `CLAUDE.md` "UI 컴포넌트 주의사항" + `.claude/rules/db-conventions.md`
- Radix 대체 예시: `apps/cms/src/pages/SolutionReview.tsx` 의 모달 패턴
