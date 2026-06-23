import React from 'react';
import { MathJax } from 'better-react-mathjax';

// MathJax 는 \( \) / \[ \] 구분자를 기본 처리. 본문 + 수식 혼재 문자열을 그대로 넘겨도
// MathJax 가 스스로 분해해 렌더한다 (KaTeX 보다 관대 — \text{} 안 \sum 도 시도).
//
// 입력 텍스트가 바뀔 때마다 MathJax 가 재처리되게 dynamic prop 사용.
// inline=true(기본): 인라인 수식(\( \))만. inline=false: 인라인 + 블록(\[ \]) 모두 처리.
//   기존 사용처(EditableMath)는 인자 안 줘서 기존대로, 막힌 지점 도우미 힌트는 inline={false}(11차).
export function MathText({
  text,
  className,
  inline = true,
}: { text: string; className?: string; inline?: boolean }) {
  return (
    <span className={className}>
      <MathJax dynamic inline={inline} hideUntilTypeset="first">
        {text}
      </MathJax>
    </span>
  );
}
