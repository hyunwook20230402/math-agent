# DB 규칙 (필수)

## ID 사용 규칙 — 핵심

모든 외래키(`teacher_id`, `student_id` 등)는 **`profiles.id`** 참조. `auth.users.id` 직접 사용 금지.

✅ 올바름:
```typescript
const { data: { user } } = await supabase.auth.getUser();
const { data: profileData } = await supabase
  .from('profiles')
  .select('id')
  .eq('user_id', user?.id)
  .single();
const teacherId = profileData?.id; // teacher_id 로 사용
```

❌ 금지:
```typescript
teacher_id: user.id // 이건 auth.users.id — 금지
```

## ID 체계
| 필드 | 테이블 | 용도 |
|------|--------|------|
| `auth.users.id` | Supabase Auth | 인증 전용, 외래키 금지 |
| `profiles.id` | profiles | 모든 외래키에 사용 |
| `profiles.user_id` | profiles | auth.users.id 연결 |

## useAuth 훅
`shared/hooks/useAuth.tsx` 가 profile 을 이미 로드:
```typescript
const { profile } = useAuth();
const teacherId = profile?.id;
```

## 현재 DB 상태
- RLS: **비활성화**
- 이미지: Supabase Storage `problem-images` 공개 버킷
- Supabase 프로젝트 ID: `grukqugorspbwsxqdhru`
- 마이그레이션: **baseline 리셋(2026-06-20)** — 현재 원격 구조를 `baseline_20260620.sql` 한 장으로 스냅샷, 이후 `017_` 부터 순번. 옛 001~016 은 `_archive/`(역사 보존). 상세 `supabase/migrations/README.md`

## 주요 테이블
```
profiles              — 사용자 (teacher/student 구분)
problems              — 수학 문제 (teacher_id → profiles.id)
problem_sets          — 문제 세트
problem_set_items     — 문제↔세트
folders               — 교재 폴더 계층
distributions         — 학생 배포
distribution_students — 배포↔학생
solution_nodes        — 막힌 지점 도우미 RAG 코퍼스 (problem_id → problems.id, 풀이 step 단위 추론 노드 + bge-m3 1024 embedding + uses INT[]/whys JSONB = 전이 DAG·논리 근거. baseline 에 포함)
```

> ℹ️ `student_conversations`/`student_attempts`(구 deeptutor 대화튜터)는 원격 DB 에 적용된 적 없음 — deeptutor 폐기(2026-06-18)로 무의미. 무시할 것.
