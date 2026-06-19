# 수학 학원 LMS

고등 수학 과외/학원 LMS. 교재 문제 등록 → 숙제 배포 → AI 튜터 오답 진단/힌트.

## 구조 (모노레포)

- `apps/cms`(8081) 컨텐츠관리 · `apps/teacher`(8082) 배포 · `apps/student`(8083) 풀이/오답노트
- `shared/` 공통(ui·supabase·hooks·types·lib)
- `backend/pdf_pipeline/`(8001) PDF 추출 + 막힌 지점 도우미 RAG 튜터

## 스택

React18 + TS + Vite + Tailwind / Supabase(PG·Auth·Storage) / FastAPI · YOLO11 · **VL=OpenAI** · bge-m3 임베딩.

- **VL은 OpenAI 단일** (2026-06-19 gemma4 폐기). 임베딩만 bge-m3(Ollama).
- 난이도: 해설 PDF의 **정답률 우선**(구간매핑), 없으면 GPT 추정.
- 막힌 지점 도우미: 풀이그래프 위치추적 RAG `POST /api/tutor/hint`, `solution_nodes` + RPC.

## 실행

```bash
cd apps/cms && npm run dev                              # http://localhost:8081
cd backend/pdf_pipeline && uvicorn main:app --reload --port 8001
```

## 공통 import

```typescript
import { supabase } from '@shared/supabase/client';
import { useAuth } from '@shared/hooks/useAuth';
import { Button } from '@shared/ui/button';
import type { Database } from '@shared/types/database';
```

## 규칙·문서 (상세는 각 파일)

- `.claude/rules/`: dev-rules(규칙·서버·격리) · project-status(현황) · db-conventions(ID·RLS) · problem-registration(필드·난이도) · code-style
- `backend/pdf_pipeline/`: ARCHITECTURE.md(데이터흐름·VL정책) · docs/TAG_VALIDATOR.md(검증)

## 슬래시 커맨드

| 커맨드 | 용도 |
|--------|------|
| `/pdf-import` | 문제/해설 PDF 추출 → 검수 → 승인 |
| `/register-problems` | 수동 문제 등록 |
| `/solution-tagging-status` | 해설 태깅 진행도 |
| `/solution-nodes-status` | 튜터 RAG 백필 진행도 |
| `/tutor-smoke` | 튜터 end-to-end 검증 |
| `/migration-safety` | 마이그레이션 적용 전 점검 |
| `/bbox-verify` | problem_staging bbox 이상치 |
| `/cms-dev-check` | CMS 빌드·금지패턴 점검 |
