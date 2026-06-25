# 수학 학원 LMS

> ⚠️ **에이전트 도구 호출**: 태그는 반드시 `antml:invoke`/`antml:parameter` 정식 형식.
> 접두어 빠진 `<invoke>` 는 파싱 실패로 턴이 멈춘다("또 멈췄다"의 원인). **한 메시지에
> 도구 1개씩, 접두어 확인 후 전송.** 빠르게 연속 호출할 때 빠뜨리기 쉬움. (상세: dev-rules)

> ⚠️ **서버 재기동**: "재기동했다"를 믿지 말 것. 새 uvicorn/vite 는 옛 서버가 포트 점유 중이면
> **조용히 바인딩 실패**(고친 코드가 화면에 반영 안 됨 — 8~18차 11번 헛수고의 정체). `netstat` PID 는
> 죽은 소켓 캐시라 못 믿음 → `Get-CimInstance` 로 살아있는 프로세스 시작시각 확인, 옛 것 `taskkill`,
> `Test-NetConnection` False(포트 해제) 확인 후 재기동. **"화면 실패" 디버깅 1순위 = '어느 서버가
> 그 포트를 서빙 중인가'.** 한 방에: `/server-check`. (상세: dev-rules 19차)

> ⚠️ **서브에이전트 모델**: Agent 호출 시 **반드시 `model: "opus"` 명시**. 빠뜨리면 기본값 Haiku 로
> 떨어진다(전역 규칙=Opus 4.8 위반). PreToolUse hook `enforce_agent_model.py` 가 누락 시 자동 차단하니
> 막히면 model 을 추가해 재시도. (상세: 전역 CLAUDE.md 모델 기준 + `feedback_agents_use_opus`)

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
- `backend/pdf_pipeline/`: ARCHITECTURE.md(데이터흐름·VL정책)

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
| `/server-check` | 서버 옛 코드/포트 점유 진단·재기동 검증 |
