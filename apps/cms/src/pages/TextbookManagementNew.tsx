import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@shared/hooks/useAuth';
import { Button } from '@shared/ui/button';
import { Input } from '@shared/ui/input';
import { Label } from '@shared/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@shared/ui/card';
import { Badge } from '@shared/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@shared/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@shared/ui/select';
import { Textarea } from '@shared/ui/textarea';
import { toast } from '@shared/hooks/use-toast';
import { 
  BookOpen, 
  Plus, 
  Edit, 
  Trash2, 
  ChevronRight, 
  FolderOpen,
  FileText,
  ArrowLeft
} from 'lucide-react';
import { supabase } from '@shared/supabase/client';

interface Textbook {
  id: string;
  name: string;
  grade: string;
  semester: string;
  description?: string;
  created_at: string;
  updated_at: string;
}

interface Chapter {
  id: string;
  textbook_id: string;
  name: string;
  description?: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

interface Subchapter {
  id: string;
  chapter_id: string;
  name: string;
  description?: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

const TextbookManagementNew = () => {
  const navigate = useNavigate();
  const { profile } = useAuth();
  
  const [textbooks, setTextbooks] = useState<Textbook[]>([]);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [subchapters, setSubchapters] = useState<Subchapter[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedTextbook, setSelectedTextbook] = useState<Textbook | null>(null);
  const [selectedChapter, setSelectedChapter] = useState<Chapter | null>(null);
  
  // 다이얼로그 상태
  const [isTextbookDialogOpen, setIsTextbookDialogOpen] = useState(false);
  const [isChapterDialogOpen, setIsChapterDialogOpen] = useState(false);
  const [isSubchapterDialogOpen, setIsSubchapterDialogOpen] = useState(false);
  
  // 폼 데이터
  const [textbookForm, setTextbookForm] = useState({
    name: '',
    grade: '',
    semester: '',
    description: ''
  });
  
  const [chapterForm, setChapterForm] = useState({
    name: '',
    description: '',
    sort_order: 1
  });
  
  const [subchapterForm, setSubchapterForm] = useState({
    name: '',
    description: '',
    sort_order: 1
  });

  // 학년 옵션
  const gradeOptions = [
    { value: '중학교 1학년', label: '중학교 1학년' },
    { value: '중학교 2학년', label: '중학교 2학년' },
    { value: '중학교 3학년', label: '중학교 3학년' },
    { value: '고등학교 1학년', label: '고등학교 1학년' },
    { value: '고등학교 2학년', label: '고등학교 2학년' },
    { value: '고등학교 3학년', label: '고등학교 3학년' }
  ];

  // 학기 옵션
  const semesterOptions = [
    { value: '1학기', label: '1학기' },
    { value: '2학기', label: '2학기' }
  ];

  useEffect(() => {
    fetchTextbooks();
  }, []);

  const fetchTextbooks = async () => {
    try {
      setLoading(true);
      console.log('개발 모드 - 더미 교재 데이터 로드');
      
      // 개발 모드: 기존 등록된 교재들 복원
      const dummyTextbooks = [
        {
          id: 'textbook-1',
          name: '쎈 수학',
          grade: '고등학교 1학년',
          semester: '1학기',
          description: '기본 수학 문제집',
          created_at: '2024-01-01T09:00:00Z',
          updated_at: '2024-01-01T09:00:00Z'
        },
        {
          id: 'textbook-2',
          name: '모의고사',
          grade: '고등학교 2학년',
          semester: '2학기',
          description: '모의고사 문제집',
          created_at: '2024-01-02T09:00:00Z',
          updated_at: '2024-01-02T09:00:00Z'
        },
        {
          id: 'textbook-3',
          name: '연산',
          grade: '고등학교 1학년',
          semester: '1학기',
          description: '연산 연습 문제집',
          created_at: '2024-01-03T09:00:00Z',
          updated_at: '2024-01-03T09:00:00Z'
        },
        {
          id: 'textbook-4',
          name: '자작',
          grade: '고등학교 3학년',
          semester: '2학기',
          description: '자작 문제 모음',
          created_at: '2024-01-04T09:00:00Z',
          updated_at: '2024-01-04T09:00:00Z'
        },
        {
          id: 'textbook-5',
          name: '쎈 수학',
          grade: '고등학교 2학년',
          semester: '1학기',
          description: '고2 수학 문제집',
          created_at: '2024-01-05T09:00:00Z',
          updated_at: '2024-01-05T09:00:00Z'
        }
      ];
      
      setTextbooks(dummyTextbooks);
    } catch (error) {
      console.error('교재 조회 오류:', error);
      toast({
        title: "오류",
        description: "교재 목록을 불러오는데 실패했습니다.",
        variant: "destructive"
      });
    } finally {
      setLoading(false);
    }
  };

  const fetchChapters = async (textbookId: string) => {
    try {
      console.log('개발 모드 - 더미 대단원 데이터 로드');
      
      // 개발 모드: 더미 대단원 데이터
      const dummyChapters = [
        {
          id: 'chapter-1',
          textbook_id: textbookId,
          name: '다항식',
          description: '다항식의 연산과 성질',
          sort_order: 1,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        },
        {
          id: 'chapter-2',
          textbook_id: textbookId,
          name: '방정식과 부등식',
          description: '방정식과 부등식의 해법',
          sort_order: 2,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }
      ];
      
      setChapters(dummyChapters);
    } catch (error) {
      console.error('대단원 조회 오류:', error);
    }
  };

  const fetchSubchapters = async (chapterId: string) => {
    try {
      console.log('개발 모드 - 더미 중단원 데이터 로드');
      
      // 개발 모드: 더미 중단원 데이터
      const dummySubchapters = [
        {
          id: 'subchapter-1',
          chapter_id: chapterId,
          name: '다항식의 연산',
          description: '다항식의 덧셈, 뺄셈, 곱셈',
          sort_order: 1,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        },
        {
          id: 'subchapter-2',
          chapter_id: chapterId,
          name: '인수분해',
          description: '다항식의 인수분해',
          sort_order: 2,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }
      ];
      
      setSubchapters(dummySubchapters);
    } catch (error) {
      console.error('중단원 조회 오류:', error);
    }
  };

  const handleTextbookSelect = async (textbook: Textbook) => {
    setSelectedTextbook(textbook);
    setSelectedChapter(null);
    setSubchapters([]);
    await fetchChapters(textbook.id);
  };

  const handleChapterSelect = async (chapter: Chapter) => {
    setSelectedChapter(chapter);
    await fetchSubchapters(chapter.id);
  };

  const handleCreateTextbook = async () => {
    try {
      console.log('개발 모드 - 교재 생성 시뮬레이션');
      
      // 개발 모드: 교재 생성 시뮬레이션
      const newTextbook = {
        id: `textbook-${Date.now()}`,
        name: textbookForm.name,
        grade: textbookForm.grade,
        semester: textbookForm.semester,
        description: textbookForm.description,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      setTextbooks(prev => [newTextbook, ...prev]);

      toast({
        title: "성공",
        description: "교재가 생성되었습니다."
      });

      setTextbookForm({ name: '', grade: '', semester: '', description: '' });
      setIsTextbookDialogOpen(false);
    } catch (error) {
      console.error('교재 생성 오류:', error);
      toast({
        title: "오류",
        description: "교재 생성에 실패했습니다.",
        variant: "destructive"
      });
    }
  };

  const handleCreateChapter = async () => {
    try {
      if (!selectedTextbook) {
        toast({
          title: "오류",
          description: "교재를 선택해주세요.",
          variant: "destructive"
        });
        return;
      }

      const { data, error } = await supabase
        .from('chapters')
        .insert({
          ...chapterForm,
          textbook_id: selectedTextbook.id
        })
        .select()
        .single();

      if (error) throw error;

      toast({
        title: "성공",
        description: "대단원이 생성되었습니다."
      });

      setChapterForm({ name: '', description: '', sort_order: 1 });
      setIsChapterDialogOpen(false);
      await fetchChapters(selectedTextbook.id);
    } catch (error) {
      console.error('대단원 생성 오류:', error);
      toast({
        title: "오류",
        description: "대단원 생성에 실패했습니다.",
        variant: "destructive"
      });
    }
  };

  const handleCreateSubchapter = async () => {
    try {
      if (!selectedChapter) {
        toast({
          title: "오류",
          description: "대단원을 선택해주세요.",
          variant: "destructive"
        });
        return;
      }

      const { data, error } = await supabase
        .from('subchapters')
        .insert({
          ...subchapterForm,
          chapter_id: selectedChapter.id
        })
        .select()
        .single();

      if (error) throw error;

      toast({
        title: "성공",
        description: "중단원이 생성되었습니다."
      });

      setSubchapterForm({ name: '', description: '', sort_order: 1 });
      setIsSubchapterDialogOpen(false);
      await fetchSubchapters(selectedChapter.id);
    } catch (error) {
      console.error('중단원 생성 오류:', error);
      toast({
        title: "오류",
        description: "중단원 생성에 실패했습니다.",
        variant: "destructive"
      });
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
      {/* 헤더 */}
      <div className="flex items-center gap-4 mb-6">
        <Button variant="outline" size="sm" onClick={() => navigate('/cms')}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          돌아가기
        </Button>
        <div>
          <h1 className="text-2xl font-bold">교재 관리</h1>
          <p className="text-muted-foreground">교재 및 단원 구조를 관리하세요</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* 교재 목록 */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2">
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
                    <DialogDescription>
                      새로운 교재를 등록하세요
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-4">
                    <div>
                      <Label htmlFor="textbook-name">교재명 *</Label>
                      <Input
                        id="textbook-name"
                        value={textbookForm.name}
                        onChange={(e) => setTextbookForm({ ...textbookForm, name: e.target.value })}
                        placeholder="예: 쎈 수학"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <Label htmlFor="textbook-grade">학년 *</Label>
                        <Select value={textbookForm.grade} onValueChange={(value) => setTextbookForm({ ...textbookForm, grade: value })}>
                          <SelectTrigger>
                            <SelectValue placeholder="학년 선택" />
                          </SelectTrigger>
                          <SelectContent>
                            {gradeOptions.map(option => (
                              <SelectItem key={option.value} value={option.value}>
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <Label htmlFor="textbook-semester">학기 *</Label>
                        <Select value={textbookForm.semester} onValueChange={(value) => setTextbookForm({ ...textbookForm, semester: value })}>
                          <SelectTrigger>
                            <SelectValue placeholder="학기 선택" />
                          </SelectTrigger>
                          <SelectContent>
                            {semesterOptions.map(option => (
                              <SelectItem key={option.value} value={option.value}>
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    <div>
                      <Label htmlFor="textbook-description">설명</Label>
                      <Textarea
                        id="textbook-description"
                        value={textbookForm.description}
                        onChange={(e) => setTextbookForm({ ...textbookForm, description: e.target.value })}
                        placeholder="교재에 대한 설명을 입력하세요"
                      />
                    </div>
                  </div>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setIsTextbookDialogOpen(false)}>
                      취소
                    </Button>
                    <Button onClick={handleCreateTextbook} disabled={!textbookForm.name || !textbookForm.grade || !textbookForm.semester}>
                      생성
                    </Button>
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
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
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
              <CardTitle className="flex items-center gap-2">
                <FolderOpen className="h-5 w-5" />
                대단원
                {selectedTextbook && (
                  <Badge variant="outline">{selectedTextbook.name}</Badge>
                )}
              </CardTitle>
              {selectedTextbook && (
                <Dialog open={isChapterDialogOpen} onOpenChange={setIsChapterDialogOpen}>
                  <DialogTrigger asChild>
                    <Button size="sm">
                      <Plus className="h-4 w-4 mr-2" />
                      새 대단원
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>새 대단원 생성</DialogTitle>
                      <DialogDescription>
                        {selectedTextbook.name}에 새로운 대단원을 추가하세요
                      </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4">
                      <div>
                        <Label htmlFor="chapter-name">대단원명 *</Label>
                        <Input
                          id="chapter-name"
                          value={chapterForm.name}
                          onChange={(e) => setChapterForm({ ...chapterForm, name: e.target.value })}
                          placeholder="예: 집합"
                        />
                      </div>
                      <div>
                        <Label htmlFor="chapter-description">설명</Label>
                        <Textarea
                          id="chapter-description"
                          value={chapterForm.description}
                          onChange={(e) => setChapterForm({ ...chapterForm, description: e.target.value })}
                          placeholder="대단원에 대한 설명을 입력하세요"
                        />
                      </div>
                      <div>
                        <Label htmlFor="chapter-order">정렬 순서</Label>
                        <Input
                          id="chapter-order"
                          type="number"
                          value={chapterForm.sort_order}
                          onChange={(e) => setChapterForm({ ...chapterForm, sort_order: parseInt(e.target.value) || 1 })}
                          min="1"
                        />
                      </div>
                    </div>
                    <DialogFooter>
                      <Button variant="outline" onClick={() => setIsChapterDialogOpen(false)}>
                        취소
                      </Button>
                      <Button onClick={handleCreateChapter} disabled={!chapterForm.name}>
                        생성
                      </Button>
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
                      selectedChapter?.id === chapter.id
                        ? 'border-primary bg-primary/5'
                        : 'border-border hover:border-primary/50'
                    }`}
                    onClick={() => handleChapterSelect(chapter)}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="font-medium">{chapter.name}</h3>
                        {chapter.description && (
                          <p className="text-sm text-muted-foreground">{chapter.description}</p>
                        )}
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
              <CardTitle className="flex items-center gap-2">
                <FileText className="h-5 w-5" />
                중단원
                {selectedChapter && (
                  <Badge variant="outline">{selectedChapter.name}</Badge>
                )}
              </CardTitle>
              {selectedChapter && (
                <Dialog open={isSubchapterDialogOpen} onOpenChange={setIsSubchapterDialogOpen}>
                  <DialogTrigger asChild>
                    <Button size="sm">
                      <Plus className="h-4 w-4 mr-2" />
                      새 중단원
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>새 중단원 생성</DialogTitle>
                      <DialogDescription>
                        {selectedChapter.name}에 새로운 중단원을 추가하세요
                      </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4">
                      <div>
                        <Label htmlFor="subchapter-name">중단원명 *</Label>
                        <Input
                          id="subchapter-name"
                          value={subchapterForm.name}
                          onChange={(e) => setSubchapterForm({ ...subchapterForm, name: e.target.value })}
                          placeholder="예: 집합의 연산"
                        />
                      </div>
                      <div>
                        <Label htmlFor="subchapter-description">설명</Label>
                        <Textarea
                          id="subchapter-description"
                          value={subchapterForm.description}
                          onChange={(e) => setSubchapterForm({ ...subchapterForm, description: e.target.value })}
                          placeholder="중단원에 대한 설명을 입력하세요"
                        />
                      </div>
                      <div>
                        <Label htmlFor="subchapter-order">정렬 순서</Label>
                        <Input
                          id="subchapter-order"
                          type="number"
                          value={subchapterForm.sort_order}
                          onChange={(e) => setSubchapterForm({ ...subchapterForm, sort_order: parseInt(e.target.value) || 1 })}
                          min="1"
                        />
                      </div>
                    </div>
                    <DialogFooter>
                      <Button variant="outline" onClick={() => setIsSubchapterDialogOpen(false)}>
                        취소
                      </Button>
                      <Button onClick={handleCreateSubchapter} disabled={!subchapterForm.name}>
                        생성
                      </Button>
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
                    className="p-3 border rounded-lg transition-colors border-border"
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="font-medium">{subchapter.name}</h3>
                        {subchapter.description && (
                          <p className="text-sm text-muted-foreground">{subchapter.description}</p>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => navigate(`/cms/problem-sets?subchapter=${subchapter.id}`)}
                        >
                          문제 세트
                        </Button>
                      </div>
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
    </div>
  );
};

export default TextbookManagementNew;
