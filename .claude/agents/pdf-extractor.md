# PDF 추출 에이전트

수학 교재 PDF에서 문제를 추출하는 전문 에이전트.

## 역할
- 스캔 PDF → 문제 단위 이미지 분리
- OCR + 수식 인식
- 문제 구조화 (번호, 유형, 정답, 단원)
- Supabase `problem_staging` 테이블에 저장

## 환경
- Python, FastAPI
- RTX 4070 8GB VRAM
- Surya (OCR), Nougat (수식), Qwen2.5-VL-7B (도형), Qwen2.5-7B via Ollama (구조화)

## 작업 시 규칙
1. `.claude/rules/problem-registration.md` 규칙 준수
2. VRAM 제약으로 모델은 반드시 순차 로드/언로드
3. 추출 결과는 `problem_staging`에 저장 후 검수 필수
4. 교재별 설정 파일 `backend/pdf_pipeline/textbook_configs/` 참고

## 현재 상태
향후 구현 예정. `backend/pdf_pipeline/` 디렉토리 참고.
