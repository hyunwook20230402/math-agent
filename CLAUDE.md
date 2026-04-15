# 수학 학원 LMS 프로젝트

## 프로젝트 개요

고등학생 대상 수학 과외/학원 운영을 위한 LMS(학습 관리 시스템).
선생님이 교재 문제를 등록하고, 학생들에게 숙제를 배포하며, 학습 현황을 분석한다.

---

## 모노레포 구조

```
math/
├── apps/
│   ├── cms/          # 컨텐츠 관리 (원장 + 조교) — 포트 8081
│   ├── teacher/      # 학생 관리/배포 (원장 + 조교) — 포트 8082
│   └── student/      # 학생용 (문제 풀기, 오답노트) — 포트 8083
├── shared/           # 공통 코드
│   ├── ui/           # Radix UI 컴포넌트
│   ├── supabase/     # Supabase 클라이언트, DB 타입
│   ├── hooks/        # useAuth 등 공통 훅
│   ├── types/        # 공통 타입
│   └── lib/          # api.ts, utils.ts
└── backend/
    ├── pdf_pipeline/ # PDF 문제/해설 자동 추출 파이프라인 (운영 중)
    └── deeptutor/    # AI 튜터링 (디렉토리만 존재, 코드 0)
```

---

## 사용자 역할

| 역할 | 앱 | 설명 |
|------|-----|------|
| 원장 | cms, teacher | 문제 등록, 학생 관리, 숙제 배포 |
| 조교 | cms, teacher | 원장과 동일 (학원 확장 시) |
| 학생 | student | 숙제 풀기, 오답노트 확인 |

각 앱은 **로그인이 분리**되어 있다.

---

## 기술 스택

### 프론트엔드 (apps/)
- React 18, TypeScript, Vite
- Radix UI + Tailwind CSS
- Supabase JS 클라이언트
- React Router v6
- TanStack Query v5

### 백엔드 (Supabase)
- PostgreSQL (Supabase)
- Supabase Auth (이메일 기반)
- Supabase Storage (`problem-images` 버킷)

### 백엔드 (backend/pdf_pipeline)
- Python 3.11, FastAPI (포트 8000)
- EasyOCR + Surya OCR (문제 크롭)
- YOLO (모의고사 문제 감지)
- Ollama — Qwen2.5-VL 7B (해설지 AI 태깅, RTX 4070 8GB)
- bge-m3 (임베딩)

---

## 앱 실행

```bash
# CMS (컨텐츠 관리)
cd apps/cms && npm run dev   # http://localhost:8081

# PDF 파이프라인 백엔드
cd backend/pdf_pipeline && uvicorn main:app --reload --port 8000
```

---

## 공통 코드 import 경로

각 앱에서 `shared/`는 `@shared` 별칭으로 접근한다:

```typescript
import { supabase } from '@shared/supabase/client';
import { useAuth } from '@shared/hooks/useAuth';
import { Button } from '@shared/ui/button';
import type { Database } from '@shared/types/database';
```

---

## DB 핵심 규칙

자세한 내용은 `.claude/rules/db-conventions.md` 참고.

1. **`teacher_id`는 반드시 `profiles.id`를 사용** (auth.users.id 아님)
2. 프로필 ID 조회:
   ```typescript
   const { data: profileData } = await supabase
     .from('profiles')
     .select('id')
     .eq('user_id', user.id)
     .single();
   const teacherId = profileData?.id;
   ```
3. RLS 정책 현재 비활성화 상태

---

## 교재/문제 데이터 규칙

자세한 내용은 `.claude/rules/problem-registration.md` 참고.

- `unit` 형식: `"과목 > 대단원 > 중단원"` (예: `"공통수학1 > 다항식 > 다항식의 연산"`)
- `category`: 교재명 (`'쎈'`, `'모의고사'`, `'연산'`, `'자작'`)
- `difficulty`: `'easy'` / `'medium'` / `'hard'`
- 객관식 보기(`choices`): **NULL 또는 []** (내용 채우지 말 것)

---

## UI 컴포넌트 주의사항

**Radix Portal 컴포넌트 (Dialog, Select, Dropdown) 사용 금지.**
클릭 이벤트가 전달되지 않는 버그 있음. 대신 순수 HTML/CSS 모달 + native `<select>` 사용.

---

## 프로젝트 격리 원칙 (필수)

- **현재 프로젝트(`math/`) 외부의 파일은 절대 수정/삭제 금지**
- 외부 경로(예: `C:\potenup3\pj3_deep_learning\`)는 **읽기/복사만** 허용
- 외부 파일을 건드려야 할 것 같으면 **반드시 유저에게 먼저 확인**
- 위반 시 복구 불가능한 데이터 손실 발생함 (사고 이력 있음)

---

## 비용 절감 규칙

- 파일 탐색/검색 → Explore subagent 위임
- 단순 CRUD, 컴포넌트 작성에 Opus 사용 금지 (Sonnet으로 충분)
- 대규모 리팩터링·탐색 완료 후 구현 시작 전 `/compact` 실행
- `--no-verify` 사용 금지 (hook으로 차단됨)

---

## 슬래시 커맨드

`.claude/commands/` 아래 정의. 반복 작업 자동화용.

| 커맨드 | 용도 |
|--------|------|
| `/pdf-import` | 문제/해설지 PDF 업로드 → 추출 → 검수 → 승인 흐름 안내 |
| `/register-problems` | 수동 문제 등록 (⚠️ 대량은 `/pdf-import` 가 주력) |
| `/solution-tagging-status` | 해설 태깅 진행도 조회 + 이어서 태깅 명령 생성 |
| `/migration-safety` | 마이그레이션 적용 전 Supabase advisor 체크 |
| `/bbox-verify` | `problem_staging.bbox` 이상치 탐지 |
| `/cms-dev-check` | CMS 빌드 오류 + 금지 패턴 (Radix Portal, user.id 오용) 점검 |

---

## 현재 완성된 기능

- [x] CMS 탭 기반 레이아웃 (교재 목록, 문제 검수, 상세 입력)
- [x] PDF 교재 문제 자동 추출 (쎈 OCR 기반, 모의고사 YOLO 기반)
- [x] bbox 편집기 (크롭 검수 UI, 수동 편집 전용)
- [x] 해설지 PDF 파이프라인 (정답 파싱 + 해설 크롭 + AI 태깅)
- [x] 문제별 개념/스킬 태그 (problem_tags 테이블, Qwen2.5-VL)
- [x] 해설 태깅 샘플/이어서 모드 (4개 먼저 → 나머지 26개)
- [x] 4단 단원 계통도 (공통수학1/2, 대수, 미적분I, 확률과 통계)
- [x] unit/difficulty/pitfall 자동 추출 + 환각 차단 (`validate_unit`)
- [x] SolutionReview 같은 번호 묶기 + 그룹 확정 UI
- [x] Supabase 마이그레이션 006 까지 적용 (`solution_jobs`, `problem_tags`, `problem_staging.pitfall`)

## 향후 작업

- [ ] DeepTutor AI 튜터링 (`backend/deeptutor/` — 현재 코드 0, 디렉토리만 존재)
  - problem_tags + solution_summary → RAG 검색
  - LangGraph 기반 오답 원인 분석, 유사 문제 추천
- [ ] teacher 앱 숙제 배포/분석 완성도 ↑ (현재 기초 구현 60~70%)
- [ ] student 앱 오답노트 고도화
