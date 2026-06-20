// 풀이 노드 편집 모달 (교사 전용)
// 교재 화면 문제 목록 → "풀이 노드" 버튼으로 연다. problems.id 기준.
// dev-rules: Radix Portal(Dialog) 금지 → 순수 HTML/CSS 모달.
// 노드 수정/추가 시 서버가 임베딩 재생성·uses(DAG)·순번 정리. 응답으로 갱신된 전체 노드 반환.
import { useEffect, useState } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { Button } from '@shared/ui/button';
import { useToast } from '@shared/ui/use-toast';
import {
  nodeApi,
  type SolutionNode,
  type SolutionNodeInput,
} from '@shared/lib/api';

const ROLES = [
  'condition_analysis',
  'equation_setup',
  'case_split',
  'computation',
  'conclusion',
] as const;

const ROLE_LABEL: Record<string, string> = {
  condition_analysis: '조건 분석',
  equation_setup: '식 세우기',
  case_split: '경우 분리',
  computation: '계산',
  conclusion: '결론',
};

// LaTeX 인라인/블록(\( \) / \[ \])을 KaTeX 로 렌더. 실패 시 원문 표시.
function renderMath(text: string): string {
  if (!text) return '';
  const pattern = /\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)/g;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));
  while ((m = pattern.exec(text)) !== null) {
    out += esc(text.slice(last, m.index));
    const isBlock = m[1] !== undefined;
    const expr = (m[1] ?? m[2] ?? '').trim();
    try {
      out += katex.renderToString(expr, { displayMode: isBlock, throwOnError: false });
    } catch {
      out += esc(expr);
    }
    last = pattern.lastIndex;
  }
  out += esc(text.slice(last));
  return out;
}

const EMPTY_NODE: SolutionNodeInput = {
  role: 'computation',
  entry_conditions: null,
  key_concept: '',
  output_formula: '',
  uses: [],
  whys: [],
  figure_description: null,
  figure_image_crop_url: null,
};

interface Props {
  problemId: string;
  problemTitle?: string;
  onClose: () => void;
}

