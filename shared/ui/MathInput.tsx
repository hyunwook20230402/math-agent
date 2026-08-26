// 한 줄짜리 수식 입력칸 + 즉시 미리보기.
//
// 객관식 보기처럼 "내용이 곧 수식" 인 짧은 칸에 쓴다. 평범한 <input> 만 두면 교사가
// `\frac{1}{2}` 같은 걸 치고도 맞게 썼는지 알 수 없어 쓰기가 한정적이다.
// 그래서 오른쪽에 학생 화면과 **같은 렌더러**로 결과를 바로 보여준다.
//
// 포커스가 오면 자주 쓰는 LaTeX 를 넣어주는 버튼 줄이 뜬다 — 커서 위치에 끼워 넣고
// 중괄호 안으로 커서를 옮겨 주므로 이어서 바로 타이핑할 수 있다.
import { useLayoutEffect, useRef, useState } from 'react';
import { renderShortMath } from '../lib/mathRender';

/** 삽입 문자열에서 커서를 놓을 자리 표시. `|` 는 절댓값(`\left|`)과 겹쳐 못 쓴다. */
const CARET = '‸';

interface Snippet {
  label: string;
  /** 커서 위치에 끼워 넣을 문자열. CARET 자리에 커서가 놓인다. */
  insert: string;
  title: string;
}

// 자주 쓰는 것만 늘 보이고, 나머지는 '더보기' 로 접어 둔다 —
// 보기 칸 5개마다 스무 개 버튼이 깔리면 화면을 못 쓴다.
const COMMON: Snippet[] = [
  { label: 'a/b', insert: `\\frac{${CARET}}{}`, title: '분수' },
  { label: 'x²', insert: `^{${CARET}}`, title: '거듭제곱' },
  { label: 'x₁', insert: `_{${CARET}}`, title: '아래첨자' },
  { label: '√', insert: `\\sqrt{${CARET}}`, title: '근호' },
  { label: '≤', insert: '\\leq ', title: '작거나 같다' },
  { label: '≥', insert: '\\geq ', title: '크거나 같다' },
  { label: '≠', insert: '\\neq ', title: '같지 않다' },
  { label: '×', insert: '\\times ', title: '곱셈' },
  { label: '÷', insert: '\\div ', title: '나눗셈' },
  { label: '±', insert: '\\pm ', title: '플러스마이너스' },
];

const MORE: Snippet[] = [
  { label: '∫', insert: `\\int ${CARET}`, title: '부정적분' },
  { label: '∫ᵇₐ', insert: `\\int_{${CARET}}^{} `, title: '정적분' },
  { label: '∑', insert: `\\sum_{k=1}^{${CARET}} `, title: '시그마' },
  { label: 'lim', insert: `\\lim_{x \\to ${CARET}} `, title: '극한' },
  { label: 'dy/dx', insert: `\\frac{d${CARET}}{dx}`, title: '미분' },
  { label: 'log', insert: `\\log_{${CARET}} `, title: '로그(밑)' },
  { label: 'ln', insert: `\\ln ${CARET}`, title: '자연로그' },
  { label: 'sin', insert: `\\sin ${CARET}`, title: '사인' },
  { label: 'cos', insert: `\\cos ${CARET}`, title: '코사인' },
  { label: 'tan', insert: `\\tan ${CARET}`, title: '탄젠트' },
  { label: '|x|', insert: `\\left|${CARET}\\right|`, title: '절댓값' },
  { label: 'ₙCᵣ', insert: `{}_{n}C_{${CARET}}`, title: '조합' },
  { label: 'ₙPᵣ', insert: `{}_{n}P_{${CARET}}`, title: '순열' },
  { label: '√ⁿ', insert: `\\sqrt[${CARET}]{}`, title: 'n제곱근' },
  { label: '( )', insert: `\\left(${CARET}\\right)`, title: '큰 괄호' },
  { label: 'π', insert: '\\pi ', title: '파이' },
  { label: '∞', insert: '\\infty ', title: '무한대' },
  { label: '→', insert: '\\to ', title: '화살표' },
];

interface Props {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  className?: string;
}

export function MathInput({ value, onChange, placeholder, onKeyDown, className }: Props) {
  const ref = useRef<HTMLInputElement | null>(null);
  const [focused, setFocused] = useState(false);
  const [showMore, setShowMore] = useState(false);
  // 스니펫을 넣은 뒤 커서를 놓을 자리. value 가 부모에서 내려와 다시 그려진 **뒤에**
  // 적용해야 한다 — 그 전에 옮기면 리렌더가 커서를 문자열 끝으로 되돌린다.
  const [pendingCaret, setPendingCaret] = useState<number | null>(null);

  useLayoutEffect(() => {
    if (pendingCaret == null || !ref.current) return;
    ref.current.focus();
    ref.current.setSelectionRange(pendingCaret, pendingCaret);
    setPendingCaret(null);
  }, [value, pendingCaret]);

  const insert = (snippet: string) => {
    const caretHint = snippet.indexOf(CARET);
    const body = snippet.replace(CARET, '');
    const el = ref.current;
    if (!el) {
      onChange(value + body);
      return;
    }
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? start;
    onChange(value.slice(0, start) + body + value.slice(end));
    setPendingCaret(start + (caretHint >= 0 ? caretHint : body.length));
  };

  const html = renderShortMath(value);

  return (
    <div className={`flex-1 min-w-0 ${className || ''}`}>
      <div className="flex items-center gap-2 min-w-0">
        <input
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          // 스니펫 버튼을 누르는 순간에도 blur 가 나므로 조금 늦춰 닫는다.
          onBlur={() => window.setTimeout(() => setFocused(false), 150)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          className="flex h-8 flex-1 min-w-0 rounded-md border border-input bg-background px-3 py-1 text-sm font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <div
          className="h-8 w-40 shrink-0 overflow-x-auto whitespace-nowrap rounded-md border border-dashed bg-muted/30 px-2 flex items-center text-sm"
          title="학생 화면에 보이는 모습"
        >
          {html
            ? <span dangerouslySetInnerHTML={{ __html: html }} />
            : <span className="text-xs text-muted-foreground">미리보기</span>}
        </div>
      </div>
      {focused && (
        <div className="flex flex-wrap gap-1 mt-1">
          {(showMore ? [...COMMON, ...MORE] : COMMON).map(s => (
            <button
              key={s.label}
              type="button"
              title={s.title}
              onMouseDown={(e) => e.preventDefault()}   // blur 방지 — 커서 위치를 지킨다
              onClick={() => insert(s.insert)}
              className="h-6 rounded border bg-background px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              {s.label}
            </button>
          ))}
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setShowMore(v => !v)}
            className="h-6 rounded border border-dashed bg-background px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {showMore ? '접기' : '적분·극한·로그…'}
          </button>
          <span className="text-xs text-muted-foreground self-center ml-1">
            LaTeX 로 씁니다. 한글이 섞이면 그대로 글자로 보입니다.
          </span>
        </div>
      )}
    </div>
  );
}
