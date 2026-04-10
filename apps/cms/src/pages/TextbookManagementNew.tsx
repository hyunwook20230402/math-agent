import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@shared/hooks/useAuth';
import { Button } from '@shared/ui/button';
import { Input } from '@shared/ui/input';
import { Label } from '@shared/ui/label';
import { Badge } from '@shared/ui/badge';
import { Textarea } from '@shared/ui/textarea';
import { toast } from '@shared/hooks/use-toast';
import {
  BookOpen,
  Plus,
  ChevronRight,
  ChevronDown,
  FolderOpen,
  FileText,
  Upload,
  Edit,
  Trash2,
  Search,
} from 'lucide-react';
import { supabase } from '@shared/supabase/client';
import { useTextbook } from '@/context/TextbookContext';
import type { Textbook, Chapter, Subchapter } from '@shared/types/database';
import PdfUploadDialog from '@/components/PdfUploadDialog';

const gradeOptions = [
  { value: '중학교 1학년', label: '중학교 1학년' },
  { value: '중학교 2학년', label: '중학교 2학년' },
  { value: '중학교 3학년', label: '중학교 3학년' },
  { value: '고등학교 1학년', label: '고등학교 1학년' },
  { value: '고등학교 2학년', label: '고등학교 2학년' },
  { value: '고등학교 3학년', label: '고등학교 3학년' },
];

const semesterOptions = [
  { value: '1학기', label: '1학기' },
  { value: '2학기', label: '2학기' },
];

interface Problem {
  id: string;
  title: string;
  problem_number: number;
  difficulty: string;
  answer_type: string;
  image_url: string;
  category: string;
  unit: string;
  correct_answer: string;
  created_at: string;
}

const difficultyLabel = (d: string) => ({ easy: '쉬움', medium: '보통', hard: '어려움' }[d] ?? d);
const difficultyColor = (d: string) => ({
  easy: 'bg-green-100 text-green-800',
  medium: 'bg-blue-100 text-blue-800',
  hard: 'bg-red-100 text-red-800',
}[d] ?? 'bg-gray-100 text-gray-800');

