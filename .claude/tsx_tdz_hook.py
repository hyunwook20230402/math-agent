"""PostToolUse hook: React 컴포넌트의 '선언 전 참조'(TDZ) 스캔.

왜 필요한가 (2026-08-27 실제 사고):
  `TextbookManagementNew.tsx` 246줄에 넣은 파생 상수가 539줄의 `useState` 를 참조해
  렌더마다 `ReferenceError: Cannot access 'draggingFolderId' before initialization` 이 났고,
  **그 라우트가 통째로 백지**가 됐다. 그런데 `tsc --noEmit` 도 `npm run build` 도 통과했다 —
  TDZ 는 실행시 오류라 타입 검사가 못 잡는다. 사용자가 빈 화면을 보고 나서야 알았다.

  dev-rules 의 결론이 "산문 규칙은 11번 안 지켜졌다(증명됨)" 이므로 문서만으로는 부족하다.
  이 훅이 `.tsx` 를 고칠 때마다 자동으로 훑는다.

무엇을 잡나:
  컴포넌트 본문(들여쓰기 정확히 2칸)의 **렌더 때 바로 계산되는 파생 `const`** 가,
  자기보다 **아래에서** 선언된 `useState`/`useRef`/`useMemo`/`useCallback` 이름을 참조하는 경우.

무엇을 일부러 안 잡나 (오탐 방지):
  - **그 상수 자체가 함수인 것**(`const f = () => …`, `function`) — 나중에 실행된다.
    ⚠️ "`=>` 가 어딘가 있으면 넘어간다" 로 하면 **안 된다**. 실제 사고 코드가
    `cond ? list.find(f => …) : null` 이라 그 규칙으로는 **사고 자신을 못 잡았다**(실측).
    `.filter(x => …)` 처럼 지금 바로 실행되는 화살표는 위험한 게 맞다.
  - **`=` 왼쪽(구조분해 패턴)** — `const { a: b } = useCtx()` 의 `a` 는 속성 이름이지 참조가
    아니다. 오른쪽만 본다(이걸 안 하면 실제 파일에서 오탐 2건이 났다).
  - `obj.prop` 의 `prop`, 객체 리터럴의 키(`{ foo: … }`).
  - **문자열·주석 안의 글자** — `searchParams.get('problems')` 의 `'problems'` 를 상태
    `problems` 참조로 오해했다(실측 오탐).
  - **다른 최상위 블록의 같은 이름** — 모듈 레벨 함수의 매개변수 `problems` 가 컴포넌트의
    `useState problems` 와 이름만 같았다(실측 오탐). 열 0 의 `}` 로 블록을 가른다.
  - 들여쓰기 2칸이 아닌 것 — 콜백/중첩 함수 안이라 역시 나중에 실행된다.

쓰는 법:
  훅(자동)  : `.claude/settings.json` 의 PostToolUse[Edit|Write] 에 등록. 걸리면 exit 2.
  전체 훑기 : python .claude/tsx_tdz_hook.py --scan apps/cms/src   (`/cms-dev-check` 5단계)

⚠️ 훅 입력은 **stdin JSON** 이다. `CLAUDE_TOOL_INPUT` 환경변수는 비어 있다 —
   tutor_import_hook 이 그 함정으로 한동안 안 돌았다(2026-06-25 실측).
"""
import json
import os
import re
import sys

# 한글 메시지가 콘솔 코드페이지(cp949)에서 깨지지 않게. 실패해도 무시.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# 컴포넌트 본문 = 들여쓰기 정확히 2칸(code-style.md: 스페이스 2칸)
_DECL = re.compile(
    r"^  const (?:\[\s*(?P<arr>[A-Za-z_$][\w$]*)\s*,[^\]]*\]|(?P<one>[A-Za-z_$][\w$]*))"
    r"\s*=\s*(?P<hook>useState|useRef|useMemo|useCallback|useReducer|useContext)\b"
)
_DERIVED = re.compile(r"^  const (?:(?P<name>[A-Za-z_$][\w$]*)|[\{\[])")
_IDENT = re.compile(r"[A-Za-z_$][\w$]*")
# 이 상수 자체가 '나중에 실행될 함수' 인가 (오른쪽이 화살표/함수로 시작)
_IS_FUNCTION = re.compile(
    r"^(?:async\s+)?(?:function\b|(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>)"
)
# 문자열·템플릿·주석 (그 안의 글자는 변수가 아니다)
_LITERAL = re.compile(
    r"'(?:[^'\\\n]|\\.)*'|\"(?:[^\"\\\n]|\\.)*\"|`(?:[^`\\]|\\.)*`|//[^\n]*|/\*.*?\*/",
    re.DOTALL,
)
_SKIP_DIRS = {"node_modules", "dist", "build", ".git", "venv", "__pycache__"}


