// @ts-nocheck
// 막힌 지점 도우미 모달 — 순수 HTML/CSS (Radix Portal 금지: dev-rules)
// RAG 백엔드(POST /api/tutor/hint)를 호출해 막힌 지점 다음 한 단계만 힌트로 안내.
import { useState } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { X, Send, Loader2, Lightbulb } from 'lucide-react';
import { Button } from '@shared/ui/button';
import { ragHintApi } from '@shared/lib/api';

interface HintTurn {
  role: 'student' | 'tutor';
  text: string;
  concept?: string | null;
  figureUrls?: string[];
}

// \( ... \) / \[ ... \] 인라인·블록 수식을 KaTeX 로 렌더링한 HTML 반환.
function renderMath(text: string): string {
  if (!text) return '';
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
  onClose: () => void;
}

export default function StuckHelperModal({ problemId, onClose }: Props) {
  const [turns, setTurns] = useState<HintTurn[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 멀티턴 — 직전 힌트까지 공개한 노드 index (첫 호출 -1)
  const [revealedIndex, setRevealedIndex] = useState<number>(-1);
  const [hasMore, setHasMore] = useState(true);

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

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center">
      {/* 오버레이 */}
      <div className="fixed inset-0 bg-black/80" onClick={onClose} />

      {/* 패널 */}
      <div className="relative z-[10000] bg-background border rounded-lg shadow-lg w-full max-w-lg mx-4 flex flex-col max-h-[85vh]">
        {/* 헤더 */}
        <div className="flex items-center justify-between border-b px-5 py-3">
          <div className="flex items-center gap-2">
            <Lightbulb className="h-5 w-5 text-amber-500" />
            <h2 className="font-semibold">막힌 지점 도우미</h2>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-5 w-5" />
          </button>
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
              <div className="bg-muted rounded-lg px-3 py-2 text-sm flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                힌트를 준비하고 있어요...
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
      </div>
    </div>
  );
}
