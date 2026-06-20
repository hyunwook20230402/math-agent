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
  FolderInput,
  Workflow,
} from 'lucide-react';
import { supabase } from '@shared/supabase/client';
import { useTextbook } from '@/context/TextbookContext';
import type { Textbook, Chapter, Subchapter } from '@shared/types/database';
import PdfUploadDialog from '@/components/PdfUploadDialog';
import { SolutionNodeEditorModal } from '@/components/SolutionNodeEditorModal';

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
  difficulty_score: number;
  difficulty: string;
  answer_type: string;
  image_url: string;
  category: string;
  unit: string;
  correct_answer: string;
  chapter_id: string | null;
  created_at: string;
}

const difficultyLabel = (score: number) => {
  if (score <= 2) return `아주 쉬움 · ${score}/10`;
  if (score <= 4) return `쉬움 · ${score}/10`;
  if (score <= 6) return `보통 · ${score}/10`;
  if (score <= 8) return `어려움 · ${score}/10`;
  return `최상위 · ${score}/10`;
};
const difficultyColor = (score: number) => {
  if (score <= 2) return 'bg-green-100 text-green-800';
  if (score <= 4) return 'bg-blue-100 text-blue-800';
  if (score <= 6) return 'bg-yellow-100 text-yellow-800';
  if (score <= 8) return 'bg-orange-100 text-orange-800';
  return 'bg-red-100 text-red-800';
};

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

  const [textbooks, setTextbooks] = useState<Textbook[]>([]);
  const [chapters, setChapters] = useState<Record<string, Chapter[]>>({});
  const [subchapters, setSubchapters] = useState<Record<string, Subchapter[]>>({});
  // 풀이 노드 편집 모달 대상 (problems.id + 제목). null=닫힘.
  const [nodeEditTarget, setNodeEditTarget] = useState<{ id: string; title: string } | null>(null);

  const [selectedTextbook, setSelectedTextbook] = useState<Textbook | null>(ctxTextbook);
  const [selectedChapter, setSelectedChapter] = useState<Chapter | null>(ctxChapter);
  const [selectedSubchapter, setSelectedSubchapter] = useState<Subchapter | null>(ctxSubchapter);

  const [expandedTextbooks, setExpandedTextbooks] = useState<Set<string>>(new Set());
  const [expandedChapters, setExpandedChapters] = useState<Set<string>>(new Set());

  const [problems, setProblems] = useState<Problem[]>([]);
  const [problemsLoading, setProblemsLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');

  // 체크박스 선택 (폴더 이동용)
  const [selectedProblemIds, setSelectedProblemIds] = useState<Set<string>>(new Set());

  // 모달 상태
  const [isTextbookDialogOpen, setIsTextbookDialogOpen] = useState(false);
  const [isChapterDialogOpen, setIsChapterDialogOpen] = useState(false);
  const [isSubchapterDialogOpen, setIsSubchapterDialogOpen] = useState(false);
  const [isPdfDialogOpen, setIsPdfDialogOpen] = useState(false);

  // 삭제 확인 모달
  const [deleteTarget, setDeleteTarget] = useState<{ type: 'textbook' | 'chapter' | 'subchapter'; id: string; name: string } | null>(null);

  // 폴더 이동 모달
  const [isMoveDialogOpen, setIsMoveDialogOpen] = useState(false);
  const [moveTargetChapterId, setMoveTargetChapterId] = useState<string>('');

  const [textbookForm, setTextbookForm] = useState({ name: '', grade: '', semester: '', description: '' });
  const [chapterForm, setChapterForm] = useState({ name: '', description: '', sort_order: 1 });
  const [subchapterForm, setSubchapterForm] = useState({ name: '', description: '', sort_order: 1 });

  // 인라인 리네임
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = React.useRef<HTMLInputElement>(null);

  const startRename = (id: string, currentName: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setRenamingId(id);
    setRenameValue(currentName);
    setTimeout(() => renameInputRef.current?.focus(), 50);
  };

  const cancelRename = () => {
    setRenamingId(null);
    setRenameValue('');
  };

  const commitRename = async (type: 'textbook' | 'chapter' | 'subchapter', id: string) => {
    const name = renameValue.trim();
    if (!name) { cancelRename(); return; }
    const table = type === 'textbook' ? 'textbooks' : type === 'chapter' ? 'chapters' : 'subchapters';
    const { error } = await supabase.from(table).update({ name }).eq('id', id);
    if (error) {
      toast({ title: '오류', description: '이름 변경에 실패했습니다.', variant: 'destructive' });
    } else {
      if (type === 'textbook') {
        setTextbooks(prev => prev.map(t => t.id === id ? { ...t, name } : t));
        if (selectedTextbook?.id === id) { setSelectedTextbook(prev => prev ? { ...prev, name } : prev); ctxSetTextbook({ ...selectedTextbook!, name }); }
      } else if (type === 'chapter') {
        setChapters(prev => {
          const next = { ...prev };
          for (const k of Object.keys(next)) next[k] = next[k].map(c => c.id === id ? { ...c, name } : c);
          return next;
        });
        if (selectedChapter?.id === id) { setSelectedChapter(prev => prev ? { ...prev, name } : prev); ctxSetChapter({ ...selectedChapter!, name }); }
      } else {
        setSubchapters(prev => {
          const next = { ...prev };
          for (const k of Object.keys(next)) next[k] = next[k].map(s => s.id === id ? { ...s, name } : s);
          return next;
        });
        if (selectedSubchapter?.id === id) { setSelectedSubchapter(prev => prev ? { ...prev, name } : prev); ctxSetSubchapter({ ...selectedSubchapter!, name }); }
      }
      toast({ title: '변경 완료', description: `이름이 "${name}"으로 변경되었습니다.` });
    }
    cancelRename();
  };

  useEffect(() => {
    fetchTextbooks();
  }, []);

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

  useEffect(() => {
    if (selectedSubchapter || selectedChapter || selectedTextbook) {
      fetchProblems();
    } else {
      setProblems([]);
    }
    setSelectedProblemIds(new Set());
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
        // 교재 루트: 폴더에 속하지 않은 문제만 표시
        query = query.eq('textbook_id', selectedTextbook.id).is('chapter_id', null);
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
      toast({ title: '오류', description: '폴더 생성에 실패했습니다.', variant: 'destructive' });
      return;
    }
    toast({ title: '성공', description: '폴더가 생성되었습니다.' });
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
      toast({ title: '오류', description: '하위 폴더 생성에 실패했습니다.', variant: 'destructive' });
      return;
    }
    toast({ title: '성공', description: '하위 폴더가 생성되었습니다.' });
    setSubchapterForm({ name: '', description: '', sort_order: 1 });
    setIsSubchapterDialogOpen(false);
    await fetchSubchapters(selectedChapter.id);
    if (data) {
      setSelectedSubchapter(data);
      ctxSetSubchapter(data);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    const { type, id, name } = deleteTarget;

    if (type === 'textbook') {
      const { error } = await supabase.from('textbooks').delete().eq('id', id);
      if (error) {
        toast({ title: '오류', description: '교재 삭제에 실패했습니다.', variant: 'destructive' });
      } else {
        toast({ title: '삭제 완료', description: `"${name}" 교재가 삭제되었습니다.` });
        if (selectedTextbook?.id === id) {
          setSelectedTextbook(null); setSelectedChapter(null); setSelectedSubchapter(null);
          ctxSetTextbook(null); ctxSetChapter(null); ctxSetSubchapter(null);
        }
        await fetchTextbooks();
      }
    } else if (type === 'chapter') {
      const { error } = await supabase.from('chapters').delete().eq('id', id);
      if (error) {
        toast({ title: '오류', description: '폴더 삭제에 실패했습니다.', variant: 'destructive' });
      } else {
        toast({ title: '삭제 완료', description: `"${name}" 폴더가 삭제되었습니다.` });
        if (selectedChapter?.id === id) {
          setSelectedChapter(null); setSelectedSubchapter(null);
          ctxSetChapter(null); ctxSetSubchapter(null);
        }
        if (selectedTextbook) await fetchChapters(selectedTextbook.id);
      }
    } else {
      const { error } = await supabase.from('subchapters').delete().eq('id', id);
      if (error) {
        toast({ title: '오류', description: '하위 폴더 삭제에 실패했습니다.', variant: 'destructive' });
      } else {
        toast({ title: '삭제 완료', description: `"${name}" 하위 폴더가 삭제되었습니다.` });
        if (selectedSubchapter?.id === id) {
          setSelectedSubchapter(null); ctxSetSubchapter(null);
        }
        if (selectedChapter) await fetchSubchapters(selectedChapter.id);
      }
    }
    setDeleteTarget(null);
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

  const handleMoveToFolder = async () => {
    if (selectedProblemIds.size === 0) return;
    const ids = Array.from(selectedProblemIds);
    const updateData = moveTargetChapterId
      ? { chapter_id: moveTargetChapterId }
      : { chapter_id: null };

    const { error } = await supabase
      .from('problems')
      .update(updateData)
      .in('id', ids);

    if (error) {
      toast({ title: '오류', description: '폴더 이동에 실패했습니다.', variant: 'destructive' });
      return;
    }
    toast({ title: '완료', description: `${ids.length}개 문제를 이동했습니다.` });
    setIsMoveDialogOpen(false);
    setSelectedProblemIds(new Set());
    setMoveTargetChapterId('');
    await fetchProblems();
  };

  const toggleProblemSelect = (id: string) => {
    setSelectedProblemIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedProblemIds.size === filteredProblems.length) {
      setSelectedProblemIds(new Set());
    } else {
      setSelectedProblemIds(new Set(filteredProblems.map(p => p.id)));
    }
  };

  const filteredProblems = searchTerm
    ? problems.filter(p =>
        p.title?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        String(p.problem_number).includes(searchTerm)
      )
    : problems;

  const breadcrumb = [selectedTextbook?.name, selectedChapter?.name, selectedSubchapter?.name]
    .filter(Boolean).join(' > ');

  // 현재 교재의 폴더 목록 (이동 모달용)
  const currentChapters = selectedTextbook ? (chapters[selectedTextbook.id] ?? []) : [];

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
                    {renamingId === textbook.id ? (
                      <input
                        ref={renameInputRef}
                        className="text-sm flex-1 border-b border-primary bg-transparent outline-none px-0.5"
                        value={renameValue}
                        onChange={e => setRenameValue(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') commitRename('textbook', textbook.id); if (e.key === 'Escape') cancelRename(); }}
                        onBlur={() => commitRename('textbook', textbook.id)}
                        onClick={e => e.stopPropagation()}
                      />
                    ) : (
                      <>
                        <span className="text-sm truncate flex-1">{textbook.name}</span>
                        <button
                          className="opacity-0 group-hover:opacity-60 hover:!opacity-100 p-0.5 rounded transition-opacity"
                          onClick={e => startRename(textbook.id, textbook.name, e)}
                          title="이름 변경"
                        >
                          <Edit className="h-3 w-3" />
                        </button>
                        <button
                          className="opacity-0 group-hover:opacity-60 hover:!opacity-100 p-0.5 rounded transition-opacity text-destructive"
                          onClick={e => { e.stopPropagation(); setDeleteTarget({ type: 'textbook', id: textbook.id, name: textbook.name }); }}
                          title="삭제"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </>
                    )}
                  </div>

                  {/* 폴더(대단원) 목록 */}
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
                              {renamingId === chapter.id ? (
                                <input
                                  ref={renameInputRef}
                                  className="text-sm flex-1 border-b border-primary bg-transparent outline-none px-0.5"
                                  value={renameValue}
                                  onChange={e => setRenameValue(e.target.value)}
                                  onKeyDown={e => { if (e.key === 'Enter') commitRename('chapter', chapter.id); if (e.key === 'Escape') cancelRename(); }}
                                  onBlur={() => commitRename('chapter', chapter.id)}
                                  onClick={e => e.stopPropagation()}
                                />
                              ) : (
                                <>
                                  <span className="text-sm truncate flex-1">{chapter.name}</span>
                                  <button
                                    className="opacity-0 group-hover:opacity-60 hover:!opacity-100 p-0.5 rounded transition-opacity"
                                    onClick={e => startRename(chapter.id, chapter.name, e)}
                                    title="이름 변경"
                                  >
                                    <Edit className="h-3 w-3" />
                                  </button>
                                  <button
                                    className="opacity-0 group-hover:opacity-60 hover:!opacity-100 p-0.5 rounded transition-opacity text-destructive"
                                    onClick={e => { e.stopPropagation(); setDeleteTarget({ type: 'chapter', id: chapter.id, name: chapter.name }); }}
                                    title="삭제"
                                  >
                                    <Trash2 className="h-3 w-3" />
                                  </button>
                                </>
                              )}
                            </div>

                            {/* 하위 폴더(중단원) 목록 */}
                            {isChapterExpanded && (
                              <div>
                                {chapterSubchapters.map(sub => (
                                  <div
                                    key={sub.id}
                                    className={`flex items-center gap-1 pl-14 pr-3 py-1.5 cursor-pointer hover:bg-muted/50 transition-colors text-sm group ${selectedSubchapter?.id === sub.id ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground'}`}
                                    onClick={() => selectSubchapter(sub)}
                                  >
                                    <FileText className="h-3 w-3 flex-shrink-0" />
                                    {renamingId === sub.id ? (
                                      <input
                                        ref={renameInputRef}
                                        className="text-sm flex-1 border-b border-primary bg-transparent outline-none px-0.5"
                                        value={renameValue}
                                        onChange={e => setRenameValue(e.target.value)}
                                        onKeyDown={e => { if (e.key === 'Enter') commitRename('subchapter', sub.id); if (e.key === 'Escape') cancelRename(); }}
                                        onBlur={() => commitRename('subchapter', sub.id)}
                                        onClick={e => e.stopPropagation()}
                                      />
                                    ) : (
                                      <>
                                        <span className="truncate flex-1">{sub.name}</span>
                                        <button
                                          className="opacity-0 group-hover:opacity-60 hover:!opacity-100 p-0.5 rounded transition-opacity"
                                          onClick={e => startRename(sub.id, sub.name, e)}
                                          title="이름 변경"
                                        >
                                          <Edit className="h-3 w-3" />
                                        </button>
                                        <button
                                          className="opacity-0 group-hover:opacity-60 hover:!opacity-100 p-0.5 rounded transition-opacity text-destructive"
                                          onClick={e => { e.stopPropagation(); setDeleteTarget({ type: 'subchapter', id: sub.id, name: sub.name }); }}
                                          title="삭제"
                                        >
                                          <Trash2 className="h-3 w-3" />
                                        </button>
                                      </>
                                    )}
                                  </div>
                                ))}
                                {/* 하위 폴더 추가 */}
                                {isChapterSelected && (
                                  <div
                                    className="flex items-center gap-1 pl-14 pr-3 py-1 cursor-pointer text-muted-foreground hover:text-primary transition-colors"
                                    onClick={() => {
                                      setSubchapterForm({ name: '', description: '', sort_order: chapterSubchapters.length + 1 });
                                      setIsSubchapterDialogOpen(true);
                                    }}
                                  >
                                    <Plus className="h-3 w-3 flex-shrink-0" />
                                    <span className="text-xs">하위 폴더 추가</span>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}

                      {/* 폴더 추가 */}
                      {isSelected && (
                        <div
                          className="flex items-center gap-1 pl-7 pr-3 py-1 cursor-pointer text-muted-foreground hover:text-primary transition-colors"
                          onClick={() => {
                            setChapterForm({ name: '', description: '', sort_order: textbookChapters.length + 1 });
                            setIsChapterDialogOpen(true);
                          }}
                        >
                          <Plus className="h-3 w-3 flex-shrink-0" />
                          <span className="text-xs">폴더 추가</span>
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
            {selectedProblemIds.size > 0 && selectedTextbook && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => { setMoveTargetChapterId(''); setIsMoveDialogOpen(true); }}
              >
                <FolderInput className="h-4 w-4 mr-1.5" />
                폴더 이동 ({selectedProblemIds.size})
              </Button>
            )}
            {(selectedTextbook || selectedChapter || selectedSubchapter) && (
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
                  {/* 전체 선택 헤더 */}
                  <div className="flex items-center gap-2 px-1 pb-1">
                    <input
                      type="checkbox"
                      className="h-4 w-4 cursor-pointer"
                      checked={filteredProblems.length > 0 && selectedProblemIds.size === filteredProblems.length}
                      onChange={toggleSelectAll}
                    />
                    <span className="text-xs text-muted-foreground">
                      {selectedProblemIds.size > 0 ? `${selectedProblemIds.size}개 선택됨` : '전체 선택'}
                    </span>
                  </div>

                  {filteredProblems.map(problem => (
                    <div
                      key={problem.id}
                      className={`flex items-center justify-between p-4 border rounded-lg hover:bg-muted/30 transition-colors ${selectedProblemIds.has(problem.id) ? 'border-primary bg-primary/5' : ''}`}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <input
                          type="checkbox"
                          className="h-4 w-4 cursor-pointer flex-shrink-0"
                          checked={selectedProblemIds.has(problem.id)}
                          onChange={() => toggleProblemSelect(problem.id)}
                        />
                        <div className="flex-shrink-0 w-10 h-10 bg-muted rounded flex items-center justify-center text-sm font-bold text-muted-foreground">
                          {problem.problem_number || '?'}
                        </div>
                        <div className="min-w-0">
                          <p className="font-medium text-sm truncate">{problem.title}</p>
                          <div className="flex items-center gap-1.5 mt-1">
                            <Badge variant="outline" className={`text-xs ${difficultyColor(problem.difficulty_score ?? 5)}`}>
                              {difficultyLabel(problem.difficulty_score ?? 5)}
                            </Badge>
                            <Badge variant="outline" className="text-xs">
                              {problem.answer_type === 'multiple_choice' ? '객관식' : '주관식'}
                            </Badge>
                            {problem.chapter_id && (
                              <Badge variant="outline" className="text-xs bg-blue-50 text-blue-700">
                                폴더
                              </Badge>
                            )}
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
                          title="풀이 노드 편집"
                          onClick={() => setNodeEditTarget({ id: problem.id, title: problem.title })}
                        >
                          <Workflow className="h-3.5 w-3.5" />
                        </Button>
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

      {/* 폴더 생성 모달 */}
      {isChapterDialogOpen && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center">
          <div className="fixed inset-0 bg-black/80" onClick={() => setIsChapterDialogOpen(false)} />
          <div className="relative z-[10000] bg-background border rounded-lg shadow-lg w-full max-w-lg p-6 space-y-4">
            <div>
              <h2 className="text-lg font-semibold">새 폴더 생성</h2>
              <p className="text-sm text-muted-foreground">{selectedTextbook?.name}에 새로운 폴더를 추가하세요</p>
            </div>
            <div className="space-y-4">
              <div>
                <Label>폴더명 *</Label>
                <Input
                  value={chapterForm.name}
                  onChange={e => setChapterForm({ ...chapterForm, name: e.target.value })}
                  placeholder="예: 평가원 6월 25년"
                  autoFocus
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

      {/* 하위 폴더 생성 모달 */}
      {isSubchapterDialogOpen && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center">
          <div className="fixed inset-0 bg-black/80" onClick={() => setIsSubchapterDialogOpen(false)} />
          <div className="relative z-[10000] bg-background border rounded-lg shadow-lg w-full max-w-lg p-6 space-y-4">
            <div>
              <h2 className="text-lg font-semibold">새 하위 폴더 생성</h2>
              <p className="text-sm text-muted-foreground">{selectedChapter?.name} 안에 추가합니다</p>
            </div>
            <div className="space-y-4">
              <div>
                <Label>하위 폴더명 *</Label>
                <Input
                  value={subchapterForm.name}
                  onChange={e => setSubchapterForm({ ...subchapterForm, name: e.target.value })}
                  placeholder="예: 1~10번"
                  autoFocus
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

      {/* 삭제 확인 모달 */}
      {deleteTarget && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center">
          <div className="fixed inset-0 bg-black/80" onClick={() => setDeleteTarget(null)} />
          <div className="relative z-[10000] bg-background border rounded-lg shadow-lg w-full max-w-md p-6 space-y-4">
            <div>
              <h2 className="text-lg font-semibold text-destructive">삭제 확인</h2>
              <p className="text-sm text-muted-foreground mt-1">
                <span className="font-medium text-foreground">"{deleteTarget.name}"</span>을 삭제하시겠습니까?
              </p>
              {deleteTarget.type !== 'subchapter' && (
                <p className="text-sm text-destructive mt-2">
                  ⚠️ 하위 폴더와 폴더 내 문제 연결이 모두 해제됩니다. (문제 자체는 삭제되지 않습니다)
                </p>
              )}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setDeleteTarget(null)}>취소</Button>
              <Button variant="destructive" onClick={handleDelete}>삭제</Button>
            </div>
          </div>
        </div>
      )}

      {/* 폴더 이동 모달 */}
      {isMoveDialogOpen && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center">
          <div className="fixed inset-0 bg-black/80" onClick={() => setIsMoveDialogOpen(false)} />
          <div className="relative z-[10000] bg-background border rounded-lg shadow-lg w-full max-w-md p-6 space-y-4">
            <div>
              <h2 className="text-lg font-semibold">폴더로 이동</h2>
              <p className="text-sm text-muted-foreground">
                선택된 {selectedProblemIds.size}개 문제를 이동할 폴더를 선택하세요
              </p>
            </div>
            <div>
              <Label>폴더 선택</Label>
              <select
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm mt-1"
                value={moveTargetChapterId}
                onChange={e => setMoveTargetChapterId(e.target.value)}
              >
                <option value="">(폴더 없음)</option>
                {currentChapters.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              {currentChapters.length === 0 && (
                <p className="text-xs text-muted-foreground mt-1">
                  먼저 사이드바에서 폴더를 생성하세요
                </p>
              )}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setIsMoveDialogOpen(false)}>취소</Button>
              <Button onClick={handleMoveToFolder}>이동</Button>
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

      {nodeEditTarget && (
        <SolutionNodeEditorModal
          problemId={nodeEditTarget.id}
          problemTitle={nodeEditTarget.title}
          onClose={() => setNodeEditTarget(null)}
        />
      )}
    </>
  );
};

export default TextbookManagementNew;
