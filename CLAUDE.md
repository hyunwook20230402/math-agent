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
└── backend/          # Python 백엔드
    ├── deeptutor/    # AI 튜터링 (향후)
    └── pdf_pipeline/ # PDF 문제 자동 추출 (향후)
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

### 백엔드 (backend/)
- Python, FastAPI
- Ollama (로컬 LLM: Qwen2.5-7B)
- RTX 4070 8GB VRAM

---

## 앱 실행

```bash
# CMS (컨텐츠 관리)
cd apps/cms && npm install && npm run dev   # http://localhost:8081

# Teacher (학생 관리)
cd apps/teacher && npm install && npm run dev  # http://localhost:8082

# Student (학생용)
cd apps/student && npm install && npm run dev  # http://localhost:8083
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

## 비용 절감 규칙

- 파일 탐색/검색 → subagent에 위임 (haiku 모델 자동 적용)
- 단순 CRUD, 컴포넌트 작성에 Opus 사용 금지 (Sonnet으로 충분)
- 대규모 리팩터링·탐색 완료 후 구현 시작 전 `/compact` 실행
- `--no-verify` 사용 금지 (hook으로 차단됨)

---

## 향후 작업

- [ ] PDF 자동 추출 파이프라인 (`backend/pdf_pipeline/`)
  - 교재 PDF(스캔본) → Surya OCR → 문제 단위 분리 → Supabase 저장
  - 검수 UI는 CMS 앱에 추가
- [ ] DeepTutor AI 튜터링 통합 (`backend/deeptutor/`)
  - 오답 원인 분석, 유사 문제 추천
