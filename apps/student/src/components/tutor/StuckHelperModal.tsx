// @ts-nocheck
// 막힌 지점 도우미 모달 — 순수 HTML/CSS (Radix Portal 금지: dev-rules)
// RAG 백엔드(POST /api/tutor/hint)를 호출해 막힌 지점 다음 한 단계만 힌트로 안내.
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
const CHAT_CACHE_VERSION = 2;
const chatKey = (problemId: string) => `tutor_chat_${problemId}`;

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

// \( ... \) / \[ ... \] 인라인·블록 수식을 KaTeX 로 렌더링한 HTML 반환.
function renderMath(rawText: string): string {
  if (!rawText) return '';
  // 1) 제어문자/특수문자 strip(캐시된 옛 대화 방어).
  let text = sanitizeHintText(rawText);
  // 2) 깨진 여는 구분자 방어 — OpenAI 가 `\(`/`\[` 를 `\w(`/`\w[` 또는 대문자 `\W(`/`\W[` 로
  //    깨뜨리는 경우(백엔드와 동일 방어, 9차에서 대문자까지 확대).
  //    구분자 바로 앞 `\w`/`\W` 만 좁게 치환해 정상 텍스트 오염 방지.
  text = text.replace(/\\[wW](?=[([])/g, '\\');
  const escapeHtml = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // \[ ... \] (블록) → \( ... \) (인라인) 순으로 치환
  const pattern = /\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)/g;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    out += escapeHtml(text.slice(last, m.index));
    const isBlock = m[1] !== undefined;
    const expr = (m[1] ?? m[2] ?? '').trim();
    try {
      out += katex.renderToString(expr, { displayMode: isBlock, throwOnError: false });
    } catch {
      out += escapeHtml(expr);
    }
    last = pattern.lastIndex;
  }
  out += escapeHtml(text.slice(last));
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
  // 멀티턴 — 직전 힌트까지 공개한 노드 index (첫 호출 -1)
  const [revealedIndex, setRevealedIndex] = useState<number>(-1);
  const [hasMore, setHasMore] = useState(true);

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
          setHasMore(data.hasMore ?? true);
          return;
        }
        localStorage.removeItem(chatKey(problemId)); // 만료·옛 버전 → 폐기
      }
    } catch (e) {
      console.warn('[tutor] 대화 복구 실패', e);
    }
    setTurns([]);
    setRevealedIndex(-1);
    setHasMore(true);
  }, [problemId]);

  // 대화 변경 시 저장 (최근 200턴까지만). 저장 직전 각 turn.text sanitize → 깨진 텍스트 캐시 차단(12차).
  useEffect(() => {
    try {
      const data = {
        version: CHAT_CACHE_VERSION,
        turns: turns.slice(-200).map((t) => ({ ...t, text: sanitizeHintText(t.text) })),
        revealedIndex,
        hasMore,
        timestamp: Date.now(),
      };
      localStorage.setItem(chatKey(problemId), JSON.stringify(data));
    } catch (e) {
      console.warn('[tutor] 대화 저장 실패', e);
    }
  }, [turns, revealedIndex, hasMore, problemId]);

  const requestHint = async (description: string) => {
    setLoading(true);
    setError(null);
    setTurns((prev) => [...prev, { role: 'student', text: description }]);
    try {
      const res = await ragHintApi.getHint({
        problemId,
        blockedDescription: description,
        revealedNodeIndex: revealedIndex,
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
      // 다음 "다음 힌트" 호출에 쓸 index 갱신
      if (typeof res.next_revealed_node_index === 'number') {
        if (res.next_revealed_node_index <= revealedIndex) setHasMore(false);
        setRevealedIndex(res.next_revealed_node_index);
      }
    } catch (e: any) {
      setError(e?.message || '힌트 생성에 실패했습니다');
    } finally {
      setLoading(false);
    }
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
    setHasMore(true);
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
          <h2 className="font-semibold">막힌 지점 도우미</h2>
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
              <div className="text-xs text-muted-foreground">생각하는 데 최대 1분 정도 걸릴 수 있어요</div>
            </div>
          </div>
        )}

        {error && (
          <div className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</div>
        )}
      </div>

      {/* 입력 영역 */}
      <div className="border-t px-5 py-3 space-y-2">
        {turns.length > 0 && hasMore && !loading && (
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => requestHint('다음 단계도 알려주세요')}
          >
            다음 힌트 →
          </Button>
        )}
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
        <Button
          variant="ghost"
          size="sm"
          className="w-full text-muted-foreground"
          disabled={loading}
          onClick={() => requestHint('아예 모르겠어요')}
        >
          아예 모르겠어요 — 처음부터 도와주세요
        </Button>
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
