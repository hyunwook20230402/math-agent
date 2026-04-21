# 문제 등록 규칙

## 필드

### `unit` (필수) — "과목 > 대단원 > 중단원"
예: `"공통수학1 > 다항식 > 다항식의 연산"`, `"미적분 > 수열의 극한 > 급수"`

### `category` — 교재명
| 값 | 설명 |
|----|------|
| `'쎈'` | 쎈 교재 |
| `'모의고사'` | 수능/모의고사 기출 |
| `'연산'` | 연산 교재 |
| `'자작'` | 자작 문제 |

### `difficulty_score` — 1~10 정수 (**쓰기 컬럼**)
| 범위 | 라벨 (`difficulty` 파생) | 기준 |
|------|--------------------------|------|
| 1~2 | `very_easy` | 공식 직접 대입, 쎈 A, 모의 2점 |
| 3~4 | `easy` | 쎈 B 초반, 모의 3점 쉬움 |
| 5~6 | `medium` | 쎈 B, 모의 3점 표준 |
| 7~8 | `hard` | 쎈 C, 모의 4점 준킬러 |
| 9~10 | `very_hard` | 수능 21/29/30번 킬러 |

- `difficulty` 는 GENERATED ALWAYS AS … STORED — insert 포함 금지
- `difficulty_score: 7` 넣으면 DB 가 `difficulty='hard'` 자동 파생

### `answer_type`
- `'multiple_choice'` — 객관식 5지선다
- `'short_answer'` — 주관식

### `choices` ⚠️ 중요
**반드시 `null` 또는 `[]`. 보기 내용 채우지 말 것** (이미지 기반 문제라 보기는 이미지에서 확인).

```typescript
choices: null    // ✅
choices: []      // ✅
choices: ['①...', '②...']  // ❌
```

### `title` — 자동 생성 형식
`"{교재} {과목} {문제번호}번"` (예: `"쎈 공통수학1 42번"`)

## 과목 목록
공통수학1, 공통수학2, 미적분, 확률과 통계, 기하, 대수

## 일괄 등록
`shared/lib/api.ts` 의 `problemApi.createProblem()` 사용. 배치는 루프 또는 `supabase.from('problems').insert([...])`.
