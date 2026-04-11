"""bge-m3 임베딩 생성 모듈 (sentence-transformers 사용)"""
from typing import List

_model = None


def _get_model():
  global _model
  if _model is None:
    from sentence_transformers import SentenceTransformer
    _model = SentenceTransformer("BAAI/bge-m3")
  return _model


def release_model():
  """모델 메모리 해제"""
  global _model
  if _model is not None:
    del _model
    _model = None
  try:
    import torch
    if torch.cuda.is_available():
      torch.cuda.empty_cache()
  except ImportError:
    pass


def generate_embedding(text: str) -> List[float]:
  """텍스트 → 1024차원 임베딩 벡터"""
  model = _get_model()
  embedding = model.encode(text)
  return embedding.tolist()


def generate_embeddings_batch(texts: List[str]) -> List[List[float]]:
  """여러 텍스트 → 임베딩 벡터 배치"""
  model = _get_model()
  embeddings = model.encode(texts)
  return [vec.tolist() for vec in embeddings]
