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
from pipeline.yolo_detector import load_model as yolo_load, detect_problems as yolo_detect, release_model as yolo_release, model_exists as yolo_model_exists
from storage.supabase_client import (
    insert_staging_problems,
    get_staging_by_job,
    get_staging_by_page,
    update_staging_status,
    update_staging_image,
    update_staging_bbox,
    delete_staging,
    approve_to_problems,
)
from storage.image_uploader import upload_cropped_images, upload_replacement_image, upload_page_image
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


class BboxItem(BaseModel):
    staging_id: Optional[str] = None  # None이면 신규 추가
    bbox: dict  # {"x1": int, "y1": int, "x2": int, "y2": int}


class UpdateBboxesRequest(BaseModel):
    page_number: int
    source_page_image_url: str  # 원본 페이지 이미지 URL (재크롭용)
    page_width: int
    page_height: int
    problems: list[BboxItem]  # 수정된 bbox 목록 (없는 staging_id는 삭제, 신규는 추가)


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
        page_images = extract_images_from_pdf(
            pdf_path, img_dir, dpi=300,
            page_start=page_start, page_end=page_end,
        )

        jobs[job_id]["total_pages"] = len(page_images)

        jobs[job_id]["status"] = "detecting"
        all_cropped = []
        crop_dir = str(Path(pdf_path).parent / "cropped")

        loop = asyncio.get_event_loop()

        # 모의고사: YOLO 기반 크롭
        if category == "모의고사" and yolo_model_exists():
            from PIL import Image as PILImage
            from concurrent.futures import ThreadPoolExecutor
            Path(crop_dir).mkdir(parents=True, exist_ok=True)

            def _run_yolo():
                model = yolo_load()
                results = []
                num = 1
                # 페이지별 원본 이미지 URL 캐시 (page_num → url)
                page_image_urls: dict = {}
                for pi in page_images:
                    ipath = pi["image_path"]
                    pnum = pi["page"]
                    with PILImage.open(ipath) as _img:
                        pw, ph = _img.size

                    # 원본 페이지 이미지 업로드
                    page_url = upload_page_image(job_id, pnum, ipath)
                    page_image_urls[pnum] = page_url

                    dets = yolo_detect(model, ipath, page_width=pw, conf=0.5, start_number=num)
                    if not dets:
                        continue

                    with PILImage.open(ipath) as img:
                        for det in dets:
                            x1, y1, x2, y2 = det["bbox"]
                            cropped_img = img.crop((x1, y1, x2, y2))
                            fname = f"page{pnum:03d}_prob{det['number']:03d}.png"
                            cpath = str(Path(crop_dir) / fname)
                            cropped_img.save(cpath)
                            results.append({
                                "number": det["number"],
                                "cropped_path": cpath,
                                "page": pnum,
                                "bbox": {
                                    "x1": x1, "y1": y1, "x2": x2, "y2": y2,
                                    "page_width": pw, "page_height": ph,
                                },
                                "source_page_image_url": page_url,
                            })
                    num += len(dets)

                yolo_release(model)
                return results

            with ThreadPoolExecutor(max_workers=1) as executor:
                all_cropped = await asyncio.get_event_loop().run_in_executor(executor, _run_yolo)

        else:
            # 기존 OCR 기반 크롭 (쎈 등)
            pattern = PROBLEM_PATTERNS.get(category, r"\d{3,4}")
            seen_numbers: set = set()

            for page_info in page_images:
                img_path = page_info["image_path"]
                page_num = page_info["page"]

                ocr_results = await loop.run_in_executor(
                    None, ocr_detect_boxes, img_path
                )

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
                regions = compute_crop_regions(detections, w, h, layout=layout, footer_y=footer, ocr_results=ocr_results)
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
            num = item["number"]
            # 모의고사: 문제 번호 기반 유형 자동 설정 (1~15: 5지선다, 16~30: 단답형)
            if category == "모의고사":
                answer_type = "multiple_choice" if num <= 15 else "short_answer"
            else:
                answer_type = "short_answer"
            entry = {
                "problem_number": num,
                "source_image_url": item["source_image_url"],
                "source_pdf": str(pdf_path),
                "source_page": item["page"],
                "confidence": 0.9 if category == "모의고사" else 0.8,
                "answer_type": answer_type,
                "difficulty": "medium",
                "unit": "미분류",
                "category": category,
                "bbox": item.get("bbox"),
                "source_page_image_url": item.get("source_page_image_url"),
                "page_number": item.get("page"),
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


@app.put("/api/staging/{job_id}/update-bboxes")
async def update_bboxes(job_id: str, body: UpdateBboxesRequest):
    """페이지의 bbox 일괄 수정 + 재크롭

    - 요청에 없는 staging_id → 삭제
    - 기존 staging_id → bbox 업데이트 + 재크롭
    - staging_id 없는 항목 → 신규 추가
    """
    import io
    import urllib.request
    from PIL import Image as PILImage
    from storage.image_uploader import upload_cropped_images

    if job_id not in jobs:
        raise HTTPException(404, "작업을 찾을 수 없습니다.")

    job = jobs[job_id]

    # 현재 페이지의 기존 staging 목록
    existing = get_staging_by_page(job_id, body.page_number)
    existing_ids = {s["id"] for s in existing}
    request_ids = {p.staging_id for p in body.problems if p.staging_id}

    # 1. 요청에 없는 staging → 삭제
    for sid in existing_ids - request_ids:
        delete_staging(sid)

    # 원본 페이지 이미지 다운로드 (재크롭용)
    try:
        with urllib.request.urlopen(body.source_page_image_url) as resp:
            page_img_bytes = resp.read()
        page_img = PILImage.open(io.BytesIO(page_img_bytes))
    except Exception as e:
        raise HTTPException(500, f"원본 페이지 이미지 다운로드 실패: {e}")

    # 2단 레이아웃 순서 정렬 (좌열→우열, 위→아래)
    mid_x = body.page_width / 2
    left_col = sorted(
        [p for p in body.problems if (p.bbox["x1"] + p.bbox["x2"]) / 2 < mid_x],
        key=lambda p: p.bbox["y1"]
    )
    right_col = sorted(
        [p for p in body.problems if (p.bbox["x1"] + p.bbox["x2"]) / 2 >= mid_x],
        key=lambda p: p.bbox["y1"]
    )
    ordered_problems = left_col + right_col

    # 페이지 내 시작 번호 계산 (기존 staging에서 최소 문제 번호 기준)
    if existing:
        page_start_num = min(s["problem_number"] for s in existing)
    else:
        # 전체 job staging에서 페이지 이전까지의 수 계산
        all_staging = get_staging_by_job(job_id)
        prev_count = sum(1 for s in all_staging if (s.get("page_number") or 0) < body.page_number)
        page_start_num = prev_count + 1

    crop_dir = str(Path(job["file_path"]).parent / "cropped")
    Path(crop_dir).mkdir(parents=True, exist_ok=True)

    results = []
    for i, prob in enumerate(ordered_problems):
        new_number = page_start_num + i
        bbox = prob.bbox
        x1, y1, x2, y2 = bbox["x1"], bbox["y1"], bbox["x2"], bbox["y2"]

        # 재크롭
        cropped_img = page_img.crop((x1, y1, x2, y2))
        fname = f"page{body.page_number:03d}_prob{new_number:03d}_edit.png"
        cpath = str(Path(crop_dir) / fname)
        cropped_img.save(cpath)

        # Storage 업로드
        uploaded = upload_cropped_images([{
            "number": new_number,
            "cropped_path": cpath,
            "page": body.page_number,
        }], job_id)
        new_image_url = uploaded[0]["source_image_url"]

        bbox_data = {
            "x1": x1, "y1": y1, "x2": x2, "y2": y2,
            "page_width": body.page_width, "page_height": body.page_height,
        }

        if prob.staging_id and prob.staging_id in existing_ids:
            # 기존 staging 업데이트
            updated = update_staging_bbox(prob.staging_id, bbox_data, new_image_url)
            # 문제 번호 재부여
            update_staging_status(prob.staging_id, updated.get("status", "modified"), {"problem_number": new_number})
            results.append(updated)
        else:
            # 신규 추가
            category = job.get("category", "모의고사")
            answer_type = "multiple_choice" if new_number <= 15 else "short_answer"
            new_staging = insert_staging_problems(job_id, job["teacher_id"], [{
                "problem_number": new_number,
                "source_image_url": new_image_url,
                "source_pdf": job.get("file_path", ""),
                "source_page": body.page_number,
                "confidence": 0.9,
                "answer_type": answer_type,
                "difficulty": "medium",
                "unit": "미분류",
                "category": category,
                "bbox": bbox_data,
                "source_page_image_url": body.source_page_image_url,
                "page_number": body.page_number,
            }])
            results.extend(new_staging)

    page_img.close()
    return {"updated": len(results), "problems": results}


@app.post("/api/staging/{staging_id}/replace-image")
async def replace_staging_image(
    staging_id: str,
    file: UploadFile = File(...),
    job_id: str = Form(...),
):
    """개별 staging 문제의 이미지 교체"""
    if not file.filename:
        raise HTTPException(400, "파일명이 없습니다.")
    ext = Path(file.filename).suffix.lower()
    if ext not in [".png", ".jpg", ".jpeg", ".webp"]:
        raise HTTPException(400, "이미지 파일만 업로드 가능합니다.")

    image_bytes = await file.read()
    new_url = upload_replacement_image(image_bytes, staging_id, job_id)
    result = update_staging_image(staging_id, new_url)
    return {"source_image_url": new_url, "staging": result}


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


class ExportRequest(BaseModel):
    job_id: str
    split_ratio: float = 0.8
    modified_page_numbers: list[int] | None = None  # None이면 전체 페이지


@app.post("/api/export-training-data")
async def export_training_data(body: ExportRequest):
    """수정된 bbox → YOLO 재학습 데이터 내보내기

    modified_page_numbers를 지정하면 해당 페이지만 내보냄 (None이면 전체).
    yolo_training/dataset_new/ 에 images/train, images/val, labels/train, labels/val 생성
    """
    from pipeline.yolo_exporter import export_to_yolo
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(
        None, export_to_yolo, body.job_id, body.split_ratio, body.modified_page_numbers
    )
    return result


@app.get("/health")
async def health():
    return {"status": "ok"}
