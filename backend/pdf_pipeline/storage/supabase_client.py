"""problem_staging 테이블 CRUD"""
import uuid
from supabase import create_client, Client
from config import SUPABASE_URL, SUPABASE_SERVICE_KEY

_client: Client | None = None


def get_client() -> Client:
    global _client
    if _client is None:
        if not SUPABASE_SERVICE_KEY:
            raise ValueError("SUPABASE_SERVICE_KEY가 설정되지 않았습니다. .env 파일을 확인하세요.")
        _client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    return _client


def insert_staging_problems(job_id: str, teacher_id: str, problems: list) -> list:
    """구조화된 문제 목록을 problem_staging에 저장"""
    client = get_client()
    rows = []
    for p in problems:
        row = {
            "job_id": job_id,
            "teacher_id": teacher_id,
            "problem_number": p.get("problem_number"),
            "title": _build_title(p),
            "unit": p.get("unit", "미분류"),
            "difficulty": p.get("difficulty", "medium"),
            "answer_type": p.get("answer_type", "short_answer"),
            "correct_answer": p.get("correct_answer", ""),
            "choices": None,
            "explanation": p.get("explanation"),
            "problem_text": p.get("problem_text", ""),
            "source_image_url": p.get("source_image_url"),
            "source_pdf": p.get("source_pdf"),
            "source_page": p.get("source_page"),
            "confidence": p.get("confidence", 0.5),
            "category": p.get("category"),
            "status": "pending",
        }
        if p.get("textbook_id"):
            row["textbook_id"] = p["textbook_id"]
        if p.get("chapter_id"):
            row["chapter_id"] = p["chapter_id"]
        if p.get("page_start"):
            row["page_start"] = p["page_start"]
        if p.get("page_end"):
            row["page_end"] = p["page_end"]
        rows.append(row)

    result = client.table("problem_staging").insert(rows).execute()
    return result.data


def get_staging_by_job(job_id: str) -> list:
    client = get_client()
    result = (
        client.table("problem_staging")
        .select("*")
        .eq("job_id", job_id)
        .order("problem_number")
        .execute()
    )
    return result.data


def update_staging_status(staging_id: str, status: str, updates: dict | None = None) -> dict:
    client = get_client()
    payload = {"status": status}
    if updates:
        payload.update(updates)
    result = (
        client.table("problem_staging")
        .update(payload)
        .eq("id", staging_id)
        .execute()
    )
    return result.data[0] if result.data else {}


def approve_to_problems(job_id: str, teacher_id: str) -> int:
    """승인된 staging 문제를 problems 테이블로 이동"""
    client = get_client()
    staged = (
        client.table("problem_staging")
        .select("*")
        .eq("job_id", job_id)
        .eq("teacher_id", teacher_id)
        .eq("status", "approved")
        .execute()
    ).data

    if not staged:
        return 0

    problems = []
    for p in staged:
        entry = {
            "teacher_id": teacher_id,
            "title": p.get("title") or _build_title(p),
            "problem_number": p.get("problem_number", 1),
            "difficulty": p.get("difficulty", "medium"),
            "category": p.get("category", "기타"),
            "unit": p.get("unit", "미분류"),
            "image_url": p.get("source_image_url"),
            "answer_type": p.get("answer_type", "short_answer"),
            "correct_answer": p.get("correct_answer", ""),
            "choices": None,
            "explanation": p.get("explanation"),
            "structuring_status": "pending",
            "source_info": {
                "book": p.get("category", "기타"),
                "page": p.get("source_page"),
                "pdf": p.get("source_pdf"),
                "job_id": str(p.get("job_id", "")),
            },
        }
        if p.get("textbook_id"):
            entry["textbook_id"] = p["textbook_id"]
        if p.get("chapter_id"):
            entry["chapter_id"] = p["chapter_id"]
        problems.append(entry)

    client.table("problems").insert(problems).execute()
    # staging 상태 업데이트
    client.table("problem_staging").update({"status": "approved"}).eq("job_id", job_id).execute()
    return len(problems)


def _build_title(p: dict) -> str:
    category = p.get("category", "기타")
    unit = p.get("unit", "")
    number = p.get("problem_number", "?")
    return f"{category} {unit} {number}번".strip()
