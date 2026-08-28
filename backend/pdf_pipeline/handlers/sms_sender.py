"""솔라피(Solapi) 문자 발송 — 키가 없으면 모의발송(mock).

왜 SDK 를 안 쓰나:
  - httpx 는 이미 requirements 에 있다(신규 의존성 0).
  - 솔라피 인증은 HMAC-SHA256 헤더 한 줄이라 SDK 이득이 없다.
  - 키가 없을 때의 mock 분기를 우리 코드가 완전히 통제해야 한다
    (계정 준비 전에도 화면·로그가 그대로 돌아야 하므로).

키(SOLAPI_API_KEY/SECRET/SENDER_PHONE)를 .env 에 채우면 코드 변경 없이 실발송으로 바뀐다.
"""
import hashlib
import hmac
import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

import httpx

from config import (
    ACADEMY_NAME,
    SOLAPI_API_KEY,
    SOLAPI_API_SECRET,
    SOLAPI_SENDER_PHONE,
)

logger = logging.getLogger(__name__)

SOLAPI_URL = "https://api.solapi.com/messages/v4/send-many/detail"
_TIMEOUT = 30.0


@dataclass
class SendOutcome:
    status: str                      # 'sent' | 'failed' | 'mock'
    provider_message_id: str | None = None
    error: str | None = None


def is_configured() -> bool:
    """실발송 가능 여부. 셋 중 하나라도 비면 모의발송으로 떨어진다."""
    return bool(SOLAPI_API_KEY and SOLAPI_API_SECRET and SOLAPI_SENDER_PHONE)


def normalize_phone(raw: str | None) -> str:
    """숫자만 남긴다. 빈 문자열이면 발송 대상에서 제외된다."""
    if not raw:
        return ""
    return "".join(ch for ch in str(raw) if ch.isdigit())


def sms_bytes(text: str) -> int:
    """SMS 길이 계산 — 한글 등 비ASCII 는 2byte. 프론트 미리보기와 같은 규칙."""
    return sum(2 if ord(c) > 0x7F else 1 for c in text)


def message_type(text: str) -> str:
    """90byte 이하면 SMS, 넘으면 LMS(장문). 단가가 달라 미리 보여줘야 한다."""
    return "SMS" if sms_bytes(text) <= 90 else "LMS"


def _auth_header() -> str:
    date = datetime.now(timezone.utc).isoformat()
    salt = uuid.uuid4().hex
    signature = hmac.new(
        SOLAPI_API_SECRET.encode(),
        (date + salt).encode(),
        hashlib.sha256,
    ).hexdigest()
    return (
        f"HMAC-SHA256 apiKey={SOLAPI_API_KEY}, date={date}, "
        f"salt={salt}, signature={signature}"
    )


def render_template(template: str, variables: dict[str, str]) -> str:
    """#{학생이름} 형태의 자리표시자를 치환한다. 모르는 변수는 그대로 둔다."""
    out = template
    for key, value in variables.items():
        out = out.replace("#{" + key + "}", str(value if value is not None else ""))
    return out


def send_bulk(items: list[tuple[str, str]]) -> list[SendOutcome]:
    """[(수신번호, 본문)] → 건별 결과.

    키가 없으면 전부 mock(문자 안 나감, 로그만 남는다).
    실패는 예외를 던지지 않고 건별 status='failed' 로 돌려준다 —
    한 건 실패로 전체 발송이 무산되면 안 되고, 로그에 남아야 추적이 된다.
    """
    if not items:
        return []

    if not is_configured():
        logger.info(f"솔라피 키 미설정 — 모의 발송 {len(items)}건")
        return [SendOutcome(status="mock") for _ in items]

    payload = {
        "messages": [
            {
                "to": to,
                "from": SOLAPI_SENDER_PHONE,
                "text": text,
                "type": message_type(text),
                **(
                    {"subject": f"[{ACADEMY_NAME}] 알림"}
                    if message_type(text) == "LMS"
                    else {}
                ),
            }
            for to, text in items
        ]
    }

    try:
        resp = httpx.post(
            SOLAPI_URL,
            json=payload,
            headers={
                "Authorization": _auth_header(),
                "Content-Type": "application/json",
            },
            timeout=_TIMEOUT,
        )
    except Exception as exc:
        logger.error(f"솔라피 호출 실패: {exc}")
        return [SendOutcome(status="failed", error=str(exc)) for _ in items]

    if resp.status_code >= 400:
        detail = resp.text[:300]
        logger.error(f"솔라피 {resp.status_code}: {detail}")
        return [SendOutcome(status="failed", error=f"{resp.status_code} {detail}") for _ in items]

    body = resp.json() if resp.content else {}

    # 실패건은 failedMessageList 로 온다. 인덱스가 아니라 수신번호(to)로 매칭해야 안전하다
    # (성공/실패 목록의 순서가 요청 순서와 같다는 보장이 없다).
    failed_by_phone: dict[str, str] = {}
    for f in body.get("failedMessageList") or []:
        phone = normalize_phone(f.get("to"))
        failed_by_phone[phone] = f.get("statusMessage") or f.get("statusCode") or "발송 실패"

    group_id = (body.get("groupInfo") or {}).get("_id") or body.get("groupId")

    outcomes: list[SendOutcome] = []
    for to, _text in items:
        key = normalize_phone(to)
        if key in failed_by_phone:
            outcomes.append(SendOutcome(status="failed", error=failed_by_phone[key]))
        else:
            outcomes.append(SendOutcome(status="sent", provider_message_id=group_id))
    return outcomes
