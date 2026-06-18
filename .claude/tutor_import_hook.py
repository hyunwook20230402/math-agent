"""PostToolUse hook: 막힌 지점 도우미(튜터 RAG) 코드 변경 시 import 스모크.

Edit/Write 대상이 튜터 스택 파일일 때만 pdf_pipeline 의 튜터 import 그래프를
검증한다(그 외 파일은 즉시 통과). import 가 깨지면 exit 2 로 즉시 경고를 띄운다.

왜 필요한가: 튜터 코드는 pdf_pipeline 의 절대 import(config/storage/pipeline/...)에
의존한다. 경로 한 줄만 틀려도 uvicorn 기동 때까지 안 드러나는데, 그때는 이미
여러 변경이 쌓여 원인 추적이 어렵다. 변경 직후 import 만 빠르게 확인해 회귀를 조기 차단.
"""
import os
import re
import subprocess
import sys

# 이 파일들이 바뀌면 import 스모크 — 튜터 스택 + 그 직접 의존
_TUTOR_FILES = (
    "backend/pdf_pipeline/handlers/stuck_helper.py",
    "backend/pdf_pipeline/routers/tutor.py",
    "backend/pdf_pipeline/auth.py",
    "backend/pdf_pipeline/models.py",
    "backend/pdf_pipeline/pipeline/rag_node_extractor.py",
)

inp = os.environ.get("CLAUDE_TOOL_INPUT", "")
m = re.search(r'file_path["\s:]+([^"]+)', inp)
if not m:
    sys.exit(0)

path = m.group(1).replace("\\", "/")
if not any(path.endswith(f) for f in _TUTOR_FILES):
    sys.exit(0)  # 튜터 파일 아님 — 통과

PIPE = "C:/Users/user/workspaces/math/backend/pdf_pipeline"
PY = f"{PIPE}/venv/Scripts/python.exe"
if not os.path.exists(PY):
    sys.exit(0)  # venv 없으면 검증 생략(차단하지 않음)

# 실제 호출 없이 import 그래프만 — 빠르고 부작용 없음
code = (
    "from routers.tutor import router; "
    "from handlers import stuck_helper; "
    "from auth import get_student_id; "
    "from models import HintRequest"
)
try:
    r = subprocess.run([PY, "-c", code], cwd=PIPE,
                       capture_output=True, text=True, timeout=60)
except Exception as exc:
    print(f"WARN: 튜터 import 스모크 실행 실패(검증 생략): {exc}")
    sys.exit(0)

if r.returncode != 0:
    tail = (r.stderr or r.stdout or "").strip().splitlines()[-5:]
    print("BLOCK: 튜터 import 가 깨졌습니다 — 방금 변경을 확인하세요:")
    print("\n".join(tail))
    sys.exit(2)

sys.exit(0)
