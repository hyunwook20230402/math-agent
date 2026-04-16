"""Supabase JWT 인증 → profiles.id 추출

FastAPI Depends 로 사용:
    @app.post(...)
    async def endpoint(student_id: str = Depends(get_student_id)):
        ...
"""
import logging

from fastapi import Header, HTTPException
from supabase import Client, create_client

from .config import SUPABASE_ANON_KEY, SUPABASE_URL
from .storage.supabase_client import get_client as get_service_client

logger = logging.getLogger(__name__)

# JWT 검증용 anon 클라이언트 (service key 와 분리)
_anon_client: Client | None = None


def _get_anon_client() -> Client:
    global _anon_client
    if _anon_client is None:
        if not SUPABASE_ANON_KEY:
            raise ValueError("SUPABASE_ANON_KEY 가 설정되지 않음 — .env 확인")
        _anon_client = create_client(SUPABASE_URL, SUPABASE_ANON_KEY)
    return _anon_client


async def get_student_id(authorization: str = Header(...)) -> str:
    """Authorization: Bearer <JWT> → profiles.id 반환.

    student 역할이 아니면 403.
    """
    if not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Bearer 토큰이 필요합니다")

    token = authorization.split(" ", 1)[1].strip()

    try:
        user_resp = _get_anon_client().auth.get_user(token)
        auth_user_id = user_resp.user.id
    except Exception as exc:
        logger.warning(f"JWT 검증 실패: {exc}")
        raise HTTPException(status_code=401, detail="유효하지 않은 토큰")

    # profiles.id 조회 (service key 클라이언트로 — RLS 우회)
    service = get_service_client()
    result = (
        service.table("profiles")
        .select("id, role")
        .eq("user_id", auth_user_id)
        .single()
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="프로필 없음")

    if result.data.get("role") != "student":
        raise HTTPException(status_code=403, detail="학생만 접근 가능합니다")

    return result.data["id"]
