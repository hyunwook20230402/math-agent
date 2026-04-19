"""PDF 문제 자동 추출 파이프라인 — FastAPI 서버 (포트 8000)"""
import os
import re
import uuid
import json
import asyncio
import logging
from pathlib import Path
from typing import Dict, Optional

logger = logging.getLogger(__name__)

from fastapi import FastAPI, UploadFile, File, HTTPException, BackgroundTasks, Form
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from config import UPLOAD_DIR
from pipeline.file_converter import extract_images_from_pdf
from pipeline.image_cropper import crop_and_save
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

# ── 업로드 파일명/폴더 유틸 ─────────────────────────────────────
def _decode_upload_filename(name: str) -> str:
    """FastAPI가 latin-1로 파싱한 파일명을 UTF-8로 복원 시도."""
    try:
        return name.encode("latin-1").decode("utf-8")
    except (UnicodeError, AttributeError):
        return name


def _sanitize_name(name: str) -> str:
    """확장자 제거 + 공백/경로문자 정리. 한글 유지."""
    stem = Path(name).stem
    cleaned = re.sub(r'[\\/:*?"<>|\s]+', "_", stem).strip("_")
    return cleaned[:80] or "untitled"


def _unique_dir(base: Path, folder_name: str) -> Path:
    """동명 충돌 시 _2, _3 접미사."""
    candidate = base / folder_name
    if not candidate.exists():
        return candidate
    n = 2
    while (base / f"{folder_name}_{n}").exists():
        n += 1
    return base / f"{folder_name}_{n}"



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

        # YOLO 기반 크롭 (모든 교재 공통)
        if not yolo_model_exists():
            raise RuntimeError(f"YOLO 모델이 없습니다. 학습 후 models/ 에 배치하세요.")

        from PIL import Image as PILImage
        from concurrent.futures import ThreadPoolExecutor
        Path(crop_dir).mkdir(parents=True, exist_ok=True)

        def _run_yolo():
            model = yolo_load()
            results = []
            num = 1
            page_image_urls: dict = {}
            for pi in page_images:
                ipath = pi["image_path"]
                pnum = pi["page"]
                with PILImage.open(ipath) as _img:
                    pw, ph = _img.size

                page_url = upload_page_image(job_id, pnum, ipath)
                page_image_urls[pnum] = page_url

                debug_dir = str(Path(crop_dir).parent / "yolo_debug")
                dets = yolo_detect(model, ipath, page_width=pw, conf=0.3, start_number=num, debug_dir=debug_dir)
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
                "difficulty_score": 5,
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

    real_filename = _decode_upload_filename(file.filename)
    ext = Path(real_filename).suffix.lower()
    if ext not in [".pdf", ".hwp", ".hwpx"]:
        raise HTTPException(400, "지원하지 않는 파일 형식입니다. (pdf, hwp, hwpx만 가능)")

    # 파일 저장 — 원본 파일명 기반 폴더, 충돌 시 _2, _3 부여
    job_id = str(uuid.uuid4())
    folder_name = _sanitize_name(real_filename)
    save_dir = _unique_dir(Path(UPLOAD_DIR) / "problems", folder_name)
    save_dir.mkdir(parents=True, exist_ok=True)
    save_path = save_dir / real_filename

    content = await file.read()
    with open(save_path, "wb") as f:
        f.write(content)

    jobs[job_id] = {
        "job_id": job_id,
        "status": "uploaded",
        "filename": real_filename,
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

    return {"job_id": job_id, "filename": real_filename}


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

    # job 메타 조회 (메모리에 없으면 DB staging에서 복원)
    job = jobs.get(job_id)
    if job is None:
        all_staging = get_staging_by_job(job_id)
        if not all_staging:
            raise HTTPException(404, "작업을 찾을 수 없습니다.")
        sample = all_staging[0]
        job = {
            "file_path": sample.get("source_pdf", ""),
            "teacher_id": sample.get("teacher_id", ""),
            "category": sample.get("category", "모의고사"),
        }

    # 현재 페이지의 기존 staging 목록 (DB 기반 — 메모리 재시작 후에도 동작)
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
    # 박스 좌측 엣지(x1)가 페이지 폭의 40% 이내면 왼쪽 열로 분류.
    # 박스 중심 기준으로 하면 좁게 잡힌 오른쪽 열 문제가 왼쪽으로 오분류되는 문제가 있어
    # x1 + 임계값 방식으로 변경.
    left_threshold = body.page_width * 0.4
    left_col = sorted(
        [p for p in body.problems if p.bbox["x1"] < left_threshold],
        key=lambda p: p.bbox["y1"]
    )
    right_col = sorted(
        [p for p in body.problems if p.bbox["x1"] >= left_threshold],
        key=lambda p: p.bbox["y1"]
    )
    ordered_problems = left_col + right_col

    # 페이지 내 시작 번호 계산: 이전 페이지들의 최신 문제 수 합산 (항상 DB에서 재계산)
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
                "difficulty_score": 5,
                "unit": "미분류",
                "category": category,
                "bbox": bbox_data,
                "source_page_image_url": body.source_page_image_url,
                "page_number": body.page_number,
            }])
            results.extend(new_staging)

    page_img.close()

    # 전체 staging problem_number를 전역 연속 값으로 재동기화
    # (현재 페이지에서 박스가 추가/삭제되면 뒤 페이지 번호가 시프트되어야 함)
    all_staging = get_staging_by_job(job_id)
    by_page: Dict[int, list] = {}
    for s in all_staging:
        pg = s.get("page_number") or 0
        if pg == 0:
            continue
        by_page.setdefault(pg, []).append(s)

    running = 0
    for pg in sorted(by_page.keys()):
        page_items = sorted(by_page[pg], key=lambda s: s.get("problem_number") or 0)
        for s in page_items:
            running += 1
            if s.get("problem_number") != running:
                update_staging_status(
                    s["id"],
                    s.get("status", "modified"),
                    {"problem_number": running},
                )

    refreshed = get_staging_by_job(job_id)
    return {"updated": len(results), "problems": refreshed}


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
    """승인된 문제들을 비동기로 구조화 (Surya → VL 모델 → bge-m3)"""
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

            # Surya OCR + VL 모델 구조화
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
    """승인된 문제들 구조화 시작 (Surya OCR + VL 모델 + bge-m3)"""
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
    force: bool = False  # True면 중복 체크 무시


