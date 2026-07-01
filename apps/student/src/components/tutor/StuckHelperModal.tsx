// @ts-nocheck
// 풀이 길잡이 모달 (내부명 stuck_helper) — 순수 HTML/CSS (Radix Portal 금지: dev-rules)
// RAG 백엔드(POST /api/tutor/hint)를 호출해 막힌 지점 다음 한 단계만 힌트로 안내.
// 화면 표시명은 "풀이 길잡이"(2026-07-01 확정), 코드 식별자·API 경로는 stuck_helper/tutor 유지.
import { useState, useEffect } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { X, Send, Loader2, Lightbulb, Trash2 } from 'lucide-react';
import { Button } from '@shared/ui/button';
import { ragHintApi } from '@shared/lib/api';

interface HintTurn {
  role: 'student' | 'tutor';
  text: string;
  concept?: string | null;
  figureUrls?: string[];
}

// 대화 영속화 — 문제별 localStorage 키. 7일 지난 대화는 로드 시 폐기.
const CHAT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// 캐시 스키마 버전. 옛 버전(제어문자 sanitize 전 저장분)은 로드 시 폐기(12차).
export const CHAT_CACHE_VERSION = 2;
const CHAT_KEY_PREFIX = 'tutor_chat_';
const chatKey = (problemId: string) => `${CHAT_KEY_PREFIX}${problemId}`;

// 앱 진입 시 1회 호출 — 옛 버전(또는 깨진) tutor_chat_* 캐시를 일괄 폐기(13차/F2).
// 12차의 키별 로드 시 폐기는 "그 문제를 다시 열 때"만 동작해, 안 연 문제의 옛 깨진 캐시가
// 남았다. 사용자가 문제를 일일이 안 열어도 앱만 새로 로드하면 모든 옛 캐시가 사라지게 한다.
export function purgeStaleTutorChatCache(): void {
  try {
    const keys = Object.keys(localStorage).filter((k) => k.startsWith(CHAT_KEY_PREFIX));
    let removed = 0;
    for (const k of keys) {
      try {
        const data = JSON.parse(localStorage.getItem(k) || 'null');
        const expired = data?.timestamp && Date.now() - data.timestamp >= CHAT_TTL_MS;
        if (!data || data.version !== CHAT_CACHE_VERSION || expired) {
          localStorage.removeItem(k);
          removed++;
        }
      } catch {
        localStorage.removeItem(k); // 파싱 불가(깨진 JSON) → 폐기
        removed++;
      }
    }
    if (removed > 0) console.info(`[tutor] 옛 대화 캐시 ${removed}개 정리`);
  } catch {
    /* localStorage 접근 불가 — 무시 */
  }
}

// 힌트 텍스트 sanitize — 제어문자·특수문자 제거. 백엔드가 이미 거르지만 localStorage 캐시된
// 옛 대화(sanitize 적용 전 백엔드가 생성한 제어문자 텍스트) 방어용 이중 안전(12차).
// 제어문자(U+0000-001F except \t\n\r, U+007F-009F)·NBSP·제로폭/방향·화살표 모두 제거.
function sanitizeHintText(text: string): string {
  if (!text) return '';
  return text
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '')  // 제어문자(C0+C1, \t\n\r 보존)
    .replace(/ /g, ' ')                                // NBSP → 일반 공백
    .replace(/[​-‏‪-‮⁠-⁤⁦-⁩﻿؜]/g, '')  // 제로폭/방향
    .replace(/[←↑→↓]/g, '');            // 화살표 ←↑→↓
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// LaTeX 같은 토큰: 백슬래시 명령(\times \frac \sqrt …, 그리고 \, \; \! \: 같은 비알파벳 공백명령)
// 또는 지수/첨자(a^2, x_{n+1}). 이게 들어있는 덩어리만 KaTeX 렌더를 시도할 후보로 본다(14차).
// 비알파벳 공백명령(`\,`=얇은공백 등)을 빠뜨리면 화면에 `₩,` 로 raw 노출되므로 포함(15차/버그A).
const LATEX_TOKEN = /\\(?:[a-zA-Z]+|[,;!:])|[A-Za-z0-9)}\]][\^_]/;

