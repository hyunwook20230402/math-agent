import logging
import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

logger = logging.getLogger(__name__)

SUPABASE_URL = os.getenv("SUPABASE_URL", "https://grukqugorspbwsxqdhru.supabase.co")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")  # service_role 키 필요
OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "gemma3:27b")
UPLOAD_DIR = os.getenv("UPLOAD_DIR", "/tmp/pdf_pipeline")

_UP = Path(UPLOAD_DIR)

# 문제 YOLO
PROBLEM_UPLOAD_DIR = _UP / "problems"
PROBLEM_DATASET_DIR = _UP / "problems" / "dataset"
PROBLEM_EXPORT_LOG = _UP / "problems" / "export_log.json"

# 해설 YOLO
SOLUTION_UPLOAD_DIR = _UP / "solutions"
SOLUTION_DATASET_DIR = _UP / "solutions" / "dataset"
SOLUTION_EXPORT_LOG = _UP / "solutions" / "export_log.json"

# 추론용 모델 (학습 후 자동 복사 대상)
MODELS_DIR = Path(__file__).parent / "yolo_training" / "models"
PROBLEM_MODEL_PATH = MODELS_DIR / "problem_detector.pt"
SOLUTION_MODEL_PATH = MODELS_DIR / "solution_detector.pt"


def to_upload_relative(path: str | Path) -> str:
    """절대 Path → UPLOAD_DIR 기준 POSIX 상대 문자열.

    UPLOAD_DIR 하위가 아니면 그대로 str 반환 (경고 없이 fallback — 외부 경로 저장은
    피해야 하지만 안전망).
    """
    p = Path(path).resolve()
    try:
        return p.relative_to(_UP.resolve()).as_posix()
    except ValueError:
        return str(p).replace("\\", "/")


def resolve_upload_path(path_str: str, pdf_path_hint: str | Path | None = None) -> Path:
    """DB 에 박힌 경로 문자열을 현 파일시스템 위치로 해석.

    케이스:
      1. 상대경로            → UPLOAD_DIR / path
      2. UPLOAD_DIR 하위 절대 → 그대로
      3. legacy 절대경로 (`..\\tmp\\pdf_pipeline\\solution_<id>\\solution_crops\\<file>`)
         → pdf_path_hint 가 주어지면 Path(pdf_path_hint).parent / <relative_after_solution_id>
    """
    s = (path_str or "").replace("\\", "/").lstrip("/")
    if not s:
        return _UP
    p = Path(s)

    # 1. 상대경로
    if not p.is_absolute() and ":" not in s[:3]:
        # legacy 'tmp/pdf_pipeline/solution_.../solution_crops/<file>' 도 여기로 들어옴
        parts = p.parts
        if len(parts) >= 3 and parts[0] == "tmp" and parts[1] == "pdf_pipeline" \
                and parts[2].startswith("solution_"):
            # legacy → pdf_path_hint 로 재매핑
            tail = Path(*parts[3:])  # solution_crops/<file>
            if pdf_path_hint:
                return Path(pdf_path_hint).parent / tail
            # hint 없으면 UPLOAD_DIR/solutions 아래 어디든 시도 — 호출측 책임
            logger.warning(
                f"resolve_upload_path: hint 없이 legacy 상대경로 fallback — {path_str!r}"
            )
            return _UP / tail
        return _UP / p

    # 2/3. 절대경로
    try:
        p.resolve().relative_to(_UP.resolve())
        return p
    except ValueError:
        # legacy 절대 (예: C:/tmp/pdf_pipeline/solution_<id>/solution_crops/<file>)
        parts = p.parts
        for i, part in enumerate(parts):
            if part.startswith("solution_") and i + 1 < len(parts):
                tail = Path(*parts[i + 1:])  # solution_crops/<file>
                if pdf_path_hint:
                    return Path(pdf_path_hint).parent / tail
                logger.warning(
                    f"resolve_upload_path: hint 없이 legacy 절대경로 fallback — {path_str!r}"
                )
                return _UP / tail
        return p
