/**
 * 2단계: 문제 상세 입력
 * 크롭된 문제 이미지를 보면서 답/난이도/유형/해설 입력
 */
import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Button } from '@shared/ui/button';
import { Input } from '@shared/ui/input';
import { Label } from '@shared/ui/label';
import { toast } from '@shared/hooks/use-toast';
import { ArrowLeft, Loader2, Save, Check } from 'lucide-react';

const PIPELINE_URL = 'http://localhost:8000';

interface StagingProblem {
  id: string;
  problem_number: number;
  difficulty: 'easy' | 'medium' | 'hard';
  answer_type: 'multiple_choice' | 'short_answer';
  correct_answer: string;
  explanation: string | null;
  unit: string;
  source_image_url: string | null;
  status: string;
}

const selectClassName = "flex h-8 w-full rounded-md border border-input bg-background px-3 py-1 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2";

const ProblemDetail = () => {
  const { jobId } = useParams<{ jobId: string }>();
  const navigate = useNavigate();

  const [problems, setProblems] = useState<StagingProblem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<Partial<StagingProblem>>({});
  const [saving, setSaving] = useState(false);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());

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
      if (list.length > 0) {
        selectProblem(list[0]);
      }
    } catch (e: any) {
      toast({ title: '오류', description: e.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  const selectProblem = (p: StagingProblem) => {
    setSelectedId(p.id);
    setEditValues({
      difficulty: p.difficulty,
      answer_type: p.answer_type,
      correct_answer: p.correct_answer || '',
      explanation: p.explanation || '',
      unit: p.unit || '',
    });
  };

  const handleSave = async () => {
    if (!selectedId) return;
    setSaving(true);
    try {
      const res = await fetch(`${PIPELINE_URL}/api/staging/${selectedId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'approved', ...editValues }),
      });
      if (!res.ok) throw new Error('저장 실패');

      setProblems(prev =>
        prev.map(p => p.id === selectedId ? { ...p, ...editValues as any, status: 'approved' } : p)
      );
      setSavedIds(prev => new Set([...prev, selectedId]));

      // 다음 문제로 자동 이동
      const idx = problems.findIndex(p => p.id === selectedId);
      if (idx < problems.length - 1) {
        selectProblem(problems[idx + 1]);
      } else {
        toast({ title: '완료', description: '모든 문제 입력 완료!' });
      }
    } catch (e: any) {
      toast({ title: '오류', description: e.message, variant: 'destructive' });
    } finally {
      setSaving(false);
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
          onClick={() => navigate('/cms/textbooks')}
        >
          교재 목록으로
        </Button>
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
            {/* 문제 이미지 */}
            <div className="flex-1 overflow-auto p-4 border-r bg-gray-50">
              {selectedProblem.source_image_url ? (
                <img
                  src={selectedProblem.source_image_url}
                  alt={`문제 ${selectedProblem.problem_number}`}
                  className="max-w-full rounded border shadow-sm"
                />
              ) : (
                <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                  이미지 없음
                </div>
              )}
            </div>

            {/* 입력 폼 */}
            <div className="w-72 overflow-y-auto p-4 space-y-4 shrink-0">
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
