"""PreToolUse hook: math/ 프로젝트 외부 파일 수정/쓰기 차단.

입력 방식(2026-06-25 실측 확정): 이 Claude Code 는 hook 입력을 **stdin JSON** 으로 준다
(CLAUDE_TOOL_INPUT 환경변수는 비어 있음 — 옛 환경변수 방식은 입력을 못 받아 항상 통과했었다).
tool_input.file_path 가 math/ 또는 ~/.claude/ 밖이면 exit 2 로 차단.
graceful: 파싱 불가·예외·file_path 없음이면 통과(정상 작업 방해 방지).
"""
import json
import sys


def main() -> None:
    action = sys.argv[1] if len(sys.argv) > 1 else "수정"
    try:
        raw = sys.stdin.read()
        data = json.loads(raw) if raw else {}
    except Exception:
        sys.exit(0)  # 입력 이상 → 통과

    path = (data.get("tool_input") or {}).get("file_path")
    if not path:
        sys.exit(0)  # file_path 없는 도구 → 통과

    p = str(path).replace("\\", "/").lower()
    if p.startswith("c:/users/fpsem/desktop/math-agent-main/math-agent-main/") or p.startswith("c:/users/fpsem/.claude/"):
        sys.exit(0)  # 허용 경로

    sys.stderr.write(f"BLOCK: math/ 프로젝트 외부 파일 {action} 금지: {path}\n")
    sys.exit(2)


if __name__ == "__main__":
    main()
