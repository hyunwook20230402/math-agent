`problem_staging.bbox` 의 이상치를 탐지해 편집이 필요한 행을 리포트한다.

## 절차

### 1. job_id 확정

사용자가 `job_id` 를 지정하거나 "최근" 이라고 하면 최근 `problem_staging` 에서 추출.

### 2. 이상치 SQL — 빈/범위 초과/음수

`mcp__supabase__execute_sql` 로:

```sql
SELECT id, problem_number, source_page, bbox, source_image_url
FROM problem_staging
WHERE job_id = '<job_id>'
  AND bbox IS NOT NULL
  AND (
    (bbox->>'width')::float  < 20  OR
    (bbox->>'height')::float < 20  OR
    (bbox->>'x')::float      < 0   OR
    (bbox->>'y')::float      < 0
  )
ORDER BY problem_number;
```

### 3. 겹침 탐지

같은 페이지 내 bbox IoU > 0.8 인 쌍은 중복 크롭. Python 으로 처리:

```python
# pseudo
for page in pages:
    boxes = staging_rows_with_bbox[page]
    for i, a in enumerate(boxes):
        for b in boxes[i+1:]:
            if iou(a.bbox, b.bbox) > 0.8:
                report(a, b, '중복 bbox')
```

### 4. 리포트 포맷

```
job: <id>
이상치 <N>건:

| staging_id | problem_number | page | 이상 유형          | source_image_url |
|------------|----------------|------|---------------------|------------------|
| ...        | 7              | 3    | width=8 (빈 박스)   | https://...      |
| ...        | 12             | 5    | x=-3 (음수)         | https://...      |
| ...        | 21 / 22        | 8    | IoU=0.92 (중복)     | https://...      |

편집기: http://localhost:8081/pdf-review?job_id=<id>
```

### 5. 후속 안내

- 빈/음수 박스 → 편집기에서 수동 재편집.
- 중복 박스 → 하나 삭제 또는 병합.
- **자동 보정 코드 추가 금지** (프로젝트 규칙: `feedback_bbox_manual_edit.md`).

## 참고

- 편집기 UI: `apps/cms/src/pages/PdfReview.tsx`
- staging 스키마: `supabase/migrations/004_*.sql` (bbox 컬럼 추가 시)
- CRUD 함수: `backend/pdf_pipeline/storage/supabase_client.py::update_staging_bbox`
