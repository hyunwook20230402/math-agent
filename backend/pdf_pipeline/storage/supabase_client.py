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
            "bbox": p.get("bbox"),
            "source_page_image_url": p.get("source_page_image_url"),
            "page_number": p.get("page_number"),
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


def get_staging_by_page(job_id: str, page_number: int) -> list:
    """특정 페이지의 staging 문제 목록 조회"""
    client = get_client()
    result = (
        client.table("problem_staging")
        .select("*")
        .eq("job_id", job_id)
        .eq("page_number", page_number)
        .order("problem_number")
        .execute()
    )
    return result.data


def update_staging_bbox(staging_id: str, bbox: dict, new_image_url: str) -> dict:
    """staging 문제의 bbox + 이미지 URL 갱신"""
    client = get_client()
    result = (
        client.table("problem_staging")
        .update({"bbox": bbox, "source_image_url": new_image_url, "status": "modified"})
        .eq("id", staging_id)
        .execute()
    )
    return result.data[0] if result.data else {}


def delete_staging(staging_id: str) -> None:
    """staging 문제 삭제"""
    client = get_client()
    client.table("problem_staging").delete().eq("id", staging_id).execute()


def update_staging_image(staging_id: str, new_image_url: str) -> dict:
    """staging 문제의 이미지 URL 업데이트 (개별 이미지 교체용)"""
    client = get_client()
    result = (
        client.table("problem_staging")
        .update({"source_image_url": new_image_url, "status": "pending"})
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
        .in_("status", ["approved", "modified", "pending"])
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


# ── 해설지 job CRUD ────────────────────────────────────────────

def create_solution_job(teacher_id: str, problem_job_id: str | None = None) -> dict:
    """solution_jobs 레코드 생성 → job dict 반환"""
    client = get_client()
    row = {
        "teacher_id": teacher_id,
        "status": "pending",
        "progress": {},
    }
    if problem_job_id:
        row["problem_job_id"] = problem_job_id
    result = client.table("solution_jobs").insert(row).execute()
    return result.data[0] if result.data else {}


def update_solution_job(
    solution_job_id: str,
    status: str,
    progress: dict | None = None,
    error: str | None = None,
    pdf_path: str | None = None,
) -> dict:
    """solution_jobs 상태/프로그레스 업데이트"""
    client = get_client()
    payload: dict = {"status": status}
    if progress is not None:
        payload["progress"] = progress
    if error is not None:
        payload["error"] = error
    if pdf_path is not None:
        payload["pdf_path"] = pdf_path
    result = (
        client.table("solution_jobs")
        .update(payload)
        .eq("id", solution_job_id)
        .execute()
    )
    return result.data[0] if result.data else {}


def get_solution_job(solution_job_id: str) -> dict:
    """solution_jobs 단일 조회"""
    client = get_client()
    result = (
        client.table("solution_jobs")
        .select("*")
        .eq("id", solution_job_id)
        .single()
        .execute()
    )
    return result.data or {}


# ── problem_tags CRUD ──────────────────────────────────────────

def upsert_problem_tags(
    tags: list,
    staging_id: str | None = None,
    problem_id: str | None = None,
) -> list:
    """problem_tags 삽입 (기존 AI 태그 교체)

    Args:
      tags: [{"tag": str, "tag_type": "concept"|"skill", "confidence": float, "source": "ai"|"manual"}]
      staging_id: staging 레코드 ID (staging 단계)
      problem_id: problems 레코드 ID (승인 후)

    Returns:
      삽입된 레코드 목록
    """
    if not tags:
        return []
    client = get_client()

    # 기존 AI 태그 삭제 후 재삽입 (manual 태그는 보존)
    if staging_id:
        client.table("problem_tags").delete().eq(
            "staging_id", staging_id
        ).eq("source", "ai").execute()
    if problem_id:
        client.table("problem_tags").delete().eq(
            "problem_id", problem_id
        ).eq("source", "ai").execute()

    rows = []
    for t in tags:
        row = {
            "tag": t["tag"],
            "tag_type": t["tag_type"],
            "confidence": t.get("confidence", 1.0),
            "source": t.get("source", "ai"),
        }
        if staging_id:
            row["staging_id"] = staging_id
        if problem_id:
            row["problem_id"] = problem_id
        rows.append(row)

    result = client.table("problem_tags").insert(rows).execute()
    return result.data or []


def get_problem_tags(
    staging_id: str | None = None,
    problem_id: str | None = None,
) -> list:
    """problem_tags 조회"""
    client = get_client()
    query = client.table("problem_tags").select("*")
    if staging_id:
        query = query.eq("staging_id", staging_id)
    elif problem_id:
        query = query.eq("problem_id", problem_id)
    else:
        return []
    result = query.execute()
    return result.data or []


def update_staging_solution(
    staging_id: str,
    solution_image_url: str | None = None,
    solution_summary: str | None = None,
    solution_job_id: str | None = None,
    match_confidence: float | None = None,
    correct_answer: str | None = None,
    answer_type: str | None = None,
) -> dict:
    """staging 레코드에 해설 정보 업데이트"""
    client = get_client()
    payload: dict = {}
    if solution_image_url is not None:
        payload["solution_image_url"] = solution_image_url
    if solution_summary is not None:
        payload["solution_summary"] = solution_summary
    if solution_job_id is not None:
        payload["solution_job_id"] = solution_job_id
    if match_confidence is not None:
        payload["match_confidence"] = match_confidence
    if correct_answer is not None:
        payload["correct_answer"] = correct_answer
    if answer_type is not None:
        payload["answer_type"] = answer_type
    if not payload:
        return {}
    result = (
        client.table("problem_staging")
        .update(payload)
        .eq("id", staging_id)
        .execute()
    )
    return result.data[0] if result.data else {}
