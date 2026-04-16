"""DeepTutor 설정 — 환경변수 로드

.env 예시:
  SUPABASE_URL=https://grukqugorspbwsxqdhru.supabase.co
  SUPABASE_SERVICE_KEY=...
  GEMMA_OLLAMA_URL=http://100.95.34.69:11434
  GEMMA_MODEL=gemma4:26b
  EMBED_OLLAMA_URL=http://localhost:11434   # bge-m3 는 로컬 (8GB 로도 충분)
  EMBED_MODEL=bge-m3
"""
import logging
import os

from dotenv import load_dotenv

load_dotenv()

logger = logging.getLogger(__name__)

# Supabase
SUPABASE_URL = os.getenv("SUPABASE_URL", "https://grukqugorspbwsxqdhru.supabase.co")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")  # JWT 검증용

# Gemma 4 (외부 GPU 서버 via Tailscale)
GEMMA_OLLAMA_URL = os.getenv("GEMMA_OLLAMA_URL", "http://100.95.34.69:11434")
GEMMA_MODEL = os.getenv("GEMMA_MODEL", "gemma4:26b")
GEMMA_TIMEOUT = int(os.getenv("GEMMA_TIMEOUT", "60"))
GEMMA_TEMPERATURE = float(os.getenv("GEMMA_TEMPERATURE", "0.7"))
GEMMA_NUM_PREDICT = int(os.getenv("GEMMA_NUM_PREDICT", "512"))

# 임베딩 (유사 문제 검색용) — 로컬 bge-m3 재사용
EMBED_OLLAMA_URL = os.getenv("EMBED_OLLAMA_URL", "http://localhost:11434")
EMBED_MODEL = os.getenv("EMBED_MODEL", "bge-m3")

# LangGraph
HINT_LEVEL_MAX = 3  # 힌트 0~2 단계 (3이면 그 다음엔 explain 으로 넘어감)
HISTORY_TURNS_FOR_PROMPT = 6  # Gemma 에 넘길 최근 대화 턴 수
