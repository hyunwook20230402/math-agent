"""PDF 문제 자동 추출 파이프라인 — FastAPI 서버 (포트 8000)"""
import os
import uuid
import asyncio
from pathlib import Path
from typing import Dict, Optional

from fastapi import FastAPI, UploadFile, File, HTTPException, BackgroundTasks, Form
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from config import UPLOAD_DIR
from pipeline.file_converter import extract_images_from_pdf
from pipeline.ocr_engine import ocr_detect_boxes, release_reader
from pipeline.image_cropper import detect_problem_numbers, compute_crop_regions, crop_and_save, detect_footer_y
from storage.supabase_client import (
    insert_staging_problems,
    get_staging_by_job,
    update_staging_status,
    approve_to_problems,
)
from storage.image_uploader import upload_cropped_images
from pipeline.structurizer import (
    structurize_problem,
    download_image,
    release_surya_models,
)
from pipeline.embedder import generate_embedding, release_model as release_embedder

# 교재별 문제 번호 패턴
PROBLEM_PATTERNS = {
    "쎈": r"^\d{4}$",          # 0038, 0039...
    "모의고사": r"^\d{1,2}$",   # 1~30
    "연산": r"^\d{1,3}$",       # 추후 확인
    "자작": r"^\d{1,3}$",       # 추후 확인
}

# 교재별 레이아웃 설정
PROBLEM_LAYOUTS = {
    "쎈": "auto",        # 2단 자동 감지
    "모의고사": "double",  # 항상 2단 (우열 번호 미감지 시에도 mid_x 기준 분할)
    "연산": "single",
    "자작": "auto",
}