def _statement(lines, start):
    """`  const ...` 로 시작하는 한 문장을 끝까지 모은다(여러 줄 가능)."""
    depth = 0
    out = []
    for i in range(start, min(start + 40, len(lines))):
        line = lines[i]
        out.append(line)
        depth += line.count("(") + line.count("[") + line.count("{")
        depth -= line.count(")") + line.count("]") + line.count("}")
        if depth <= 0 and line.rstrip().endswith(";"):
            break
    return "\n".join(out)


def _rhs(stmt):
    """`const 패턴 = 오른쪽` 에서 오른쪽만. 최상위 `=` 하나로 가른다."""
    depth = 0
    for i, ch in enumerate(stmt):
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
        elif ch == "=" and depth == 0:
            nxt, prv = stmt[i + 1:i + 2], stmt[i - 1:i]
            if nxt not in ("=", ">") and prv not in ("=", "!", "<", ">"):
                return stmt[i + 1:]
    return ""


def _strip_literals(s):
    """문자열·템플릿·주석을 공백으로. 그 안의 글자를 변수로 오해하지 않게."""
    return _LITERAL.sub(lambda m: " " * len(m.group()), s)


def _referenced(rhs):
    """오른쪽에서 '진짜 참조' 인 식별자만. 멤버 접근·객체 키·문자열은 뺀다."""
    rhs = _strip_literals(rhs)
    out = set()
    for m in _IDENT.finditer(rhs):
        before = rhs[:m.start()].rstrip()
        if before.endswith("."):
            continue                                   # obj.prop 의 prop
        after = rhs[m.end():].lstrip()
        if after.startswith(":") and (not before or before[-1] in "{,"):
            continue                                   # { key: ... } 의 key
        out.add(m.group())
    return out


def scan_text(text):
    """[(줄번호, 파생상수, 참조한이름, 그이름의선언줄)] — 없으면 빈 목록."""
    lines = text.split("\n")
    # 최상위 블록 번호 — 열 0 의 `}` 를 만날 때마다 하나 올린다. 모듈 레벨 함수의
    # 매개변수와 컴포넌트의 상태가 이름만 같은 경우를 갈라내는 데 쓴다.
    block_of, blk = [], 0
    for line in lines:
        if line.startswith("}"):
            blk += 1
        block_of.append(blk)

    decls = {}
    for i, line in enumerate(lines):
        m = _DECL.match(line)
        if m:
            decls.setdefault(m.group("arr") or m.group("one"), i)
    if not decls:
        return []

    hits = []
    for i, line in enumerate(lines):
        m = _DERIVED.match(line)
        if not m or _DECL.match(line):
            continue
        rhs = _rhs(_statement(lines, i)).strip()
        if not rhs or _IS_FUNCTION.match(rhs):
            continue  # 이 상수 자체가 함수 — 나중에 실행되므로 안전
        own = m.group("name")
        for ident in _referenced(rhs):
            if ident == own:
                continue
            at = decls.get(ident)
            if at is not None and at > i and block_of[at] == block_of[i]:
                hits.append((i + 1, own or "{...}", ident, at + 1))
    return hits


def scan_file(path):
    try:
        with open(path, encoding="utf-8") as fp:
            return scan_text(fp.read())
    except (OSError, UnicodeDecodeError):
        return []


def _report(path, hits):
    for line, own, ident, at in hits:
        sys.stderr.write(
            "  %s:%d  `%s` 가 `%s`(선언 %d줄) 를 **선언 전에** 참조합니다\n"
            % (path, line, own, ident, at)
        )


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--scan":
        roots = sys.argv[2:] or ["apps", "shared"]
        total = files = 0
        for root in roots:
            for dirpath, dirnames, filenames in os.walk(root):
                dirnames[:] = [d for d in dirnames if d not in _SKIP_DIRS]
                for name in filenames:
                    if not name.endswith((".tsx", ".ts")):
                        continue
                    files += 1
                    path = os.path.join(dirpath, name).replace("\\", "/")
                    hits = scan_file(path)
                    if hits:
                        total += len(hits)
                        _report(path, hits)
        print("[TDZ] %s (%d files, %d hits)"
              % ("OK" if total == 0 else "FAIL", files, total))
        return 1 if total else 0

    try:
        raw = sys.stdin.read()
        data = json.loads(raw) if raw else {}
    except Exception:
        return 0

    path = (data.get("tool_input") or {}).get("file_path")
    if not path:
        return 0
    path = str(path).replace("\\", "/")
    if not path.endswith((".tsx", ".ts")):
        return 0            # React 파일 아님 — 통과
    if not os.path.exists(path):
        return 0

    hits = scan_file(path)
    if not hits:
        return 0
    sys.stderr.write(
        "BLOCK: 선언 전 참조(TDZ) — 이대로면 렌더 때 ReferenceError 로 "
        "**화면이 통째로 백지**가 됩니다. tsc/빌드는 이걸 못 잡습니다:\n"
    )
    _report(path, hits)
    sys.stderr.write("  → 파생 const 를 그 값이 쓰는 useState/useRef 선언 **아래**로 옮기세요.\n")
    return 2


if __name__ == "__main__":
    sys.exit(main())
