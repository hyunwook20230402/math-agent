import React, { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
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
import { formatDifficultyScore, getDifficultyColor } from '@shared/lib/utils';
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
  chapter_id: string | null;   // 옛 구조(보존)
  folder_id: string | null;
  created_at: string;
}

// 난이도 표기/색상은 공통 유틸(4단계 Lv1~4)로 통일. 옛 1~10 데이터는 Lv4 로 흡수됨.
const difficultyLabel = formatDifficultyScore;
const difficultyColor = getDifficultyColor;

const TextbookManagementNew = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { profile } = useAuth();
  const {
    selectedTextbook: ctxTextbook,
    selectedFolder: ctxFolder,
    setTextbook: ctxSetTextbook,
    setFolder: ctxSetFolder,
  } = useTextbook();

  const [textbooks, setTextbooks] = useState<Textbook[]>([]);
  // 교재별 폴더 **평면 목록**(모든 깊이). 트리는 parent_id 로 화면에서 조립한다.
  // 깊이별로 따로 불러오던 옛 방식(chapters→subchapters)은 깊이가 늘면 감당이 안 된다.
  const [folders, setFolders] = useState<Record<string, ProblemFolder[]>>({});
  // 풀이 노드 편집 모달 대상 (problems.id + 제목). null=닫힘.
  const [nodeEditTarget, setNodeEditTarget] = useState<{ id: string; title: string } | null>(null);

  const [selectedTextbook, setSelectedTextbook] = useState<Textbook | null>(ctxTextbook);
  const [selectedFolder, setSelectedFolder] = useState<ProblemFolder | null>(ctxFolder);

  const [expandedTextbooks, setExpandedTextbooks] = useState<Set<string>>(new Set());
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());

  const [problems, setProblems] = useState<Problem[]>([]);
  const [problemsLoading, setProblemsLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');

  // 체크박스 선택 (폴더 이동용)
  const [selectedProblemIds, setSelectedProblemIds] = useState<Set<string>>(new Set());

  // 모달 상태
  const [isTextbookDialogOpen, setIsTextbookDialogOpen] = useState(false);
  const [isPdfDialogOpen, setIsPdfDialogOpen] = useState(false);
  // 폴더 생성 모달. parentId=null 이면 교재 바로 아래(최상위), 아니면 그 폴더의 자식.
  // textbookId 를 같이 들고 다닌다 — 선택 안 된 교재에서도 '폴더 추가' 를 누를 수 있는데,
  // 선택된 교재를 보고 만들면 엉뚱한 교재 밑에 폴더가 생긴다.
  const [folderDialog, setFolderDialog] = useState<
    { textbookId: string; parentId: string | null; parentName: string } | null
  >(null);

  // 삭제 확인 모달
  const [deleteTarget, setDeleteTarget] = useState<{ type: 'textbook' | 'folder'; id: string; name: string } | null>(null);

  // 폴더 이동 모달. '' = 교재 루트(폴더 없음), 그 외는 폴더 id.
  const [isMoveDialogOpen, setIsMoveDialogOpen] = useState(false);
  const [moveTarget, setMoveTarget] = useState<string>('');

  const [textbookForm, setTextbookForm] = useState({ name: '', grade: '', semester: '', description: '' });
  const [folderForm, setFolderForm] = useState({ name: '', description: '', sort_order: 1 });

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

  const commitRename = async (type: 'textbook' | 'folder', id: string) => {
    const name = renameValue.trim();
    if (!name) { cancelRename(); return; }
    const table = type === 'textbook' ? 'textbooks' : 'problem_folders';
    const { error } = await supabase.from(table).update({ name }).eq('id', id);
    if (error) {
      toast({ title: '오류', description: '이름 변경에 실패했습니다.', variant: 'destructive' });
    } else {
      if (type === 'textbook') {
        setTextbooks(prev => prev.map(t => t.id === id ? { ...t, name } : t));
        if (selectedTextbook?.id === id) {
          const next = { ...selectedTextbook, name };
          setSelectedTextbook(next); ctxSetTextbook(next);
        }
      } else {
        setFolders(prev => {
          const next = { ...prev };
          for (const k of Object.keys(next)) next[k] = next[k].map(f => f.id === id ? { ...f, name } : f);
          return next;
        });
        if (selectedFolder?.id === id) setSelectedFolder({ ...selectedFolder, name });
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
      fetchFolders(ctxTextbook.id);
    }
  }, []);

  useEffect(() => {
    if (selectedFolder || selectedTextbook) {
      fetchProblems();
    } else {
      setProblems([]);
    }
    setSelectedProblemIds(new Set());
  }, [selectedTextbook, selectedFolder, folders]);

  // URL 쿼리로 들어오면 그 교재·폴더를 자동 선택.
  // chapter_id/subchapter_id 는 옛 링크 호환 — 폴더 id 를 그대로 물려받았기에 같은 값이다.
  useEffect(() => {
    const tbId = searchParams.get('textbook_id');
    const fId = searchParams.get('folder_id') || searchParams.get('subchapter_id') || searchParams.get('chapter_id');
    if (!tbId || textbooks.length === 0) return;
    if (selectedTextbook?.id !== tbId) {
      const tb = textbooks.find(t => t.id === tbId);
      if (tb) {
        setSelectedTextbook(tb);
        ctxSetTextbook(tb);
        setExpandedTextbooks(prev => new Set([...prev, tb.id]));
        if (!folders[tbId]) fetchFolders(tbId);
      }
      return;
    }
    if (fId && folders[tbId] && selectedFolder?.id !== fId) {
      const f = folders[tbId].find(x => x.id === fId);
      if (f) selectFolder(f);
    }
  }, [searchParams, textbooks, folders, selectedTextbook, selectedFolder]);

  const fetchTextbooks = async () => {
    const { data, error } = await supabase
      .from('textbooks')
      .select('*')
      .order('name', { ascending: true });
    if (!error && data) setTextbooks(data);
  };

  /** 한 교재의 모든 폴더를 깊이 상관없이 한 번에 가져온다. */
  const fetchFolders = async (textbookId: string): Promise<ProblemFolder[]> => {
    const { data, error } = await supabase
      .from('problem_folders')
      .select('*')
      .eq('textbook_id', textbookId)
      .order('sort_order', { ascending: true });
    if (error || !data) return folders[textbookId] ?? [];
    setFolders(prev => ({ ...prev, [textbookId]: data }));
    return data;
  };

  // ── 폴더 트리 헬퍼 (평면 목록 → 계층) ──────────────────────────
  const folderList = selectedTextbook ? (folders[selectedTextbook.id] ?? []) : [];

  const childrenOf = (list: ProblemFolder[], parentId: string | null) =>
    list.filter(f => f.parent_id === parentId);

  /** 최상위 → 해당 폴더 순서의 조상 경로. 브레드크럼과 컨텍스트에 쓴다. */
  const pathOf = (list: ProblemFolder[], folder: ProblemFolder): ProblemFolder[] => {
    const byId = new Map(list.map(f => [f.id, f]));
    const out: ProblemFolder[] = [];
    let cur: ProblemFolder | undefined = folder;
    while (cur) { out.push(cur); cur = cur.parent_id ? byId.get(cur.parent_id) : undefined; }
    return out.reverse();
  };

  /** 자기 자신 + 모든 하위 폴더 id. 폴더를 고르면 그 아래 문제까지 함께 보여주기 위함. */
  const descendantIds = (list: ProblemFolder[], rootId: string): string[] => {
    const out = [rootId];
    for (let i = 0; i < out.length; i++) {
      for (const f of list) if (f.parent_id === out[i]) out.push(f.id);
    }
    return out;
  };

  /** 트리를 깊이우선으로 훑어 [폴더, 깊이] 목록으로 편다 — 이동 모달 드롭다운용. */
  const flattenTree = (
    list: ProblemFolder[],
    parentId: string | null = null,
    depth = 0,
  ): Array<{ folder: ProblemFolder; depth: number }> =>
    childrenOf(list, parentId).flatMap(f => [
      { folder: f, depth },
      ...flattenTree(list, f.id, depth + 1),
    ]);

  const fetchProblems = async () => {
    if (!profile) return;
    setProblemsLoading(true);
    try {
      let query = supabase
        .from('problems')
        .select('*')
        .eq('teacher_id', profile.id)
        .order('problem_number', { ascending: true });

      if (selectedFolder) {
        // 하위 폴더의 문제까지 함께 보여준다(옛 구조에서 챕터가 서브챕터 것을 포함하던 동작 유지).
        query = query.in('folder_id', descendantIds(folderList, selectedFolder.id));
      } else if (selectedTextbook) {
        // 교재 루트: 폴더에 속하지 않은 문제만
        query = query.eq('textbook_id', selectedTextbook.id).is('folder_id', null);
      }

      const { data, error } = await query;
      if (!error && data) setProblems(data);
    } finally {
      setProblemsLoading(false);
    }
  };

  /** 화살표 전용 — 접기/펼치기만 한다. 폴더 행과 같은 규칙. */
  const toggleTextbookExpand = async (textbook: Textbook, e: React.MouseEvent) => {
    e.stopPropagation();
    if (expandedTextbooks.has(textbook.id)) {
      setExpandedTextbooks(prev => { const s = new Set(prev); s.delete(textbook.id); return s; });
      return;
    }
    setExpandedTextbooks(prev => new Set([...prev, textbook.id]));
    if (!folders[textbook.id]) await fetchFolders(textbook.id);
  };

  /**
   * 교재 행 클릭 — 고르고 펼친다. **접지 않는다.**
   * 옛 동작(클릭=토글)은 이미 펼쳐진 교재를 고르려고 누르면 접혀 버려서,
   * 그 아래 '폴더 추가' 가 같이 사라졌다("고3 모의고사는 왜 폴더 추가가 안 되냐"의 정체).
   */
  const selectTextbook = async (textbook: Textbook) => {
    setExpandedTextbooks(prev => new Set([...prev, textbook.id]));
    if (!folders[textbook.id]) await fetchFolders(textbook.id);
    setSelectedTextbook(textbook);
    setSelectedFolder(null);
    ctxSetTextbook(textbook);
    ctxSetFolder(null);
  };

  const selectFolder = (folder: ProblemFolder, listOverride?: ProblemFolder[]) => {
    const list = listOverride ?? folders[folder.textbook_id] ?? folderList;
    // 폴더를 고르면 그 폴더가 속한 교재도 같이 고른다.
    // 화살표로 펼치기만 하고(선택 안 함) 안쪽 폴더를 누르면 selectedTextbook 이 비어 있어
    // 본문이 "교재를 선택하세요" 로 남는다 — 헤더엔 문제 수가 뜨는데 목록은 안 나온다.
    if (selectedTextbook?.id !== folder.textbook_id) {
      const owner = textbooks.find(t => t.id === folder.textbook_id);
      if (owner) {
        setSelectedTextbook(owner);
        ctxSetTextbook(owner);
        setExpandedTextbooks(prev => new Set([...prev, owner.id]));
      }
    }
    setSelectedFolder(folder);
    ctxSetFolder(folder, pathOf(list, folder));
    // 고르면 펼쳐준다 — 안 그러면 하위 폴더를 보려고 화살표를 따로 눌러야 해서 불편하다.
    // 조상들도 같이 펼쳐 트리에서 현재 위치가 보이게 한다.
    setExpandedFolders(prev => new Set([...prev, ...pathOf(list, folder).map(f => f.id)]));
  };

  /** 접기/펴기는 선택과 분리 — 깊은 트리에서 화살표만 눌러 훑어볼 수 있어야 한다. */
  const toggleFolderExpand = (folderId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setExpandedFolders(prev => {
      const s = new Set(prev);
      if (s.has(folderId)) s.delete(folderId); else s.add(folderId);
      return s;
    });
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

  /** 깊이 상관없이 폴더를 만든다. parentId=null 이면 교재 바로 아래. */
  const handleCreateFolder = async () => {
    if (!folderDialog) return;
    const { textbookId, parentId } = folderDialog;
    const { data, error } = await supabase
      .from('problem_folders')
      .insert({
        name: folderForm.name,
        description: folderForm.description,
        sort_order: folderForm.sort_order,
        textbook_id: textbookId,
        parent_id: parentId,
      })
      .select()
      .single();
    if (error) {
      const dup = (error as { code?: string }).code === '23505';
      toast({
        title: '오류',
        description: dup ? '같은 위치에 같은 이름의 폴더가 이미 있습니다.' : '폴더 생성에 실패했습니다.',
        variant: 'destructive',
      });
      return;
    }
    toast({ title: '성공', description: '폴더가 생성되었습니다.' });
    setFolderForm({ name: '', description: '', sort_order: 1 });
    setFolderDialog(null);
    const list = await fetchFolders(textbookId);
    if (data) {
      const owner = textbooks.find(t => t.id === textbookId);
      if (owner && selectedTextbook?.id !== textbookId) {
        setSelectedTextbook(owner);
        ctxSetTextbook(owner);
        setExpandedTextbooks(prev => new Set([...prev, textbookId]));
      }
      if (parentId) setExpandedFolders(prev => new Set([...prev, parentId]));
      selectFolder(data, list);
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
          setSelectedTextbook(null); setSelectedFolder(null);
          ctxSetTextbook(null); ctxSetFolder(null);
        }
        await fetchTextbooks();
      }
    } else {
      // DB 가 ON DELETE CASCADE 라 하위 폴더도 같이 사라진다.
      // 문제는 지워지지 않고 folder_id 가 NULL 이 되어 교재 루트로 돌아간다(ON DELETE SET NULL).
      const doomed = descendantIds(folderList, id);
      const { error } = await supabase.from('problem_folders').delete().eq('id', id);
      if (error) {
        toast({ title: '오류', description: '폴더 삭제에 실패했습니다.', variant: 'destructive' });
      } else {
        toast({ title: '삭제 완료', description: `"${name}" 폴더가 삭제되었습니다.` });
        if (selectedFolder && doomed.includes(selectedFolder.id)) {
          setSelectedFolder(null); ctxSetFolder(null);
        }
        if (selectedTextbook) await fetchFolders(selectedTextbook.id);
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

  const openMoveDialog = () => {
    // 폴더는 교재 단위로 통째로 들고 있어 따로 더 불러올 게 없다.
    setMoveTarget('');
    setIsMoveDialogOpen(true);
  };

  const handleMoveToFolder = async () => {
    if (selectedProblemIds.size === 0) return;
    const ids = Array.from(selectedProblemIds);
    // 폴더가 한 컬럼(folder_id)으로 통합돼 깊이에 상관없이 이 한 줄이면 된다.
    // 다만 **교재도 같이 맞춘다** — 옮긴 폴더가 다른 교재 소속이면 folder_id 만 바꿔서는
    // textbook_id 가 옛 교재를 가리킨 채 남아, 브레드크럼이 엉뚱한 교재를 띄운다
    // (실측: 쎈 120문제가 folder=쎈 / textbook=내신 기출 로 어긋나 있었다).
    const target = moveTarget
      ? Object.values(folders).flat().find(f => f.id === moveTarget)
      : null;
    const patch: { folder_id: string | null; textbook_id?: string } = {
      folder_id: moveTarget || null,
    };
    if (target) patch.textbook_id = target.textbook_id;

    const { error } = await supabase
      .from('problems')
      .update(patch)
      .in('id', ids);

    if (error) {
      toast({ title: '오류', description: '폴더 이동에 실패했습니다.', variant: 'destructive' });
      return;
    }
    toast({ title: '완료', description: `${ids.length}개 문제를 이동했습니다.` });
    setIsMoveDialogOpen(false);
    setSelectedProblemIds(new Set());
    setMoveTarget('');
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

  const breadcrumb = [
    selectedTextbook?.name,
    ...(selectedFolder ? pathOf(folderList, selectedFolder).map(f => f.name) : []),
  ].filter(Boolean).join(' > ');

  // ── 폴더 이동 ────────────────────────────────────────────────
  // 드래그로 옮기거나, 폴더 행의 '이동' 버튼으로 목록에서 골라 옮긴다.
  // 자기 하위로 옮기는 순환은 DB 트리거가 막지만, 화면에서도 미리 걸러 안내한다.
  const [draggingFolderId, setDraggingFolderId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [folderMoveTarget, setFolderMoveTarget] = useState<ProblemFolder | null>(null);
  const [folderMoveParent, setFolderMoveParent] = useState<string>('');

  /** 자기 자신과 자기 하위 폴더는 부모가 될 수 없다(순환). */
  const canBeParent = (list: ProblemFolder[], moving: ProblemFolder, candidateId: string | null) => {
    if (candidateId === null) return moving.parent_id !== null;
    if (candidateId === moving.id) return false;
    if (candidateId === moving.parent_id) return false;
    return !descendantIds(list, moving.id).includes(candidateId);
  };

  const moveFolder = async (folder: ProblemFolder, newParentId: string | null) => {
    if (!canBeParent(folderList, folder, newParentId)) return;
    const { error } = await supabase
      .from('problem_folders')
      .update({ parent_id: newParentId })
      .eq('id', folder.id);
    if (error) {
      // DB 트리거가 순환을 막았거나 같은 위치에 동명 폴더가 있는 경우.
      const dup = (error as { code?: string }).code === '23505';
      toast({
        title: '오류',
        description: dup ? '옮기려는 위치에 같은 이름의 폴더가 이미 있습니다.' : '폴더를 옮기지 못했습니다.',
        variant: 'destructive',
      });
      return;
    }
    const parentName = newParentId
      ? (folderList.find(f => f.id === newParentId)?.name ?? '상위 폴더')
      : (selectedTextbook?.name ?? '교재');
    toast({ title: '이동 완료', description: `'${folder.name}'을(를) ${parentName} 아래로 옮겼습니다.` });
    if (selectedTextbook) await fetchFolders(selectedTextbook.id);
    if (newParentId) setExpandedFolders(prev => new Set([...prev, newParentId]));
  };

  const handleFolderDrop = async (targetId: string | null) => {
    const moving = folderList.find(f => f.id === draggingFolderId);
    setDraggingFolderId(null);
    setDropTargetId(null);
    if (!moving) return;
    if (!canBeParent(folderList, moving, targetId)) {
      if (targetId && descendantIds(folderList, moving.id).includes(targetId)) {
        toast({ title: '이동 불가', description: '폴더를 자기 하위 폴더 아래로 옮길 수 없습니다.', variant: 'destructive' });
      }
      return;
    }
    await moveFolder(moving, targetId);
  };

  /**
   * 폴더 한 줄 + 그 아래 자식들을 재귀로 그린다.
   * 깊이가 늘어도 코드가 안 늘어난다 — 옛 구조는 1단계/2단계를 각각 따로 그려서
   * 3단계를 만들려면 같은 JSX 를 또 복사해야 했다.
   */
  const renderFolderRow = (
    folder: ProblemFolder,
    list: ProblemFolder[],
    depth: number,
  ): React.ReactNode => {
    const kids = childrenOf(list, folder.id);
    const isOpen = expandedFolders.has(folder.id);
    const isSel = selectedFolder?.id === folder.id;
    const indent = { paddingLeft: `${depth * 14 + 12}px` };

    return (
      <div key={folder.id}>
        <div
          style={indent}
          draggable
          onDragStart={e => { e.stopPropagation(); setDraggingFolderId(folder.id); }}
          onDragEnd={() => { setDraggingFolderId(null); setDropTargetId(null); }}
          onDragOver={e => {
            if (!draggingFolderId || draggingFolderId === folder.id) return;
            e.preventDefault(); e.stopPropagation();
            setDropTargetId(folder.id);
          }}
          onDragLeave={e => { e.stopPropagation(); setDropTargetId(prev => prev === folder.id ? null : prev); }}
          onDrop={e => { e.preventDefault(); e.stopPropagation(); handleFolderDrop(folder.id); }}
          className={`flex items-center gap-1 pr-3 py-1.5 cursor-pointer hover:bg-muted/50 transition-colors group ${isSel ? 'bg-primary/10 text-primary font-medium' : ''} ${dropTargetId === folder.id ? 'ring-2 ring-primary ring-inset bg-primary/5' : ''} ${draggingFolderId === folder.id ? 'opacity-40' : ''}`}
          onClick={() => selectFolder(folder)}
          title="끌어서 다른 폴더 위에 놓으면 그 아래로 옮겨집니다"
        >
          {kids.length > 0 ? (
            <button
              className="p-0 flex-shrink-0 text-muted-foreground"
              onClick={e => toggleFolderExpand(folder.id, e)}
              title={isOpen ? '접기' : '펼치기'}
            >
              {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            </button>
          ) : (
            <span className="w-3 flex-shrink-0" />
          )}
          <FolderOpen className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
          {renamingId === folder.id ? (
            <input
              ref={renameInputRef}
              className="text-sm flex-1 border-b border-primary bg-transparent outline-none px-0.5"
              value={renameValue}
              onChange={e => setRenameValue(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') commitRename('folder', folder.id); if (e.key === 'Escape') cancelRename(); }}
              onBlur={() => commitRename('folder', folder.id)}
              onClick={e => e.stopPropagation()}
            />
          ) : (
            <>
              <span className="text-sm truncate flex-1">{folder.name}</span>
              <button
                className="opacity-0 group-hover:opacity-60 hover:!opacity-100 p-0.5 rounded transition-opacity"
                onClick={e => { e.stopPropagation(); setFolderMoveTarget(folder); setFolderMoveParent(folder.parent_id ?? ''); }}
                title="폴더 옮기기"
              >
                <FolderInput className="h-3 w-3" />
              </button>
              <button
                className="opacity-0 group-hover:opacity-60 hover:!opacity-100 p-0.5 rounded transition-opacity"
                onClick={e => startRename(folder.id, folder.name, e)}
                title="이름 변경"
              >
                <Edit className="h-3 w-3" />
              </button>
              <button
                className="opacity-0 group-hover:opacity-60 hover:!opacity-100 p-0.5 rounded transition-opacity text-destructive"
                onClick={e => { e.stopPropagation(); setDeleteTarget({ type: 'folder', id: folder.id, name: folder.name }); }}
                title="삭제"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </>
          )}
        </div>

        {isOpen && kids.map(k => renderFolderRow(k, list, depth + 1))}

        {/* 선택된 폴더에는 두 가지 추가 방식을 다 띄운다.
            '하위'만 있으면 2026년 옆에 2025년을 못 만들고 2026년 안으로 들어가 버린다. */}
        {isSel && (
          <>
            <div
              style={{ paddingLeft: `${(depth + 1) * 14 + 12}px` }}
              className="flex items-center gap-1 pr-3 py-1 cursor-pointer text-muted-foreground hover:text-primary transition-colors"
              onClick={e => {
                e.stopPropagation();
                setFolderForm({ name: '', description: '', sort_order: kids.length + 1 });
                setFolderDialog({ textbookId: folder.textbook_id, parentId: folder.id, parentName: folder.name });
              }}
            >
              <Plus className="h-3 w-3 flex-shrink-0" />
              <span className="text-xs">하위 폴더 추가</span>
            </div>
            <div
              style={{ paddingLeft: `${depth * 14 + 12}px` }}
              className="flex items-center gap-1 pr-3 py-1 cursor-pointer text-muted-foreground hover:text-primary transition-colors"
              onClick={e => {
                e.stopPropagation();
                const siblings = childrenOf(list, folder.parent_id);
                const parentName = folder.parent_id
                  ? (list.find(f => f.id === folder.parent_id)?.name ?? '상위 폴더')
                  : (selectedTextbook?.name ?? '교재');
                setFolderForm({ name: '', description: '', sort_order: siblings.length + 1 });
                setFolderDialog({ textbookId: folder.textbook_id, parentId: folder.parent_id, parentName });
              }}
            >
              <Plus className="h-3 w-3 flex-shrink-0" />
              <span className="text-xs">같은 위치에 폴더 추가</span>
            </div>
          </>
        )}
      </div>
    );
  };

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
              const textbookFolders = folders[textbook.id] ?? [];

              return (
                <div key={textbook.id}>
                  {/* 교재 행 */}
                  <div
                    className={`flex items-center gap-1 px-3 py-2 cursor-pointer hover:bg-muted/50 transition-colors group ${isSelected && !selectedFolder ? 'bg-primary/10 text-primary' : ''}`}
                    onClick={() => selectTextbook(textbook)}
                  >
                    <button
                      className="p-0 flex-shrink-0 text-muted-foreground"
                      onClick={e => toggleTextbookExpand(textbook, e)}
                      title={isExpanded ? '접기' : '펼치기'}
                    >
                      {isExpanded ? (
                        <ChevronDown className="h-3.5 w-3.5" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5" />
                      )}
                    </button>
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

                  {/* 폴더 트리 — 깊이 제한 없음 */}
                  {isExpanded && (
                    <div>
                      {childrenOf(textbookFolders, null).map(f =>
                        renderFolderRow(f, textbookFolders, 1)
                      )}

                      {/* 최상위로 빼는 드롭 영역 겸 '폴더 추가'.
                          펼친 교재면 늘 보여준다 — 선택된 교재에만 띄우면
                          다른 교재에 폴더를 만들 방법이 없다.
                          드래그 드롭만 선택된 교재로 한정한다(handleFolderDrop 이
                          선택된 교재의 폴더 목록에서 대상을 찾기 때문). */}
                      <div
                        onDragOver={isSelected ? (e => { if (draggingFolderId) { e.preventDefault(); setDropTargetId('__root__'); } }) : undefined}
                        onDragLeave={isSelected ? (() => setDropTargetId(prev => prev === '__root__' ? null : prev)) : undefined}
                        onDrop={isSelected ? (e => { e.preventDefault(); handleFolderDrop(null); }) : undefined}
                        className={`flex items-center gap-1 pl-7 pr-3 py-1 cursor-pointer text-muted-foreground hover:text-primary transition-colors ${isSelected && dropTargetId === '__root__' ? 'ring-2 ring-primary ring-inset bg-primary/5' : ''}`}
                        title={isSelected && draggingFolderId ? '여기에 놓으면 교재 바로 아래(최상위)로 나옵니다' : undefined}
                        onClick={() => {
                          setFolderForm({ name: '', description: '', sort_order: childrenOf(textbookFolders, null).length + 1 });
                          setFolderDialog({ textbookId: textbook.id, parentId: null, parentName: textbook.name });
                        }}
                      >
                        <Plus className="h-3 w-3 flex-shrink-0" />
                        <span className="text-xs">폴더 추가</span>
                      </div>
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
                onClick={openMoveDialog}
              >
                <FolderInput className="h-4 w-4 mr-1.5" />
                폴더 이동 ({selectedProblemIds.size})
              </Button>
            )}
            {(selectedTextbook || selectedFolder) && (
              <Button size="sm" onClick={() => {
                const params = new URLSearchParams();
                if (selectedTextbook) params.set('textbook_id', selectedTextbook.id);
                if (selectedFolder) params.set('folder_id', selectedFolder.id);
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
                    {selectedFolder
                      ? `'${selectedFolder.name}'에`
                      : `'${selectedTextbook.name}'에`} 문제를 추가해보세요
                  </p>
                  <Button size="sm" onClick={() => {
                    const params = new URLSearchParams();
                    if (selectedTextbook) params.set('textbook_id', selectedTextbook.id);
                    if (selectedFolder) params.set('folder_id', selectedFolder.id);
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
                            <Badge variant="outline" className={`text-xs ${difficultyColor(problem.difficulty_score ?? 2)}`}>
                              {difficultyLabel(problem.difficulty_score ?? 2)}
                            </Badge>
                            <Badge variant="outline" className="text-xs">
                              {problem.answer_type === 'multiple_choice' ? '객관식' : '주관식'}
                            </Badge>
                            {/* 폴더 통합 후 새 문제는 folder_id 만 채워진다.
                                옛 chapter_id 를 보고 있어서, 같은 문제인데도 등록 시점에 따라
                                배지가 붙고 안 붙어 서로 다른 내용처럼 보였다. */}
                            {problem.folder_id && (
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
      {/* 폴더 생성 모달 — 최상위든 하위든 하나로 처리한다 */}
      {folderDialog && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center">
          <div className="fixed inset-0 bg-black/80" onClick={() => setFolderDialog(null)} />
          <div className="relative z-[10000] bg-background border rounded-lg shadow-lg w-full max-w-md p-6 space-y-4">
            <div>
              <h2 className="text-lg font-semibold">새 폴더</h2>
              <p className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">{folderDialog.parentName}</span> 바로 아래에 만듭니다
              </p>
            </div>
            <div>
              <Label>폴더 이름 *</Label>
              <Input
                className="mt-1"
                value={folderForm.name}
                onChange={e => setFolderForm({ ...folderForm, name: e.target.value })}
                onKeyDown={e => { if (e.key === 'Enter' && folderForm.name) handleCreateFolder(); }}
                placeholder="예: 2026년"
                autoFocus
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setFolderDialog(null)}>취소</Button>
              <Button onClick={handleCreateFolder} disabled={!folderForm.name}>생성</Button>
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

      {/* 폴더 자체를 옮기는 모달 (드래그가 어려울 때의 대안) */}
      {folderMoveTarget && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center">
          <div className="fixed inset-0 bg-black/80" onClick={() => setFolderMoveTarget(null)} />
          <div className="relative z-[10000] bg-background border rounded-lg shadow-lg w-full max-w-md p-6 space-y-4">
            <div>
              <h2 className="text-lg font-semibold">폴더 옮기기</h2>
              <p className="text-sm text-muted-foreground">
                '{folderMoveTarget.name}' 을(를) 어느 폴더 아래로 옮길지 고르세요
              </p>
            </div>
            <div>
              <Label>이동할 위치</Label>
              <select
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm mt-1"
                value={folderMoveParent}
                onChange={e => setFolderMoveParent(e.target.value)}
              >
                <option value="">(최상위 — 교재 바로 아래)</option>
                {flattenTree(folderList)
                  .filter(({ folder }) => canBeParent(folderList, folderMoveTarget, folder.id))
                  .map(({ folder, depth }) => (
                    <option key={folder.id} value={folder.id}>
                      {`${' '.repeat(depth * 3)}${depth > 0 ? '└ ' : ''}${folder.name}`}
                    </option>
                  ))}
              </select>
              <p className="text-xs text-muted-foreground mt-1">
                자기 자신과 자기 하위 폴더는 목록에 나오지 않습니다
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setFolderMoveTarget(null)}>취소</Button>
              <Button
                onClick={async () => {
                  const target = folderMoveTarget;
                  setFolderMoveTarget(null);
                  await moveFolder(target, folderMoveParent || null);
                }}
              >
                옮기기
              </Button>
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
                value={moveTarget}
                onChange={e => setMoveTarget(e.target.value)}
              >
                <option value="">(폴더 없음)</option>
                {flattenTree(folderList).map(({ folder, depth }) => (
                  <option key={folder.id} value={folder.id}>
                    {`${' '.repeat(depth * 3)}${depth > 0 ? '└ ' : ''}${folder.name}`}
                  </option>
                ))}
              </select>
              {folderList.length === 0 && (
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
          folder={selectedFolder}
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
