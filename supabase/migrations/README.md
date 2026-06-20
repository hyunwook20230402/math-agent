# Supabase 마이그레이션

## baseline 방식 (2026-06-20 리셋)

기존 001~016 마이그레이션이 원격 DB와 어긋나(드리프트) 정리했다. 현재 구조는 **baseline 한 장**으로 재현한다.

### 현역 파일
- **`baseline_20260620.sql`** — 원격 Supabase DB 현재 구조 전체 스냅샷(테이블 18 · FK · UNIQUE · 인덱스 · 트리거 · 우리 RPC). **이미 원격에 적용된 상태.** 새 환경 재구축 시 이 파일 하나로 전체 스키마를 재현한다. RLS 정책·pgvector 자동생성 함수는 제외.
- **`017_fix_recalc_set_difficulty_column.sql`** — baseline 이후 첫 변경(세트 난이도 함수 버그 수정). baseline에는 이미 수정본이 반영돼 있고, 이 파일은 원격에 적용한 변경 기록.

### 앞으로
- 새 스키마 변경은 **`018_*.sql`** 부터 순번으로 쌓는다.
- 원격 적용은 Supabase MCP `apply_migration`(또는 CLI). 적용 후 같은 SQL을 이 폴더에 파일로 남겨 드리프트를 막는다.
- 큰 변경이 누적되면 다시 baseline을 떠서 리셋(이번처럼).

### `_archive/`
- 옛 001~016 마이그레이션. 역사 보존용으로만 남긴다(deeptutor 등 폐기 기능 흔적 포함). **새 환경에서 실행하지 말 것** — baseline이 그 결과를 이미 담고 있다.

## 참고
- RLS는 **비활성**(의도) — `.claude/rules/db-conventions.md`.
- 마이그레이션 안전 점검: `/migration-safety` 스킬.
