/**
 * 2단계: 문제 상세 입력
 * 크롭된 문제 이미지를 보면서 답/난이도/유형/해설/AI 태그 입력
 */
import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Button } from '@shared/ui/button';
import { Input } from '@shared/ui/input';
import { Label } from '@shared/ui/label';
import { toast } from '@shared/hooks/use-toast';
import { ArrowLeft, Loader2, Save, Check, Tag, Upload, X, Bot, Zap } from 'lucide-react';

const PIPELINE_URL = 'http://localhost:8000';

interface TagItem {
  tag: string;
  confidence: number;
  source: 'ai' | 'manual';
  tag_type: 'concept' | 'skill';
}

interface StagingProblem {
  id: string;
  problem_number: number;
  difficulty: 'easy' | 'medium' | 'hard';
  answer_type: 'multiple_choice' | 'short_answer';
  correct_answer: string;
  explanation: string | null;
  unit: string;
  source_image_url: string | null;
  solution_image_url: string | null;
  solution_summary: string | null;
  match_confidence: number | null;
  status: string;
}

const selectClassName = "flex h-8 w-full rounded-md border border-input bg-background px-3 py-1 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2";

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

  // 해설지 업로드 상태
  const [solutionJobId, setSolutionJobId] = useState<string | null>(null);
  const [solutionStatus, setSolutionStatus] = useState<string>('');
  const [solutionUploading, setSolutionUploading] = useState(false);
  const [solutionProgress, setSolutionProgress] = useState<{ processed: number; total: number } | null>(null);
  const [applyingTags, setApplyingTags] = useState(false);
  const [taggingProblemId, setTaggingProblemId] = useState<string | null>(null);

  useEffect(() => {
    if (jobId) loadProblems();
  }, [jobId]);

  // 해설지 추출 진행 상황 폴링
  useEffect(() => {
    if (!solutionJobId || ['done', 'error', ''].includes(solutionStatus)) return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`${PIPELINE_URL}/api/solution/status/${solutionJobId}`);
        if (res.ok) {
          const data = await res.json();
          setSolutionStatus(data.status);
          if (data.progress) setSolutionProgress(data.progress);
          if (data.status === 'done') clearInterval(timer);
        }
      } catch {}
    }, 3000);
    return () => clearInterval(timer);
  }, [solutionJobId, solutionStatus]);

  const loadProblems = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${PIPELINE_URL}/api/staging/${jobId}`);
      if (!res.ok) throw new Error('문제 목록 조회 실패');
      const data = await res.json();
      const list: StagingProblem[] = data.problems.filter((p: any) => p.status !== 'rejected');
      setProblems(list);
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
      difficulty: p.difficulty,
      answer_type: p.answer_type,
      correct_answer: p.correct_answer || '',
      explanation: p.explanation || '',
      unit: p.unit || '',
      solution_summary: p.solution_summary || '',
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

  const handleSolutionUpload = async (file: File) => {
    if (!jobId) return;
    setSolutionUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('teacher_id', 'placeholder'); // TODO: 실제 teacher_id
      formData.append('problem_job_id', jobId);

      const res = await fetch(`${PIPELINE_URL}/api/solution/upload`, {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) throw new Error('업로드 실패');
      const data = await res.json();
      setSolutionJobId(data.solution_job_id);
      setSolutionStatus('uploaded');

      // 즉시 추출 시작
      await fetch(`${PIPELINE_URL}/api/solution/extract/${data.solution_job_id}`, {
        method: 'POST',
      });
      setSolutionStatus('extracting');
      toast({ title: '해설지 업로드 완료', description: '추출 중...' });
    } catch (e: any) {
      toast({ title: '오류', description: e.message, variant: 'destructive' });
    } finally {
      setSolutionUploading(false);
    }
  };

  const handleApplySolution = async () => {
    if (!solutionJobId || !jobId) return;
    setApplyingTags(true);
    try {
      const res = await fetch(`${PIPELINE_URL}/api/solution/apply/${solutionJobId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ problem_job_id: jobId }),
      });
      if (!res.ok) throw new Error('적용 실패');
      const data = await res.json();
      toast({ title: '해설 적용 완료', description: data.message });
      await loadProblems();
    } catch (e: any) {
      toast({ title: '오류', description: e.message, variant: 'destructive' });
    } finally {
      setApplyingTags(false);
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

  const solutionStatusLabel: Record<string, string> = {
    uploaded: '업로드됨',
    extracting: '정답 추출 중...',
    cropping: '해설 크롭 중...',
    uploading: '이미지 업로드 중...',
    tagging: 'AI 태깅 중...',
    done: '완료',
    error: '오류 발생',
  };

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
          <div>
            <h1 className="text-xl font-bold">문제 상세 입력</h1>
            <p className="text-xs text-muted-foreground">
              완료: {savedIds.size} / {problems.length}개
            </p>
          </div>
        </div>

        {/* 해설지 연결 영역 */}
        <div className="flex items-center gap-2">
          {solutionJobId ? (
            <div className="flex items-center gap-2 text-sm">
              <span className={`px-2 py-1 rounded text-xs ${
                solutionStatus === 'done' ? 'bg-green-100 text-green-700' :
                solutionStatus === 'error' ? 'bg-red-100 text-red-700' :
                'bg-blue-100 text-blue-700'
              }`}>
                해설지: {solutionStatusLabel[solutionStatus] || solutionStatus}
                {solutionProgress && solutionStatus === 'tagging' && (
                  <> ({solutionProgress.processed}/{solutionProgress.total})</>
                )}
              </span>
              {solutionStatus === 'done' && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleApplySolution}
                  disabled={applyingTags}
                  className="text-xs h-7"
                >
                  {applyingTags ? <Loader2 className="h-3 w-3 animate-spin" /> : <Zap className="h-3 w-3" />}
                  문제에 적용
                </Button>
              )}
            </div>
          ) : (
            <label className="cursor-pointer">
              <input
                type="file"
                accept=".pdf"
                className="hidden"
                onChange={e => {
                  const f = e.target.files?.[0];
                  if (f) handleSolutionUpload(f);
                }}
              />
              <Button
                variant="outline"
                size="sm"
                disabled={solutionUploading}
                asChild
              >
                <span>
                  {solutionUploading ? (
                    <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  ) : (
                    <Upload className="h-4 w-4 mr-1" />
                  )}
                  해설지 PDF 업로드
                </span>
              </Button>
            </label>
          )}

          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate('/cms/textbooks')}
          >
            교재 목록으로
          </Button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* 좌측: 문제 번호 목록 */}
        <div className="w-48 border-r overflow-y-auto shrink-0 bg-gray-50">
          <div className="p-2 space-y-1">
            {problems.map(p => (
              <button
                key={p.id}
                onClick={() => selectProblem(p)}
                className={`w-full text-left px-3 py-2 rounded text-sm transition-colors ${
                  selectedId === p.id
                    ? 'bg-primary text-primary-foreground'
                    : 'hover:bg-gray-200'
                }`}
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
                <Input
                  value={editValues.correct_answer || ''}
                  onChange={e => setEditValues(prev => ({ ...prev, correct_answer: e.target.value }))}
                  placeholder="예: 3, ①, 15"
                  className="mt-1"
                  onKeyDown={e => e.key === 'Enter' && handleSave()}
                />
              </div>

              <div>
                <Label className="text-sm">난이도</Label>
                <select
                  value={editValues.difficulty || 'medium'}
                  onChange={e => setEditValues(prev => ({ ...prev, difficulty: e.target.value as any }))}
                  className={`mt-1 ${selectClassName}`}
                >
                  <option value="easy">쉬움</option>
                  <option value="medium">보통</option>
                  <option value="hard">어려움</option>
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

              {/* 풀이 요약 (AI 생성) */}
              {(editValues.solution_summary || selectedProblem.solution_summary) && (
                <div>
                  <Label className="text-sm flex items-center gap-1">
                    <Bot className="h-3 w-3" />
                    풀이 요약 (AI)
                  </Label>
                  <textarea
                    value={editValues.solution_summary || ''}
                    onChange={e => setEditValues(prev => ({ ...prev, solution_summary: e.target.value }))}
                    rows={3}
                    className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 resize-none"
                  />
                </div>
              )}

              <div>
                <Label className="text-sm">해설 (선택)</Label>
                <textarea
                  value={editValues.explanation || ''}
                  onChange={e => setEditValues(prev => ({ ...prev, explanation: e.target.value }))}
                  placeholder="해설 내용..."
                  rows={4}
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
    </div>
  );
};

export default ProblemDetail;
