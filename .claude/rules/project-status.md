# 프로젝트 현황

## 완성된 기능

- CMS 탭 기반 레이아웃 (교재 목록, 문제 검수, 상세 입력)
- PDF 교재 문제 자동 추출 (쎈 OCR 기반, 모의고사 YOLO 기반)
- bbox 편집기 (크롭 검수 UI, 수동 편집 전용)
- 해설지 PDF 파이프라인 (정답 파싱 + 해설 크롭 + AI 태깅)
- 문제별 개념/스킬 태그 (problem_tags 테이블, VL 모델 + bge-m3 정규화)
- 해설 태깅 샘플/이어서 모드 (4개 먼저 → 나머지)
- 단원 계통도 (공통수학1/2, 대수, 미적분I, 확률과 통계 — concepts 375 / skills 359 / units 15)
- unit 자동 매핑 (`unit_matcher.py` bge-m3 cosine) + difficulty/pitfall/solution_steps/common_mistakes AI 추출
- 3-layer 태깅 검증 (`tag_validator.py` — rule / LLM cross-check / 임베딩 자가체크)
- SolutionReview 같은 번호 묶기 + 그룹 확정 UI
- Supabase 마이그레이션 **008** 까지 적용 (`solution_steps`, `common_mistakes` JSONB)
- Provider 시간대 자동 선택 (`provider_selector.py` — 평일 09-18 KST Ollama, 그외 Gemini→OpenAI)

## 향후 작업

- DeepTutor AI 튜터링 (`backend/deeptutor/` — 현재 스켈레톤만, 코드 0)
  - solution_steps 단계별 힌트, common_mistakes 오답 진단, problem_tags 유사 문제 추천
- teacher 앱 숙제 배포/분석 완성도 ↑ (현재 기초 구현 60~70%)
- student 앱 오답노트 고도화

## 파이프라인 운영 정보

### VL Provider 전략

| 시간대 | VL Provider | Embed Provider |
|--------|-------------|----------------|
| 평일 09-18 KST (서버) | Ollama Gemma3 27B | bge-m3 (Ollama) |
| 그 외 (집) | Gemini → OpenAI fallback | OpenAI text-embedding-3-small |

- 환경변수 `VL_PROVIDER` / `EMBED_PROVIDER` 로 강제 override 가능
- 서버 Ollama 모델: `gemma3:27b` (17GB, RTX 4090 24GB)
- Gemma 4 Ollama 공개 시 서버 세션에서 교체 검토

### UPLOAD_DIR

`.env` 의 `UPLOAD_DIR` 가 실제 경로. `config.py` 기본값(`/tmp/pdf_pipeline`) 보지 말 것.
실제: `C:/Users/user/workspaces/math/backend/pdf_pipeline/uploads`

### 서버 세팅 현황 (2026-04-19 기준)

- 로컬 push 완료: 커밋 `3326b45`
- 내일(2026-04-20) 서버에서 순서대로:
  1. `git pull`
  2. `ollama pull gemma3:27b` (17GB, 10~20분)
  3. Vision ping 검증 후 서버 `.env` 설정 (`VL_MODEL=gemma3:27b`)
  4. `scripts/smoke_test_gemini.py` 로 스모크 테스트

### 데이터 파이프라인 상세

`backend/pdf_pipeline/ARCHITECTURE.md` 참조 — AI 튜터용 데이터 구조 전체 설명.
