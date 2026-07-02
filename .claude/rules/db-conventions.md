# DB 규칙 (필수)

## ⚠️ 합성키 조회는 `.maybeSingle()` + DB UNIQUE 짝으로 (2026-07-02, profiles 406 버그)

**PK 가 아닌 조합(합성키·비-UNIQUE 컬럼)으로 조회할 땐 `.single()` 금지 → `.maybeSingle()`.**
`.single()` 은 결과가 **0행이면 406, 2행 이상이면 406** 을 던진다. 그런데 그 조합에 UNIQUE 제약이
없으면 중복이 쌓여 어느 순간 2행 이상 → 조회가 통째로 깨진다(profiles.user_id 중복 21개로 로그인·
배포 조회 실패한 실제 사고). 게다가 `.single()` 뒤에 `error` 를 안 받으면 406 을 "결과 없음"으로
오판해 **또 insert → 무한 중복** 악순환까지 간다.

- **"논리적으로 1행이어야 하는" 합성키는 반드시 짝으로 방어**: ① **DB UNIQUE 제약**(중복 원천 차단)
  + ② 코드 **`.maybeSingle()`**(0행=null 정상 처리, 2행은 제약이 막음). 예: `profiles.user_id`(025),
  `distribution_students(distribution_id, student_id)`·`wrong_answers(student_id, problem_id)`·
  `profiles.email`(026).
- **PK(`id`) 로 조회하거나 `insert().select()` 는 1행 보장** → `.single()` 안전.
- 새 조인/계층 테이블 만들 때 "한 조합에 1행"이면 **처음부터 UNIQUE 제약**을 건다(나중에 중복 쌓이면
  제약 추가 전에 중복 정리부터 해야 해서 번거롭다).

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
