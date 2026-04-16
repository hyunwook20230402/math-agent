"""임베딩 생성 모듈 — Ollama HTTP API 사용 (bge-m3)

sentence_transformers 의존성을 제거하고 Ollama 의 /api/embeddings 엔드포인트로 호출.
Qwen2.5-VL 호출과 동일한 Ollama 서버를 재사용하므로 Pillow/transformers dep 불필요.
"""
import os
from typing import List

import requests

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
EMBED_MODEL = os.environ.get("EMBED_MODEL", "bge-m3")


def generate_embedding(text: str) -> List[float]:
  """텍스트 → 임베딩 벡터 (bge-m3 는 1024차원)"""
  resp = requests.post(
    f"{OLLAMA_URL}/api/embeddings",
    json={"model": EMBED_MODEL, "prompt": text},
    timeout=60,
  )
  resp.raise_for_status()
  return resp.json()["embedding"]


def generate_embeddings_batch(texts: List[str]) -> List[List[float]]:
  """여러 텍스트 → 임베딩 벡터. Ollama embed 는 단일 호출만 지원 → 순차 처리."""
  return [generate_embedding(t) for t in texts]


def release_model():
  """Ollama 가 자체 모델 관리 → no-op"""
  pass
