"""Supabase service-role 클라이언트 싱글톤.

pdf_pipeline.storage.supabase_client 와 동일 패턴. 별도 파일로 두는 이유는
deeptutor 모듈이 pdf_pipeline 상대 import 를 피하기 위함.
"""
from supabase import Client, create_client

from ..config import SUPABASE_SERVICE_KEY, SUPABASE_URL

_client: Client | None = None


def get_client() -> Client:
    global _client
    if _client is None:
        if not SUPABASE_SERVICE_KEY:
            raise ValueError(
                "SUPABASE_SERVICE_KEY 가 설정되지 않음 — .env 확인"
            )
        _client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    return _client
