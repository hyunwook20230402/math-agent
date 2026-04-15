# 수학 학원 LMS

고등학생 대상 수학 과외/학원 운영 LMS. 선생님이 교재 문제를 등록하고, 학생에게 숙제를 배포하며, 학습 현황을 분석한다.

> 내부용 비공개 프로젝트.

---

## 기술 스택

- **Frontend**: React 18, TypeScript, Vite, Tailwind CSS, Radix UI, TanStack Query v5, React Router v6
- **Backend (DB/Auth)**: Supabase (PostgreSQL, Auth, Storage)
- **Backend (PDF 파이프라인)**: Python 3.11, FastAPI, EasyOCR + Surya, YOLO (ultralytics), Ollama (Qwen2.5-VL 7B)
- **개발 환경**: Windows 11, RTX 4070 8GB

---

## 모노레포 구조

```
math/
├── apps/
│   ├── cms/          # 컨텐츠 관리 (8081)
│   ├── teacher/      # 학생/배포 관리 (8082)
│   └── student/      # 학생용 (8083)
├── shared/           # ui, supabase, hooks, types, lib
├── backend/
│   ├── pdf_pipeline/ # PDF 문제·해설 자동 추출 (운영 중)
│   └── deeptutor/    # AI 튜터링 (예정, stub)
└── supabase/migrations/
```

---

## 빠른 시작

필수 환경변수 (각 앱 `.env.local`):
- `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`

PDF 파이프라인 `.env` (`backend/pdf_pipeline/.env`):
- `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `UPLOAD_DIR`

```bash
# 1. 의존성
npm install

# 2. CMS 개발 서버
cd apps/cms && npm run dev       # http://localhost:8081

# 3. PDF 파이프라인 백엔드
cd backend/pdf_pipeline
pip install -r requirements.txt
uvicorn main:app --reload --port 8000

# 4. Ollama 모델 (해설 태깅용)
ollama pull qwen2.5vl:7b
```

---

## 주요 흐름

### 문제 PDF 자동 추출
1. CMS `/pdf-import` 에서 PDF 업로드 (쎈/모의고사).
2. OCR 또는 YOLO 가 문제 박스를 검출 → `problem_staging` 에 저장.
3. `/pdf-review` 에서 bbox/번호 검수 (수동).
4. 승인 → `problems` 테이블 이관.

### 해설지 태깅
1. CMS `/solution-review` 에서 해설 PDF 업로드.
2. 해설 크롭 + 정답 파싱.
3. "샘플 (앞 4개)" → "이어서" → 전체 30개 Qwen2.5-VL 태깅 (unit, difficulty, concept/skill, summary, pitfall).
4. "문제에 적용" → `problem_staging` 에 병합.

---

## 상세 문서

- **개발 규칙 / 컨벤션** — `CLAUDE.md`, `.claude/rules/`
- **슬래시 커맨드** — `.claude/commands/` (`/pdf-import`, `/solution-tagging-status`, `/migration-safety`, `/bbox-verify`, `/cms-dev-check`)
- **에이전트** — `.claude/agents/pdf-extractor.md`
- **Supabase 마이그레이션** — `supabase/migrations/` (현재 006 까지 적용)

---

## 포트 요약

| 앱/서비스 | 포트 |
|-----------|------|
| CMS | 8081 |
| Teacher | 8082 |
| Student | 8083 |
| PDF 파이프라인 API | 8000 |
| Ollama | 11434 |
