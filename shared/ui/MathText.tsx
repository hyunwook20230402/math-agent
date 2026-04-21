import katex from 'katex';
import 'katex/dist/katex.min.css';
import React from 'react';

function tryRenderKatex(expr: string, display = false): string | null {
  try {
    return katex.renderToString(expr, { displayMode: display, throwOnError: true });
  } catch {
    return null;
  }
}

export function MathText({ text, className }: { text: string; className?: string }) {
  const parts = text.split(/(\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]|\$\$[\s\S]*?\$\$|\$[^$\n]+?\$)/g);
  return (
    <span className={className}>
      {parts.map((part, i) => {
        const display = part.startsWith('\\[') || part.startsWith('$$');
        const inner = part.replace(/^\\\(|\\\)$|^\\\[|\\\]$|^\$\$|\$\$$|^\$|\$$/g, '');
        if ((part.startsWith('\\(') && part.endsWith('\\)')) ||
            (part.startsWith('\\[') && part.endsWith('\\]')) ||
            (part.startsWith('$$') && part.endsWith('$$')) ||
            (part.startsWith('$') && part.endsWith('$') && part.length > 2)) {
          const html = tryRenderKatex(inner, display);
          return html
            ? <span key={i} dangerouslySetInnerHTML={{ __html: html }} />
            : <span key={i}>{part}</span>;
        }
        const subParts: React.ReactNode[] = [];
        let last = 0;
        let m: RegExpExecArray | null;
        const re = /([a-zA-Z0-9α-ωΑ-Ω]+(?:[\^_]\{?[^}\s]+\}?)+|\\[a-zA-Z]+(?:\{[^}]*\})*)/g;
        while ((m = re.exec(part)) !== null) {
          if (m.index > last) subParts.push(<span key={`t${i}_${last}`}>{part.slice(last, m.index)}</span>);
          const html = tryRenderKatex(m[0]);
          subParts.push(html
            ? <span key={`m${i}_${m.index}`} dangerouslySetInnerHTML={{ __html: html }} />
            : <span key={`m${i}_${m.index}`}>{m[0]}</span>
          );
          last = m.index + m[0].length;
        }
        if (last < part.length) subParts.push(<span key={`t${i}_end`}>{part.slice(last)}</span>);
        return <span key={i}>{subParts}</span>;
      })}
    </span>
  );
}