app = FastAPI(title="PDF Pipeline API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:8081", "http://localhost:8082", "http://localhost:8083"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 작업 진행 상황 저장 (메모리, 재시작 시 초기화)
jobs: Dict[str, dict] = {}


# --- 요청/응답 모델 ---

class StagingUpdate(BaseModel):
    status: str  # approved / rejected / modified
    problem_number: Optional[int] = None
    difficulty: Optional[str] = None
    answer_type: Optional[str] = None
    correct_answer: Optional[str] = None
    explanation: Optional[str] = None
    unit: Optional[str] = None


class ApproveRequest(BaseModel):
    teacher_id: str


# --- 백그라운드 추출 작업 ---

async def _run_extraction(
    job_id: str, pdf_path: str, teacher_id: str, category: str,
    textbook_id: Optional[str] = None, chapter_id: Optional[str] = None,
    page_start: Optional[int] = None, page_end: Optional[int] = None,
):
    jobs[job_id]["status"] = "extracting"
    try:
        # --- 모든 PDF: 이미지 크롭 파이프라인 ---
        jobs[job_id]["status"] = "converting"
        img_dir = str(Path(pdf_path).parent / "images")
        page_images = extract_images_from_pdf(pdf_path, img_dir, dpi=300)

        # 페이지 범위 필터링
        if page_start or page_end:
            start = (page_start or 1) - 1  # 0-indexed
            end = page_end or len(page_images)
            page_images = page_images[start:end]

        jobs[job_id]["total_pages"] = len(page_images)

        jobs[job_id]["status"] = "detecting"
        all_cropped = []
        crop_dir = str(Path(pdf_path).parent / "cropped")
        pattern = PROBLEM_PATTERNS.get(category, r"\d{3,4}")

        loop = asyncio.get_event_loop()
        seen_numbers: set = set()  # 페이지 간 중복 번호 방지
        for page_info in page_images:
            img_path = page_info["image_path"]
            page_num = page_info["page"]

            # OCR로 문제 번호 좌표 감지 (blocking → executor)
            ocr_results = await loop.run_in_executor(
                None, ocr_detect_boxes, img_path
            )

            # 이미지 크기 얻기
            from PIL import Image as PILImage
            img = PILImage.open(img_path)
            w, h = img.size
            img.close()

            layout = PROBLEM_LAYOUTS.get(category, "auto")
            detections = detect_problem_numbers(
                ocr_results, pattern, h, w, layout=layout,
                skip_numbers=seen_numbers,
            )
            seen_numbers.update(d["number"] for d in detections)
            if not detections:
                continue
            footer = detect_footer_y(ocr_results, h)
            regions = compute_crop_regions(detections, w, h, layout=layout, footer_y=footer)
            cropped = crop_and_save(img_path, regions, crop_dir, page_num)
            all_cropped.extend(cropped)

        # OCR VRAM 해제
        release_reader()

        jobs[job_id]["total_problems"] = len(all_cropped)

        if not all_cropped:
            jobs[job_id]["status"] = "error"
            jobs[job_id]["error"] = "문제 번호를 감지하지 못했습니다. 교재 종류를 확인해주세요."
            return

        # Supabase Storage 업로드
        jobs[job_id]["status"] = "uploading"
        uploaded = await loop.run_in_executor(
            None, upload_cropped_images, all_cropped, job_id
        )

        # staging 저장 (LLM 구조화 건너뜀)
        jobs[job_id]["status"] = "saving"
        staging_data = []
        for item in uploaded:
            entry = {
                "problem_number": item["number"],
                "source_image_url": item["source_image_url"],
                "source_pdf": str(pdf_path),
                "source_page": item["page"],
                "confidence": 0.8,
                "answer_type": "short_answer",
                "difficulty": "medium",
                "unit": "미분류",
                "category": category,
            }
            if textbook_id:
                entry["textbook_id"] = textbook_id
            if chapter_id:
                entry["chapter_id"] = chapter_id
            if page_start:
                entry["page_start"] = page_start
            if page_end:
                entry["page_end"] = page_end
            staging_data.append(entry)
        insert_staging_problems(job_id, teacher_id, staging_data)

        jobs[job_id]["status"] = "done"

    except Exception as e:
        jobs[job_id]["status"] = "error"
        jobs[job_id]["error"] = str(e)
        raise


# --- API 엔드포인트 ---

@app.post("/api/upload")
async def upload_file(
    file: UploadFile = File(...),
    teacher_id: str = Form(...),
    category: str = Form("기타"),
    textbook_id: Optional[str] = Form(None),
    chapter_id: Optional[str] = Form(None),
    page_start: Optional[int] = Form(None),
    page_end: Optional[int] = Form(None),
):
    """PDF/HWP 파일 업로드 → job_id 반환"""
    if not file.filename:
        raise HTTPException(400, "파일명이 없습니다.")

    ext = Path(file.filename).suffix.lower()
    if ext not in [".pdf", ".hwp", ".hwpx"]:
        raise HTTPException(400, "지원하지 않는 파일 형식입니다. (pdf, hwp, hwpx만 가능)")

    # 파일 저장
    job_id = str(uuid.uuid4())
    save_dir = Path(UPLOAD_DIR) / job_id
    save_dir.mkdir(parents=True, exist_ok=True)
    save_path = save_dir / file.filename

    content = await file.read()
    with open(save_path, "wb") as f:
        f.write(content)

    jobs[job_id] = {
        "job_id": job_id,
        "status": "uploaded",
        "filename": file.filename,
        "file_path": str(save_path),
        "teacher_id": teacher_id,
        "category": category,
        "textbook_id": textbook_id,
        "chapter_id": chapter_id,
        "page_start": page_start,
        "page_end": page_end,
        "total_pages": 0,
        "total_problems": 0,
        "error": None,
    }

    return {"job_id": job_id, "filename": file.filename}


@app.post("/api/extract/{job_id}")
async def start_extraction(job_id: str, background_tasks: BackgroundTasks):
    """추출 시작 (백그라운드)"""
    if job_id not in jobs:
        raise HTTPException(404, "작업을 찾을 수 없습니다.")

    job = jobs[job_id]
    if job["status"] not in ["uploaded", "error"]:
        raise HTTPException(400, f"이미 처리 중입니다. 현재 상태: {job['status']}")

    pdf_path = job["file_path"]
    ext = Path(pdf_path).suffix.lower()

    if ext == ".pdf":
        background_tasks.add_task(
            _run_extraction,
            job_id,
            pdf_path,
            job["teacher_id"],
            job["category"],
            job.get("textbook_id"),
            job.get("chapter_id"),
            job.get("page_start"),
            job.get("page_end"),
        )
    else:
        raise HTTPException(400, "HWP 지원은 4단계에서 추가됩니다.")

    jobs[job_id]["status"] = "queued"
    return {"message": "추출 시작됨", "job_id": job_id}


@app.get("/api/jobs/{job_id}")
async def get_job_status(job_id: str):
    """작업 진행 상황 조회"""
    if job_id not in jobs:
        raise HTTPException(404, "작업을 찾을 수 없습니다.")
    return jobs[job_id]


@app.get("/api/staging/{job_id}")
async def get_staging_problems(job_id: str):
    """staging 문제 목록 조회"""
    problems = get_staging_by_job(job_id)
    return {"job_id": job_id, "problems": problems, "count": len(problems)}


@app.patch("/api/staging/{staging_id}")
async def update_staging(staging_id: str, body: StagingUpdate):
    """개별 staging 문제 상태/내용 수정"""
    updates = body.model_dump(exclude_none=True, exclude={"status"})
    result = update_staging_status(staging_id, body.status, updates if updates else None)
    return result


@app.post("/api/staging/{job_id}/approve-all")
async def approve_all(job_id: str, body: ApproveRequest):
    """승인된 모든 문제를 problems 테이블로 이동"""
    count = approve_to_problems(job_id, body.teacher_id)
    return {"approved_count": count, "message": f"{count}개 문제가 등록되었습니다."}


# --- 구조화 작업 ---

structurize_jobs: Dict[str, dict] = {}


async def _run_structurize(job_id: str):
    """승인된 문제들을 비동기로 구조화 (Surya → Qwen → bge-m3)"""
    from storage.supabase_client import get_client
    client = get_client()

    # structuring_status=pending인 문제 조회
    result = client.table("problems").select("id, image_url").eq(
        "structuring_status", "pending"
    ).execute()

    # source_info에서 job_id 매칭
    problems = []
    all_pending = result.data or []
    for p in all_pending:
        info_result = client.table("problems").select("source_info").eq("id", p["id"]).single().execute()
        source_info = info_result.data.get("source_info") if info_result.data else None
        if source_info and source_info.get("job_id") == job_id:
            problems.append(p)

    if not problems:
        structurize_jobs[job_id] = {"status": "done", "processed": 0, "total": 0}
        return

    total = len(problems)
    structurize_jobs[job_id] = {"status": "processing", "processed": 0, "total": total}
    loop = asyncio.get_event_loop()

    for i, prob in enumerate(problems):
        try:
            # 상태 업데이트: processing
            client.table("problems").update(
                {"structuring_status": "processing"}
            ).eq("id", prob["id"]).execute()

            # 이미지 다운로드
            image_path = await loop.run_in_executor(
                None, download_image, prob["image_url"]
            )

            # Surya OCR + Qwen 구조화
            structured = await loop.run_in_executor(
                None, structurize_problem, image_path
            )

            # Surya VRAM 해제 후 임베딩 생성
            release_surya_models()

            embed_text = structured["problem_text"] + " " + " ".join(structured["topic_tags"])
            embedding = await loop.run_in_executor(
                None, generate_embedding, embed_text
            )

            # DB 업데이트
            client.table("problems").update({
                "problem_text": structured["problem_text"],
                "problem_latex": structured["problem_latex"],
                "topic_tags": structured["topic_tags"],
                "embedding": embedding,
                "structuring_status": "done",
            }).eq("id", prob["id"]).execute()

            # 임시 파일 삭제
            import os
            os.unlink(image_path)

        except Exception as e:
            client.table("problems").update({
                "structuring_status": "failed",
            }).eq("id", prob["id"]).execute()

        structurize_jobs[job_id]["processed"] = i + 1

    # VRAM 해제
    release_surya_models()
    release_embedder()
    structurize_jobs[job_id]["status"] = "done"


@app.post("/api/structurize/{job_id}")
async def start_structurize(job_id: str, background_tasks: BackgroundTasks):
    """승인된 문제들 구조화 시작 (Surya OCR + Qwen + bge-m3)"""
    if job_id in structurize_jobs and structurize_jobs[job_id]["status"] == "processing":
        raise HTTPException(400, "이미 구조화 진행 중입니다.")

    structurize_jobs[job_id] = {"status": "queued", "processed": 0, "total": 0}
    background_tasks.add_task(_run_structurize, job_id)
    return {"message": "구조화 시작됨", "job_id": job_id}


@app.get("/api/structurize/{job_id}/status")
async def get_structurize_status(job_id: str):
    """구조화 진행 상황 조회"""
    if job_id not in structurize_jobs:
        return {"status": "unknown", "job_id": job_id}
    return {**structurize_jobs[job_id], "job_id": job_id}


@app.get("/health")
async def health():
    return {"status": "ok"}
