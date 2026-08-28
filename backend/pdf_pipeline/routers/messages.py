"""학부모/학생 문자 발송 API — 교사 전용.

설계 원칙: **클라이언트는 전화번호를 보내지 않는다.**
student_ids + template 만 받고, 서버가
  ① 소유권 검증(그 학생이 정말 내 학생인가) → ② 번호 조회 → ③ 학생별 치환
  → ④ 발송 → ⑤ message_logs 기록
을 한다. RLS 가 비활성이라 이 소유권 검증이 유일한 방어선이다 —
빠뜨리면 남의 학생 학부모 번호로 문자가 나간다.

솔라피 키가 없으면 handlers.sms_sender 가 모의발송(status='mock')으로 떨어진다.
"""
import logging
import uuid
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from auth import get_teacher_id
from config import ACADEMY_NAME
from handlers import sms_sender
from storage.supabase_client import get_client

logger = logging.getLogger(__name__)

router = APIRouter()

_MAX_RECIPIENTS = 200


class SendRequest(BaseModel):
    student_ids: list[str]
    template: str
    recipient_kind: Literal["parent", "student"] = "parent"
    message_type: Literal["notice", "attendance", "report"] = "notice"
    extra_vars: dict[str, str] = Field(default_factory=dict)
    report_id: str | None = None      # 학습보고서 발송이면 sent_at 갱신


class SendResultItem(BaseModel):
    student_id: str
    student_name: str
    status: str                        # sent | failed | mock | skipped
    error: str | None = None


class SendResponse(BaseModel):
    batch_id: str
    mock: bool
    sent: int
    failed: int
    skipped: int
    results: list[SendResultItem]


@router.get("/config")
async def get_config(teacher_id: str = Depends(get_teacher_id)):
    """화면이 '모의 발송 모드' 배너를 띄울지 판단하는 용도."""
    return {"configured": sms_sender.is_configured(), "academy_name": ACADEMY_NAME}


@router.post("/send", response_model=SendResponse)
async def send_messages(req: SendRequest, teacher_id: str = Depends(get_teacher_id)):
    if not req.student_ids:
        raise HTTPException(status_code=400, detail="수신자를 선택해주세요")
    if not req.template.strip():
        raise HTTPException(status_code=400, detail="메시지 내용을 입력해주세요")

    unique_ids = list(dict.fromkeys(req.student_ids))
    if len(unique_ids) > _MAX_RECIPIENTS:
        raise HTTPException(
            status_code=400, detail=f"한 번에 {_MAX_RECIPIENTS}명까지 보낼 수 있습니다"
        )

    sb = get_client()

    # ── ① 소유권 검증 ──────────────────────────────────────────────
    rows = (
        sb.table("profiles")
        .select("id, name, grade, school, role, teacher_id, parent_phone, student_phone")
        .in_("id", unique_ids)
        .execute()
        .data
        or []
    )
    mine = [r for r in rows if r.get("teacher_id") == teacher_id and r.get("role") == "student"]
    if len(mine) != len(unique_ids):
        raise HTTPException(status_code=403, detail="내 학생이 아닌 대상이 포함돼 있습니다")

    teacher = (
        sb.table("profiles").select("name").eq("id", teacher_id).single().execute().data or {}
    )

    batch_id = str(uuid.uuid4())
    now_iso = datetime.now(timezone.utc).isoformat()

    phone_field = "parent_phone" if req.recipient_kind == "parent" else "student_phone"

    targets: list[tuple[dict, str, str]] = []   # (profile, phone, body)
    skipped: list[dict] = []
    for r in mine:
        phone = sms_sender.normalize_phone(r.get(phone_field))
        body = sms_sender.render_template(
            req.template,
            {
                "학생이름": r.get("name") or "",
                "학년": r.get("grade") or "",
                "학교": r.get("school") or "",
                "선생님이름": teacher.get("name") or "",
                "학원명": ACADEMY_NAME,
                **req.extra_vars,
            },
        )
        if not phone:
            skipped.append(r)
            continue
        targets.append((r, phone, body))

    # ── ② 발송 (키 없으면 mock) ────────────────────────────────────
    outcomes = sms_sender.send_bulk([(p, b) for _, p, b in targets])

    # ── ③ 로그 (성공·실패·모의·번호없음 전부 남긴다) ─────────────────
    log_rows = []
    results: list[SendResultItem] = []

    for (prof, phone, body), outcome in zip(targets, outcomes):
        log_rows.append(
            {
                "teacher_id": teacher_id,
                "student_id": prof["id"],
                "batch_id": batch_id,
                "recipient_kind": req.recipient_kind,
                "recipient_phone": phone,
                "message_type": req.message_type,
                "body": body,
                "status": outcome.status,
                "provider": "solapi",
                "provider_message_id": outcome.provider_message_id,
                "error": outcome.error,
                "sent_at": now_iso,
            }
        )
        results.append(
            SendResultItem(
                student_id=prof["id"],
                student_name=prof.get("name") or "",
                status=outcome.status,
                error=outcome.error,
            )
        )

    for prof in skipped:
        log_rows.append(
            {
                "teacher_id": teacher_id,
                "student_id": prof["id"],
                "batch_id": batch_id,
                "recipient_kind": req.recipient_kind,
                "recipient_phone": "",
                "message_type": req.message_type,
                "body": "",
                "status": "skipped",
                "provider": "solapi",
                "error": "번호 미등록",
                "sent_at": now_iso,
            }
        )
        results.append(
            SendResultItem(
                student_id=prof["id"],
                student_name=prof.get("name") or "",
                status="skipped",
                error="번호 미등록",
            )
        )

    if log_rows:
        try:
            sb.table("message_logs").insert(log_rows).execute()
        except Exception as exc:
            # 발송은 이미 나갔다. 로그 실패로 500 을 던지면 화면은 실패로 보이고
            # 선생님이 다시 눌러 중복 발송이 된다 → 경고만 남기고 결과는 그대로 준다.
            logger.error(f"message_logs 기록 실패(발송은 완료): {exc}")

    # ── ④ 학습보고서 발송이면 보고서에 발송 시각 기록 ────────────────
    if req.report_id and any(x.status in ("sent", "mock") for x in results):
        try:
            body_sample = targets[0][2] if targets else req.template
            sb.table("monthly_reports").update(
                {"sent_at": now_iso, "sms_body": body_sample}
            ).eq("id", req.report_id).execute()
        except Exception as exc:
            logger.error(f"monthly_reports.sent_at 갱신 실패: {exc}")

    return SendResponse(
        batch_id=batch_id,
        mock=not sms_sender.is_configured(),
        sent=sum(1 for r in results if r.status == "sent"),
        failed=sum(1 for r in results if r.status == "failed"),
        skipped=sum(1 for r in results if r.status == "skipped"),
        results=results,
    )
