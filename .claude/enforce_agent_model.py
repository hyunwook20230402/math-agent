"""PreToolUse hook: 서브에이전트(Agent) 호출 시 model 이 'opus' 가 아니면 차단.

왜 필요한가: 이 프로젝트 규칙은 "모든 서브에이전트는 Opus 4.8"(전역 CLAUDE.md +
feedback_agents_use_opus). Agent 호출 시 `model: "opus"` 를 깜빡 누락하면 에이전트 정의의
기본 모델(Haiku)로 떨어진다. 산문 규칙만으론 안 지켜져(실제로 누락 발생) hook 으로 자동 차단.

입력 방식(2026-06-25 실측 확정): 이 Claude Code 는 hook 입력을 **stdin JSON** 으로 준다
(CLAUDE_TOOL_INPUT 환경변수는 비어 있음). tool_input.model 필드가 누락이면 차단 대상.
  - model 명시: {"tool_input":{...,"model":"opus"}}  → model 필드 존재
  - model 누락: {"tool_input":{"prompt":...,"subagent_type":...}}  → model 필드 없음

차단: exit 2 + stderr 메시지(기존 hook 패턴). graceful: 파싱 불가·예외면 통과(작업 안 막음).
"""
import json
import sys


def _fail_open(reason: str = "") -> None:
    # 입력 이상·예외 시 차단하지 않고 통과(정상 작업 방해 방지 — 기존 hook 철학).
    sys.exit(0)


def main() -> None:
    try:
        raw = sys.stdin.read()
    except Exception:
        _fail_open()
        return
    if not raw:
        _fail_open()
        return
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        _fail_open()
        return

    # Agent(서브에이전트) 호출만 검사. 그 외 도구는 통과.
    if data.get("tool_name") not in ("Agent", "Task"):
        sys.exit(0)

    tool_input = data.get("tool_input") or {}
    model = (tool_input.get("model") or "").strip().lower()

    # 규칙: model 은 반드시 opus 계열. 누락(빈 문자열)·비-opus 면 차단.
    if "opus" in model:
        sys.exit(0)

    shown = model or "(누락 → 기본 Haiku)"
    sys.stderr.write(
        f"BLOCK: 서브에이전트는 model:'opus' 필수입니다 (현재: {shown}).\n"
        "규칙=모든 서브에이전트 Opus 4.8(전역 CLAUDE.md + feedback_agents_use_opus). "
        "Agent 호출에 model: \"opus\" 를 명시하고 다시 시도하세요.\n"
    )
    sys.exit(2)


if __name__ == "__main__":
    main()