const TextbookManagementNew = () => {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const {
    selectedTextbook: ctxTextbook,
    selectedChapter: ctxChapter,
    selectedSubchapter: ctxSubchapter,
    setTextbook: ctxSetTextbook,
    setChapter: ctxSetChapter,
    setSubchapter: ctxSetSubchapter,
  } = useTextbook();

  // 교재/단원 데이터
  const [textbooks, setTextbooks] = useState<Textbook[]>([]);
  const [chapters, setChapters] = useState<Record<string, Chapter[]>>({});
  const [subchapters, setSubchapters] = useState<Record<string, Subchapter[]>>({});

  // 선택 상태
  const [selectedTextbook, setSelectedTextbook] = useState<Textbook | null>(ctxTextbook);
  const [selectedChapter, setSelectedChapter] = useState<Chapter | null>(ctxChapter);
  const [selectedSubchapter, setSelectedSubchapter] = useState<Subchapter | null>(ctxSubchapter);

  // 트리 펼침 상태
  const [expandedTextbooks, setExpandedTextbooks] = useState<Set<string>>(new Set());
  const [expandedChapters, setExpandedChapters] = useState<Set<string>>(new Set());

  // 문제 목록
  const [problems, setProblems] = useState<Problem[]>([]);
  const [problemsLoading, setProblemsLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');

  // Dialog 상태
  const [isTextbookDialogOpen, setIsTextbookDialogOpen] = useState(false);
  const [isChapterDialogOpen, setIsChapterDialogOpen] = useState(false);
  const [isSubchapterDialogOpen, setIsSubchapterDialogOpen] = useState(false);
  const [isPdfDialogOpen, setIsPdfDialogOpen] = useState(false);

  // 폼
  const [textbookForm, setTextbookForm] = useState({ name: '', grade: '', semester: '', description: '' });
  const [chapterForm, setChapterForm] = useState({ name: '', description: '', sort_order: 1 });
  const [subchapterForm, setSubchapterForm] = useState({ name: '', description: '', sort_order: 1 });

  useEffect(() => {
    fetchTextbooks();
  }, []);

  // 컨텍스트 선택 복원 시 트리 펼침
  useEffect(() => {
    if (ctxTextbook) {
      setExpandedTextbooks(prev => new Set([...prev, ctxTextbook.id]));
      fetchChapters(ctxTextbook.id);
    }
    if (ctxChapter) {
      setExpandedChapters(prev => new Set([...prev, ctxChapter.id]));
      fetchSubchapters(ctxChapter.id);
    }
  }, []);

  // 문제 목록 로드
  useEffect(() => {
    if (selectedSubchapter || selectedChapter || selectedTextbook) {
      fetchProblems();
    } else {
      setProblems([]);
    }
  }, [selectedTextbook, selectedChapter, selectedSubchapter]);

  const fetchTextbooks = async () => {
    const { data, error } = await supabase
      .from('textbooks')
      .select('*')
      .order('name', { ascending: true });
    if (!error && data) setTextbooks(data);
  };

  const fetchChapters = async (textbookId: string) => {
    const { data, error } = await supabase
      .from('chapters')
      .select('*')
      .eq('textbook_id', textbookId)
      .order('sort_order', { ascending: true });
    if (!error && data) {
      setChapters(prev => ({ ...prev, [textbookId]: data }));
    }
  };

  const fetchSubchapters = async (chapterId: string) => {
    const { data, error } = await supabase
      .from('subchapters')
      .select('*')
      .eq('chapter_id', chapterId)
      .order('sort_order', { ascending: true });
    if (!error && data) {
      setSubchapters(prev => ({ ...prev, [chapterId]: data }));
    }
  };

  const fetchProblems = async () => {
    if (!profile) return;
    setProblemsLoading(true);
    try {
      let query = supabase
        .from('problems')
        .select('*')
        .eq('teacher_id', profile.id)
        .order('problem_number', { ascending: true });

      if (selectedSubchapter) {
        query = query.eq('subchapter_id', selectedSubchapter.id);
      } else if (selectedChapter) {
        query = query.eq('chapter_id', selectedChapter.id);
      } else if (selectedTextbook) {
        query = query.eq('textbook_id', selectedTextbook.id);
      }

      const { data, error } = await query;
      if (!error && data) setProblems(data);
    } finally {
      setProblemsLoading(false);
    }
  };

  const toggleTextbook = async (textbook: Textbook) => {
    const isExpanded = expandedTextbooks.has(textbook.id);
    if (isExpanded) {
      setExpandedTextbooks(prev => { const s = new Set(prev); s.delete(textbook.id); return s; });
    } else {
      setExpandedTextbooks(prev => new Set([...prev, textbook.id]));
      if (!chapters[textbook.id]) await fetchChapters(textbook.id);
    }
    setSelectedTextbook(textbook);
    setSelectedChapter(null);
    setSelectedSubchapter(null);
    ctxSetTextbook(textbook);
    ctxSetChapter(null);
    ctxSetSubchapter(null);
  };

  const toggleChapter = async (chapter: Chapter) => {
    const isExpanded = expandedChapters.has(chapter.id);
    if (isExpanded) {
      setExpandedChapters(prev => { const s = new Set(prev); s.delete(chapter.id); return s; });
    } else {
      setExpandedChapters(prev => new Set([...prev, chapter.id]));
      if (!subchapters[chapter.id]) await fetchSubchapters(chapter.id);
    }
    setSelectedChapter(chapter);
    setSelectedSubchapter(null);
    ctxSetChapter(chapter);
    ctxSetSubchapter(null);
  };

  const selectSubchapter = (subchapter: Subchapter) => {
    setSelectedSubchapter(subchapter);
    ctxSetSubchapter(subchapter);
  };

  const handleCreateTextbook = async () => {
    const { data, error } = await supabase
      .from('textbooks')
      .insert({ ...textbookForm, created_by: profile?.id })
      .select()
      .single();
    if (error) {
      toast({ title: '오류', description: '교재 생성에 실패했습니다.', variant: 'destructive' });
      return;
    }
    toast({ title: '성공', description: '교재가 생성되었습니다.' });
    setTextbookForm({ name: '', grade: '', semester: '', description: '' });
    setIsTextbookDialogOpen(false);
    await fetchTextbooks();
    if (data) {
      setExpandedTextbooks(prev => new Set([...prev, data.id]));
      setSelectedTextbook(data);
      ctxSetTextbook(data);
    }
  };

  const handleCreateChapter = async () => {
    if (!selectedTextbook) return;
    const { data, error } = await supabase
      .from('chapters')
      .insert({ ...chapterForm, textbook_id: selectedTextbook.id })
      .select()
      .single();
    if (error) {
      toast({ title: '오류', description: '대단원 생성에 실패했습니다.', variant: 'destructive' });
      return;
    }
    toast({ title: '성공', description: '대단원이 생성되었습니다.' });
    setChapterForm({ name: '', description: '', sort_order: 1 });
    setIsChapterDialogOpen(false);
    await fetchChapters(selectedTextbook.id);
    if (data) {
      setExpandedChapters(prev => new Set([...prev, data.id]));
      setSelectedChapter(data);
      ctxSetChapter(data);
    }
  };

  const handleCreateSubchapter = async () => {
    if (!selectedChapter) return;
    const { data, error } = await supabase
      .from('subchapters')
      .insert({ ...subchapterForm, chapter_id: selectedChapter.id })
      .select()
      .single();
    if (error) {
      toast({ title: '오류', description: '중단원 생성에 실패했습니다.', variant: 'destructive' });
      return;
    }
    toast({ title: '성공', description: '중단원이 생성되었습니다.' });
    setSubchapterForm({ name: '', description: '', sort_order: 1 });
    setIsSubchapterDialogOpen(false);
    await fetchSubchapters(selectedChapter.id);
    if (data) {
      setSelectedSubchapter(data);
      ctxSetSubchapter(data);
    }
  };

  const handleDeleteProblem = async (problemId: string) => {
    if (!confirm('정말로 이 문제를 삭제하시겠습니까?')) return;
    const { error } = await supabase
      .from('problems')
      .delete()
      .eq('id', problemId)
      .eq('teacher_id', profile?.id);
    if (error) {
      toast({ title: '오류', description: '문제 삭제에 실패했습니다.', variant: 'destructive' });
      return;
    }
    setProblems(prev => prev.filter(p => p.id !== problemId));
  };

  const filteredProblems = searchTerm
    ? problems.filter(p =>
        p.title?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        String(p.problem_number).includes(searchTerm)
      )
    : problems;

  // 현재 선택 경로
  const breadcrumb = [selectedTextbook?.name, selectedChapter?.name, selectedSubchapter?.name]
    .filter(Boolean).join(' > ');

  return (
    <>
    <div className="flex h-[calc(100vh-57px)]">
      {/* 사이드바: 교재 트리 */}
      <div className="w-72 border-r bg-card flex flex-col flex-shrink-0">
        <div className="p-4 border-b flex items-center justify-between">
          <span className="text-sm font-semibold text-muted-foreground">교재</span>
          <Button size="sm" variant="ghost" onClick={() => setIsTextbookDialogOpen(true)}>
            <Plus className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto py-2">
          {textbooks.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              <BookOpen className="h-8 w-8 mx-auto mb-2 opacity-40" />
              <p>등록된 교재가 없습니다</p>
              <Button size="sm" variant="outline" className="mt-3" onClick={() => setIsTextbookDialogOpen(true)}>
                <Plus className="h-3 w-3 mr-1" />새 교재
              </Button>
            </div>
          ) : (
            textbooks.map(textbook => {
              const isExpanded = expandedTextbooks.has(textbook.id);
              const isSelected = selectedTextbook?.id === textbook.id;
              const textbookChapters = chapters[textbook.id] ?? [];

              return (
                <div key={textbook.id}>
                  {/* 교재 행 */}
                  <div
                    className={`flex items-center gap-1 px-3 py-2 cursor-pointer hover:bg-muted/50 transition-colors group ${isSelected && !selectedChapter ? 'bg-primary/10 text-primary' : ''}`}
                    onClick={() => toggleTextbook(textbook)}
                  >
                    {isExpanded ? (
                      <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                    )}
                    <BookOpen className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                    <span className="text-sm truncate flex-1">{textbook.name}</span>
                    <span className="text-xs text-muted-foreground opacity-0 group-hover:opacity-100">
                      {textbook.grade?.replace('학교 ', '')}
                    </span>
                  </div>

                  {/* 대단원 목록 */}
                  {isExpanded && (
                    <div>
                      {textbookChapters.map(chapter => {
                        const isChapterExpanded = expandedChapters.has(chapter.id);
                        const isChapterSelected = selectedChapter?.id === chapter.id;
                        const chapterSubchapters = subchapters[chapter.id] ?? [];

                        return (
                          <div key={chapter.id}>
                            <div
                              className={`flex items-center gap-1 pl-7 pr-3 py-1.5 cursor-pointer hover:bg-muted/50 transition-colors group ${isChapterSelected && !selectedSubchapter ? 'bg-primary/10 text-primary' : ''}`}
                              onClick={() => toggleChapter(chapter)}
                            >
                              {isChapterExpanded ? (
                                <ChevronDown className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
                              ) : (
                                <ChevronRight className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
                              )}
                              <FolderOpen className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
                              <span className="text-sm truncate flex-1">{chapter.name}</span>
                            </div>

                            {/* 중단원 목록 */}
                            {isChapterExpanded && (
                              <div>
                                {chapterSubchapters.map(sub => (
                                  <div
                                    key={sub.id}
                                    className={`flex items-center gap-1 pl-14 pr-3 py-1.5 cursor-pointer hover:bg-muted/50 transition-colors text-sm ${selectedSubchapter?.id === sub.id ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground'}`}
                                    onClick={() => selectSubchapter(sub)}
                                  >
                                    <FileText className="h-3 w-3 flex-shrink-0" />
                                    <span className="truncate">{sub.name}</span>
                                  </div>
                                ))}
                                {/* 중단원 추가 */}
                                {isChapterSelected && (
                                  <div
                                    className="flex items-center gap-1 pl-14 pr-3 py-1 cursor-pointer text-muted-foreground hover:text-primary transition-colors"
                                    onClick={() => {
                                      setSubchapterForm({ name: '', description: '', sort_order: chapterSubchapters.length + 1 });
                                      setIsSubchapterDialogOpen(true);
                                    }}
                                  >
                                    <Plus className="h-3 w-3 flex-shrink-0" />
                                    <span className="text-xs">중단원 추가</span>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}

                      {/* 대단원 추가 */}
                      {isSelected && (
                        <div
                          className="flex items-center gap-1 pl-7 pr-3 py-1 cursor-pointer text-muted-foreground hover:text-primary transition-colors"
                          onClick={() => {
                            setChapterForm({ name: '', description: '', sort_order: textbookChapters.length + 1 });
                            setIsChapterDialogOpen(true);
                          }}
                        >
                          <Plus className="h-3 w-3 flex-shrink-0" />
                          <span className="text-xs">대단원 추가</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* 메인 영역: 문제 목록 */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* 메인 헤더 */}
        <div className="px-6 py-4 border-b bg-card flex items-center justify-between flex-shrink-0">
          <div>
            {breadcrumb ? (
              <h2 className="font-semibold text-base">{breadcrumb}</h2>
            ) : (
              <h2 className="font-semibold text-base text-muted-foreground">교재를 선택하세요</h2>
            )}
            {problems.length > 0 && (
              <p className="text-xs text-muted-foreground mt-0.5">문제 {problems.length}개</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {selectedTextbook && (
              <Button variant="outline" size="sm" onClick={() => setIsPdfDialogOpen(true)}>
                <Upload className="h-4 w-4 mr-1.5" />
                PDF 가져오기
              </Button>
            )}
            {(selectedTextbook || selectedChapter || selectedSubchapter) && (
              <Button size="sm" onClick={() => {
                // 선택된 컨텍스트를 query param으로 넘겨 문제 등록 페이지로 이동
                const params = new URLSearchParams();
                if (selectedTextbook) params.set('textbook_id', selectedTextbook.id);
                if (selectedChapter) params.set('chapter_id', selectedChapter.id);
                if (selectedSubchapter) params.set('subchapter_id', selectedSubchapter.id);
                navigate(`/cms/problems/new?${params.toString()}`);
              }}>
                <Plus className="h-4 w-4 mr-1.5" />
                문제 등록
              </Button>
            )}
          </div>
        </div>

        {/* 콘텐츠 */}
        <div className="flex-1 overflow-y-auto p-6">
          {!selectedTextbook ? (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
              <BookOpen className="h-16 w-16 mb-4 opacity-20" />
              <p className="text-lg font-medium">교재를 선택하세요</p>
              <p className="text-sm mt-1">왼쪽 사이드바에서 교재를 선택하거나 새 교재를 만드세요</p>
            </div>
          ) : (
            <>
              {/* 검색 */}
              {problems.length > 0 && (
                <div className="relative mb-4">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    className="pl-9"
                    placeholder="문제 번호 또는 제목 검색..."
                    value={searchTerm}
                    onChange={e => setSearchTerm(e.target.value)}
                  />
                </div>
              )}

              {/* 문제 목록 */}
              {problemsLoading ? (
                <div className="flex items-center justify-center py-16">
                  <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
                </div>
              ) : filteredProblems.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                  <FileText className="h-12 w-12 mb-4 opacity-20" />
                  <p className="font-medium">등록된 문제가 없습니다</p>
                  <p className="text-sm mt-1 mb-4">
                    {selectedSubchapter
                      ? `'${selectedSubchapter.name}'에`
                      : selectedChapter
                      ? `'${selectedChapter.name}'에`
                      : `'${selectedTextbook.name}'에`} 문제를 추가해보세요
                  </p>
                  <Button size="sm" onClick={() => {
                    const params = new URLSearchParams();
                    if (selectedTextbook) params.set('textbook_id', selectedTextbook.id);
                    if (selectedChapter) params.set('chapter_id', selectedChapter.id);
                    if (selectedSubchapter) params.set('subchapter_id', selectedSubchapter.id);
                    navigate(`/cms/problems/new?${params.toString()}`);
                  }}>
                    <Plus className="h-4 w-4 mr-1.5" />
                    문제 등록
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  {filteredProblems.map(problem => (
                    <div
                      key={problem.id}
                      className="flex items-center justify-between p-4 border rounded-lg hover:bg-muted/30 transition-colors"
                    >
                      <div className="flex items-center gap-4 min-w-0">
                        <div className="flex-shrink-0 w-10 h-10 bg-muted rounded flex items-center justify-center text-sm font-bold text-muted-foreground">
                          {problem.problem_number || '?'}
                        </div>
                        <div className="min-w-0">
                          <p className="font-medium text-sm truncate">{problem.title}</p>
                          <div className="flex items-center gap-1.5 mt-1">
                            <Badge variant="outline" className={`text-xs ${difficultyColor(problem.difficulty)}`}>
                              {difficultyLabel(problem.difficulty)}
                            </Badge>
                            <Badge variant="outline" className="text-xs">
                              {problem.answer_type === 'multiple_choice' ? '객관식' : '주관식'}
                            </Badge>
                            {problem.image_url && !problem.image_url.includes('placeholder') && (
                              <Badge variant="outline" className="text-xs bg-purple-50 text-purple-700">
                                이미지
                              </Badge>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0 ml-4">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => navigate(`/cms/problems/new?edit=${problem.id}`)}
                        >
                          <Edit className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDeleteProblem(problem.id)}
                          className="text-destructive hover:text-destructive"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>

      {/* 교재 생성 모달 */}
      {isTextbookDialogOpen && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center">
          <div className="fixed inset-0 bg-black/80" onClick={() => setIsTextbookDialogOpen(false)} />
          <div className="relative z-[10000] bg-background border rounded-lg shadow-lg w-full max-w-lg p-6 space-y-4">
            <div>
              <h2 className="text-lg font-semibold">새 교재 생성</h2>
              <p className="text-sm text-muted-foreground">새로운 교재를 등록하세요</p>
            </div>
            <div className="space-y-4">
              <div>
                <Label>교재명 *</Label>
                <Input
                  value={textbookForm.name}
                  onChange={e => setTextbookForm({ ...textbookForm, name: e.target.value })}
                  placeholder="예: 쎈 수학"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>학년 *</Label>
                  <select
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={textbookForm.grade}
                    onChange={e => setTextbookForm({ ...textbookForm, grade: e.target.value })}
                  >
                    <option value="">학년 선택</option>
                    {gradeOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
                <div>
                  <Label>학기 *</Label>
                  <select
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={textbookForm.semester}
                    onChange={e => setTextbookForm({ ...textbookForm, semester: e.target.value })}
                  >
                    <option value="">학기 선택</option>
                    {semesterOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <Label>설명</Label>
                <Textarea
                  value={textbookForm.description}
                  onChange={e => setTextbookForm({ ...textbookForm, description: e.target.value })}
                  placeholder="교재에 대한 설명"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setIsTextbookDialogOpen(false)}>취소</Button>
              <Button
                onClick={handleCreateTextbook}
                disabled={!textbookForm.name || !textbookForm.grade || !textbookForm.semester}
              >
                생성
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 대단원 생성 모달 */}
      {isChapterDialogOpen && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center">
          <div className="fixed inset-0 bg-black/80" onClick={() => setIsChapterDialogOpen(false)} />
          <div className="relative z-[10000] bg-background border rounded-lg shadow-lg w-full max-w-lg p-6 space-y-4">
            <div>
              <h2 className="text-lg font-semibold">새 대단원 생성</h2>
              <p className="text-sm text-muted-foreground">{selectedTextbook?.name}에 새로운 대단원을 추가하세요</p>
            </div>
            <div className="space-y-4">
              <div>
                <Label>대단원명 *</Label>
                <Input
                  value={chapterForm.name}
                  onChange={e => setChapterForm({ ...chapterForm, name: e.target.value })}
                  placeholder="예: 다항식"
                />
              </div>
              <div>
                <Label>설명</Label>
                <Textarea
                  value={chapterForm.description}
                  onChange={e => setChapterForm({ ...chapterForm, description: e.target.value })}
                />
              </div>
              <div>
                <Label>정렬 순서</Label>
                <Input
                  type="number"
                  value={chapterForm.sort_order}
                  onChange={e => setChapterForm({ ...chapterForm, sort_order: parseInt(e.target.value) || 1 })}
                  min="1"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setIsChapterDialogOpen(false)}>취소</Button>
              <Button onClick={handleCreateChapter} disabled={!chapterForm.name}>생성</Button>
            </div>
          </div>
        </div>
      )}

      {/* 중단원 생성 모달 */}
      {isSubchapterDialogOpen && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center">
          <div className="fixed inset-0 bg-black/80" onClick={() => setIsSubchapterDialogOpen(false)} />
          <div className="relative z-[10000] bg-background border rounded-lg shadow-lg w-full max-w-lg p-6 space-y-4">
            <div>
              <h2 className="text-lg font-semibold">새 중단원 생성</h2>
              <p className="text-sm text-muted-foreground">{selectedChapter?.name}에 새로운 중단원을 추가하세요</p>
            </div>
            <div className="space-y-4">
              <div>
                <Label>중단원명 *</Label>
                <Input
                  value={subchapterForm.name}
                  onChange={e => setSubchapterForm({ ...subchapterForm, name: e.target.value })}
                  placeholder="예: 다항식의 연산"
                />
              </div>
              <div>
                <Label>설명</Label>
                <Textarea
                  value={subchapterForm.description}
                  onChange={e => setSubchapterForm({ ...subchapterForm, description: e.target.value })}
                />
              </div>
              <div>
                <Label>정렬 순서</Label>
                <Input
                  type="number"
                  value={subchapterForm.sort_order}
                  onChange={e => setSubchapterForm({ ...subchapterForm, sort_order: parseInt(e.target.value) || 1 })}
                  min="1"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setIsSubchapterDialogOpen(false)}>취소</Button>
              <Button onClick={handleCreateSubchapter} disabled={!subchapterForm.name}>생성</Button>
            </div>
          </div>
        </div>
      )}

      {/* PDF 업로드 다이얼로그 */}
      {selectedTextbook && (
        <PdfUploadDialog
          open={isPdfDialogOpen}
          onOpenChange={setIsPdfDialogOpen}
          textbook={selectedTextbook}
          chapter={selectedChapter}
        />
      )}
    </>
  );
};

export default TextbookManagementNew;
