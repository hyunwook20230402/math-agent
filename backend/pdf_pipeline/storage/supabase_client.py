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
            "difficulty_score": p.get("difficulty_score", 2),
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


def approve_to_problems(job_id: str, teacher_id: str) -> list[dict]:
    """승인된 staging 문제를 problems 테이블로 이동.

    반환: INSERT 된 problems 행 리스트(id·solution_image_url 등 포함).
      승인 직후 풀이 노드 자동 추출 등 후속 작업이 problem_id 를 쓸 수 있게 한다.
      대상 없으면 빈 리스트.
    """
    client = get_client()
    # 멱등성: 아직 problems 로 승격 안 됨(promoted_to_problems=FALSE) + 해설 태깅 완료
    # (solution_image_url 있음) 인 것만 대상. → 중복 INSERT 와 빈 메타 등록을 동시에 막는다.
    staged = (
        client.table("problem_staging")
        .select("*")
        .eq("job_id", job_id)
        .eq("teacher_id", teacher_id)
        .in_("status", ["approved", "modified", "pending"])
        .eq("promoted_to_problems", False)
        .not_.is_("solution_image_url", "null")
        .execute()
    ).data

    if not staged:
        return []

    problems = []
    promoted_ids = []
    for p in staged:
        promoted_ids.append(p["id"])
        entry = {
            "teacher_id": teacher_id,
            # 제목은 항상 source_pdf 기반(_build_title)으로. staging.title 에는 단원경로가
            # 박혀 있어 화면이 길어지므로 무시한다. 예: "평가원 6월 26년 1번".
            "title": _build_title(p),
            "problem_number": p.get("problem_number", 1),
            "difficulty_score": p.get("difficulty_score", 2),
            "correct_rate": p.get("correct_rate"),
            "category": p.get("category", "기타"),
            "unit": p.get("unit", "미분류"),
            "image_url": p.get("source_image_url"),
            "answer_type": p.get("answer_type", "short_answer"),
            "correct_answer": p.get("correct_answer", ""),
            "choices": None,
            "explanation": p.get("explanation"),
            "structuring_status": "pending",
            # 해설/온톨로지 필드 (staging → problems 복사)
            "solution_image_url": p.get("solution_image_url"),
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

    inserted = client.table("problems").insert(problems).execute().data or []
    # 승격된 staging 만 promoted_to_problems=TRUE 로 마킹 → 재호출해도 중복 INSERT 안 됨.
    # status 도 'approved' 로(modified 는 YOLO 학습 마킹 겸용이라 보존).
    if promoted_ids:
        client.table("problem_staging") \
            .update({"promoted_to_problems": True}) \
            .in_("id", promoted_ids) \
            .execute()
        client.table("problem_staging") \
            .update({"status": "approved"}) \
            .in_("id", promoted_ids) \
            .neq("status", "modified") \
            .execute()
        # 백링크: staging.promoted_problem_id 에 방금 만든 problems.id 저장(상세입력에서
        # 노드 편집기를 그 id 로 연다). problem_number 로 매핑(INSERT 반환 순서에 비의존).
        num_to_pid = {row.get("problem_number"): row.get("id") for row in inserted}
        for p in staged:
            pid = num_to_pid.get(p.get("problem_number"))
            if pid:
                client.table("problem_staging") \
                    .update({"promoted_problem_id": pid}) \
                    .eq("id", p["id"]) \
                    .execute()
                # 개념/스킬 태그를 staging_id → problem_id 로 복사.
                # (취약점 분석은 problem_tags.problem_id 기준으로 집계하므로 승격 시 옮겨줘야 함.)
                _copy_tags_staging_to_problem(p["id"], pid)
    return inserted


def _copy_tags_staging_to_problem(staging_id: str, problem_id: str) -> None:
    """staging 단계에서 붙은 AI 태그를 승격된 problem_id 로 복사.

    problem_tags 는 staging 단계에서 staging_id 로만 저장된다. 승격 후
    취약점 분석(student_answers ⨝ problem_tags.problem_id)이 가능하려면
    같은 태그를 problem_id 로도 남겨야 한다. 멱등(기존 AI 태그 교체)."""
    try:
        client = get_client()
        existing = (
            client.table("problem_tags")
            .select("tag, tag_type, confidence, source")
            .eq("staging_id", staging_id)
            .execute()
        ).data or []
        if not existing:
            return
        upsert_problem_tags(existing, problem_id=problem_id)
    except Exception as e:  # 태그 복사 실패가 승격 자체를 막지 않게
        print(f"[approve] 태그 복사 실패 staging={staging_id} problem={problem_id}: {e}")


def _build_title(p: dict) -> str:
    import re as _re
    number = p.get("problem_number", "?")
    # source_pdf 파일명에서 제목 추출: "평가원 6월 25년_문제.pdf" → "평가원 6월 25년"
    source_pdf = p.get("source_pdf") or ""
    if source_pdf:
        basename = _re.split(r"[/\\]", source_pdf)[-1]  # 파일명만
        stem = _re.sub(r"\.pdf$", "", basename, flags=_re.IGNORECASE)
        stem = _re.sub(r"[_\s]*(문제|해설|정답|answer|solution)\s*$", "", stem, flags=_re.IGNORECASE).strip()
        if stem:
            return f"{stem} {number}번"
    # fallback: category + unit 첫 계층
    category = p.get("category", "기타")
    unit_top = (p.get("unit") or "").split(" > ")[0]
    base = f"{category} {unit_top}".strip() if unit_top else category
    return f"{base} {number}번"


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


def _coerce_int_key(k):
    """숫자 str 이면 int 로, 아니면 원본 유지."""
    if isinstance(k, int):
        return k
    if isinstance(k, str) and k.isdigit():
        return int(k)
    return k


def _normalize_solution_progress(progress: dict) -> dict:
    """JSONB 역직렬화로 str 이 된 숫자 key 를 int 로 통일.

    - fragments: {str(num): [...]} → {int(num): [...]} (비숫자 key 는 그대로)
    - page_bboxes: {str(page): {...}} → {int(page): {...}}
    - page_bboxes[*].items[*].number: 숫자 str 이면 int 로
    """
    if not isinstance(progress, dict):
        return progress

    out = dict(progress)

    fragments = progress.get("fragments")
    if isinstance(fragments, dict):
        out["fragments"] = {_coerce_int_key(k): v for k, v in fragments.items()}

    page_bboxes = progress.get("page_bboxes")
    if isinstance(page_bboxes, dict):
        new_pb: dict = {}
        for pk, pdata in page_bboxes.items():
            nk = _coerce_int_key(pk)
            if isinstance(pdata, dict):
                new_pdata = dict(pdata)
                items = pdata.get("items")
                if isinstance(items, list):
                    new_items = []
                    for it in items:
                        if isinstance(it, dict) and "number" in it:
                            new_it = dict(it)
                            new_it["number"] = _coerce_int_key(it["number"])
                            new_items.append(new_it)
                        else:
                            new_items.append(it)
                    new_pdata["items"] = new_items
                new_pb[nk] = new_pdata
            else:
                new_pb[nk] = pdata
        out["page_bboxes"] = new_pb

    tag_results = progress.get("tag_results")
    if isinstance(tag_results, dict):
        out["tag_results"] = {_coerce_int_key(k): v for k, v in tag_results.items()}

    solution_image_urls = progress.get("solution_image_urls")
    if isinstance(solution_image_urls, dict):
        out["solution_image_urls"] = {
            _coerce_int_key(k): v for k, v in solution_image_urls.items()
        }

    answers = progress.get("answers")
    if isinstance(answers, dict):
        out["answers"] = {_coerce_int_key(k): v for k, v in answers.items()}

    return out


def get_solution_job(solution_job_id: str) -> dict:
    """solution_jobs 단일 조회 (progress key 타입 정규화 포함)"""
    client = get_client()
    result = (
        client.table("solution_jobs")
        .select("*")
        .eq("id", solution_job_id)
        .single()
        .execute()
    )
    data = result.data or {}
    if data and isinstance(data.get("progress"), dict):
        data["progress"] = _normalize_solution_progress(data["progress"])
    return data


def get_solution_job_by_problem(problem_job_id: str) -> dict:
    """problem_job_id 로 가장 최근 solution_jobs 역조회 (없으면 {})."""
    client = get_client()
    result = (
        client.table("solution_jobs")
        .select("*")
        .eq("problem_job_id", problem_job_id)
        .order("created_at", desc=True)
        .limit(1)
        .execute()
    )
    return result.data[0] if result.data else {}


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
    solution_job_id: str | None = None,
    match_confidence: float | None = None,
    correct_answer: str | None = None,
    answer_type: str | None = None,
    unit: str | None = None,
    difficulty_score: int | None = None,
    correct_rate: float | None = None,
    validation_status: str | None = None,
    validation_score: float | None = None,
    validation_issues: list | None = None,
    title: str | None = None,
) -> dict:
    """staging 레코드에 해설 정보 업데이트"""
    client = get_client()
    payload: dict = {}
    if solution_image_url is not None:
        payload["solution_image_url"] = solution_image_url
    if solution_job_id is not None:
        payload["solution_job_id"] = solution_job_id
    if match_confidence is not None:
        payload["match_confidence"] = match_confidence
    if correct_answer is not None:
        payload["correct_answer"] = correct_answer
    if answer_type is not None:
        payload["answer_type"] = answer_type
    if unit is not None:
        payload["unit"] = unit
    if difficulty_score is not None:
        payload["difficulty_score"] = difficulty_score
    if correct_rate is not None:
        payload["correct_rate"] = correct_rate
    if validation_status is not None:
        payload["validation_status"] = validation_status
    if validation_score is not None:
        payload["validation_score"] = validation_score
    if validation_issues is not None:
        payload["validation_issues"] = validation_issues
    if title is not None:
        payload["title"] = title
    if not payload:
        return {}
    result = (
        client.table("problem_staging")
        .update(payload)
        .eq("id", staging_id)
        .execute()
    )
    return result.data[0] if result.data else {}
