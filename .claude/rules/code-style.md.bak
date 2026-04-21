# 코드 스타일 규칙

## 기본 원칙

- 들여쓰기: **스페이스 2칸**
- 언어: TypeScript (strict 모드)
- 컴포넌트: 함수형 컴포넌트 (클래스 컴포넌트 금지)

## import 경로 별칭

```typescript
@/          → 해당 앱의 src/ (예: apps/cms/src/)
@shared/    → shared/ (공통 코드)
```

```typescript
// 앱 내부 코드
import { SomeComponent } from '@/components/SomeComponent';
import { SomePage } from '@/pages/SomePage';

// 공통 코드
import { supabase } from '@shared/supabase/client';
import { useAuth } from '@shared/hooks/useAuth';
import { Button } from '@shared/ui/button';
import type { Database } from '@shared/types/database';
import { problemApi } from '@shared/lib/api';
```

## UI 컴포넌트

Radix UI 기반 shadcn/ui 컴포넌트를 사용한다 (`@shared/ui/`).

```typescript
import { Button } from '@shared/ui/button';
import { Input } from '@shared/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@shared/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@shared/ui/card';
import { useToast } from '@shared/ui/use-toast';
```

## 상태 관리

- 폼 상태: `useState` 직접 사용 (react-hook-form은 일부만 사용)
- 서버 상태: Supabase 직접 호출 또는 TanStack Query
- 인증 상태: `useAuth()` 훅

```typescript
// 인증 상태 사용 예시
const { user, profile, role, loading, logout } = useAuth();
```

## Supabase 호출 패턴

직접 호출보다 `shared/lib/api.ts`의 함수를 우선 사용한다.

```typescript
import { problemApi, problemSetApi, distributionApi } from '@shared/lib/api';

// 문제 조회
const problems = await problemApi.getProblems(profile.id);

// 문제 생성
await problemApi.createProblem({ teacher_id: profile.id, ...data });
```

## 에러 처리 패턴

```typescript
const { data, error } = await supabase.from('problems').select('*');
if (error) {
  toast({ title: '오류', description: error.message, variant: 'destructive' });
  return;
}
```

## 파일명 규칙

- 컴포넌트: `PascalCase.tsx`
- 훅: `useCamelCase.tsx`
- 유틸: `camelCase.ts`
