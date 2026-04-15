Supabase에 수학 문제를 일괄 등록한다.

> ⚠️ **현재 거의 비권장** — 쎈/모의고사는 `/pdf-import` 파이프라인이 주력. 이 커맨드는 자작 문제 · 특수 케이스 · 마이그레이션 등 예외 상황용. 대량 등록이면 PDF 업로드 흐름 먼저 검토.

사용자가 교재명, 과목, 대단원, 중단원, 문제 번호 범위를 알려주면:

1. `.claude/rules/problem-registration.md`의 규칙을 먼저 확인한다.
2. `.claude/rules/db-conventions.md`의 ID 규칙을 확인한다.
3. `shared/lib/api.ts`의 `problemApi.createProblem`을 사용한다.
4. 다음 형식으로 문제 데이터를 생성한다:

```typescript
{
  teacher_id: profile.id,  // profiles.id 사용
  title: `${category} ${subject} ${problemNumber}번`,
  problem_number: problemNumber,
  difficulty: 'medium',     // 사용자가 지정하면 해당 값 사용
  category: '쎈',           // 교재명
  unit: `${subject} > ${majorUnit} > ${minorUnit}`,
  answer_type: 'short_answer',
  correct_answer: '',       // 비워둠 (나중에 수정)
  choices: null,            // 항상 null
  explanation: null,
  image_url: null
}
```

5. `scripts/create_problems.js` 패턴을 참고하여 Supabase에 직접 삽입하는 스크립트를 생성한다.
