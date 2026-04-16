"""Gemma 4 26B MoE — Ollama HTTP 호출 wrapper.

Tailscale 로 연결된 외부 GPU 서버(100.95.34.69) 의 Ollama 를 호출한다.
이미지 입력은 불필요 (해설은 이미 solution_summary 로 요약돼있음).

pdf_pipeline.pipeline.solution_tagger._call_qwen 패턴을 채팅형으로 변형.
"""
from __future__ import annotations

import json
import logging
from typing import Optional

import requests

from ..config import (
    GEMMA_MODEL,
    GEMMA_NUM_PREDICT,
    GEMMA_OLLAMA_URL,
    GEMMA_TEMPERATURE,
    GEMMA_TIMEOUT,
)

logger = logging.getLogger(__name__)


class GemmaError(RuntimeError):
    """Gemma 호출 실패 (타임아웃, 네트워크, HTTP 에러)"""


def chat(
    system_prompt: str,
    user_prompt: str,
    history: Optional[list[dict]] = None,
    *,
    temperature: Optional[float] = None,
    num_predict: Optional[int] = None,
    timeout: Optional[int] = None,
) -> str:
    """Gemma 4 채팅 API 호출.

    Args:
        system_prompt: 시스템 지시 (튜터 역할, 규칙)
        user_prompt: 이번 턴 사용자 입력
        history: 이전 대화 이력 [{"role": "user"|"assistant", "content": str}, ...]
                 — LangGraph state 의 messages 를 변환해서 넘김
        temperature/num_predict/timeout: 기본값 config 참조

    Returns:
        Gemma 응답 텍스트 (strip 된 상태)

    Raises:
        GemmaError: 호출 실패 시
    """
    messages: list[dict] = [{"role": "system", "content": system_prompt}]
    if history:
        messages.extend(history)
    messages.append({"role": "user", "content": user_prompt})

    payload = {
        "model": GEMMA_MODEL,
        "messages": messages,
        "stream": False,
        "options": {
            "temperature": temperature if temperature is not None else GEMMA_TEMPERATURE,
            "num_predict": num_predict if num_predict is not None else GEMMA_NUM_PREDICT,
        },
    }

    url = f"{GEMMA_OLLAMA_URL}/api/chat"
    try:
        resp = requests.post(
            url,
            json=payload,
            timeout=timeout if timeout is not None else GEMMA_TIMEOUT,
        )
        resp.raise_for_status()
    except requests.exceptions.Timeout as exc:
        logger.error(f"Gemma 타임아웃 ({timeout or GEMMA_TIMEOUT}s): {url}")
        raise GemmaError(f"Gemma 응답 시간 초과: {exc}") from exc
    except requests.exceptions.ConnectionError as exc:
        logger.error(f"Gemma 연결 실패: {url} — Tailscale/Ollama 서버 확인 필요")
        raise GemmaError(f"Gemma 서버에 연결할 수 없음: {exc}") from exc
    except requests.exceptions.HTTPError as exc:
        logger.error(f"Gemma HTTP 에러: {exc.response.status_code} {exc.response.text[:200]}")
        raise GemmaError(f"Gemma HTTP 에러: {exc}") from exc

    body = resp.json()
    message = body.get("message") or {}
    content = (message.get("content") or "").strip()
    if not content:
        logger.warning(f"Gemma 응답 비어있음: {body}")
        raise GemmaError("Gemma 응답이 비어있습니다")
    return content


def chat_json(
    system_prompt: str,
    user_prompt: str,
    history: Optional[list[dict]] = None,
    **kwargs,
) -> dict:
    """chat() 호출 후 응답에서 JSON 부분만 파싱.

    LangGraph 의 intent classifier 같이 JSON 출력이 필요한 노드용.
    solution_tagger._parse_json_response 패턴과 동일.
    """
    raw = chat(system_prompt, user_prompt, history, **kwargs)
    raw = raw.strip()

    # ``` 코드블록 제거
    if raw.startswith("```"):
        lines = raw.split("\n")
        lines = [l for l in lines if not l.startswith("```")]
        raw = "\n".join(lines).strip()

    # { ... } 블록만 추출
    start = raw.find("{")
    end = raw.rfind("}") + 1
    if start != -1 and end > start:
        raw = raw[start:end]

    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        logger.error(f"Gemma JSON 파싱 실패: {exc}\n원본: {raw[:300]}")
        raise GemmaError(f"Gemma 응답 JSON 파싱 실패: {exc}") from exc


def ping() -> bool:
    """Gemma 서버 연결 확인 — /api/tags 에 GEMMA_MODEL 이 있는지.

    API 기동 시 또는 /health/gemma 엔드포인트에서 호출.
    """
    try:
        resp = requests.get(f"{GEMMA_OLLAMA_URL}/api/tags", timeout=5)
        resp.raise_for_status()
        models = [m.get("name", "") for m in resp.json().get("models", [])]
        return any(name.startswith(GEMMA_MODEL.split(":")[0]) for name in models)
    except Exception as exc:
        logger.warning(f"Gemma ping 실패: {exc}")
        return False
