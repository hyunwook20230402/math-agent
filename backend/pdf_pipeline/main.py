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
from pipeline.file_converter import extract_text_from_pdf, is_text_pdf
from pipeline.text_splitter import split_problems_from_pages
from pipeline.structurizer import structurize_problems_batch
from storage.supabase_client import (
    insert_staging_problems,
    get_staging_by_job,
    update_staging_status,
    approve_to_problems,
)

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

async def _run_extraction(job_id: str, pdf_path: str, teacher_id: str, category: str):
    jobs[job_id]["status"] = "extracting"
    try:
        # 1. 텍스트 추출
        pages = extract_text_from_pdf(pdf_path)
        jobs[job_id]["total_pages"] = len(pages)
        jobs[job_id]["status"] = "splitting"

        # 2. 문제 분리
        raw_problems = split_problems_from_pages(pages)
        jobs[job_id]["total_problems"] = len(raw_problems)
        jobs[job_id]["status"] = "structurizing"

        # 3. LLM 구조화
        for p in raw_problems:
            p["source_pdf"] = str(pdf_path)

        structured = await structurize_problems_batch(raw_problems, category=category)

        # 4. staging 저장
        jobs[job_id]["status"] = "saving"
        insert_staging_problems(job_id, teacher_id, structured)
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
        if not is_text_pdf(pdf_path):
            return {
                "message": "이미지형 PDF입니다. 현재는 텍스트형 PDF만 지원됩니다.",
                "job_id": job_id,
                "is_image_pdf": True,
            }
        background_tasks.add_task(
            _run_extraction,
            job_id,
            pdf_path,
            job["teacher_id"],
            job["category"],
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
    if job_id not in jobs:
        raise HTTPException(404, "작업을 찾을 수 없습니다.")
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
    if job_id not in jobs:
        raise HTTPException(404, "작업을 찾을 수 없습니다.")
    count = approve_to_problems(job_id, body.teacher_id)
    return {"approved_count": count, "message": f"{count}개 문제가 등록되었습니다."}


@app.get("/health")
async def health():
    return {"status": "ok"}
