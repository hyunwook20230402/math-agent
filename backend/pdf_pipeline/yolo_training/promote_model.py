"""학습 결과 가중치를 추론용 models/ 로 복사.

train_finetune.py / train_solution_finetune.py 마지막에 호출되어
runs/<name>/weights/best.pt → yolo_training/models/<target>.pt 로 복사한다.
추론 경로(config.PROBLEM_MODEL_PATH, SOLUTION_MODEL_PATH)가 즉시 최신 모델을 본다.
"""
import shutil
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PIPELINE_DIR = SCRIPT_DIR.parent
sys.path.insert(0, str(PIPELINE_DIR))

from config import PROBLEM_MODEL_PATH, SOLUTION_MODEL_PATH


def promote(run_dir: Path, kind: str) -> Path:
    """best.pt 를 추론용 위치로 복사.

    Args:
        run_dir: ultralytics train 의 save_dir (예: runs/exam_finetune_v3)
        kind: "problem" 또는 "solution"
    Returns:
        복사된 대상 경로
    """
    src = Path(run_dir) / "weights" / "best.pt"
    if not src.exists():
        raise FileNotFoundError(f"best.pt 없음: {src}")
    if kind == "problem":
        dst = PROBLEM_MODEL_PATH
    elif kind == "solution":
        dst = SOLUTION_MODEL_PATH
    else:
        raise ValueError(f"kind must be 'problem' or 'solution', got: {kind!r}")
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)
    print(f"[promote_model] {src} → {dst}")
    return dst
