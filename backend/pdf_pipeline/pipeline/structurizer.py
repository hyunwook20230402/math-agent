"""크롭 이미지 구조화: Surya OCR + Ollama (기본 Gemma4 26B)"""
import json
import re
import tempfile

import httpx
from PIL import Image

from config import OLLAMA_BASE_URL, OLLAMA_MODEL

# 모델 (싱글턴, VRAM 관리)
_ocr_predictor = None
_texify_model = None
_texify_processor = None


def _get_ocr_predictor():
  global _ocr_predictor
  if _ocr_predictor is None:
    from surya.recognition import RecognitionPredictor
    _ocr_predictor = RecognitionPredictor()
  return _ocr_predictor


def _get_texify():
  global _texify_model, _texify_processor
  if _texify_model is None:
    from texify.model.model import load_model
    from texify.model.processor import load_processor
    _texify_model = load_model()
    _texify_processor = load_processor()
  return _texify_model, _texify_processor


def release_surya_models():
  """OCR/Texify 모델 VRAM 해제"""
  global _ocr_predictor, _texify_model, _texify_processor
  if _ocr_predictor is not None:
    del _ocr_predictor
    _ocr_predictor = None
  if _texify_model is not None:
    del _texify_model
    _texify_model = None
  if _texify_processor is not None:
    del _texify_processor
    _texify_processor = None
  try:
    import torch
    if torch.cuda.is_available():
      torch.cuda.empty_cache()
  except ImportError:
    pass


def ocr_image(image_path: str) -> str:
  """Surya OCR로 이미지에서 한국어+영어 텍스트 추출"""
  predictor = _get_ocr_predictor()
  img = Image.open(image_path).convert("RGB")
  predictions = predictor([img], languages=["ko", "en"])
  if predictions and len(predictions) > 0:
    lines = [line.text for line in predictions[0].text_lines]
    return "\n".join(lines)
  return ""


def texify_image(image_path: str) -> str:
  """Texify로 이미지에서 LaTeX 수식 추출"""
  from texify.inference import batch_inference
  model, processor = _get_texify()
  img = Image.open(image_path).convert("RGB")
  results = batch_inference([img], model, processor)
  if results and len(results) > 0:
    return results[0]
  return ""


def structurize_with_llm(ocr_text: str, latex_text: str) -> dict:
  """Ollama VL 모델로 OCR 결과를 구조화 JSON으로 변환"""
  prompt = f"""다음은 수학 문제의 OCR 결과입니다. JSON으로 정리하세요.

OCR 텍스트:
{ocr_text}

LaTeX 수식:
{latex_text}

다음 JSON 형식으로만 응답하세요 (다른 텍스트 없이):
{{
  "problem_text": "순수 텍스트 (수식은 자연어로 풀어서 작성)",
  "problem_latex": "전체 문제 텍스트 (수식은 $..$ LaTeX 표기 사용)",
  "topic_tags": ["과목", "대단원", "소주제"]
}}

규칙:
- 보기 번호(①②③④⑤)와 내용 포함
- 그래프/도형은 [그래프: y=f(x)] 형태로 기술
- topic_tags는 한국 수학 교육과정 기준 (공통수학1, 공통수학2, 미적분, 확률과통계, 기하)
- JSON만 출력하세요"""

  try:
    resp = httpx.post(
      f"{OLLAMA_BASE_URL}/api/generate",
      json={
        "model": OLLAMA_MODEL,
        "prompt": prompt,
        "stream": False,
        "options": {"temperature": 0.1, "num_predict": 1024},
      },
      timeout=120,
    )
    resp.raise_for_status()
    raw = resp.json().get("response", "")
    return _parse_json_response(raw)
  except Exception as e:
    return {
      "problem_text": ocr_text,
      "problem_latex": latex_text,
      "topic_tags": [],
      "error": str(e),
    }


def _parse_json_response(raw: str) -> dict:
  """LLM 응답에서 JSON 추출"""
  match = re.search(r'\{[\s\S]*\}', raw)
  if match:
    try:
      return json.loads(match.group())
    except json.JSONDecodeError:
      pass
  return {"problem_text": raw, "problem_latex": "", "topic_tags": []}


def structurize_problem(image_path: str) -> dict:
  """단일 문제 이미지 → 구조화 결과

  Args:
    image_path: 크롭된 문제 이미지 경로

  Returns:
    {"problem_text": str, "problem_latex": str, "topic_tags": list[str]}
  """
  ocr_text = ocr_image(image_path)
  latex_text = texify_image(image_path)
  result = structurize_with_llm(ocr_text, latex_text)
  return {
    "problem_text": result.get("problem_text", ocr_text),
    "problem_latex": result.get("problem_latex", latex_text),
    "topic_tags": result.get("topic_tags", []),
  }


def download_image(url: str) -> str:
  """Supabase Storage URL에서 이미지 다운로드 → 임시 파일 경로 반환"""
  resp = httpx.get(url, timeout=30)
  resp.raise_for_status()
  tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".png")
  tmp.write(resp.content)
  tmp.close()
  return tmp.name
