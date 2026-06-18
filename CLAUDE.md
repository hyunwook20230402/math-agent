# 수학 학원 LMS 프로젝트

고등학생 대상 수학 과외/학원 운영을 위한 LMS. 선생님이 교재 문제를 등록하고, 학생에게 숙제를 배포하며, AI 튜터로 오답 진단/힌트를 제공한다.

## 모노레포 구조

```
math/
├── apps/
│   ├── cms/          # 컨텐츠 관리 (원장 + 조교) — 포트 8081
│   ├── teacher/      # 학생 관리/배포 — 포트 8082
│   └── student/      # 학생용 (문제 풀기, 오답노트) — 포트 8083
├── shared/           # 공통 코드 (ui, supabase, hooks, types, lib)
└── backend/
    └── pdf_pipeline/ # PDF 문제/해설 추출 + 막힌 지점 도우미 RAG 튜터 (운영 중)
```

> deeptutor(LangGraph 다중턴 대화튜터)는 폐기됨(2026-06-18). 막힌 지점 도우미는 pdf_pipeline 으로 이전(`POST /api/tutor/hint`). 상세 `.claude/rules/dev-rules.md`.

## 기술 스택

**프론트엔드**: React 18, TypeScript, Vite, Radix UI + Tailwind, Supabase JS, React Router v6, TanStack Query v5

**백엔드 (Supabase)**: PostgreSQL, Auth (이메일), Storage (`problem-images` 버킷)

**백엔드 (pdf_pipeline)**: Python 3.11, FastAPI (포트 8001), EasyOCR + YOLO11 (기본 11n / 재학습은 11m — `dev-rules` 참조), VL 모델 (Ollama **Gemma4 26B** 서버 근무시간 / OpenAI 오프시간 — `provider_selector` 자동 전환), bge-m3 임베딩. **Call B + 검증은 어려운 문제 (`difficulty_score >= CALL_B_HARD_THRESHOLD`) 일 때 OpenAI gpt-5.4-mini 강제 분기** — 상세 `backend/pdf_pipeline/docs/CALL_B_ROUTING.md` / `docs/TAG_VALIDATOR.md`

**막힌 지점 도우미 (pdf_pipeline 내)**: 풀이 그래프 위치추적 RAG. `POST /api/tutor/hint` (localize→retrieve→generate). 데이터: `solution_nodes` 테이블 + RPC `search_solution_nodes_for_hint`. VL=OpenAI, 임베딩=bge-m3 1024. 상세 `.claude/rules/dev-rules.md`

## 앱 실행

```bash
cd apps/cms && npm run dev          # http://localhost:8081
cd backend/pdf_pipeline && uvicorn main:app --reload --port 8001
```

## 공통 코드 import

```typescript
import { supabase } from '@shared/supabase/client';
import { useAuth } from '@shared/hooks/useAuth';
import { Button } from '@shared/ui/button';
import type { Database } from '@shared/types/database';
```

## 규칙 문서

| 파일 | 내용 |
|------|------|
| `.claude/rules/dev-rules.md` | UI 주의사항, 격리 원칙, 서버 규칙, 의사결정 규칙, 메모리 규칙 |
| `.claude/rules/project-status.md` | 완성된 기능, 향후 작업, provider 전략, 서버 세팅 현황 |
| `.claude/rules/db-conventions.md` | DB ID 규칙 (teacher_id → profiles.id), RLS 상태 |
| `.claude/rules/problem-registration.md` | unit/category/difficulty/choices 형식 |
| `.claude/rules/code-style.md` | 들여쓰기, import 경로, 컴포넌트 패턴 |

## pdf_pipeline 상세 문서

| 파일 | 내용 |
|------|------|
| `backend/pdf_pipeline/ARCHITECTURE.md` | 전체 데이터 흐름, provider 전략, TagResult 스키마, DB |
| `backend/pdf_pipeline/docs/TAG_VALIDATOR.md` | 3-layer 검증 에이전트 동작, OpenAI 분기, suggested_fixes 자동 적용 |
| `backend/pdf_pipeline/docs/CALL_B_ROUTING.md` | Call B 어려운 문제 OpenAI gpt-5.4-mini 분기 정책 + 비용 |

## 슬래시 커맨드

| 커맨드 | 용도 |
|--------|------|
| `/pdf-import` | 문제/해설지 PDF 업로드 → 추출 → 검수 → 승인 |
| `/register-problems` | 수동 문제 등록 (대량은 `/pdf-import` 주력) |
| `/solution-tagging-status` | 해설 태깅 진행도 + 이어서 명령 |
| `/migration-safety` | 마이그레이션 적용 전 Supabase advisor 체크 |
| `/bbox-verify` | problem_staging bbox 이상치 탐지 |
| `/cms-dev-check` | CMS 빌드 오류 + 금지 패턴 점검 |
