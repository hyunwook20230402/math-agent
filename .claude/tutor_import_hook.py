"""PostToolUse hook: 막힌 지점 도우미(튜터 RAG) 코드 변경 시 import 스모크.

Edit/Write 대상이 튜터 스택 파일일 때만 pdf_pipeline 의 튜터 import 그래프를
검증한다(그 외 파일은 즉시 통과). import 가 깨지면 exit 2 로 즉시 경고를 띄운다.

왜 필요한가: 튜터 코드는 pdf_pipeline 의 절대 import(config/storage/pipeline/...)에
의존한다. 경로 한 줄만 틀려도 uvicorn 기동 때까지 안 드러나는데, 그때는 이미
여러 변경이 쌓여 원인 추적이 어렵다. 변경 직후 import 만 빠르게 확인해 회귀를 조기 차단.

입력 방식(2026-06-25 실측 확정): hook 입력은 **stdin JSON**(CLAUDE_TOOL_INPUT 환경변수는 비어 있음 —
옛 환경변수 방식은 입력을 못 받아 이 스모크가 사실상 안 돌고 있었다). tool_input.file_path 로 대상 추출.
"""
import json
import os
import subprocess
import sys

# 이 파일들이 바뀌면 import 스모크 — 튜터 스택 + 그 직접 의존
_TUTOR_FILES = (
    "backend/pdf_pipeline/handlers/stuck_helper.py",
    "backend/pdf_pipeline/routers/tutor.py",
    "backend/pdf_pipeline/routers/nodes.py",
    "backend/pdf_pipeline/auth.py",
    "backend/pdf_pipeline/models.py",
    "backend/pdf_pipeline/pipeline/rag_node_extractor.py",
)

try:
    raw = sys.stdin.read()
    data = json.loads(raw) if raw else {}
except Exception:
    sys.exit(0)

path = (data.get("tool_input") or {}).get("file_path")
if not path:
    sys.exit(0)

path = str(path).replace("\\", "/")
if not any(path.endswith(f) for f in _TUTOR_FILES):
    sys.exit(0)  # 튜터 파일 아님 — 통과

PIPE = "C:/Users/fpsem/Desktop/math-agent-main/math-agent-main/backend/pdf_pipeline"
PY = f"{PIPE}/venv/Scripts/python.exe"
if not os.path.exists(PY):
    sys.exit(0)  # venv 없으면 검증 생략(차단하지 않음)

# 실제 호출 없이 import 그래프만 — 빠르고 부작용 없음
code = (
    "from routers.tutor import router; "
    "from routers.nodes import router as nodes_router; "
    "from handlers import stuck_helper; "
    "from auth import get_student_id, get_teacher_id; "
    "from models import HintRequest"
)
try:
    r = subprocess.run([PY, "-c", code], cwd=PIPE,
                       capture_output=True, text=True, timeout=60)
except Exception as exc:
    sys.stderr.write(f"WARN: 튜터 import 스모크 실행 실패(검증 생략): {exc}\n")
    sys.exit(0)

if r.returncode != 0:
    tail = (r.stderr or r.stdout or "").strip().splitlines()[-5:]
    sys.stderr.write("BLOCK: 튜터 import 가 깨졌습니다 — 방금 변경을 확인하세요:\n")
    sys.stderr.write("\n".join(tail) + "\n")
    sys.exit(2)

sys.exit(0)
