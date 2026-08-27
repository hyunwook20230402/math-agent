"""problem_staging 테이블 CRUD"""
import logging
import uuid
from supabase import create_client, Client
from config import SUPABASE_URL, SUPABASE_SERVICE_KEY

logger = logging.getLogger(__name__)

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
            # 지면에 인쇄된 번호. 빠른정답표와 맞추는 기준이라 그대로 보존한다.
            "source_label": p.get("source_label"),
            "title": _build_title(p),
            "unit": p.get("unit", "미분류"),
            "difficulty_score": p.get("difficulty_score", 2),
            "answer_type": p.get("answer_type", "short_answer"),
            "correct_answer": p.get("correct_answer", ""),
            "choices": p.get("choices"),
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
        if p.get("folder_id"):
            row["folder_id"] = p["folder_id"]
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


# 상세 입력에서 고칠 수 있는 값 중 problems 로도 넘겨야 하는 것들.
# `difficulty`·`title` 은 파생/별도 규칙이라 제외한다.
_SYNC_TO_PROBLEMS = ("answer_type", "correct_answer", "choices",
                     "difficulty_score", "unit", "explanation")


def sync_promoted_problem(staging_row: dict, updates: dict | None) -> None:
    """staging 을 고쳤을 때 이미 승격된 problems 행에도 같은 값을 반영한다.

    승격(`promoted_to_problems=True`)된 뒤에는 `approve_to_problems` 가 멱등성 때문에
    그 행을 다시 만들지 않는다. 그래서 이 동기화가 없으면 상세 입력에서 정답을 넣어도
    학생에게 나가는 problems 행은 영영 빈 채로 남는다.
    """
    pid = staging_row.get("promoted_problem_id")
    if not pid or not updates:
        return
    payload = {k: v for k, v in updates.items() if k in _SYNC_TO_PROBLEMS}
    if not payload:
        return
    try:
        get_client().table("problems").update(payload).eq("id", pid).execute()
    except Exception as e:  # noqa: BLE001 — 동기화 실패로 staging 저장을 되돌리진 않는다
        logger.warning("[sync] problems %s 갱신 실패: %s", pid, e)


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
    # 멱등성: 아직 problems 로 승격 안 됨(promoted_to_problems=FALSE) 인 것만 대상.
    # → 재호출해도 중복 INSERT 가 안 된다.
    #
    # 예전엔 여기에 `.not_.is_("solution_image_url", "null")` 이 붙어 있었다.
    # 해설 태깅에서 단원·난이도·개념태그가 나오므로 "해설이 붙은 것만 등록" 시킨 것인데,
    # 그러면 **문제 PDF 만 올린 경우 승격이 0건**이라 화면에 아무것도 안 뜬다
    # (실측: 내신 21건이 staging 에 approved 로 남았는데 problems 에는 0건).
    # 해설을 늘 함께 올리는 게 아니어서 이 조건을 뺀다 — 해설 없이 올라온 문제는
    # unit='미분류', difficulty_score 기본값으로 등록되고, 메타는 나중에 채운다.
    staged = (
        client.table("problem_staging")
        .select("*")
        .eq("job_id", job_id)
        .eq("teacher_id", teacher_id)
        .in_("status", ["approved", "modified", "pending"])
        .eq("promoted_to_problems", False)
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
            "source_label": p.get("source_label"),
            "difficulty_score": p.get("difficulty_score", 2),
            "correct_rate": p.get("correct_rate"),
            "category": p.get("category", "기타"),
            "unit": p.get("unit", "미분류"),
            "image_url": p.get("source_image_url"),
            "answer_type": p.get("answer_type", "short_answer"),
            "correct_answer": p.get("correct_answer", ""),
            # 교사가 직접 만든 보기가 있으면 그대로 넘긴다.
            # (지면에 보기가 인쇄된 문제는 None — 학생 화면이 이미지를 보고 번호만 고른다.)
            "choices": p.get("choices"),
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
        if p.get("folder_id"):
            entry["folder_id"] = p["folder_id"]
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


# ── 빠른정답표 (스코프: 교재 전체 또는 폴더=회차/시험) ──────────────────
#
# 왜 스코프가 필요한가: 쎈 같은 교재는 번호가 책 전체에서 유일하지만(0001~1316),
# 모의고사·내신은 한 교재 안에 회차/학교가 폴더로 들어 있고 번호가 1~30 으로 겹친다.
# 교재 단위로만 담으면 25년 6월 답지가 24년 답지를 덮어쓴다(029 마이그레이션 참조).
#
#   folder_id 있음 → 그 회차/시험 답지        folder_id 없음 → 교재 전체 답지
#
# DB 의 유일성은 GENERATED 컬럼 scope_id = COALESCE(folder_id, textbook_id) 로 건다.

_ANSWER_KEY_FIELDS = "label,answer,answer_type,needs_review,folder_id"


def upsert_answer_keys(textbook_id: str, rows: list, source_pdf: str | None = None,
                       folder_id: str | None = None,
                       source_hash: str | None = None) -> list:
    """읽어 온 정답을 정답표에 넣는다. 같은 (스코프, 번호) 는 새 값으로 갱신.

    folder_id 를 주면 그 폴더(모의고사 회차·내신 학교) 답지로, 안 주면 교재 전체 답지로 담는다.
    """
    if not rows:
        return []
    client = get_client()
    payload = [{
        "textbook_id": textbook_id,
        "folder_id": folder_id,
        "label": r["label"],
        "answer": r.get("answer", ""),
        "answer_type": r.get("answer_type", "short_answer"),
        "needs_review": bool(r.get("needs_review")),
        "source_pdf": source_pdf,
        "source_hash": source_hash,
    } for r in rows]

    saved: list = []
    # 한 번에 수천 건을 보내면 요청이 커져 실패한다 — 500개씩 나눠 넣는다.
    for i in range(0, len(payload), 500):
        chunk = payload[i:i + 500]
        res = (
            client.table("answer_keys")
            .upsert(chunk, on_conflict="scope_id,label")
            .execute()
        )
        saved.extend(res.data or [])
    return saved


def _fetch_answer_keys(textbook_id: str, select: str = _ANSWER_KEY_FIELDS) -> list:
    """이 교재에 딸린 답지 전부(교재 전체 + 모든 폴더). PostgREST 상한을 넘게 나눠 읽는다.

    ⚠️ 나눠 읽을 땐 반드시 정렬을 건다. ORDER BY 없이 range 로 페이지를 넘기면 순서가
    보장되지 않아 **경계에서 행이 빠지거나 겹친다**. 정답표는 한 줄만 새도 그 문제가
    통째로 안 채워지므로 유일한 PK(id) 로 고정한다.
    """
    out: list = []
    client = get_client()
    step = 1000
    start = 0
    while True:
        res = (
            client.table("answer_keys")
            .select(select)
            .eq("textbook_id", textbook_id)
            .order("id")
            .range(start, start + step - 1)
            .execute()
        )
        batch = res.data or []
        out.extend(batch)
        if len(batch) < step:
            return out
        start += step


def get_answer_keys(textbook_id: str, folder_id: str | None = None) -> list:
    """이 스코프에서 쓸 정답표.

    folder_id 를 주면 **그 폴더 답지가 교재 전체 답지를 이긴다**. 덕분에
      · 쎈처럼 교재 전체로 한 번 넣어둔 답지는 어느 단원 폴더에서도 그대로 쓰이고,
      · 모의고사는 그 회차 답지만 정확히 붙는다.
    폴더 답지가 없는 번호는 교재 전체 답지로 자연히 폴백된다.
    """
    rows = _fetch_answer_keys(textbook_id)
    merged: dict = {}
    for r in rows:                          # 1) 교재 전체 답지를 깔고
        if not r.get("folder_id"):
            merged[r["label"]] = r
    if folder_id:                           # 2) 그 위에 폴더 답지를 덮는다
        for r in rows:
            if r.get("folder_id") == folder_id:
                merged[r["label"]] = r
    return list(merged.values())


def get_answer_key_summary(textbook_id: str) -> dict:
    """이 교재에 저장된 답지 현황 — 또 돈을 쓸지 판단하는 근거.

    스코프(교재 전체 / 폴더별)마다 개수·번호 범위·출처 PDF·갱신 시각을 준다.
    """
    rows = _fetch_answer_keys(textbook_id, "label,folder_id,needs_review,source_pdf,source_hash,updated_at")
    scopes: dict = {}
    for r in rows:
        key = r.get("folder_id") or ""      # "" = 교재 전체
        g = scopes.setdefault(key, {
            "folder_id": r.get("folder_id"), "count": 0, "needs_review": 0,
            "labels": [], "source_pdf": r.get("source_pdf"),
            "source_hashes": set(), "updated_at": r.get("updated_at"),
        })
        g["count"] += 1
        g["needs_review"] += 1 if r.get("needs_review") else 0
        g["labels"].append(r["label"])
        if r.get("source_hash"):
            g["source_hashes"].add(r["source_hash"])
        if (r.get("updated_at") or "") > (g["updated_at"] or ""):
            g["updated_at"] = r.get("updated_at")

    out = []
    for g in scopes.values():
        labels = sorted(g.pop("labels"), key=lambda x: (len(x), x))
        g["label_min"] = labels[0] if labels else None
        g["label_max"] = labels[-1] if labels else None
        g["source_hashes"] = sorted(g["source_hashes"])
        out.append(g)
    out.sort(key=lambda g: (g["folder_id"] is not None, -g["count"]))
    return {"total": len(rows), "scopes": out}
