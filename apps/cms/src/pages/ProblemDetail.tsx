/**
 * 2단계: 문제 상세 입력
 * 크롭된 문제 이미지를 보면서 답/난이도/유형/해설/AI 태그 입력
 */
import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '@shared/supabase/client';
import { Button } from '@shared/ui/button';
import { scoreToLevel } from '@shared/lib/utils';
import { Input } from '@shared/ui/input';
import { Label } from '@shared/ui/label';
import { toast } from '@shared/hooks/use-toast';
import { ArrowLeft, Loader2, Save, Check, Tag, X, Bot, Zap, Crop, Workflow } from 'lucide-react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { MathInput } from '@shared/ui/MathInput';
import { SolutionNodeEditorModal } from '@/components/SolutionNodeEditorModal';

const PIPELINE_URL =
  (import.meta.env.VITE_TUTOR_API_URL as string | undefined) || 'http://localhost:8001';

function tryRenderKatex(expr: string, display = false): string | null {
  try {
    return katex.renderToString(expr, { displayMode: display, throwOnError: true });
  } catch {
    return null;
  }
}

function MathText({ text }: { text: string }) {
  const parts = text.split(/(\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]|\$\$[\s\S]*?\$\$|\$[^$\n]+?\$)/g);
  return (
    <span>
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

interface TagItem {
  tag: string;
  confidence: number;
  source: 'ai' | 'manual';
  tag_type: 'concept' | 'skill';
}

interface StagingProblem {
  id: string;
  problem_number: number;
  difficulty_score: number | null;
  difficulty: 'very_easy' | 'easy' | 'medium' | 'hard' | 'very_hard' | null;
  answer_type: 'multiple_choice' | 'short_answer';
  correct_answer: string;
  /** 교사가 직접 만든 보기. 지면에 보기가 인쇄된 문제는 비어 있다. */
  choices: string[] | null;
  explanation: string | null;
  unit: string;
  source_image_url: string | null;
  solution_image_url: string | null;
  solution_job_id: string | null;
  promoted_problem_id: string | null;
  match_confidence: number | null;
  status: string;
}

const selectClassName = "flex h-8 w-full rounded-md border border-input bg-background px-3 py-1 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2";

const CHOICE_MARKS = ['①', '②', '③', '④', '⑤'];

const confidenceBadgeColor = (c: number) => {
  if (c >= 0.8) return 'bg-green-100 text-green-700';
  if (c >= 0.5) return 'bg-yellow-100 text-yellow-700';
  return 'bg-red-100 text-red-700';
};

// 태그 chip 컴포넌트
function TagChip({
  item,
  onRemove,
}: {
  item: TagItem;
  onRemove: () => void;
}) {
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border ${
      item.source === 'ai' ? 'border-blue-200 bg-blue-50' : 'border-gray-200 bg-gray-50'
    }`}>
      {item.source === 'ai' && (
        <span className={`text-[10px] px-1 rounded ${confidenceBadgeColor(item.confidence)}`}>
          AI {Math.round(item.confidence * 100)}%
        </span>
      )}
      {item.tag}
      <button
        onClick={onRemove}
        className="ml-0.5 text-gray-400 hover:text-red-500"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

// 태그 입력 섹션 컴포넌트
function TagSection({
  label,
  icon,
  tags,
  onAdd,
  onRemove,
}: {
  label: string;
  icon: React.ReactNode;
  tags: TagItem[];
  onAdd: (tag: string) => void;
  onRemove: (idx: number) => void;
}) {
  const [input, setInput] = useState('');

  const handleAdd = () => {
    const trimmed = input.trim();
    if (trimmed) {
      onAdd(trimmed);
      setInput('');
    }
  };

  return (
    <div>
      <Label className="text-sm flex items-center gap-1">
        {icon}
        {label}
      </Label>
      <div className="mt-1 flex flex-wrap gap-1 min-h-[28px]">
        {tags.map((t, i) => (
          <TagChip key={`${t.tag}-${i}`} item={t} onRemove={() => onRemove(i)} />
        ))}
      </div>
      <div className="mt-1 flex gap-1">
        <Input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), handleAdd())}
          placeholder="태그 입력 후 Enter"
          className="h-7 text-xs"
        />
        <Button size="sm" variant="outline" onClick={handleAdd} className="h-7 text-xs px-2">
          추가
        </Button>
      </div>
    </div>
  );
}

const ProblemDetail = () => {
  const { jobId } = useParams<{ jobId: string }>();
  const navigate = useNavigate();

  const [problems, setProblems] = useState<StagingProblem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<Partial<StagingProblem>>({});
  const [conceptTags, setConceptTags] = useState<TagItem[]>([]);
  const [skillTags, setSkillTags] = useState<TagItem[]>([]);
  const [saving, setSaving] = useState(false);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [activeTab, setActiveTab] = useState<'problem' | 'solution'>('problem');
  const [nodeEditTarget, setNodeEditTarget] = useState<{ id: string; title: string } | null>(null);

  const [taggingProblemId, setTaggingProblemId] = useState<string | null>(null);

  useEffect(() => {
    if (jobId) loadProblems();
  }, [jobId]);

  const loadProblems = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${PIPELINE_URL}/api/staging/${jobId}`);
      if (!res.ok) throw new Error('문제 목록 조회 실패');
      const data = await res.json();
      const list: StagingProblem[] = data.problems.filter((p: any) => p.status !== 'rejected');
      setProblems(list);
      // 이미 저장(approved/modified)된 문제 복원
      // 저장 버튼을 눌러 확정한 문제: status=approved이면서 correct_answer가 있는 경우
      const alreadySaved = new Set(list.filter((p: any) => p.status === 'approved' && p.correct_answer).map((p: any) => p.id));
      setSavedIds(alreadySaved);
      if (list.length > 0) {
        await selectProblem(list[0]);
      }
    } catch (e: any) {
      toast({ title: '오류', description: e.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  const selectProblem = async (p: StagingProblem) => {
    setSelectedId(p.id);
    setEditValues({
      difficulty_score: p.difficulty_score ?? 2,
      answer_type: p.answer_type,
      correct_answer: p.correct_answer || '',
      choices: Array.isArray(p.choices) ? p.choices : [],
      explanation: p.explanation || '',
      unit: p.unit || '',
    });
    setActiveTab('problem');

    // 태그 로드
    try {
      const res = await fetch(`${PIPELINE_URL}/api/staging/${p.id}/tags`);
      if (res.ok) {
        const tags: TagItem[] = await res.json();
        setConceptTags(tags.filter(t => t.tag_type === 'concept'));
        setSkillTags(tags.filter(t => t.tag_type === 'skill'));
      } else {
        setConceptTags([]);
        setSkillTags([]);
      }
    } catch {
      setConceptTags([]);
      setSkillTags([]);
    }
  };

  const handleSave = async () => {
    if (!selectedId) return;
    setSaving(true);
    try {
      // 메타데이터 저장
      const res = await fetch(`${PIPELINE_URL}/api/staging/${selectedId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'approved', ...editValues }),
      });
      if (!res.ok) throw new Error('저장 실패');

      // 태그 저장 (manual 태그)
      const allTags = [
        ...conceptTags.map(t => ({ ...t, tag_type: 'concept' as const })),
        ...skillTags.map(t => ({ ...t, tag_type: 'skill' as const })),
      ];
      await fetch(`${PIPELINE_URL}/api/staging/${selectedId}/tags`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags: allTags }),
      });

      setProblems(prev =>
        prev.map(p => p.id === selectedId ? { ...p, ...editValues as any, status: 'approved' } : p)
      );
      setSavedIds(prev => new Set([...prev, selectedId]));

      // 다음 문제로 자동 이동
      const idx = problems.findIndex(p => p.id === selectedId);
      if (idx < problems.length - 1) {
        await selectProblem(problems[idx + 1]);
      } else {
        toast({ title: '완료', description: '모든 문제 입력 완료!' });
      }
    } catch (e: any) {
      toast({ title: '오류', description: e.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const handleTagFromProblem = async (stagingId: string) => {
    setTaggingProblemId(stagingId);
    try {
      const res = await fetch(`${PIPELINE_URL}/api/solution/tag-from-problem/${stagingId}`, {
        method: 'POST',
      });
      if (!res.ok) throw new Error('태깅 시작 실패');
      toast({ title: 'AI 태깅 시작', description: '잠시 후 태그가 생성됩니다.' });
      // 5초 후 태그 다시 로드
      setTimeout(async () => {
        const selected = problems.find(p => p.id === stagingId);
        if (selected) await selectProblem(selected);
        setTaggingProblemId(null);
      }, 5000);
    } catch (e: any) {
      toast({ title: '오류', description: e.message, variant: 'destructive' });
      setTaggingProblemId(null);
    }
  };

  const selectedProblem = problems.find(p => p.id === selectedId);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      {/* 헤더 */}
      <div className="flex items-center justify-between px-4 py-3 border-b bg-white shrink-0">
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => navigate(`/cms/import/${jobId}`)}>
            <ArrowLeft className="h-4 w-4 mr-1" />
            크롭 검수로
          </Button>
          {selectedProblem?.solution_image_url && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const sj = selectedProblem.solution_job_id;
                if (sj) {
                  navigate(`/cms/solution/${jobId}?sj=${sj}`);
                } else {
                  toast({ title: '해설 크롭 작업을 찾을 수 없습니다', variant: 'destructive' });
                }
              }}
              title="이 문제의 해설 크롭 화면으로 돌아가 영역을 다시 잡습니다"
            >
              <Crop className="h-4 w-4 mr-1" />
              해설 다시 크롭
            </Button>
          )}
          <div>
            <h1 className="text-xl font-bold">문제 상세 입력</h1>
            <p className="text-xs text-muted-foreground">
              완료: {savedIds.size} / {problems.length}개
            </p>
          </div>
        </div>

        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            // 승격된 문제의 현재 폴더(textbook/chapter)를 조회해 교재화면이 그 폴더를
            // 자동 선택하게 한다. (staging.chapter_id 는 옛 폴더일 수 있어 problems 우선)
            const pid = (selectedProblem?.promoted_problem_id)
              || problems.find(p => p.promoted_problem_id)?.promoted_problem_id;
            if (pid) {
              const { data } = await supabase
                .from('problems')
                .select('textbook_id, chapter_id')
                .eq('id', pid)
                .single();
              const params = new URLSearchParams();
              if (data?.textbook_id) params.set('textbook_id', data.textbook_id);
              if (data?.chapter_id) params.set('chapter_id', data.chapter_id);
              navigate(`/cms/textbooks?${params.toString()}`);
              return;
            }
            navigate('/cms/textbooks');
          }}
        >
          교재 목록으로
        </Button>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* 좌측: 문제 번호 목록 */}
        <div className="w-48 border-r overflow-y-auto shrink-0 bg-gray-50">
          <div className="p-2 space-y-1">
            {problems.map(p => (
              <div
                key={p.id}
                className={`flex items-center rounded text-sm transition-colors ${
                  selectedId === p.id
                    ? 'bg-primary text-primary-foreground'
                    : 'hover:bg-gray-200'
                }`}
              >
                <button
                  onClick={() => selectProblem(p)}
                  className="flex-1 text-left px-3 py-2 min-w-0"
                >
                  <span className="font-medium">{p.problem_number}번</span>
                  {savedIds.has(p.id) && (
                    <span className="ml-1 text-green-500">
                      <Check className="inline h-3 w-3" />
                    </span>
                  )}
                  {p.solution_image_url && (
                    <span className="ml-1 text-blue-400 text-[10px]">해설</span>
                  )}
                  {!savedIds.has(p.id) && p.correct_answer && (
                    <span className="ml-1 text-xs opacity-60">({p.correct_answer})</span>
                  )}
                </button>
                {/* 풀이 노드 편집: 승격(등록)된 문제만 활성. 미승격은 비활성+툴팁. */}
                <button
                  disabled={!p.promoted_problem_id}
                  title={p.promoted_problem_id ? '풀이 노드 편집' : '등록 완료 후 노드가 생성됩니다'}
                  onClick={() => {
                    if (p.promoted_problem_id) {
                      setNodeEditTarget({ id: p.promoted_problem_id, title: p.title || `${p.problem_number}번` });
                    }
                  }}
                  className={`px-2 py-2 shrink-0 ${
                    p.promoted_problem_id
                      ? 'opacity-70 hover:opacity-100'
                      : 'opacity-25 cursor-not-allowed'
                  }`}
                >
                  <Workflow className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* 우측: 이미지 + 입력 폼 */}
        {selectedProblem ? (
          <div className="flex flex-1 overflow-hidden">
            {/* 이미지 영역 (탭) */}
            <div className="flex-1 overflow-auto border-r bg-gray-50">
              {/* 탭 */}
              <div className="flex border-b bg-white px-2 pt-2">
                <button
                  onClick={() => setActiveTab('problem')}
                  className={`px-3 py-1.5 text-sm rounded-t border-b-2 transition-colors ${
                    activeTab === 'problem'
                      ? 'border-primary text-primary font-medium'
                      : 'border-transparent text-muted-foreground hover:text-foreground'
                  }`}
                >
                  문제
                </button>
                <button
                  onClick={() => setActiveTab('solution')}
                  className={`px-3 py-1.5 text-sm rounded-t border-b-2 transition-colors ${
                    activeTab === 'solution'
                      ? 'border-primary text-primary font-medium'
                      : 'border-transparent text-muted-foreground hover:text-foreground'
                  }`}
                >
                  해설
                  {selectedProblem.match_confidence !== null && selectedProblem.match_confidence !== undefined && (
                    <span className={`ml-1 text-[10px] px-1 rounded ${
                      confidenceBadgeColor(selectedProblem.match_confidence)
                    }`}>
                      {Math.round(selectedProblem.match_confidence * 100)}%
                    </span>
                  )}
                </button>
              </div>

              <div className="p-4">
                {activeTab === 'problem' ? (
                  selectedProblem.source_image_url ? (
                    <img
                      src={selectedProblem.source_image_url}
                      alt={`문제 ${selectedProblem.problem_number}`}
                      className="max-w-full rounded border shadow-sm"
                    />
                  ) : (
                    <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                      이미지 없음
                    </div>
                  )
                ) : (
                  selectedProblem.solution_image_url ? (
                    <img
                      src={selectedProblem.solution_image_url}
                      alt={`해설 ${selectedProblem.problem_number}`}
                      className="max-w-full rounded border shadow-sm"
                    />
                  ) : (
                    <div className="flex flex-col items-center justify-center h-64 text-muted-foreground text-sm gap-3">
                      <p>해설 이미지 없음</p>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleTagFromProblem(selectedProblem.id)}
                        disabled={taggingProblemId === selectedProblem.id}
                      >
                        {taggingProblemId === selectedProblem.id ? (
                          <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                        ) : (
                          <Bot className="h-4 w-4 mr-1" />
                        )}
                        AI로 문제만 보고 태깅
                      </Button>
                    </div>
                  )
                )}
              </div>
            </div>

            {/* 입력 폼 */}
            <div className="w-80 overflow-y-auto p-4 space-y-4 shrink-0">
              <div>
                <h2 className="text-lg font-semibold mb-4">{selectedProblem.problem_number}번 입력</h2>
              </div>

              <div>
                <Label className="text-sm">정답</Label>
                {editValues.answer_type === 'multiple_choice' ? (
                  <select
                    value={editValues.correct_answer || ''}
                    onChange={e => setEditValues(prev => ({ ...prev, correct_answer: e.target.value }))}
                    className={`mt-1 ${selectClassName}`}
                  >
                    <option value="">선택</option>
                    {[1,2,3,4,5].map(n => (
                      <option key={n} value={String(n)}>{n}번</option>
                    ))}
                  </select>
                ) : (
                  <Input
                    value={editValues.correct_answer || ''}
                    onChange={e => setEditValues(prev => ({ ...prev, correct_answer: e.target.value }))}
                    placeholder="숫자 입력"
                    className="mt-1"
                    onKeyDown={e => e.key === 'Enter' && handleSave()}
                  />
                )}
              </div>

              {/* 보기 내용 — 답이 수식이라 지면에 보기가 없는 문제를 객관식으로 낼 때 쓴다.
                  ("나머지를 구하시오" 처럼 답이 일차식이면 주관식 칸에 못 담는다.)
                  지면에 보기(①~⑤)가 인쇄된 문제는 비워 두면 학생 화면이 번호만 보여준다. */}
              {editValues.answer_type === 'multiple_choice' && (
                <div>
                  <Label className="text-sm">보기 내용 (선택)</Label>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    비워 두면 문제 이미지의 보기를 그대로 씁니다. LaTeX 로 수식을 쓸 수 있고,
                    오른쪽에 학생 화면과 같은 모습이 바로 보입니다.
                  </p>
                  {CHOICE_MARKS.map((mark, i) => (
                    <div key={i} className="flex items-center gap-2 mt-1">
                      <span className="text-sm w-4 text-muted-foreground shrink-0 self-start mt-1.5">{mark}</span>
                      <MathInput
                        value={editValues.choices?.[i] ?? ''}
                        onChange={next => setEditValues(prev => {
                          const arr = [...(prev.choices ?? [])];
                          while (arr.length < CHOICE_MARKS.length) arr.push('');
                          arr[i] = next;
                          // 전부 비면 빈 배열로 — 지면 보기를 쓰는 문제로 되돌린다.
                          return { ...prev, choices: arr.some(c => c.trim()) ? arr : [] };
                        })}
                        placeholder={`${i + 1}번 보기 (예: x+2, \frac{1}{2})`}
                        onKeyDown={e => e.key === 'Enter' && handleSave()}
                      />
                    </div>
                  ))}
                </div>
              )}

              <div>
                <Label className="text-sm">난이도</Label>
                <select
                  className="mt-1 flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={scoreToLevel(editValues.difficulty_score ?? 2)}
                  onChange={e => setEditValues(prev => ({ ...prev, difficulty_score: parseInt(e.target.value) }))}
                >
                  <option value={1}>Lv1 (쉬움)</option>
                  <option value={2}>Lv2 (보통)</option>
                  <option value={3}>Lv3 (어려움)</option>
                  <option value={4}>Lv4 (최고난도)</option>
                </select>
              </div>

              <div>
                <Label className="text-sm">유형</Label>
                <select
                  value={editValues.answer_type || 'short_answer'}
                  onChange={e => setEditValues(prev => ({ ...prev, answer_type: e.target.value as any }))}
                  className={`mt-1 ${selectClassName}`}
                >
                  <option value="multiple_choice">객관식</option>
                  <option value="short_answer">주관식</option>
                </select>
              </div>

              <div>
                <Label className="text-sm">단원</Label>
                <Input
                  value={editValues.unit || ''}
                  onChange={e => setEditValues(prev => ({ ...prev, unit: e.target.value }))}
                  placeholder="예: 미적분 > 수열의 극한"
                  className="mt-1"
                />
              </div>

              {/* 개념 태그 */}
              <TagSection
                label="개념 태그"
                icon={<Tag className="h-3 w-3" />}
                tags={conceptTags}
                onAdd={tag => setConceptTags(prev => [
                  ...prev,
                  { tag, confidence: 1.0, source: 'manual', tag_type: 'concept' }
                ])}
                onRemove={idx => setConceptTags(prev => prev.filter((_, i) => i !== idx))}
              />

              {/* 스킬 태그 */}
              <TagSection
                label="스킬 태그"
                icon={<Zap className="h-3 w-3" />}
                tags={skillTags}
                onAdd={tag => setSkillTags(prev => [
                  ...prev,
                  { tag, confidence: 1.0, source: 'manual', tag_type: 'skill' }
                ])}
                onRemove={idx => setSkillTags(prev => prev.filter((_, i) => i !== idx))}
              />


              {/* 해설 이미지 */}
              {selectedProblem.solution_image_url && (
                <div>
                  <Label className="text-sm">해설 이미지</Label>
                  <img
                    src={selectedProblem.solution_image_url}
                    alt="해설 이미지"
                    className="mt-1 w-full rounded-md border border-input"
                  />
                </div>
              )}

              <div>
                <Label className="text-sm">해설 메모 (선택)</Label>
                <textarea
                  value={editValues.explanation || ''}
                  onChange={e => setEditValues(prev => ({ ...prev, explanation: e.target.value }))}
                  placeholder="추가 메모..."
                  rows={3}
                  className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 resize-none"
                />
              </div>

              <Button
                className="w-full"
                onClick={handleSave}
                disabled={saving}
              >
                {saving ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Save className="h-4 w-4 mr-2" />
                )}
                저장 후 다음 문제
              </Button>

              <p className="text-xs text-muted-foreground text-center">
                Enter 키로 빠르게 저장 가능
              </p>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            좌측에서 문제를 선택하세요
          </div>
        )}
      </div>

      {/* 풀이 노드 편집 모달 (onClose 주면 컴포넌트가 자체 오버레이) */}
      {nodeEditTarget && (
        <SolutionNodeEditorModal
          problemId={nodeEditTarget.id}
          problemTitle={nodeEditTarget.title}
          onClose={() => setNodeEditTarget(null)}
        />
      )}
    </div>
  );
};

export default ProblemDetail;
