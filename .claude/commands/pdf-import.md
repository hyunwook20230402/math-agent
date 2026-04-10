교재 PDF에서 수학 문제를 자동 추출하여 Supabase에 등록한다.

현재 상태: 향후 구현 예정 (`backend/pdf_pipeline/`)

## PDF 특성 (확인 완료)
- 쎈 수학 1 문제.pdf: 184페이지, 스캔 PDF (텍스트 레이어 없음)
- OCR 필수

## 파이프라인 계획
1. `backend/pdf_pipeline/` Python FastAPI 서버 실행
2. CMS 앱에서 `/cms/pdf-import` 페이지로 PDF 업로드
3. Surya OCR + Nougat 수식 인식으로 문제 추출
4. `problem_staging` 테이블에 임시 저장
5. CMS 검수 UI에서 확인 후 `problems` 테이블에 최종 저장

## 구현 시 참고
- `CLAUDE.md`의 향후 작업 섹션 참고
- 교재 설정 파일: `backend/pdf_pipeline/textbook_configs/`
- VRAM 제약: RTX 4070 8GB → 모델 순차 로드 필요