// 공백 없는 한 덩어리에서 "수식으로 볼 선행 부분"의 끝 인덱스를 찾는다(14차).
// 한국어는 수식 뒤에 조사가 공백 없이 붙는다(`3^{2/3}이다`, `\sqrt[3]{9}를`). 중괄호 밖에서 한글이
// 나오면 거기서 수식이 끝난 것 → 그 앞만 수식, 뒤 한글은 평문으로 분리. `\text{한글}` 안의 한글은
// 중괄호 깊이>0 라 보존(KaTeX 가 렌더).
function splitMathPrefix(chunk: string): number {
  let depth = 0;
  for (let i = 0; i < chunk.length; i++) {
    const c = chunk[i];
    if (c === '\\') { i++; continue; }                   // 이스케이프 명령 1글자 건너뜀
    if (c === '{') depth++;
    else if (c === '}') depth = Math.max(0, depth - 1);
    else if (depth === 0 && /[가-힣]/.test(c)) return i;  // 중괄호 밖 한글 → 수식 끝
  }
  return chunk.length;
}

// 구분자(\(...\)) 밖 텍스트 조각 처리 — gpt-5.2 가 구분자를 빠뜨린 평문 LaTeX(예: `a^m\times a^n`)도
// 화면에 raw 노출되지 않게 렌더 시도(14차, 렌더러 폴백). 안전장치: KaTeX `strict:true` —
// 한글 등 LaTeX 비호환 입력이 섞이면 KaTeX 가 거부(throw)하므로 평문(escapeHtml)으로 폴백(실측 확인).
// 수식 뒤 한글 조사는 splitMathPrefix 로 미리 떼어내 수식 부분만 렌더한다.
function renderBareSegment(seg: string): string {
  if (!seg) return '';
  return seg
    .split(/(\s+)/)
    .map((chunk) => {
      if (/^\s+$/.test(chunk) || !chunk) return chunk;       // 공백은 그대로
      if (!LATEX_TOKEN.test(chunk)) return escapeHtml(chunk); // LaTeX 토큰 없으면 평문(한글·일반어)
      const cut = splitMathPrefix(chunk);
      const mathPart = chunk.slice(0, cut);
      const rest = chunk.slice(cut);                          // 뒤에 붙은 한글 조사 등
      let head: string;
      if (mathPart && LATEX_TOKEN.test(mathPart)) {
        try {
          // strict:true → LaTeX 비호환이면 throw → catch 평문 폴백.
          head = katex.renderToString(mathPart, { throwOnError: true, strict: true });
        } catch {
          head = escapeHtml(mathPart);
        }
      } else {
        head = escapeHtml(mathPart);
      }
      return head + escapeHtml(rest);
    })
    .join('');
}

// \( ... \) / \[ ... \] 인라인·블록 수식을 KaTeX 로 렌더링한 HTML 반환.
function renderMath(rawText: string): string {
  if (!rawText) return '';
  // 1) 제어문자/특수문자 strip(캐시된 옛 대화 방어).
  let text = sanitizeHintText(rawText);
  // 2) 깨진 여는 구분자 방어 — OpenAI 가 `\(`/`\[` 를 `\w(`/`\w[` 또는 대문자 `\W(`/`\W[` 로
  //    깨뜨리는 경우(백엔드와 동일 방어, 9차에서 대문자까지 확대).
  //    구분자 바로 앞 `\w`/`\W` 만 좁게 치환해 정상 텍스트 오염 방지.
  text = text.replace(/\\[wW](?=[([])/g, '\\');
  // \[ ... \] (블록) → \( ... \) (인라인) 순으로 치환
  const pattern = /\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)/g;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    // 구분자 밖 텍스트도 평문 노출 대신 렌더 폴백(14차).
    out += renderBareSegment(text.slice(last, m.index));
    const isBlock = m[1] !== undefined;
    const expr = (m[1] ?? m[2] ?? '').trim();
    try {
      out += katex.renderToString(expr, { displayMode: isBlock, throwOnError: false });
    } catch {
      out += escapeHtml(expr);
    }
    last = pattern.lastIndex;
  }
  out += renderBareSegment(text.slice(last));
  return out;
}

interface Props {
  problemId: string;
  onClose?: () => void;
  mode?: 'modal' | 'panel';
}

