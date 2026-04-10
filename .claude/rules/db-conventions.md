# DB 규칙 (필수 준수)

## 핵심 원칙: ID 사용 규칙

### ✅ 올바른 방법 — `profiles.id` 사용
모든 외래키(`teacher_id`, `student_id` 등)는 반드시 `profiles` 테이블의 `id` 컬럼을 참조한다.

```typescript
// 항상 이 방식으로 프로필 ID를 가져올 것
const { data: { user } } = await supabase.auth.getUser();
const { data: profileData } = await supabase
  .from('profiles')
  .select('id')
  .eq('user_id', user?.id)
  .single();
const teacherId = profileData?.id; // ← 이것을 teacher_id로 사용
```

### ❌ 금지 — `auth.users.id` 직접 사용
```typescript
// 절대 하지 말 것
const { data: { user } } = await supabase.auth.getUser();
teacher_id: user.id // ❌ 이건 auth.users.id임
```

## ID 체계 요약

| 필드 | 테이블 | 용도 |
|------|--------|------|
| `auth.users.id` | Supabase Auth | 인증 전용, 외래키로 직접 사용 금지 |
| `profiles.id` | profiles | 모든 외래키 참조에 사용 |
| `profiles.user_id` | profiles | auth.users.id와 연결 |

## useAuth 훅 활용

`shared/hooks/useAuth.tsx`의 `useAuth()`가 이미 profile을 로드한다:

```typescript
const { profile } = useAuth();
const teacherId = profile?.id; // ← 바로 사용 가능
```

## 현재 DB 상태

- RLS 정책: **비활성화** (마이그레이션 `20250116000003`으로 비활성화됨)
- 이미지 저장: Supabase Storage `problem-images` 버킷 (공개 버킷)
- Supabase 프로젝트 ID: `grukqugorspbwsxqdhru`

## 주요 테이블 구조

```
profiles           — 사용자 프로필 (teacher/student 역할 구분)
problems           — 수학 문제 (teacher_id → profiles.id)
problem_sets       — 문제 세트
problem_set_items  — 문제↔세트 연결
folders            — 교재 폴더 계층
distributions      — 학생 배포
distribution_students — 배포↔학생 연결
```
