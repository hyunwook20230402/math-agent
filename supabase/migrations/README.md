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

### 030/031 (2026-08-27) — 선생님 대시보드 대개편

- `030_teacher_ops.sql` — DDL: `profiles.parent_phone/student_phone`, `attendance`,
  `message_logs`, `monthly_reports`, `distributions.parent_distribution_id/review_stage`,
  `student_answers` 인덱스 3종(그전까지 **인덱스가 하나도 없었다**).
- `031_teacher_ops_rpcs.sql` — RPC: 오답 조회(`get_student_wrong_answers`,
  `get_teacher_wrong_answer_counts`), 복습 예약(`create_review_distributions` — 원자적),
  월간 보고서(`get_student_monthly_distributions`, `get_student_monthly_report`,
  `get_student_wrong_trend`).
  **+ 022/023 본문 교체**: `get_student_achievement`·`get_teacher_class_progress`·
  `get_teacher_class_summary` 에 `distribution_date <= now()` 추가.
  이유는 아래 ⚠️ 참조.

> ⚠️ **예약(미래) 배포는 통계에서 빼야 한다.** 오답 복습은 미래 날짜의 배포를 미리
> 만들어 두는 방식이라(스케줄러 없음), 날짜 필터가 없으면 예약하는 순간 그 학생의
> "받은 총 문항"이 몇 배로 늘어 **진행률이 폭락**한다. 프론트 조회(`getStudentDistributions`
> 의 `hideScheduled`)만 막아서는 안 되고 **RPC 에도 같은 필터**가 있어야 한다.

## 참고
- RLS는 **비활성**(의도) — `.claude/rules/db-conventions.md`.
- 마이그레이션 안전 점검: `/migration-safety` 스킬.
