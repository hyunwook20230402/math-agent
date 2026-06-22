특정 `solution_job_id` 또는 최근 해설 job 들의 태깅 현황을 조회하고, 이어서 태깅 명령을 제안한다.

## 절차

### 1. 대상 job 식별

사용자가 `solution_job_id` 를 주면 그걸 사용. 아니면 최근 5개 조회:

```sql
SELECT id, status, problem_job_id, created_at,
       jsonb_object_keys(progress->'tag_results') AS tagged_num,
       jsonb_object_keys(progress->'fragments') AS fragment_num
FROM solution_jobs
ORDER BY created_at DESC
LIMIT 5;
```

`mcp__supabase__execute_sql` 로 실행. status/created_at 먼저 보고 어느 job 이 "검수 중" 인지 확인.

### 2. fragments 대비 tag_results 차집합 계산

각 job 에 대해:
```sql
SELECT id,
       jsonb_object_keys(progress->'fragments') AS frag,
       jsonb_object_keys(progress->'tag_results') AS tagged
FROM solution_jobs WHERE id = '<job_id>';
```

Python/JS 로 두 set 차집합을 계산해 "아직 태그 안 된 번호" 를 산출.

### 3. 현황 보고 + 이어서 명령

결과 포맷:
```
job: <id>
status: tagging|done|...
전체 해설: 30개 (fragments)
태깅됨: 4개 (1, 2, 3, 4)
남음: 26개 (5..30)

→ 이어서 태깅:
curl -X POST "http://localhost:8001/solutions/<id>/upload-and-tag?mode=continue"
```

### 4. match_confidence 저조 경고

적용 이후 상태(`status='done'`)면 staging 도 확인:
```sql
SELECT problem_number, match_confidence, unit, difficulty_score, correct_rate
FROM problem_staging
WHERE solution_job_id = '<job_id>' AND match_confidence < 0.5
ORDER BY problem_number;
```

`confidence < 0.5` 행이 있으면 "번호 매칭 실패 or 해설 이미지 없음 — SolutionReview 에서 수동 묶기 필요" 로 안내.

> ℹ️ 옛 태깅 품질 경고(`validation_status/score/issues`)는 2-layer 검증 폐기(2026-06-22)로 제거. 해당 컬럼은 DB 보존이나 항상 NULL이라 조회 무의미. 메타는 Call A(gpt-4o) 결과를 그대로 신뢰한다.

### 5. 판단 기준

| 상황 | 권장 조치 |
|------|----------|
| fragments=30, tagged=0 | `mode=fresh&sample_count=4` 로 샘플부터 |
| fragments=30, tagged=4 | 샘플 상태. 결과 확인 후 `mode=continue` |
| fragments=30, tagged=30 | `POST /solutions/{id}/apply` 로 staging 반영 |
| status=`failed` | `error` 컬럼 + pdf_pipeline 로그 확인 |

## 참고

- 엔드포인트 구현: `backend/pdf_pipeline/main.py` 의 `solution_upload_and_tag`
- 태깅 로직: `backend/pdf_pipeline/pipeline/solution_tagger.py`
- CMS UI: `apps/cms/src/pages/SolutionReview.tsx` — 같은 동작을 버튼으로 제공
