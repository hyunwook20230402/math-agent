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

### 5. 리포트 포맷

```
[Build]          OK  (0 errors, 3 warnings)
[Radix Portal]   OK  (0 hits)
[user.id 오용]   OK  (0 hits)
[console.log]    WARN (5 hits — 파일:line 나열)

전체: 통과 가능 / 수정 권장
```

## 참고

- 프로젝트 규칙: `CLAUDE.md` "UI 컴포넌트 주의사항" + `.claude/rules/db-conventions.md`
- Radix 대체 예시: `apps/cms/src/pages/SolutionReview.tsx` 의 모달 패턴
