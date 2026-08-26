// 짧은 수식 문자열(객관식 보기 등)을 HTML 로 렌더한다.
//
// 왜 KaTeX 인가:
//   CMS 는 MathJax(`MathText`), student 는 KaTeX 를 쓴다. 보기 내용은 **교사가 CMS 에서
//   미리보기로 확인한 그대로 학생에게 보여야** 하므로 두 앱이 같은 렌더러를 써야 한다.
//   두 앱 모두 katex 의존성을 이미 갖고 있어 KaTeX 로 통일했다.
//
// 왜 구분자를 안 쓰나:
//   보기 칸은 내용 전체가 수식인 경우가 대부분이다("x+2", "\frac{1}{2}").
//   교사에게 `\(...\)` 를 매번 치라고 하면 쓰기 번거롭다. 그래서 **한글이 없으면 통째로
//   수식으로 본다**. 한글이 섞이면("ㄱ만 옳다") 평문으로 둔다 — KaTeX 는 한글을
//   strict 모드에서 거부하고, 애초에 그런 보기는 수식이 아니다.

import katex from 'katex';

const HANGUL = /[가-힣ㄱ-ㅎㅏ-ㅣ]/;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 이 문자열을 수식으로 렌더할 것인가 (한글이 섞이면 평문). */
export function looksLikeMath(text: string): boolean {
  const t = text.trim();
  return !!t && !HANGUL.test(t);
}

/**
 * 보기 한 줄을 HTML 로. 수식이 깨지면 입력한 원문을 그대로 보여준다
 * (렌더 실패로 내용이 사라지는 것보다 낫다).
 */
export function renderShortMath(text: string | null | undefined): string {
  const t = (text ?? '').trim();
  if (!t) return '';
  if (!looksLikeMath(t)) return escapeHtml(t);
  try {
    return katex.renderToString(t, { throwOnError: true, strict: false });
  } catch {
    return escapeHtml(t);
  }
}
