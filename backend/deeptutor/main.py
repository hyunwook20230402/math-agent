"""DeepTutor FastAPI 앱 (포트 8001)

대화형 수학 튜터 백엔드. 학생이 문제를 틀렸을 때 Gemma 4 와 LangGraph 로
다중 턴 대화를 나눌 수 있게 해준다.

실행:
    cd backend/deeptutor
    uvicorn main:app --reload --port 8001
"""
import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import GEMMA_MODEL, GEMMA_OLLAMA_URL
from .llm import gemma_client
from .routers import tutor

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="DeepTutor API",
    description="수학 대화형 튜터 — Gemma 4 + LangGraph",
    version="0.1.0",
)

# 학생 앱(8083), CMS(8081), teacher(8082) 전부 허용
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:8081",
        "http://localhost:8082",
        "http://localhost:8083",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
async def root():
    return {"service": "deeptutor", "status": "ok"}


@app.get("/health")
async def health():
    """간단 health check — Gemma 서버 연결 확인은 /health/gemma 로 분리"""
    return {"status": "ok"}


@app.get("/health/gemma")
async def health_gemma():
    """Gemma 서버(Tailscale) 연결 + 모델 확인."""
    ok = gemma_client.ping()
    return {
        "ok": ok,
        "url": GEMMA_OLLAMA_URL,
        "model": GEMMA_MODEL,
    }


app.include_router(tutor.router, prefix="/api/tutor", tags=["tutor"])
