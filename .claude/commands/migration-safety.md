새 Supabase 마이그레이션 SQL 을 apply 하기 전 안전성을 점검한다.

## 절차

### 1. 현재 적용 상태 확인

```
mcp__supabase__list_migrations
```

가장 최근 마이그레이션 번호와 새 SQL 의 번호가 연속인지 확인. 건너뛰거나 중복이면 중단하고 사용자에게 확인.

### 2. 기존 DB 상태 점검 (advisor)

```
mcp__supabase__get_advisors (type='security')
mcp__supabase__get_advisors (type='performance')
```

현재 경고들을 먼저 요약. 마이그레이션 이후 재실행하면 증가한 경고가 새 마이그레이션 책임.

### 3. SQL 패턴별 리스크 검토

새 SQL 파일을 읽고 아래 패턴 발견 시 **사용자 확인 필수**:

| 패턴 | 리스크 | 확인 사항 |
|------|--------|----------|
| `DROP TABLE/COLUMN` | 데이터 손실 | 백업 여부, 이 컬럼 참조하는 코드 |
| `ALTER TABLE ... ALTER COLUMN ... SET NOT NULL` | 기존 NULL 행 에러 | 백필 경로, `DEFAULT` 설정 병행 |
| `DROP/RENAME INDEX` | 쿼리 성능 저하 | 관련 쿼리 재검토 |
| PK/FK 변경 | 참조 체인 붕괴 | cascade 영향 범위 |
| `CREATE UNIQUE INDEX` | 중복값 존재 시 실패 | 사전 중복 확인 SQL 제안 |

`ADD COLUMN ... NULL` (기본값 없는 추가) 은 안전 — 경고 없이 진행.

### 4. RLS 현황

현재 이 프로젝트는 RLS **비활성화** 상태 (`.claude/rules/db-conventions.md` 참고).
새 테이블 생성 시 RLS 정책 누락 경고가 advisor 에 떠도 현재는 무시 가능. 향후 RLS 활성화 시 다시 검토.

### 5. Apply

사용자 확인 후:
```
mcp__supabase__apply_migration
  name: "<번호>_<짧은설명>"
  query: "<SQL 내용>"
```

### 6. 사후 검증

- `mcp__supabase__list_tables` 또는 `mcp__supabase__execute_sql` 로 스키마 변경 반영 확인.
- `mcp__supabase__get_advisors` 재실행 — 새 경고 없는지.
- 파일을 `supabase/migrations/<번호>_<이름>.sql` 에도 커밋 (로컬 기록용).

## 참고

- 현재 적용 상태: 008 (`solution_steps`, `common_mistakes` JSONB — problems + problem_staging)
- 마이그레이션 히스토리: `supabase/migrations/`
- DB 규칙: `.claude/rules/db-conventions.md`
