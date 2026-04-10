import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@shared/hooks/useAuth';
import { Button } from '@shared/ui/button';
import { Input } from '@shared/ui/input';
import { Label } from '@shared/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@shared/ui/card';
import { Badge } from '@shared/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@shared/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@shared/ui/select';
import { Textarea } from '@shared/ui/textarea';
import { toast } from '@shared/hooks/use-toast';
import {
  BookOpen,
  Plus,
  ChevronRight,
  FolderOpen,
  FileText,
  Upload,
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

const TextbookManagementNew = () => {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const {
    selectedTextbook: ctxTextbook,
    selectedChapter: ctxChapter,
    setTextbook: ctxSetTextbook,
    setChapter: ctxSetChapter,
    setSubchapter: ctxSetSubchapter,
  } = useTextbook();

  const [textbooks, setTextbooks] = useState<Textbook[]>([]);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [subchapters, setSubchapters] = useState<Subchapter[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedTextbook, setSelectedTextbook] = useState<Textbook | null>(ctxTextbook);
  const [selectedChapter, setSelectedChapter] = useState<Chapter | null>(ctxChapter);
  const [problemCounts, setProblemCounts] = useState<Record<string, number>>({});

  // 다이얼로그 상태
  const [isTextbookDialogOpen, setIsTextbookDialogOpen] = useState(false);
  const [isChapterDialogOpen, setIsChapterDialogOpen] = useState(false);
  const [isSubchapterDialogOpen, setIsSubchapterDialogOpen] = useState(false);
  const [isPdfDialogOpen, setIsPdfDialogOpen] = useState(false);

  // 폼 데이터
  const [textbookForm, setTextbookForm] = useState({ name: '', grade: '', semester: '', description: '' });
  const [chapterForm, setChapterForm] = useState({ name: '', description: '', sort_order: 1 });
  const [subchapterForm, setSubchapterForm] = useState({ name: '', description: '', sort_order: 1 });

  useEffect(() => {
    fetchTextbooks();
  }, []);

  useEffect(() => {
    if (selectedTextbook) {
      fetchChapters(selectedTextbook.id);
      fetchProblemCount(selectedTextbook.id);
    }
  }, [selectedTextbook]);

  useEffect(() => {
    if (selectedChapter) {
      fetchSubchapters(selectedChapter.id);
    }
  }, [selectedChapter]);

  const fetchTextbooks = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from('textbooks')
        .select('*')
        .order('name', { ascending: true });
      if (error) throw error;
      setTextbooks(data || []);

      // 문제 수 조회
      if (data && data.length > 0) {
        const counts: Record<string, number> = {};
        for (const tb of data) {
          const { count } = await supabase
            .from('problems')
            .select('id', { count: 'exact', head: true })
            .eq('textbook_id', tb.id);
          counts[tb.id] = count || 0;
        }
        setProblemCounts(counts);
      }
    } catch (error) {
      console.error('교재 조회 오류:', error);
      toast({ title: '오류', description: '교재 목록을 불러오는데 실패했습니다.', variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  const fetchProblemCount = async (textbookId: string) => {
    const { count } = await supabase
      .from('problems')
      .select('id', { count: 'exact', head: true })
      .eq('textbook_id', textbookId);
    setProblemCounts(prev => ({ ...prev, [textbookId]: count || 0 }));
  };

  const fetchChapters = async (textbookId: string) => {
    try {
      const { data, error } = await supabase
        .from('chapters')
        .select('*')
        .eq('textbook_id', textbookId)
        .order('sort_order', { ascending: true });
      if (error) throw error;
      setChapters(data || []);
    } catch (error) {
      console.error('대단원 조회 오류:', error);
    }
  };

  const fetchSubchapters = async (chapterId: string) => {
    try {
      const { data, error } = await supabase
        .from('subchapters')
        .select('*')
        .eq('chapter_id', chapterId)
        .order('sort_order', { ascending: true });
      if (error) throw error;
      setSubchapters(data || []);
    } catch (error) {
      console.error('중단원 조회 오류:', error);
    }
  };

  const handleTextbookSelect = async (textbook: Textbook) => {
    setSelectedTextbook(textbook);
    setSelectedChapter(null);
    setSubchapters([]);
    ctxSetTextbook(textbook);
  };

  const handleChapterSelect = async (chapter: Chapter) => {
    setSelectedChapter(chapter);
    ctxSetChapter(chapter);
  };

  const handleSubchapterClick = (subchapter: Subchapter) => {
    ctxSetSubchapter(subchapter);
    navigate('/cms/problems');
  };

  const handleCreateTextbook = async () => {
    try {
      const { data, error } = await supabase
        .from('textbooks')
        .insert({
          name: textbookForm.name,
          grade: textbookForm.grade,
          semester: textbookForm.semester,
          description: textbookForm.description,
          created_by: profile?.id,
        })
        .select()
        .single();
      if (error) throw error;
      toast({ title: '성공', description: '교재가 생성되었습니다.' });
      setTextbookForm({ name: '', grade: '', semester: '', description: '' });
      setIsTextbookDialogOpen(false);
      fetchTextbooks();
    } catch (error) {
      console.error('교재 생성 오류:', error);
      toast({ title: '오류', description: '교재 생성에 실패했습니다.', variant: 'destructive' });
    }
  };

  const handleCreateChapter = async () => {
    if (!selectedTextbook) return;
    try {
      const { error } = await supabase
        .from('chapters')
        .insert({ ...chapterForm, textbook_id: selectedTextbook.id })
        .select()
        .single();
      if (error) throw error;
      toast({ title: '성공', description: '대단원이 생성되었습니다.' });
      setChapterForm({ name: '', description: '', sort_order: chapters.length + 1 });
      setIsChapterDialogOpen(false);
      fetchChapters(selectedTextbook.id);
    } catch (error) {
      console.error('대단원 생성 오류:', error);
      toast({ title: '오류', description: '대단원 생성에 실패했습니다.', variant: 'destructive' });
    }
  };

  const handleCreateSubchapter = async () => {
    if (!selectedChapter) return;
    try {
      const { error } = await supabase
        .from('subchapters')
        .insert({ ...subchapterForm, chapter_id: selectedChapter.id })
        .select()
        .single();
      if (error) throw error;
      toast({ title: '성공', description: '중단원이 생성되었습니다.' });
      setSubchapterForm({ name: '', description: '', sort_order: subchapters.length + 1 });
      setIsSubchapterDialogOpen(false);
      fetchSubchapters(selectedChapter.id);
    } catch (error) {
      console.error('중단원 생성 오류:', error);
      toast({ title: '오류', description: '중단원 생성에 실패했습니다.', variant: 'destructive' });
    }
  };

  if (loading) {
    return (
      <div className="container mx-auto px-4 py-6">
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-6">
      {/* 액션 바 */}
      {selectedTextbook && (
        <div className="flex items-center gap-2 mb-4">
          <Button variant="outline" size="sm" onClick={() => setIsPdfDialogOpen(true)}>
            <Upload className="h-4 w-4 mr-2" />
            이 교재에 PDF 가져오기
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate('/cms/problems')}
          >
            <FileText className="h-4 w-4 mr-2" />
            문제 보기 ({problemCounts[selectedTextbook.id] || 0}개)
          </Button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* 교재 목록 */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2 text-base">
                <BookOpen className="h-5 w-5" />
                교재 목록
              </CardTitle>
              <Dialog open={isTextbookDialogOpen} onOpenChange={setIsTextbookDialogOpen}>
                <DialogTrigger asChild>
                  <Button size="sm">
                    <Plus className="h-4 w-4 mr-2" />
                    새 교재
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>새 교재 생성</DialogTitle>
                    <DialogDescription>새로운 교재를 등록하세요</DialogDescription>
                  </DialogHeader>
                  <div className="space-y-4">
                    <div>
                      <Label>교재명 *</Label>
                      <Input
                        value={textbookForm.name}
                        onChange={(e) => setTextbookForm({ ...textbookForm, name: e.target.value })}
                        placeholder="예: 쎈 수학"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <Label>학년 *</Label>
                        <Select value={textbookForm.grade} onValueChange={(v) => setTextbookForm({ ...textbookForm, grade: v })}>
                          <SelectTrigger><SelectValue placeholder="학년 선택" /></SelectTrigger>
                          <SelectContent>
                            {gradeOptions.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <Label>학기 *</Label>
                        <Select value={textbookForm.semester} onValueChange={(v) => setTextbookForm({ ...textbookForm, semester: v })}>
                          <SelectTrigger><SelectValue placeholder="학기 선택" /></SelectTrigger>
                          <SelectContent>
                            {semesterOptions.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    <div>
                      <Label>설명</Label>
                      <Textarea
                        value={textbookForm.description}
                        onChange={(e) => setTextbookForm({ ...textbookForm, description: e.target.value })}
                        placeholder="교재에 대한 설명"
                      />
                    </div>
                  </div>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setIsTextbookDialogOpen(false)}>취소</Button>
                    <Button onClick={handleCreateTextbook} disabled={!textbookForm.name || !textbookForm.grade || !textbookForm.semester}>생성</Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {textbooks.map((textbook) => (
                <div
                  key={textbook.id}
                  className={`p-3 border rounded-lg cursor-pointer transition-colors ${
                    selectedTextbook?.id === textbook.id
                      ? 'border-primary bg-primary/5'
                      : 'border-border hover:border-primary/50'
                  }`}
                  onClick={() => handleTextbookSelect(textbook)}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="font-medium">{textbook.name}</h3>
                      <p className="text-sm text-muted-foreground">
                        {textbook.grade} {textbook.semester}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {problemCounts[textbook.id] > 0 && (
                        <Badge variant="secondary">{problemCounts[textbook.id]}문제</Badge>
                      )}
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    </div>
                  </div>
                </div>
              ))}
              {textbooks.length === 0 && (
                <div className="text-center py-8 text-muted-foreground">
                  <BookOpen className="h-12 w-12 mx-auto mb-4" />
                  <p>등록된 교재가 없습니다</p>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* 대단원 목록 */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2 text-base">
                <FolderOpen className="h-5 w-5" />
                대단원
                {selectedTextbook && <Badge variant="outline">{selectedTextbook.name}</Badge>}
              </CardTitle>
              {selectedTextbook && (
                <Dialog open={isChapterDialogOpen} onOpenChange={setIsChapterDialogOpen}>
                  <DialogTrigger asChild>
                    <Button size="sm"><Plus className="h-4 w-4 mr-2" />새 대단원</Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>새 대단원 생성</DialogTitle>
                      <DialogDescription>{selectedTextbook.name}에 새로운 대단원을 추가하세요</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4">
                      <div>
                        <Label>대단원명 *</Label>
                        <Input value={chapterForm.name} onChange={(e) => setChapterForm({ ...chapterForm, name: e.target.value })} placeholder="예: 다항식" />
                      </div>
                      <div>
                        <Label>설명</Label>
                        <Textarea value={chapterForm.description} onChange={(e) => setChapterForm({ ...chapterForm, description: e.target.value })} />
                      </div>
                      <div>
                        <Label>정렬 순서</Label>
                        <Input type="number" value={chapterForm.sort_order} onChange={(e) => setChapterForm({ ...chapterForm, sort_order: parseInt(e.target.value) || 1 })} min="1" />
                      </div>
                    </div>
                    <DialogFooter>
                      <Button variant="outline" onClick={() => setIsChapterDialogOpen(false)}>취소</Button>
                      <Button onClick={handleCreateChapter} disabled={!chapterForm.name}>생성</Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {selectedTextbook ? (
              <div className="space-y-2">
                {chapters.map((chapter) => (
                  <div
                    key={chapter.id}
                    className={`p-3 border rounded-lg cursor-pointer transition-colors ${
                      selectedChapter?.id === chapter.id ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50'
                    }`}
                    onClick={() => handleChapterSelect(chapter)}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="font-medium">{chapter.name}</h3>
                        {chapter.description && <p className="text-sm text-muted-foreground">{chapter.description}</p>}
                      </div>
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    </div>
                  </div>
                ))}
                {chapters.length === 0 && (
                  <div className="text-center py-8 text-muted-foreground">
                    <FolderOpen className="h-12 w-12 mx-auto mb-4" />
                    <p>등록된 대단원이 없습니다</p>
                  </div>
                )}
              </div>
            ) : (
              <div className="text-center py-8 text-muted-foreground">
                <FolderOpen className="h-12 w-12 mx-auto mb-4" />
                <p>교재를 선택해주세요</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* 중단원 목록 */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2 text-base">
                <FileText className="h-5 w-5" />
                중단원
                {selectedChapter && <Badge variant="outline">{selectedChapter.name}</Badge>}
              </CardTitle>
              {selectedChapter && (
                <Dialog open={isSubchapterDialogOpen} onOpenChange={setIsSubchapterDialogOpen}>
                  <DialogTrigger asChild>
                    <Button size="sm"><Plus className="h-4 w-4 mr-2" />새 중단원</Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>새 중단원 생성</DialogTitle>
                      <DialogDescription>{selectedChapter.name}에 새로운 중단원을 추가하세요</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4">
                      <div>
                        <Label>중단원명 *</Label>
                        <Input value={subchapterForm.name} onChange={(e) => setSubchapterForm({ ...subchapterForm, name: e.target.value })} placeholder="예: 다항식의 연산" />
                      </div>
                      <div>
                        <Label>설명</Label>
                        <Textarea value={subchapterForm.description} onChange={(e) => setSubchapterForm({ ...subchapterForm, description: e.target.value })} />
                      </div>
                      <div>
                        <Label>정렬 순서</Label>
                        <Input type="number" value={subchapterForm.sort_order} onChange={(e) => setSubchapterForm({ ...subchapterForm, sort_order: parseInt(e.target.value) || 1 })} min="1" />
                      </div>
                    </div>
                    <DialogFooter>
                      <Button variant="outline" onClick={() => setIsSubchapterDialogOpen(false)}>취소</Button>
                      <Button onClick={handleCreateSubchapter} disabled={!subchapterForm.name}>생성</Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {selectedChapter ? (
              <div className="space-y-2">
                {subchapters.map((subchapter) => (
                  <div
                    key={subchapter.id}
                    className="p-3 border rounded-lg cursor-pointer transition-colors border-border hover:border-primary/50"
                    onClick={() => handleSubchapterClick(subchapter)}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="font-medium">{subchapter.name}</h3>
                        {subchapter.description && <p className="text-sm text-muted-foreground">{subchapter.description}</p>}
                      </div>
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    </div>
                  </div>
                ))}
                {subchapters.length === 0 && (
                  <div className="text-center py-8 text-muted-foreground">
                    <FileText className="h-12 w-12 mx-auto mb-4" />
                    <p>등록된 중단원이 없습니다</p>
                  </div>
                )}
              </div>
            ) : (
              <div className="text-center py-8 text-muted-foreground">
                <FileText className="h-12 w-12 mx-auto mb-4" />
                <p>대단원을 선택해주세요</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* PDF 업로드 다이얼로그 */}
      {selectedTextbook && (
        <PdfUploadDialog
          open={isPdfDialogOpen}
          onOpenChange={setIsPdfDialogOpen}
          textbook={selectedTextbook}
          chapter={selectedChapter}
        />
      )}
    </div>
  );
};

export default TextbookManagementNew;