export function SolutionNodeEditorModal({ problemId, problemTitle, onClose }: Props) {
  const { toast } = useToast();
  const [nodes, setNodes] = useState<SolutionNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  // 편집 중인 노드 index (-1=없음, -2=새 노드 추가)
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState<SolutionNodeInput>(EMPTY_NODE);

  const load = async () => {
    setLoading(true);
    try {
      const res = await nodeApi.list(problemId);
      setNodes(res.nodes);
    } catch (e: any) {
      toast({ title: '노드 조회 실패', description: e.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [problemId]);

  const startEdit = (n: SolutionNode) => {
    setEditing(n.node_index);
    setDraft({
      role: n.role,
      entry_conditions: n.entry_conditions,
      key_concept: n.key_concept,
      output_formula: n.output_formula,
      uses: n.uses,
      whys: n.whys,
      figure_description: n.figure_description,
      figure_image_crop_url: n.figure_image_crop_url,
    });
  };

  const startAdd = () => {
    setEditing(-2);
    setDraft({ ...EMPTY_NODE });
  };

  const cancelEdit = () => { setEditing(null); setDraft(EMPTY_NODE); };

  const saveDraft = async () => {
    if (!draft.key_concept.trim() || !draft.output_formula.trim()) {
      toast({ title: '필수값 누락', description: '핵심 개념과 결과 수식은 비울 수 없습니다.', variant: 'destructive' });
      return;
    }
    setBusy(true);
    try {
      const res = editing === -2
        ? await nodeApi.add(problemId, draft)
        : await nodeApi.update(problemId, editing as number, draft);
      setNodes(res.nodes);
      cancelEdit();
      toast({ title: '저장됨', description: '노드와 검색 인덱스를 갱신했습니다.' });
    } catch (e: any) {
      toast({ title: '저장 실패', description: e.message, variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  const removeNode = async (idx: number) => {
    if (!confirm(`노드 ${idx} 를 삭제할까요? 참조 관계가 자동 정리됩니다.`)) return;
    setBusy(true);
    try {
      const res = await nodeApi.remove(problemId, idx);
      setNodes(res.nodes);
      toast({ title: '삭제됨' });
    } catch (e: any) {
      toast({ title: '삭제 실패', description: e.message, variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  const reExtract = async () => {
    if (!confirm('AI 로 노드를 다시 추출합니다. 기존 노드는 모두 교체됩니다. 진행할까요?')) return;
    setBusy(true);
    try {
      const res = await nodeApi.reExtract(problemId);
      setNodes(res.nodes);
      toast({ title: '재추출 완료', description: `${res.nodes.length}개 노드` });
    } catch (e: any) {
      toast({ title: '재추출 실패', description: e.message, variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center">
      <div className="fixed inset-0 bg-black/80" onClick={onClose} />
      <div className="relative z-[10000] bg-background border rounded-lg shadow-lg w-full max-w-3xl max-h-[90vh] overflow-y-auto p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">풀이 노드 편집 {problemTitle ? `· ${problemTitle}` : ''}</h2>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={reExtract} disabled={busy || loading}>
              AI 재추출
            </Button>
            <Button variant="ghost" size="sm" onClick={onClose}>닫기</Button>
          </div>
        </div>

        {loading ? (
          <p className="text-sm text-muted-foreground py-8 text-center">불러오는 중…</p>
        ) : (
          <div className="space-y-3">
            {nodes.length === 0 && (
              <p className="text-sm text-muted-foreground py-6 text-center">
                노드가 없습니다. AI 재추출로 생성하거나 아래에서 직접 추가하세요.
              </p>
            )}

            {nodes.map((n) => (
              <div key={n.node_index} className="border rounded-md p-3">
                {editing === n.node_index ? (
                  <NodeForm draft={draft} setDraft={setDraft} onSave={saveDraft} onCancel={cancelEdit} busy={busy} maxUseIndex={n.node_index} />
                ) : (
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs font-bold bg-muted rounded px-1.5 py-0.5">#{n.node_index}</span>
                        <span className="text-xs text-muted-foreground">{ROLE_LABEL[n.role] || n.role}</span>
                        {n.uses.length > 0 && (
                          <span className="text-xs text-blue-600">uses [{n.uses.join(', ')}]</span>
                        )}
                      </div>
                      <p className="text-sm font-medium">{n.key_concept}</p>
                      <div className="text-sm mt-0.5" dangerouslySetInnerHTML={{ __html: renderMath(n.output_formula) }} />
                      {n.whys.length > 0 && (
                        <ul className="mt-1 text-xs text-muted-foreground list-disc list-inside">
                          {n.whys.map((w, i) => <li key={i}>{w.question}</li>)}
                        </ul>
                      )}
                    </div>
                    <div className="flex flex-col gap-1 flex-shrink-0">
                      <Button variant="ghost" size="sm" onClick={() => startEdit(n)} disabled={busy}>수정</Button>
                      <Button variant="ghost" size="sm" className="text-destructive" onClick={() => removeNode(n.node_index)} disabled={busy}>삭제</Button>
                    </div>
                  </div>
                )}
              </div>
            ))}

            {editing === -2 ? (
              <div className="border rounded-md p-3 border-primary">
                <p className="text-sm font-medium mb-2">새 노드 (맨 뒤에 추가)</p>
                <NodeForm draft={draft} setDraft={setDraft} onSave={saveDraft} onCancel={cancelEdit} busy={busy} maxUseIndex={nodes.length} />
              </div>
            ) : (
              <Button variant="outline" size="sm" onClick={startAdd} disabled={busy || editing !== null}>
                + 노드 추가
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── 노드 편집 폼 (전체 필드: role/concept/formula/entry/uses/whys/figure) ──
function NodeForm({
  draft, setDraft, onSave, onCancel, busy, maxUseIndex,
}: {
  draft: SolutionNodeInput;
  setDraft: (d: SolutionNodeInput) => void;
  onSave: () => void;
  onCancel: () => void;
  busy: boolean;
  maxUseIndex: number; // uses 는 이 값 미만의 인덱스만 유효(자기 이전)
}) {
  const set = (patch: Partial<SolutionNodeInput>) => setDraft({ ...draft, ...patch });
  const inputCls = 'mt-1 w-full rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-ring';

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs">역할
          <select className={inputCls} value={draft.role} onChange={(e) => set({ role: e.target.value })}>
            {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
          </select>
        </label>
        <label className="text-xs">참조 노드 uses (쉼표, {maxUseIndex > 0 ? `0~${maxUseIndex - 1}` : '없음'})
          <input
            className={inputCls}
            value={draft.uses.join(', ')}
            onChange={(e) => set({
              uses: e.target.value.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n)),
            })}
            placeholder="예: 0, 2"
          />
        </label>
      </div>

      <label className="text-xs block">핵심 개념 *
        <input className={inputCls} value={draft.key_concept} onChange={(e) => set({ key_concept: e.target.value })} placeholder="예: 판별식" />
      </label>

      <label className="text-xs block">결과 수식 * (LaTeX \( ... \))
        <input className={inputCls} value={draft.output_formula} onChange={(e) => set({ output_formula: e.target.value })} placeholder="\( D > 0 \)" />
        {draft.output_formula && (
          <div className="mt-1 text-sm px-2 py-1 bg-muted/40 rounded" dangerouslySetInnerHTML={{ __html: renderMath(draft.output_formula) }} />
        )}
      </label>

      <label className="text-xs block">진입 조건 (선택)
        <input className={inputCls} value={draft.entry_conditions ?? ''} onChange={(e) => set({ entry_conditions: e.target.value || null })} placeholder="이 단계 직전까지 확보한 상태" />
      </label>

      {/* whys: 왜 이 단계로 넘어가나 — 질문/이유 0~2개 */}
      <div className="text-xs">
        <div className="flex items-center justify-between">
          <span>전이 근거 whys (왜 이 단계로?)</span>
          {draft.whys.length < 2 && (
            <button type="button" className="text-blue-600" onClick={() => set({ whys: [...draft.whys, { question: '', reason: '' }] })}>+ 추가</button>
          )}
        </div>
        {draft.whys.map((w, i) => (
          <div key={i} className="flex gap-1 mt-1">
            <input className={inputCls + ' flex-1'} value={w.question} placeholder="왜 ...?"
              onChange={(e) => set({ whys: draft.whys.map((x, j) => j === i ? { ...x, question: e.target.value } : x) })} />
            <input className={inputCls + ' flex-1'} value={w.reason} placeholder="이유(학생 비공개)"
              onChange={(e) => set({ whys: draft.whys.map((x, j) => j === i ? { ...x, reason: e.target.value } : x) })} />
            <button type="button" className="text-destructive px-1" onClick={() => set({ whys: draft.whys.filter((_, j) => j !== i) })}>×</button>
          </div>
        ))}
      </div>

      <label className="text-xs block">도형 설명 (선택)
        <input className={inputCls} value={draft.figure_description ?? ''} onChange={(e) => set({ figure_description: e.target.value || null })} placeholder="도형/그래프 언어화" />
      </label>

      <div className="flex gap-2 pt-1">
        <Button size="sm" onClick={onSave} disabled={busy}>저장</Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>취소</Button>
      </div>
    </div>
  );
}
