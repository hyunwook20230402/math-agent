import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '@shared/hooks/useAuth';
import { Button } from '@shared/ui/button';
import { Input } from '@shared/ui/input';
import { Label } from '@shared/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@shared/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@shared/ui/select';
import { Badge } from '@shared/ui/badge';
import { toast } from '@shared/hooks/use-toast';
import { ArrowLeft, Check, X, CheckCheck, Loader2, BookOpen } from 'lucide-react';
import { useTextbook } from '@/context/TextbookContext';

const PIPELINE_URL = 'http://localhost:8000';

interface StagingProblem {
  id: string;
  problem_number: number;
  title: string;
  unit: string;
  difficulty: 'easy' | 'medium' | 'hard';
  answer_type: 'multiple_choice' | 'short_answer';
  correct_answer: string;
  explanation: string | null;
  problem_text: string;
  source_image_url: string | null;
  confidence: number;
  status: 'pending' | 'approved' | 'rejected' | 'modified';
}

const difficultyLabel = { easy: '쉬움', medium: '보통', hard: '어려움' };
const statusColor: Record<string, string> = {
  pending: 'bg-gray-100 text-gray-700',
  approved: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
  modified: 'bg-blue-100 text-blue-700',
};

const PdfReview = () => {
  const { jobId } = useParams<{ jobId: string }>();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const { selectedTextbook, selectedChapter, breadcrumb } = useTextbook();
  const [problems, setProblems] = useState<StagingProblem[]>([]);
  const [loading, setLoading] = useState(true);
  const [approving, setApproving] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<Partial<StagingProblem>>({});

  useEffect(() => {
    if (jobId) loadProblems();
  }, [jobId]);

  const loadProblems = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${PIPELINE_URL}/api/staging/${jobId}`);
      if (!res.ok) throw new Error('문제 목록 조회 실패');
      const data = await res.json();
      setProblems(data.problems);
    } catch (e: any) {
      toast({ title: '오류', description: e.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  const updateStatus = async (id: string, status: string, updates?: Partial<StagingProblem>) => {
    const res = await fetch(`${PIPELINE_URL}/api/staging/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, ...updates }),
    });
    if (!res.ok) throw new Error('업데이트 실패');
    setProblems(prev =>
      prev.map(p => (p.id === id ? { ...p, status: status as any, ...updates } : p))
    );
  };

  const handleApprove = async (id: string) => {
    try {
      await updateStatus(id, 'approved');
    } catch (e: any) {
      toast({ title: '오류', description: e.message, variant: 'destructive' });
    }
  };

  const handleReject = async (id: string) => {
    try {
      await updateStatus(id, 'rejected');
    } catch (e: any) {
      toast({ title: '오류', description: e.message, variant: 'destructive' });
    }
  };

  const handleApproveAll = async () => {
    try {
      // 모든 pending 문제 승인
      const pendingIds = problems.filter(p => p.status === 'pending').map(p => p.id);
      await Promise.all(pendingIds.map(id => updateStatus(id, 'approved')));
      toast({ title: '전체 승인 완료', description: `${pendingIds.length}개 문제 승인됨` });
    } catch (e: any) {
      toast({ title: '오류', description: e.message, variant: 'destructive' });
    }
  };

  const handleFinalApprove = async () => {
    if (!profile) return;
    setApproving(true);
    try {
      const res = await fetch(`${PIPELINE_URL}/api/staging/${jobId}/approve-all`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teacher_id: profile.id }),
      });
      if (!res.ok) throw new Error('등록 실패');
      const data = await res.json();
      toast({ title: '등록 완료', description: data.message });
      navigate('/cms/problems');
    } catch (e: any) {
      toast({ title: '오류', description: e.message, variant: 'destructive' });
    } finally {
      setApproving(false);
    }
  };

  const startEdit = (p: StagingProblem) => {
    setEditing(p.id);
    setEditValues({
      problem_number: p.problem_number,
      difficulty: p.difficulty,
      answer_type: p.answer_type,
      correct_answer: p.correct_answer,
      unit: p.unit,
      explanation: p.explanation || '',
    });
  };

  const saveEdit = async (id: string) => {
    try {
      await updateStatus(id, 'modified', editValues as Partial<StagingProblem>);
      setEditing(null);
    } catch (e: any) {
      toast({ title: '오류', description: e.message, variant: 'destructive' });
    }
  };

  const approvedCount = problems.filter(p => p.status === 'approved').length;
  const totalCount = problems.filter(p => p.status !== 'rejected').length;

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-6 max-w-4xl">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <Button variant="outline" size="sm" onClick={() => navigate('/cms/textbooks')}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            돌아가기
          </Button>
          <div>
            <h1 className="text-2xl font-bold">문제 검수</h1>
            {breadcrumb && (
              <p className="text-sm text-primary flex items-center gap-1">
                <BookOpen className="h-3 w-3" />
                {breadcrumb}
              </p>
            )}
            <p className="text-muted-foreground">
              승인됨: {approvedCount} / {totalCount}개
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleApproveAll}>
            <CheckCheck className="h-4 w-4 mr-2" />
            전체 승인
          </Button>
          <Button onClick={handleFinalApprove} disabled={approving || approvedCount === 0}>
            {approving ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Check className="h-4 w-4 mr-2" />
            )}
            DB에 등록 ({approvedCount}개)
          </Button>
        </div>
      </div>

      <div className="space-y-3">
        {problems.map(p => (
          <Card
            key={p.id}
            className={`border-l-4 ${
              p.confidence < 0.7 ? 'border-l-red-400' : 'border-l-green-400'
            } ${p.status === 'rejected' ? 'opacity-40' : ''}`}
          >
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">
                  {p.problem_number}번
                  {p.confidence < 0.7 && (
                    <span className="ml-2 text-xs text-red-500 font-normal">
                      (신뢰도 낮음: {(p.confidence * 100).toFixed(0)}%)
                    </span>
                  )}
                </CardTitle>
                <div className="flex items-center gap-2">
                  <span className={`text-xs px-2 py-1 rounded-full ${statusColor[p.status]}`}>
                    {p.status}
                  </span>
                  {editing !== p.id && (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => startEdit(p)}>
                        편집
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-green-600"
                        onClick={() => handleApprove(p.id)}
                        disabled={p.status === 'approved'}
                      >
                        <Check className="h-4 w-4" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-red-600"
                        onClick={() => handleReject(p.id)}
                        disabled={p.status === 'rejected'}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {editing === p.id ? (
                <div className="space-y-3">
                  {p.source_image_url && (
                    <div>
                      <img
                        src={p.source_image_url}
                        alt={`문제 ${p.problem_number}`}
                        className="max-w-full rounded border"
                        style={{ maxHeight: '400px' }}
                      />
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label className="text-xs">문제 번호</Label>
                      <Input
                        type="number"
                        value={editValues.problem_number || ''}
                        onChange={e => setEditValues(prev => ({ ...prev, problem_number: parseInt(e.target.value) || 0 }))}
                        className="h-8"
                      />
                    </div>
                    <div>
                      <Label className="text-xs">난이도</Label>
                      <Select
                        value={editValues.difficulty}
                        onValueChange={v => setEditValues(prev => ({ ...prev, difficulty: v as any }))}
                      >
                        <SelectTrigger className="h-8">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="easy">쉬움</SelectItem>
                          <SelectItem value="medium">보통</SelectItem>
                          <SelectItem value="hard">어려움</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label className="text-xs">유형</Label>
                      <Select
                        value={editValues.answer_type}
                        onValueChange={v => setEditValues(prev => ({ ...prev, answer_type: v as any }))}
                      >
                        <SelectTrigger className="h-8">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="multiple_choice">객관식</SelectItem>
                          <SelectItem value="short_answer">주관식</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div>
                    <Label className="text-xs">정답</Label>
                    <Input
                      value={editValues.correct_answer || ''}
                      onChange={e => setEditValues(prev => ({ ...prev, correct_answer: e.target.value }))}
                      className="h-8"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">단원</Label>
                    <Input
                      value={editValues.unit || ''}
                      onChange={e => setEditValues(prev => ({ ...prev, unit: e.target.value }))}
                      className="h-8"
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => saveEdit(p.id)}>저장</Button>
                    <Button size="sm" variant="outline" onClick={() => setEditing(null)}>취소</Button>
                  </div>
                </div>
              ) : (
                <div className="text-sm space-y-1">
                  <div className="flex gap-4 text-muted-foreground">
                    <span>난이도: {difficultyLabel[p.difficulty] || p.difficulty}</span>
                    <span>유형: {p.answer_type === 'multiple_choice' ? '객관식' : '주관식'}</span>
                    <span>정답: {p.correct_answer}</span>
                  </div>
                  {p.unit && <p className="text-xs text-muted-foreground">단원: {p.unit}</p>}
                  {p.source_image_url ? (
                    <div className="mt-2">
                      <img
                        src={p.source_image_url}
                        alt={`문제 ${p.problem_number}`}
                        className="max-w-full rounded border"
                        style={{ maxHeight: '400px' }}
                      />
                    </div>
                  ) : (
                    <p className="mt-2 text-sm bg-muted p-2 rounded text-ellipsis overflow-hidden max-h-20">
                      {p.problem_text}
                    </p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
};

export default PdfReview;