# export 기록 파일 경로 (백엔드 재시작해도 유지)
from config import PROBLEM_EXPORT_LOG as _EXPORT_LOG_PATH


def _load_export_log() -> dict:
    if _EXPORT_LOG_PATH.exists():
        try:
            return json.loads(_EXPORT_LOG_PATH.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def _save_export_log(log: dict):
    _EXPORT_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    _EXPORT_LOG_PATH.write_text(json.dumps(log, ensure_ascii=False, indent=2), encoding="utf-8")


@app.get("/api/export-training-data/{job_id}/status")
async def get_export_status(job_id: str):
    """이 job이 이미 export됐는지 확인"""
    log = _load_export_log()
    if job_id in log:
        return {"exported": True, "exported_at": log[job_id]["exported_at"], "image_count": log[job_id].get("image_count", 0)}
    return {"exported": False}


@app.post("/api/export-training-data")
async def export_training_data(body: ExportRequest):
    """수정된 bbox → YOLO 재학습 데이터 내보내기

    modified_page_numbers를 지정하면 해당 페이지만 내보냄 (None이면 전체).
    yolo_training/dataset_new/ 에 images/train, images/val, labels/train, labels/val 생성
    force=True면 중복 체크 없이 재export.
    """
    # 중복 export 체크
    if not body.force:
        log = _load_export_log()
        if body.job_id in log:
            entry = log[body.job_id]
            return {
                "already_exported": True,
                "exported_at": entry["exported_at"],
                "image_count": entry.get("image_count", 0),
                "message": f"이미 {entry['exported_at']} 에 export됨. force=true로 재export 가능.",
            }

    from pipeline.yolo_exporter import export_to_yolo
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(
        None, export_to_yolo, body.job_id, body.split_ratio, body.modified_page_numbers
    )

    # export 기록 저장
    from datetime import datetime as _dt
    log = _load_export_log()
    log[body.job_id] = {
        "exported_at": _dt.now().strftime("%Y-%m-%d %H:%M:%S"),
        "image_count": result.get("total_images", 0),
        "job_id": body.job_id,
    }
    _save_export_log(log)

    return result


@app.get("/health")
async def health():
    return {"status": "ok"}


# ── YOLO 재학습 API ──────────────────────────────────────────────

retrain_jobs: Dict[str, dict] = {}  # 재학습 진행 상태 캐시

_YOLO_TRAINING_DIR = Path(__file__).parent / "yolo_training"
_YOLO_MODEL_PATH = Path(__file__).parent / "models" / "exam_problem_detector.pt"


class RetrainRequest(BaseModel):
    base_weights: str = "runs/exam_finetune_v2/weights/best.pt"
    epochs: int = 50
    run_name: str | None = None  # None이면 자동 생성


@app.post("/api/retrain")
async def start_retrain(body: RetrainRequest):
    """YOLO 재학습 시작 (백그라운드)

    완료 시 best.pt를 models/exam_problem_detector.pt로 자동 교체.
    """
    import re
    # 자동 run_name 생성 (exam_finetune_v{N+1})
    run_name = body.run_name
    if run_name is None:
        runs_dir = _YOLO_TRAINING_DIR / "runs"
        existing = [d.name for d in runs_dir.glob("exam_finetune_v*")] if runs_dir.exists() else []
        nums = [int(m.group(1)) for d in existing if (m := re.search(r"v(\d+)$", d))]
        next_v = max(nums, default=2) + 1
        run_name = f"exam_finetune_v{next_v}"

    retrain_id = str(uuid.uuid4())
    retrain_jobs[retrain_id] = {"status": "pending", "run_name": run_name, "progress": ""}

    asyncio.create_task(_run_retrain(retrain_id, body.base_weights, body.epochs, run_name))
    return {"retrain_id": retrain_id, "run_name": run_name, "status": "pending"}


@app.get("/api/retrain/{retrain_id}")
async def get_retrain_status(retrain_id: str):
    if retrain_id not in retrain_jobs:
        raise HTTPException(status_code=404, detail="재학습 작업을 찾을 수 없습니다")
    return retrain_jobs[retrain_id]


async def _run_retrain(retrain_id: str, base_weights: str, epochs: int, run_name: str):
    import shutil
    import subprocess
    from datetime import datetime

    retrain_jobs[retrain_id]["status"] = "training"

    base_weights_path = _YOLO_TRAINING_DIR / base_weights
    if not base_weights_path.exists():
        retrain_jobs[retrain_id] = {"status": "error", "message": f"가중치 파일 없음: {base_weights_path}"}
        return

    venv_python = _YOLO_TRAINING_DIR.parent / "venv" / "Scripts" / "python.exe"
    python_bin = str(venv_python) if venv_python.exists() else "python"

    cmd = [
        python_bin,
        str(_YOLO_TRAINING_DIR / "train_finetune.py"),
        "--base-weights", str(base_weights_path),
        "--epochs", str(epochs),
        "--run-name", run_name,
    ]

    try:
        loop = asyncio.get_event_loop()
        proc = await loop.run_in_executor(
            None,
            lambda: subprocess.run(cmd, cwd=str(_YOLO_TRAINING_DIR), capture_output=True, text=True)
        )

        if proc.returncode != 0:
            retrain_jobs[retrain_id] = {
                "status": "error",
                "message": proc.stderr[-2000:] if proc.stderr else "알 수 없는 오류",
            }
            return

        # best.pt 경로 파싱
        best_pt = None
        for line in proc.stdout.splitlines():
            if line.startswith("BEST_MODEL_PATH="):
                best_pt = Path(line.split("=", 1)[1].strip())
                break

        if best_pt is None or not best_pt.exists():
            best_pt = _YOLO_TRAINING_DIR / "runs" / run_name / "weights" / "best.pt"

        if not best_pt.exists():
            retrain_jobs[retrain_id] = {"status": "error", "message": "best.pt를 찾을 수 없습니다"}
            return

        # 기존 모델 백업 후 교체
        if _YOLO_MODEL_PATH.exists():
            ts = datetime.now().strftime("%Y%m%d_%H%M%S")
            bak = _YOLO_MODEL_PATH.with_name(f"exam_problem_detector.bak_{ts}.pt")
            shutil.copy2(_YOLO_MODEL_PATH, bak)

        shutil.copy2(best_pt, _YOLO_MODEL_PATH)

        retrain_jobs[retrain_id] = {
            "status": "done",
            "run_name": run_name,
            "best_pt": str(best_pt),
            "model_updated": str(_YOLO_MODEL_PATH),
        }

    except Exception as e:
        retrain_jobs[retrain_id] = {"status": "error", "message": str(e)}


# ── 해설지 파이프라인 ────────────────────────────────────────────

solution_jobs: Dict[str, dict] = {}  # 메모리 진행 상태 캐시


def _hydrate_solution_job(solution_job_id: str) -> dict | None:
    """DB 에서 solution_job 을 읽어 메모리 캐시에 세팅. 없으면 None.

    get_solution_job() 이 progress 를 이미 정규화(int key)해서 주기 때문에,
    여기선 그 값을 그대로 메모리 딕셔너리로 조립.
    """
    from storage.supabase_client import get_solution_job
    db_job = get_solution_job(solution_job_id)
    if not db_job:
        return None
    progress = db_job.get("progress") or {}
    solution_jobs[solution_job_id] = {
        "solution_job_id": solution_job_id,
        "status": db_job.get("status", "reviewing"),
        "teacher_id": db_job.get("teacher_id"),
        "problem_job_id": db_job.get("problem_job_id"),
        "file_path": db_job.get("pdf_path"),
        "answers": progress.get("answers", {}),
        "fragments": progress.get("fragments", {}),
        "page_bboxes": progress.get("page_bboxes", {}),
        "modified_pages": progress.get("modified_pages", []),
        "solution_image_urls": progress.get("solution_image_urls", {}),
        "tag_results": progress.get("tag_results", {}),
        "progress": progress,
        "error": db_job.get("error"),
    }
    return solution_jobs[solution_job_id]


class SolutionMatchRequest(BaseModel):
    problem_job_id: str


class SolutionApplyRequest(BaseModel):
    problem_job_id: str
    overrides: Optional[list] = None  # [{staging_id, answer, answer_type}, ...]


async def _run_solution_upload_and_tag(
    solution_job_id: str,
    sample_count: int | None = None,
    mode: str = "fresh",
):
    """해설지 병합 + Storage 업로드 + AI 태깅 (백그라운드)

    extract 단계에서 크롭 + 정답 추출은 이미 완료되어 있음.
    여기서는 fragments를 병합하여 최종 해설 이미지 생성 → 업로드 → VL 모델 태깅.

    Args:
      sample_count: 앞 N개만 태깅 (fresh 모드에서 샘플 검증용). None 이면 대상 전체.
      mode: 'fresh' = 기존 tag_results 덮어쓰기(부분 업데이트), 'continue' = 이미 tag_results
            에 있는 번호 제외하고 나머지만 태깅.
    """
    from pipeline.solution_parser import merge_cross_page_solutions
    from pipeline.solution_tagger import tag_all_solutions
    from storage.supabase_client import update_solution_job
    from storage.image_uploader import upload_cropped_images

    def _merged_progress(extra: dict) -> dict:
        """기존 progress(fragments/page_bboxes/answers 등) 보존하며 태깅 지표만 덮어씀."""
        base = dict(solution_jobs[solution_job_id].get("progress") or {})
        base.update(extra)
        solution_jobs[solution_job_id]["progress"] = base
        return base

    def _progress(processed, total, current_number):
        merged = _merged_progress({
            "processed": processed,
            "total": total,
            "current_number": current_number,
        })
        update_solution_job(
            solution_job_id,
            status="tagging",
            progress=merged,
        )

    try:
        job = solution_jobs[solution_job_id]
        pdf_path = job["file_path"]
        fragments = job.get("fragments", {})

        if not fragments:
            raise RuntimeError("해설 크롭 결과가 없습니다. 먼저 /api/solution/extract를 호출하세요.")

        loop = asyncio.get_event_loop()
        from concurrent.futures import ThreadPoolExecutor

        # 1. 페이지 걸침 병합 (전체 번호 대상)
        merged_dir = str(Path(pdf_path).parent / "solution_merged")
        merged_images = await loop.run_in_executor(
            None, merge_cross_page_solutions, fragments, merged_dir, 10, pdf_path
        )

        # 1-1. 타겟 번호 결정 (mode + sample_count)
        existing_tag_results = dict(job.get("tag_results") or {})
        existing_tag_numbers = {
            int(k) for k in existing_tag_results.keys()
            if isinstance(k, int) or (isinstance(k, str) and k.isdigit())
        }
        all_numbers_sorted = sorted(int(n) for n in merged_images.keys())

        if mode == "continue":
            target_numbers = [n for n in all_numbers_sorted if n not in existing_tag_numbers]
        else:  # fresh
            target_numbers = list(all_numbers_sorted)

        if sample_count is not None and sample_count > 0:
            target_numbers = target_numbers[:sample_count]

        target_set = set(target_numbers)
        logger.info(
            f"태깅 대상: mode={mode} sample_count={sample_count} "
            f"→ {len(target_set)}개 / 전체 {len(all_numbers_sorted)}개"
        )

        # 2. Supabase Storage 업로드 — 타겟 번호만 (기존 url 은 보존/병합)
        solution_jobs[solution_job_id]["status"] = "uploading"
        update_solution_job(solution_job_id, status="uploading")

        upload_items = [
            {"number": num, "cropped_path": path, "page": 0}
            for num, path in merged_images.items()
            if num in target_set
        ]
        uploaded = await loop.run_in_executor(
            None, upload_cropped_images, upload_items, f"solution_{solution_job_id}"
        )
        new_urls = {
            item["number"]: item["source_image_url"] for item in uploaded
        }
        merged_urls = dict(job.get("solution_image_urls") or {})
        merged_urls.update(new_urls)
        solution_jobs[solution_job_id]["solution_image_urls"] = merged_urls

        # 3. VL 모델 태깅 — 타겟 번호만
        solution_jobs[solution_job_id]["status"] = "tagging"
        update_solution_job(
            solution_job_id, status="tagging",
            progress=_merged_progress({
                "processed": 0,
                "total": len(target_set),
                "current_number": 0,
            }),
        )

        # 3-1. 문제 이미지 맵 구성 (문제+해설 동시 태깅용)
        problem_job_id = job.get("problem_job_id")
        problem_local_paths: dict[int, str] = {}
        if problem_job_id:
            try:
                staging_rows = await loop.run_in_executor(
                    None, get_staging_by_job, problem_job_id
                )
                problem_url_map: dict[int, str] = {}
                for row in staging_rows or []:
                    num = row.get("problem_number")
                    url = row.get("source_image_url")
                    if num is None or not url:
                        continue
                    try:
                        num_int = int(num)
                    except (TypeError, ValueError):
                        continue
                    if num_int in target_set:
                        problem_url_map[num_int] = url

                def _download_all(url_map: dict[int, str]) -> dict[int, str]:
                    local: dict[int, str] = {}
                    for n, u in url_map.items():
                        try:
                            local[n] = download_image(u)
                        except Exception as e:
                            logger.warning(f"문제 이미지 다운로드 실패 {n}: {e}")
                    return local

                problem_local_paths = await loop.run_in_executor(
                    None, _download_all, problem_url_map
                )
                logger.info(
                    f"문제 이미지 확보: {len(problem_local_paths)}/{len(target_set)}"
                )
            except Exception as e:
                logger.warning(f"문제 이미지 맵 구성 실패 (해설 단독 태깅으로 fallback): {e}")
                problem_local_paths = {}

        def _tag_runner():
            return tag_all_solutions(
                merged_images,
                _progress,
                numbers_filter=target_set,
                problem_images=problem_local_paths or None,
            )

        try:
            with ThreadPoolExecutor(max_workers=1) as executor:
                new_tag_results = await loop.run_in_executor(executor, _tag_runner)
        finally:
            for p in problem_local_paths.values():
                try:
                    os.unlink(p)
                except Exception:
                    pass

        # raw_response 제거 (JSONB 비대화 방지) — 디버깅용이라 DB 저장 불필요
        def _strip_raw(d: dict) -> dict:
            return {k: v for k, v in d.items() if k != "raw_response"}

        slim_new = {num: _strip_raw(r) for num, r in new_tag_results.items() if isinstance(r, dict)}
        merged_tag_results = dict(existing_tag_results)
        merged_tag_results.update(slim_new)
        solution_jobs[solution_job_id]["tag_results"] = merged_tag_results

        # 4. 완료 — progress 에 병합된 tag_results/solution_image_urls 도 저장
        update_solution_job(
            solution_job_id, status="done",
            progress=_merged_progress({
                "processed": len(target_set),
                "total": len(target_set),
                "tag_results": merged_tag_results,
                "solution_image_urls": merged_urls,
            }),
        )
        solution_jobs[solution_job_id]["status"] = "done"

    except Exception as e:
        solution_jobs[solution_job_id]["status"] = "error"
        solution_jobs[solution_job_id]["error"] = str(e)
        update_solution_job(solution_job_id, status="error", error=str(e))
        raise


@app.get("/api/staging/{staging_id}/tags")
async def get_staging_tags(staging_id: str):
    """staging 문제의 태그 목록 조회"""
    from storage.supabase_client import get_problem_tags
    tags = get_problem_tags(staging_id=staging_id)
    return tags


class TagsUpdateRequest(BaseModel):
    tags: list  # [{"tag": str, "tag_type": str, "confidence": float, "source": str}]


@app.put("/api/staging/{staging_id}/tags")
async def update_staging_tags(staging_id: str, body: TagsUpdateRequest):
    """staging 문제의 태그 전체 교체 (수동 편집 포함)"""
    from storage.supabase_client import upsert_problem_tags, get_client

    # 기존 태그 전체 삭제 후 재삽입
    client = get_client()
    client.table("problem_tags").delete().eq("staging_id", staging_id).execute()

    inserted = upsert_problem_tags(body.tags, staging_id=staging_id)
    return {"count": len(inserted), "tags": inserted}


@app.post("/api/solution/upload")
async def solution_upload(
    file: UploadFile = File(...),
    teacher_id: str = Form(...),
    problem_job_id: Optional[str] = Form(None),
):
    """해설지 PDF 업로드 → solution_job_id 반환"""
    if not file.filename:
        raise HTTPException(400, "파일명이 없습니다.")

    real_filename = _decode_upload_filename(file.filename)
    ext = Path(real_filename).suffix.lower()
    if ext != ".pdf":
        raise HTTPException(400, "PDF 파일만 지원합니다.")

    from storage.supabase_client import create_solution_job

    # solution_jobs DB 레코드 생성
    sol_job = create_solution_job(teacher_id, problem_job_id)
    solution_job_id = sol_job["id"]

    # 파일 저장 — 원본 파일명 기반 폴더, 충돌 시 _2, _3 부여
    folder_name = _sanitize_name(real_filename)
    save_dir = _unique_dir(Path(UPLOAD_DIR) / "solutions", folder_name)
    save_dir.mkdir(parents=True, exist_ok=True)
    save_path = save_dir / real_filename

    content = await file.read()
    with open(save_path, "wb") as f:
        f.write(content)

    from storage.supabase_client import update_solution_job
    update_solution_job(solution_job_id, status="uploaded", pdf_path=str(save_path))

    solution_jobs[solution_job_id] = {
        "solution_job_id": solution_job_id,
        "status": "uploaded",
        "filename": real_filename,
        "file_path": str(save_path),
        "teacher_id": teacher_id,
        "problem_job_id": problem_job_id,
        "answers": {},
        "solution_image_urls": {},
        "tag_results": {},
        "progress": {},
        "error": None,
    }

    return {"solution_job_id": solution_job_id, "filename": real_filename}


@app.post("/api/solution/extract/{solution_job_id}")
async def solution_extract(solution_job_id: str):
    """해설 크롭 + 정답 추출 (동기). 검수용 page_bboxes를 반환.

    업로드 + AI 태깅은 /api/solution/{id}/upload-and-tag에서 별도 처리.
    """
    if solution_job_id not in solution_jobs:
        raise HTTPException(404, "해설지 작업을 찾을 수 없습니다.")

    job = solution_jobs[solution_job_id]
    if job["status"] not in ["uploaded", "error", "reviewing"]:
        raise HTTPException(400, f"처리할 수 없는 상태: {job['status']}")

    from pipeline.solution_parser import extract_answers, crop_solutions
    from storage.supabase_client import update_solution_job
    from storage.image_uploader import upload_page_image
    from concurrent.futures import ThreadPoolExecutor

    pdf_path = job["file_path"]
    crop_dir = str(Path(pdf_path).parent / "solution_crops")

    solution_jobs[solution_job_id]["status"] = "extracting"
    update_solution_job(solution_job_id, status="extracting")

    loop = asyncio.get_event_loop()
    try:
        with ThreadPoolExecutor(max_workers=1) as executor:
            answers = await loop.run_in_executor(executor, extract_answers, pdf_path)
            crop_result = await loop.run_in_executor(executor, crop_solutions, pdf_path, crop_dir)

        pages = crop_result.get("pages", {})
        fragments = crop_result.get("fragments", {})

        # 페이지 원본 이미지를 Storage에 업로드해서 검수 UI에서 로드 가능하게
        page_bboxes: dict = {}
        for page_num, pdata in pages.items():
            page_img_path = pdata["page_image_path"]
            page_url = await loop.run_in_executor(
                None, upload_page_image, f"solution_{solution_job_id}", page_num, page_img_path
            )
            page_bboxes[page_num] = {
                "page_image_url": page_url,
                "page_width": pdata["page_width"],
                "page_height": pdata["page_height"],
                "items": pdata["items"],
            }

        # cropped_path/fragments 절대경로 → UPLOAD_DIR 상대경로로 정규화
        from config import to_upload_relative
        for pb in page_bboxes.values():
            for it in pb.get("items", []):
                cp = it.get("cropped_path")
                if cp:
                    it["cropped_path"] = to_upload_relative(cp)
        fragments = {
            k: [to_upload_relative(p) for p in paths]
            for k, paths in fragments.items()
        }

        solution_jobs[solution_job_id]["answers"] = answers
        solution_jobs[solution_job_id]["fragments"] = fragments
        solution_jobs[solution_job_id]["page_bboxes"] = page_bboxes
        solution_jobs[solution_job_id]["modified_pages"] = []
        solution_jobs[solution_job_id]["status"] = "reviewing"
        # DB progress에도 저장 → 서버 재시작 후 복구 가능
        update_solution_job(
            solution_job_id,
            status="reviewing",
            progress={
                "page_bboxes": page_bboxes,
                "answers": answers,
                "fragments": fragments,
                "modified_pages": [],
            },
        )

        total_numbers = len(fragments)
        return {
            "solution_job_id": solution_job_id,
            "page_bboxes": page_bboxes,
            "answers": answers,
            "total_numbers": total_numbers,
        }
    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        solution_jobs[solution_job_id]["status"] = "error"
        solution_jobs[solution_job_id]["error"] = str(e)
        solution_jobs[solution_job_id]["traceback"] = tb
        update_solution_job(solution_job_id, status="error", error=str(e))
        raise HTTPException(500, f"추출 실패: {e}\n\n{tb}")


class SolutionBboxUpdateItem(BaseModel):
    number: int
    bbox: Dict[str, float]  # {x1, y1, x2, y2}
    group_id: str | None = None  # L자/cross-page 묶기용 그룹 ID
    box_type: str = "solution"  # 'solution' | 'answer_table' (YOLO 2-클래스)


class SolutionUpdateBboxesRequest(BaseModel):
    page_number: int
    items: list  # [SolutionBboxUpdateItem]


@app.put("/api/solution/{solution_job_id}/update-bboxes")
async def solution_update_bboxes(solution_job_id: str, body: SolutionUpdateBboxesRequest):
    """사용자가 수정한 페이지별 bbox로 재크롭. fragments/page_bboxes 갱신."""
    if solution_job_id not in solution_jobs:
        if _hydrate_solution_job(solution_job_id) is None:
            raise HTTPException(404, "해설지 작업을 찾을 수 없습니다.")

    job = solution_jobs[solution_job_id]
    page_bboxes = job.get("page_bboxes", {})
    page_data = page_bboxes.get(body.page_number)
    if not page_data:
        raise HTTPException(404, f"{body.page_number}페이지 데이터 없음")

    from PIL import Image as PILImage
    from pipeline.image_cropper import _trim_whitespace

    # 기존 해당 페이지 조각들을 fragments에서 제거
    old_items = page_data.get("items", [])
    old_paths: list[str] = []
    for it in old_items:
        cp = it.get("cropped_path")
        if cp:
            old_paths.append(cp)

    # fragments 전역에서 이 페이지의 이전 경로들을 제거 (key가 int든 str이든 무관)
    fragments: dict = job.get("fragments", {})
    for key in list(fragments.keys()):
        fragments[key] = [p for p in fragments[key] if p not in old_paths]
        if not fragments[key]:
            del fragments[key]

    # 새 bbox로 재크롭
    pdf_parent = Path(job["file_path"]).parent
    crop_dir = pdf_parent / "solution_crops"
    crop_dir.mkdir(parents=True, exist_ok=True)

    # page_image_url이 아닌 로컬 페이지 원본 사용 — extract 시 pages_tmp_dir에 저장됨
    pages_tmp_dir = crop_dir / "_pages"
    # 페이지 원본 찾기
    local_page_imgs = sorted(pages_tmp_dir.glob("*.png"))
    page_img_path = None
    if body.page_number - 1 < len(local_page_imgs):
        page_img_path = str(local_page_imgs[body.page_number - 1])
    if not page_img_path or not Path(page_img_path).exists():
        raise HTTPException(500, "페이지 원본 이미지를 찾을 수 없습니다.")

    img = PILImage.open(page_img_path)
    new_items: list = []
    for idx, it in enumerate(body.items):
        num = it["number"] if isinstance(it, dict) else it.number
        bbox = it["bbox"] if isinstance(it, dict) else it.bbox
        box_type = (it.get("box_type") if isinstance(it, dict) else getattr(it, "box_type", None)) or "solution"
        group_id = it.get("group_id") if isinstance(it, dict) else getattr(it, "group_id", None)

        x1, y1 = int(bbox["x1"]), int(bbox["y1"])
        x2, y2 = int(bbox["x2"]), int(bbox["y2"])
        if x2 <= x1 or y2 <= y1:
            continue

        # 정답표는 라벨 메타만 저장, 크롭/fragments 제외 (해설 파이프라인 오염 방지)
        if box_type == "answer_table":
            new_items.append({
                "number": num,
                "bbox": {"x1": x1, "y1": y1, "x2": x2, "y2": y2},
                "cropped_path": None,
                "is_fragment": False,
                "group_id": group_id,
                "box_type": "answer_table",
            })
            continue

        cropped = img.crop((x1, y1, x2, y2))
        cropped = _trim_whitespace(cropped)
        # num이 None(OCR 미확정)이면 파일명/fragments key는 idx 기반 placeholder 사용
        num_token = f"{num:04d}" if isinstance(num, int) and num > 0 else f"none_{idx:02d}"
        save_abs = crop_dir / f"page_{body.page_number:03d}_{num_token}_edit_{idx}.png"
        cropped.save(str(save_abs))
        # DB 에는 UPLOAD_DIR 기준 상대경로만 저장 (UPLOAD_DIR 변경/이전 내성)
        from config import to_upload_relative
        save_rel = to_upload_relative(save_abs)

        frag_key = num if isinstance(num, int) and num > 0 else f"__page{body.page_number}_idx{idx}"
        fragments.setdefault(frag_key, []).append(save_rel)
        new_items.append({
            "number": num,
            "bbox": {"x1": x1, "y1": y1, "x2": x2, "y2": y2},
            "cropped_path": save_rel,
            "is_fragment": False,
            "group_id": group_id,
            "box_type": "solution",
        })
    img.close()

    # 메모리 갱신
    page_data["items"] = new_items
    job["fragments"] = fragments
    job["page_bboxes"][body.page_number] = page_data
    modified = set(job.get("modified_pages", []) or [])
    modified.add(body.page_number)
    job["modified_pages"] = sorted(modified)

    # DB progress 갱신 → 서버 재시작 후 복구 가능
    from storage.supabase_client import update_solution_job as _update_sj
    _update_sj(
        solution_job_id,
        status=job.get("status", "reviewing"),
        progress={
            "page_bboxes": job["page_bboxes"],
            "answers": job.get("answers", {}),
            "fragments": job.get("fragments", {}),
            "modified_pages": job["modified_pages"],
        },
    )

    return {"ok": True, "items": new_items, "fragments_count": len(fragments)}


@app.post("/api/solution/{solution_job_id}/upload-and-tag")
async def solution_upload_and_tag(
    solution_job_id: str,
    background_tasks: BackgroundTasks,
    sample_count: int | None = None,
    mode: str = "fresh",
):
    """검수 완료 후 병합 + Storage 업로드 + VL 모델 태깅 (백그라운드)

    쿼리 파라미터:
      sample_count: 앞 N개만 태깅 (예: 4) — 샘플 검증용. None 이면 대상 전체.
      mode: 'fresh'(기본) | 'continue'
            - fresh: 대상 번호를 앞에서부터 (sample_count 있으면 N개). 이미 태그 있어도 덮어쓰기.
            - continue: 아직 tag_results 에 없는 번호만 태깅 (이어서).
    """
    if mode not in ("fresh", "continue"):
        raise HTTPException(400, f"mode 값이 잘못됨: {mode}")

    if solution_job_id not in solution_jobs:
        if _hydrate_solution_job(solution_job_id) is None:
            raise HTTPException(404, "해설지 작업을 찾을 수 없습니다.")

    job = solution_jobs[solution_job_id]
    # continue 모드는 done 상태에서도 허용 (이미 일부 끝난 상태에서 이어서)
    allowed_statuses = {"reviewing", "error", "done"} if mode == "continue" else {"reviewing", "error", "done"}
    if job["status"] not in allowed_statuses:
        raise HTTPException(400, f"태깅 가능 상태 아님: {job['status']}")
    if not job.get("fragments"):
        raise HTTPException(400, "크롭 결과가 없습니다. extract부터 실행하세요.")

    background_tasks.add_task(
        _run_solution_upload_and_tag, solution_job_id, sample_count, mode
    )
    solution_jobs[solution_job_id]["status"] = "queued"
    return {
        "message": "AI 태깅 시작됨",
        "solution_job_id": solution_job_id,
        "sample_count": sample_count,
        "mode": mode,
    }


@app.get("/api/solution/by-problem/{problem_job_id}")
async def solution_by_problem(problem_job_id: str):
    """problem_job_id 로 연결된 최신 solution_jobs 역조회. 없으면 {} 반환."""
    from storage.supabase_client import get_solution_job_by_problem
    return get_solution_job_by_problem(problem_job_id)


@app.get("/api/solution/status/{solution_job_id}")
async def solution_status(solution_job_id: str):
    """해설지 파이프라인 진행 상황 조회. 메모리에 없으면 DB에서 복구(hydrate)한다."""
    if solution_job_id not in solution_jobs:
        if _hydrate_solution_job(solution_job_id) is None:
            raise HTTPException(404, "해설지 작업을 찾을 수 없습니다.")
    return solution_jobs[solution_job_id]


@app.post("/api/solution/match/{solution_job_id}")
async def solution_match(solution_job_id: str, body: SolutionMatchRequest):
    """문제 staging ↔ 해설 매칭 결과 미리보기 (DB 반영 없음)"""
    if solution_job_id not in solution_jobs:
        raise HTTPException(404, "해설지 작업을 찾을 수 없습니다.")

    job = solution_jobs[solution_job_id]
    if job["status"] != "done":
        raise HTTPException(400, f"해설지 추출이 완료되지 않았습니다. 현재 상태: {job['status']}")

    from pipeline.solution_matcher import match_solutions_to_problems, summarize_match_results
    from storage.supabase_client import get_staging_by_job

    staging = get_staging_by_job(body.problem_job_id)
    if not staging:
        raise HTTPException(404, "문제 staging 데이터를 찾을 수 없습니다.")

    match_results = match_solutions_to_problems(
        staging_problems=staging,
        answers=job["answers"],
        solution_images={num: "" for num in job["solution_image_urls"]},
        tag_results=job["tag_results"],
    )

    # URL 포함 버전으로 교체
    for sid, data in match_results.items():
        num = data["problem_number"]
        data["solution_image_url"] = job["solution_image_urls"].get(num)
        data.pop("solution_image_local_path", None)

    summary = summarize_match_results(match_results)
    return {"match_results": match_results, "summary": summary}


@app.post("/api/solution/apply/{solution_job_id}")
async def solution_apply(solution_job_id: str, body: SolutionApplyRequest):
    """매칭 결과를 problem_staging에 반영 + problem_tags 삽입

    overrides가 있으면 해당 staging_id의 answer/answer_type을 override 값으로 사용.
    """
    if solution_job_id not in solution_jobs:
        raise HTTPException(404, "해설지 작업을 찾을 수 없습니다.")

    job = solution_jobs[solution_job_id]
    if job["status"] != "done":
        raise HTTPException(400, f"해설지 추출이 완료되지 않았습니다. 현재 상태: {job['status']}")

    from pipeline.solution_matcher import match_solutions_to_problems
    from storage.supabase_client import (
        get_staging_by_job, update_staging_solution, upsert_problem_tags
    )

    staging = get_staging_by_job(body.problem_job_id)
    if not staging:
        raise HTTPException(404, "문제 staging 데이터를 찾을 수 없습니다.")

    match_results = match_solutions_to_problems(
        staging_problems=staging,
        answers=job["answers"],
        solution_images={num: "" for num in job["solution_image_urls"]},
        tag_results=job["tag_results"],
    )

    # override 딕셔너리 생성
    override_map: dict = {}
    if body.overrides:
        for ov in body.overrides:
            sid = ov.get("staging_id")
            if sid:
                override_map[sid] = ov

    # staging 기존 값 맵 — unit/difficulty 는 기존값 비어있을 때만 덮어쓰기
    staging_map = {row["id"]: row for row in staging}

    applied = 0
    for sid, data in match_results.items():
        num = data["problem_number"]
        sol_url = job["solution_image_urls"].get(num)

        # override 적용
        ov = override_map.get(sid, {})
        answer = ov.get("answer", data.get("answer"))
        answer_type = ov.get("answer_type", data.get("answer_type"))

        # unit/difficulty 는 override > 기존 staging 값이 비어있을 때만 AI 결과로
        existing_row = staging_map.get(sid, {})
        ai_unit = data.get("unit") or None
        ai_difficulty_score = data.get("difficulty_score")

        unit_val = ov.get("unit")
        if unit_val is None and not (existing_row.get("unit") or "").strip() and ai_unit:
            unit_val = ai_unit

        diff_score_val = ov.get("difficulty_score")
        if diff_score_val is None and existing_row.get("difficulty_score") is None and ai_difficulty_score:
            diff_score_val = ai_difficulty_score

        # staging 업데이트
        update_staging_solution(
            staging_id=sid,
            solution_image_url=sol_url,
            solution_summary=data.get("solution_summary"),
            solution_job_id=solution_job_id,
            match_confidence=data.get("match_confidence"),
            correct_answer=answer,
            answer_type=answer_type,
            pitfall=data.get("pitfall"),
            unit=unit_val,
            difficulty_score=diff_score_val,
            solution_steps=data.get("solution_steps") or None,
            common_mistakes=data.get("common_mistakes") or None,
        )

        # 태그 삽입 — concept_tags/skill_tags는 이제 list[str]
        tags = []
        for tag_name in data.get("concept_tags", []) or []:
            if not tag_name:
                continue
            tags.append({
                "tag": tag_name,
                "tag_type": "concept",
                "confidence": 1.0,
                "source": "ai",
            })
        for tag_name in data.get("skill_tags", []) or []:
            if not tag_name:
                continue
            tags.append({
                "tag": tag_name,
                "tag_type": "skill",
                "confidence": 1.0,
                "source": "ai",
            })
        if tags:
            upsert_problem_tags(tags, staging_id=sid)

        applied += 1

    return {"applied": applied, "message": f"{applied}개 문제에 해설/태그 적용 완료"}


# ── 해설지 YOLO 학습 인프라 ─────────────────────────────────────

from config import SOLUTION_MODEL_PATH as _SOLUTION_MODEL_PATH
from config import SOLUTION_EXPORT_LOG as _SOLUTION_EXPORT_LOG_PATH

retrain_solution_jobs: Dict[str, dict] = {}  # 해설지 재학습 진행 상태


def _load_solution_export_log() -> dict:
    if _SOLUTION_EXPORT_LOG_PATH.exists():
        try:
            return json.loads(_SOLUTION_EXPORT_LOG_PATH.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def _save_solution_export_log(log: dict):
    _SOLUTION_EXPORT_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    _SOLUTION_EXPORT_LOG_PATH.write_text(json.dumps(log, ensure_ascii=False, indent=2), encoding="utf-8")


class SolutionExportRequest(BaseModel):
    solution_job_id: str
    split_ratio: float = 0.8
    force: bool = False


@app.post("/api/solution/export-training-data")
async def export_solution_training_data(body: SolutionExportRequest):
    """검수 완료된 해설지 page_bboxes → YOLO 라벨 역수출

    solution_dataset/{images,labels,metadata}/{train,val}/ 에 저장.
    is_negative_page=True 페이지: 빈 라벨 (hard negative).
    박스 0개 + negative 아님: 제외 (실수 방지).
    """
    if not body.force:
        log = _load_solution_export_log()
        if body.solution_job_id in log:
            entry = log[body.solution_job_id]
            return {
                "already_exported": True,
                "exported_at": entry.get("exported_at"),
                "message": f"이미 {entry.get('exported_at')} 에 export됨. force=true로 재export 가능.",
            }

    if body.solution_job_id not in solution_jobs:
        if _hydrate_solution_job(body.solution_job_id) is None:
            raise HTTPException(404, "해설지 작업을 찾을 수 없습니다.")

    job = solution_jobs[body.solution_job_id]
    page_bboxes = job.get("page_bboxes", {})
    if not page_bboxes:
        raise HTTPException(400, "page_bboxes 데이터 없음. 검수 완료 후 실행하세요.")

    pdf_path = Path(job.get("file_path", ""))
    pages_tmp_dir = pdf_path.parent / "solution_crops" / "_pages"
    if not pages_tmp_dir.exists():
        raise HTTPException(500, f"페이지 이미지 디렉토리 없음: {pages_tmp_dir}")

    from yolo_training.solution_labels import export_solution_labels
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(
        None,
        lambda: export_solution_labels(
            body.solution_job_id, page_bboxes, pages_tmp_dir,
            split_ratio=body.split_ratio, force=body.force,
        )
    )

    # export 기록 저장
    from datetime import datetime as _dt
    log = _load_solution_export_log()
    log[body.solution_job_id] = {
        "exported_at": _dt.now().strftime("%Y-%m-%d %H:%M:%S"),
        "exported_pages": result.get("exported", 0),
        "train": result.get("train", 0),
        "val": result.get("val", 0),
    }
    _save_solution_export_log(log)

    return result


@app.get("/api/solution/export-training-data/{solution_job_id}/status")
async def get_solution_export_status(solution_job_id: str):
    """해설지 job의 export 여부 확인"""
    log = _load_solution_export_log()
    if solution_job_id in log:
        return {"exported": True, **log[solution_job_id]}
    return {"exported": False}


class RetrainSolutionRequest(BaseModel):
    base_weights: str = "models/yolov8n.pt"  # 첫 학습은 pretrained에서 시작
    epochs: int = 100
    run_name: str | None = None


@app.post("/api/retrain-solution")
async def start_retrain_solution(body: RetrainSolutionRequest):
    """해설지 YOLO 재학습 시작 (백그라운드)

    완료 시 best.pt를 models/solution_detector.pt로 자동 교체.
    """
    import re
    run_name = body.run_name
    if run_name is None:
        runs_dir = _YOLO_TRAINING_DIR / "runs"
        existing = [d.name for d in runs_dir.glob("solution_finetune_v*")] if runs_dir.exists() else []
        nums = [int(m.group(1)) for d in existing if (m := re.search(r"v(\d+)$", d))]
        next_v = max(nums, default=0) + 1
        run_name = f"solution_finetune_v{next_v}"

    retrain_id = str(uuid.uuid4())
    retrain_solution_jobs[retrain_id] = {"status": "pending", "run_name": run_name, "progress": ""}

    asyncio.create_task(_run_retrain_solution(retrain_id, body.base_weights, body.epochs, run_name))
    return {"retrain_id": retrain_id, "run_name": run_name, "status": "pending"}


@app.get("/api/retrain-solution/{retrain_id}")
async def get_retrain_solution_status(retrain_id: str):
    if retrain_id not in retrain_solution_jobs:
        raise HTTPException(status_code=404, detail="해설지 재학습 작업을 찾을 수 없습니다")
    return retrain_solution_jobs[retrain_id]


async def _run_retrain_solution(retrain_id: str, base_weights: str, epochs: int, run_name: str):
    import shutil
    import subprocess
    from datetime import datetime

    retrain_solution_jobs[retrain_id]["status"] = "training"

    # base_weights가 상대경로면 training dir 기준, 절대경로면 그대로
    base_weights_path = Path(base_weights)
    if not base_weights_path.is_absolute():
        base_weights_path = _YOLO_TRAINING_DIR.parent / base_weights

    if not base_weights_path.exists():
        retrain_solution_jobs[retrain_id] = {
            "status": "error",
            "message": f"가중치 파일 없음: {base_weights_path}",
        }
        return

    venv_python = _YOLO_TRAINING_DIR.parent / "venv" / "Scripts" / "python.exe"
    python_bin = str(venv_python) if venv_python.exists() else "python"

    cmd = [
        python_bin,
        str(_YOLO_TRAINING_DIR / "train_solution_finetune.py"),
        "--base-weights", str(base_weights_path),
        "--epochs", str(epochs),
        "--run-name", run_name,
    ]

    try:
        loop = asyncio.get_event_loop()
        proc = await loop.run_in_executor(
            None,
            lambda: subprocess.run(cmd, cwd=str(_YOLO_TRAINING_DIR), capture_output=True, text=True)
        )

        if proc.returncode != 0:
            retrain_solution_jobs[retrain_id] = {
                "status": "error",
                "message": proc.stderr[-2000:] if proc.stderr else "알 수 없는 오류",
            }
            return

        # best.pt 경로 파싱
        best_pt = None
        for line in proc.stdout.splitlines():
            if line.startswith("BEST_MODEL_PATH="):
                best_pt = Path(line.split("=", 1)[1].strip())
                break

        if best_pt is None or not best_pt.exists():
            best_pt = _YOLO_TRAINING_DIR / "runs" / run_name / "weights" / "best.pt"

        if not best_pt.exists():
            retrain_solution_jobs[retrain_id] = {"status": "error", "message": "best.pt를 찾을 수 없습니다"}
            return

        # 기존 모델 백업 후 원자적 교체
        if _SOLUTION_MODEL_PATH.exists():
            ts = datetime.now().strftime("%Y%m%d_%H%M%S")
            bak = _SOLUTION_MODEL_PATH.with_name(f"solution_detector.bak_{ts}.pt")
            shutil.copy2(_SOLUTION_MODEL_PATH, bak)

        shutil.copy2(best_pt, _SOLUTION_MODEL_PATH)

        retrain_solution_jobs[retrain_id] = {
            "status": "done",
            "run_name": run_name,
            "best_pt": str(best_pt),
            "model_updated": str(_SOLUTION_MODEL_PATH),
        }

    except Exception as e:
        retrain_solution_jobs[retrain_id] = {"status": "error", "message": str(e)}


@app.post("/api/solution/tag-from-problem/{staging_id}")
async def tag_from_problem(staging_id: str, background_tasks: BackgroundTasks):
    """해설 없이 문제 이미지만으로 AI 태깅 (문제 이미지 기반, confidence 낮음)"""
    from storage.supabase_client import get_client, upsert_problem_tags

    client = get_client()
    result = (
        client.table("problem_staging")
        .select("id, source_image_url, problem_number")
        .eq("id", staging_id)
        .single()
        .execute()
    )
    staging = result.data
    if not staging:
        raise HTTPException(404, "staging 문제를 찾을 수 없습니다.")

    image_url = staging.get("source_image_url")
    if not image_url:
        raise HTTPException(400, "문제 이미지가 없습니다.")

    async def _do_tag():
        from pipeline.solution_tagger import extract_tags_from_image
        from pipeline.structurizer import download_image
        import os

        try:
            img_path = download_image(image_url)
            result_data = extract_tags_from_image(img_path, has_solution=False)
            os.unlink(img_path)

            tags = []
            for t in result_data.get("concept_tags", []):
                tags.append({"tag": t["tag"], "tag_type": "concept",
                              "confidence": t["confidence"], "source": "ai"})
            for t in result_data.get("skill_tags", []):
                tags.append({"tag": t["tag"], "tag_type": "skill",
                              "confidence": t["confidence"], "source": "ai"})
            if tags:
                upsert_problem_tags(tags, staging_id=staging_id)
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"문제 이미지 태깅 실패 {staging_id}: {e}")

    background_tasks.add_task(_do_tag)
    return {"message": "태깅 시작됨 (백그라운드)", "staging_id": staging_id}
