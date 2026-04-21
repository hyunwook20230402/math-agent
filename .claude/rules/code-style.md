# 코드 스타일

## 기본
- 들여쓰기: 스페이스 2칸
- TypeScript strict
- 함수형 컴포넌트만 (클래스 금지)

## import 별칭
- `@/` → 해당 앱 `src/` (예: `apps/cms/src/`)
- `@shared/` → `shared/` 공통 코드

```typescript
import { SomeComponent } from '@/components/SomeComponent';
import { supabase } from '@shared/supabase/client';
import { useAuth } from '@shared/hooks/useAuth';
import { Button } from '@shared/ui/button';
import type { Database } from '@shared/types/database';
import { problemApi } from '@shared/lib/api';
```

## UI
Radix UI 기반 shadcn/ui (`@shared/ui/`). Button, Input, Select, Card, useToast 등.

## 상태 관리
- 폼: `useState` (react-hook-form 일부만)
- 서버: Supabase 직접 또는 TanStack Query
- 인증: `useAuth()` → `{ user, profile, role, loading, logout }`

## Supabase 호출
`shared/lib/api.ts` 우선 사용.

```typescript
import { problemApi, problemSetApi, distributionApi } from '@shared/lib/api';
const problems = await problemApi.getProblems(profile.id);
await problemApi.createProblem({ teacher_id: profile.id, ...data });
```

## 에러 처리
```typescript
const { data, error } = await supabase.from('problems').select('*');
if (error) {
  toast({ title: '오류', description: error.message, variant: 'destructive' });
  return;
}
```

## 파일명
- 컴포넌트: `PascalCase.tsx`
- 훅: `useCamelCase.tsx`
- 유틸: `camelCase.ts`
