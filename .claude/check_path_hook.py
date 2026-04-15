"""Hook: math/ 프로젝트 외부 파일 수정/쓰기 차단"""
import os, sys, re

inp = os.environ.get("CLAUDE_TOOL_INPUT", "")
m = re.search(r'file_path["\s:]+([^"]+)', inp)
if not m:
    sys.exit(0)

p = m.group(1).replace("\\", "/").lower()
if p.startswith("c:/users/user/workspaces/math/") or p.startswith("c:/users/user/.claude/"):
    sys.exit(0)

action = sys.argv[1] if len(sys.argv) > 1 else "수정"
print(f"BLOCK: math/ 프로젝트 외부 파일 {action} 금지: {m.group(1)}")
sys.exit(2)