export default function StuckHelperModal({ problemId, onClose, mode = 'modal' }: Props) {
  const [turns, setTurns] = useState<HintTurn[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 실패한 마지막 발화 — timeout/에러 시 "다시 시도" 버튼으로 한 번에 재요청(16차).
  const [lastFailedDesc, setLastFailedDesc] = useState<string | null>(null);
  // 멀티턴 — 직전 힌트까지 공개한 노드 index (첫 호출 -1)
  const [revealedIndex, setRevealedIndex] = useState<number>(-1);

  // 문제별 대화 복구 (problemId 바뀌면 그 문제 대화 로드)
  useEffect(() => {
    setInput('');
    setError(null);
    try {
      const saved = localStorage.getItem(chatKey(problemId));
      if (saved) {
        const data = JSON.parse(saved);
        // version 불일치(옛 제어문자 캐시) 또는 만료면 폐기. version 2 부터만 신뢰.
        if (
          data &&
          data.version === CHAT_CACHE_VERSION &&
          (!data.timestamp || Date.now() - data.timestamp < CHAT_TTL_MS)
        ) {
          setTurns(Array.isArray(data.turns) ? data.turns : []);
          setRevealedIndex(typeof data.revealedIndex === 'number' ? data.revealedIndex : -1);
          return;
        }
        localStorage.removeItem(chatKey(problemId)); // 만료·옛 버전 → 폐기
      }
    } catch (e) {
      console.warn('[tutor] 대화 복구 실패', e);
    }
    setTurns([]);
    setRevealedIndex(-1);
  }, [problemId]);

  // 대화 변경 시 저장 (최근 200턴까지만). 저장 직전 각 turn.text sanitize → 깨진 텍스트 캐시 차단(12차).
  useEffect(() => {
    try {
      const data = {
        version: CHAT_CACHE_VERSION,
        turns: turns.slice(-200).map((t) => ({ ...t, text: sanitizeHintText(t.text) })),
        revealedIndex,
        timestamp: Date.now(),
      };
      localStorage.setItem(chatKey(problemId), JSON.stringify(data));
    } catch (e) {
      console.warn('[tutor] 대화 저장 실패', e);
    }
  }, [turns, revealedIndex, problemId]);

  const requestHint = async (description: string) => {
    setLoading(true);
    setError(null);
    setLastFailedDesc(null);
    // 현재 발화를 추가하기 직전의 turns = 백엔드에 줄 "지금까지의 대화" 이력(최근 7턴, role+text 만).
    // setTurns 는 비동기라 이 시점 turns 가 곧 직전 이력이다(15차: LLM 이 맥락 이해하게).
    const history = turns.slice(-7).map((t) => ({ role: t.role, text: t.text }));
    setTurns((prev) => [...prev, { role: 'student', text: description }]);
    try {
      const res = await ragHintApi.getHint({
        problemId,
        blockedDescription: description,
        revealedNodeIndex: revealedIndex,
        conversationHistory: history,
      });
      setTurns((prev) => [
        ...prev,
        {
          role: 'tutor',
          text: res.hint_text,
          concept: res.next_step_concept,
          figureUrls: res.figure_urls || [],
        },
      ]);
      // 멀티턴 진행도 갱신 — 다음 힌트 요청에 그대로 전달
      if (typeof res.next_revealed_node_index === 'number') {
        setRevealedIndex(res.next_revealed_node_index);
      }
    } catch (e: any) {
      setError(e?.message || '힌트 생성에 실패했습니다');
      // 방금 학생 발화를 turns 에서 빼고(중복 방지) lastFailedDesc 로 보관 → "다시 시도" 버튼(16차).
      setTurns((prev) => prev.filter((t, i) => !(i === prev.length - 1 && t.role === 'student' && t.text === description)));
      setLastFailedDesc(description);
    } finally {
      setLoading(false);
    }
  };

  // timeout/에러 후 마지막 발화를 한 번에 재요청(16차).
  const retryLast = () => {
    if (loading || !lastFailedDesc) return;
    const desc = lastFailedDesc;
    setLastFailedDesc(null);
    requestHint(desc);
  };

  const handleSubmit = () => {
    const desc = input.trim();
    if (!desc || loading) return;
    setInput('');
    requestHint(desc);
  };

  // 이 문제의 대화 초기화 (state + localStorage). 저장 effect 가 빈 대화로 덮어씀.
  const clearChat = () => {
    if (loading) return;
    setTurns([]);
    setRevealedIndex(-1);
    setInput('');
    setError(null);
    try {
      localStorage.removeItem(chatKey(problemId));
    } catch { /* ignore */ }
  };

  // 헤더 + 대화 + 입력 — modal/panel 공유 본문
  const inner = (
    <>
      {/* 헤더 */}
      <div className="flex items-center justify-between border-b px-5 py-3">
        <div className="flex items-center gap-2">
          <Lightbulb className="h-5 w-5 text-amber-500" />
          <h2 className="font-semibold">풀이 길잡이</h2>
        </div>
        <div className="flex items-center gap-1">
          {turns.length > 0 && (
            <button
              onClick={clearChat}
              disabled={loading}
              title="대화 지우기"
              className="text-muted-foreground hover:text-foreground p-1 disabled:opacity-50"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
          {onClose && (
            <button onClick={onClose} className="text-muted-foreground hover:text-foreground p-1">
              <X className="h-5 w-5" />
            </button>
          )}
        </div>
      </div>

      {/* 대화 영역 */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
        {turns.length === 0 && !loading && (
          <div className="text-sm text-muted-foreground space-y-2 py-4 text-center">
            <p>어디까지 풀었고 어디서 막혔는지 적어주세요.</p>
            <p className="text-xs">
              예: "이차방정식까지 세웠는데 그 다음을 모르겠어요"
            </p>
          </div>
        )}

        {turns.map((t, i) =>
          t.role === 'student' ? (
            <div key={i} className="flex justify-end">
              <div className="bg-primary text-primary-foreground rounded-lg px-3 py-2 text-sm max-w-[80%]">
                {t.text}
              </div>
            </div>
          ) : (
            <div key={i} className="flex justify-start">
              <div className="bg-muted rounded-lg px-3 py-2 text-sm max-w-[85%] space-y-2">
                {t.concept && (
                  <div className="text-xs font-medium text-amber-600">💡 {t.concept}</div>
                )}
                <div
                  className="leading-relaxed"
                  dangerouslySetInnerHTML={{ __html: renderMath(t.text) }}
                />
                {t.figureUrls && t.figureUrls.length > 0 && (
                  <div className="space-y-1">
                    {t.figureUrls.map((url, j) => (
                      <img
                        key={j}
                        src={url}
                        alt="관련 도형"
                        className="max-w-full h-auto rounded border"
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          )
        )}

        {loading && (
          <div className="flex justify-start">
            <div className="bg-muted rounded-lg px-3 py-2 text-sm space-y-1">
              <div className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                힌트를 준비하고 있어요...
              </div>
              <div className="text-xs text-muted-foreground">보통 10초 안에 답해요</div>
            </div>
          </div>
        )}

        {error && (
          <div className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2 space-y-2">
            <div>{error}</div>
            {lastFailedDesc && !loading && (
              <Button variant="outline" size="sm" className="h-7" onClick={retryLast}>
                다시 시도
              </Button>
            )}
          </div>
        )}
      </div>

      {/* 입력 영역 */}
      <div className="border-t px-5 py-3 space-y-2">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
            placeholder="어디서 막혔는지 적어주세요"
            disabled={loading}
            className="flex-1 p-2 border rounded-md text-sm"
          />
          <Button onClick={handleSubmit} disabled={loading || !input.trim()} size="icon">
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </>
  );

  // 상시 노출 사이드 패널 모드 (문제 옆 채팅창)
  if (mode === 'panel') {
    return (
      <div className="h-full flex flex-col bg-background border rounded-lg overflow-hidden">
        {inner}
      </div>
    );
  }

  // 모달 모드 (기존)
  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center">
      <div className="fixed inset-0 bg-black/80" onClick={onClose} />
      <div className="relative z-[10000] bg-background border rounded-lg shadow-lg w-full max-w-lg mx-4 flex flex-col max-h-[85vh]">
        {inner}
      </div>
    </div>
  );
}
