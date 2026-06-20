교재/해설지 PDF 를 자동 추출해 Supabase 에 등록한다.

## 실제 운영 흐름 (문제 PDF)

1. **백엔드 기동**
   ```bash
   cd backend/pdf_pipeline && uvicorn main:app --reload --port 8001
   ```
2. **CMS 에서 업로드** — `http://localhost:8081/pdf-import` 에서 PDF 선택 + 교재(`쎈`/`모의고사`) 지정.
3. **자동 추출** — `POST /api/extract/{job_id}` 가 비동기로 OCR/YOLO 실행. `GET /api/staging/{job_id}` 로 폴링.
4. **검수** — `PdfReview.tsx` 에서 bbox 편집, 번호 수정, 삭제. 자동 보정 쓰지 말고 수동.
5. **승인** — `POST /api/approve/{job_id}` → `problems` 테이블 이관.

## 해설지 흐름

1. `POST /solutions/upload` 로 해설 PDF 업로드.
2. `POST /solutions/{job_id}/extract` — 해설 크롭 + 정답 파싱.
3. **샘플 태깅** (권장) — `POST /solutions/{job_id}/upload-and-tag?sample_count=4&mode=fresh` → 앞 4개만 태깅해 프롬프트/taxonomy 검증.
4. **이어서 태깅** — `POST /solutions/{job_id}/upload-and-tag?mode=continue` → 나머지 26개.
5. **적용** — `POST /solutions/{job_id}/apply` — `unit / difficulty / difficulty_score / correct_rate` 를 `problem_staging` 에 반영, `problem_tags` 에 concept/skill 삽입. (옛 4필드는 4차에서 제거.)

CMS 는 `apps/cms/src/pages/SolutionReview.tsx` 에서 이 흐름을 UI 로 제공 (샘플/이어서/전체 버튼 + 번호별 결과 카드).

## 실패 시 체크리스트

- **VL 키 확인** — `OPENAI_API_KEY` 필요 (VL=OpenAI 단일, 2026-06-19 gemma4 폐기). 임베딩용 ollama `bge-m3` 도 확인.
- **Supabase 키 누락** — `.env` 의 `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`.
- **UPLOAD_DIR 불일치** — 업로드 파일이 안 보이면 `.env` 의 `UPLOAD_DIR` 가 실제 디렉토리 가리키는지 확인 (보통 `backend/pdf_pipeline/uploads`).
- **VRAM OOM** — YOLO/VL 모델 동시 실행 금지. 각 단계가 독립 요청으로 쪼개진 이유.
- **마이그레이션** — baseline(`baseline_20260620.sql`) + 017 이상 적용 상태여야 함. 상세 `supabase/migrations/README.md`.

## 참고

- 교재 설정: `backend/pdf_pipeline/textbook_configs/`
- 4단 단원 taxonomy: `backend/pdf_pipeline/data/concept_taxonomy.json`
- 관련 규칙: `.claude/rules/problem-registration.md`, `.claude/rules/db-conventions.md`
