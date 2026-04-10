import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { 
  BookOpen, 
  Plus, 
  Edit, 
  Trash2, 
  FolderOpen, 
  Target,
  Settings,
  Users,
  FileText,
  Star
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
// import { folderApi } from '@/lib/api';
import type { Folder } from '@/types/database';

interface TextbookFormData {
  name: string;
  description: string;
  textbook_type: string;
  grade_level: string;
  semester: string;
  subject: string;
}

const TextbookManagement = () => {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const [textbooks, setTextbooks] = useState<Folder[]>([]);
  const [loading, setLoading] = useState(true);
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [editingTextbook, setEditingTextbook] = useState<Folder | null>(null);
  const [formData, setFormData] = useState<TextbookFormData>({
    name: '',
    description: '',
    textbook_type: '',
    grade_level: '',
    semester: '',
    subject: ''
  });

  // 교재 타입 옵션
  const textbookTypes = [
    { value: '쎈', label: '쎈' },
    { value: '자작', label: '자작' },
    { value: '기타', label: '기타' }
  ];

  // 학년 옵션
  const gradeLevels = [
    { value: '중1', label: '중학교 1학년' },
    { value: '중2', label: '중학교 2학년' },
    { value: '중3', label: '중학교 3학년' },
    { value: '고1', label: '고등학교 1학년' },
    { value: '고2', label: '고등학교 2학년' },
    { value: '고3', label: '고등학교 3학년' }
  ];

  // 학기 옵션
  const semesters = [
    { value: '1학기', label: '1학기' },
    { value: '2학기', label: '2학기' }
  ];

  // 과목 옵션
  const subjects = [
    { value: '수학', label: '수학' },
    { value: '영어', label: '영어' },
    { value: '국어', label: '국어' },
    { value: '과학', label: '과학' }
  ];

  useEffect(() => {
    if (profile) {
      fetchTextbooks();
    }
  }, [profile]);

  const fetchTextbooks = async () => {
    try {
      setLoading(true);
      // const data = await folderApi.getFolders();
      const data = []; // 임시로 빈 배열 사용
      setTextbooks(data);
    } catch (error) {
      console.error('교재 조회 실패:', error);
    } finally {
      setLoading(false);
    }
  };

  const openCreateDialog = () => {
    setFormData({
      name: '',
      description: '',
      textbook_type: '',
      grade_level: '',
      semester: '',
      subject: ''
    });
    setIsCreateDialogOpen(true);
  };

  const openEditDialog = (textbook: Folder) => {
    setEditingTextbook(textbook);
    setFormData({
      name: textbook.name,
      description: textbook.description || '',
      textbook_type: textbook.textbook_type || '',
      grade_level: textbook.grade_level || '',
      semester: textbook.semester || '',
      subject: textbook.subject || ''
    });
    setIsEditDialogOpen(true);
  };

  const handleSubmit = async () => {
    if (!profile) return;

    try {
      const textbookData = {
        ...formData,
        folder_type: 'textbook' as const,
        created_by: profile.id
      };

      // if (editingTextbook) {
      //   await folderApi.updateFolder(editingTextbook.id, textbookData);
      // } else {
      //   await folderApi.createFolder(textbookData);
      // }
      console.log('폴더 API 비활성화됨');

      await fetchTextbooks();
      setIsCreateDialogOpen(false);
      setIsEditDialogOpen(false);
      setEditingTextbook(null);
    } catch (error: any) {
      console.error('교재 저장 실패:', error);
      console.error('교재 저장 실패 - 상세 에러:', {
        message: error.message,
        code: error.code,
        details: error.details,
        hint: error.hint
      });
      alert(`교재 저장 실패: ${error.message || '알 수 없는 오류가 발생했습니다.'}`);
    }
  };

  const handleDelete = async (textbookId: string) => {
    if (confirm('정말로 이 교재를 삭제하시겠습니까?')) {
      try {
        // await folderApi.deleteFolder(textbookId);
      console.log('폴더 삭제 API 비활성화됨');
        await fetchTextbooks();
      } catch (error) {
        console.error('교재 삭제 실패:', error);
      }
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
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold text-foreground">교재 관리</h1>
          <p className="text-muted-foreground">
            교과서/문제집 단위로 교재를 구성하고 관리하세요
          </p>
        </div>
        <Button onClick={openCreateDialog}>
          <Plus className="h-4 w-4 mr-2" />
          새 교재 생성
        </Button>
      </div>

      {/* 통계 카드 */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">총 교재 수</CardTitle>
            <BookOpen className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{textbooks.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">쎈 교재</CardTitle>
            <FileText className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {textbooks.filter(t => t.textbook_type === '쎈').length}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">자작 교재</CardTitle>
            <Star className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {textbooks.filter(t => t.textbook_type === '자작').length}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">수학 교재</CardTitle>
            <Target className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {textbooks.filter(t => t.subject === '수학').length}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* 교재 목록 */}
      <Card>
        <CardHeader>
          <CardTitle>교재 목록 ({textbooks.length}개)</CardTitle>
          <CardDescription>
            등록된 교재들을 확인하고 관리하세요
          </CardDescription>
        </CardHeader>
        <CardContent>
          {textbooks.length === 0 ? (
            <div className="text-center py-8">
              <BookOpen className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <p className="text-muted-foreground">등록된 교재가 없습니다.</p>
              <Button 
                variant="outline" 
                className="mt-4"
                onClick={openCreateDialog}
              >
                <Plus className="h-4 w-4 mr-2" />
                첫 교재 생성하기
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {textbooks.map((textbook) => (
                <Card key={textbook.id} className="hover:shadow-lg transition-shadow">
                  <CardHeader>
                    <CardTitle className="flex items-center justify-between">
                      <span className="text-lg">{textbook.name}</span>
                      <div className="flex items-center gap-2">
                        <Button 
                          variant="outline" 
                          size="sm"
                          onClick={() => openEditDialog(textbook)}
                        >
                          <Edit className="h-4 w-4" />
                        </Button>
                        <Button 
                          variant="outline" 
                          size="sm"
                          onClick={() => handleDelete(textbook.id)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </CardTitle>
                    <CardDescription>
                      {textbook.description || '설명이 없습니다.'}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline">
                          {textbook.textbook_type || '미분류'}
                        </Badge>
                        <Badge variant="secondary">
                          {textbook.grade_level} {textbook.semester}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Target className="h-4 w-4" />
                        <span>{textbook.subject}</span>
                      </div>
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <FolderOpen className="h-4 w-4" />
                        <span>문제 세트: 0개</span>
                      </div>
                    </div>
                    <div className="mt-4 flex gap-2">
                      <Button 
                        variant="outline" 
                        size="sm" 
                        className="flex-1"
                        onClick={() => navigate(`/cms/problem-sets?folder=${textbook.id}`)}
                      >
                        <Plus className="h-4 w-4 mr-2" />
                        문제 세트 추가
                      </Button>
                      <Button 
                        variant="outline" 
                        size="sm"
                        onClick={() => navigate(`/cms/textbooks/${textbook.id}`)}
                      >
                        <Settings className="h-4 w-4" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 교재 생성 다이얼로그 */}
      <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>새 교재 생성</DialogTitle>
            <DialogDescription>
              새로운 교재를 생성하고 설정하세요
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="name">교재 이름</Label>
              <Input
                id="name"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="예: 중학교 3학년 1학기 수학"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="description">설명</Label>
              <Input
                id="description"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder="교재에 대한 설명을 입력하세요"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="textbook_type">교재 타입</Label>
                <Select value={formData.textbook_type} onValueChange={(value) => setFormData({ ...formData, textbook_type: value })}>
                  <SelectTrigger>
                    <SelectValue placeholder="교재 타입 선택" />
                  </SelectTrigger>
                  <SelectContent>
                    {textbookTypes.map(type => (
                      <SelectItem key={type.value} value={type.value}>
                        {type.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="subject">과목</Label>
                <Select value={formData.subject} onValueChange={(value) => setFormData({ ...formData, subject: value })}>
                  <SelectTrigger>
                    <SelectValue placeholder="과목 선택" />
                  </SelectTrigger>
                  <SelectContent>
                    {subjects.map(subject => (
                      <SelectItem key={subject.value} value={subject.value}>
                        {subject.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="grade_level">학년</Label>
                <Select value={formData.grade_level} onValueChange={(value) => setFormData({ ...formData, grade_level: value })}>
                  <SelectTrigger>
                    <SelectValue placeholder="학년 선택" />
                  </SelectTrigger>
                  <SelectContent>
                    {gradeLevels.map(grade => (
                      <SelectItem key={grade.value} value={grade.value}>
                        {grade.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="semester">학기</Label>
                <Select value={formData.semester} onValueChange={(value) => setFormData({ ...formData, semester: value })}>
                  <SelectTrigger>
                    <SelectValue placeholder="학기 선택" />
                  </SelectTrigger>
                  <SelectContent>
                    {semesters.map(semester => (
                      <SelectItem key={semester.value} value={semester.value}>
                        {semester.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setIsCreateDialogOpen(false)}>
              취소
            </Button>
            <Button 
              onClick={handleSubmit} 
              disabled={
                !formData.name.trim() || 
                !formData.textbook_type.trim() || 
                !formData.grade_level.trim() || 
                !formData.semester.trim() || 
                !formData.subject.trim()
              }
              title={
                !formData.name.trim() ? '교재 이름을 입력하세요' :
                !formData.textbook_type.trim() ? '교재 타입을 선택하세요' :
                !formData.grade_level.trim() ? '학년을 선택하세요' :
                !formData.semester.trim() ? '학기를 선택하세요' :
                !formData.subject.trim() ? '과목을 선택하세요' :
                '모든 필수 항목이 입력되었습니다'
              }
            >
              생성
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 교재 수정 다이얼로그 */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>교재 수정</DialogTitle>
            <DialogDescription>
              교재 정보를 수정하세요
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="edit-name">교재 이름</Label>
              <Input
                id="edit-name"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="예: 중학교 3학년 1학기 수학"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="edit-description">설명</Label>
              <Input
                id="edit-description"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder="교재에 대한 설명을 입력하세요"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="edit-textbook_type">교재 타입</Label>
                <Select value={formData.textbook_type} onValueChange={(value) => setFormData({ ...formData, textbook_type: value })}>
                  <SelectTrigger>
                    <SelectValue placeholder="교재 타입 선택" />
                  </SelectTrigger>
                  <SelectContent>
                    {textbookTypes.map(type => (
                      <SelectItem key={type.value} value={type.value}>
                        {type.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="edit-subject">과목</Label>
                <Select value={formData.subject} onValueChange={(value) => setFormData({ ...formData, subject: value })}>
                  <SelectTrigger>
                    <SelectValue placeholder="과목 선택" />
                  </SelectTrigger>
                  <SelectContent>
                    {subjects.map(subject => (
                      <SelectItem key={subject.value} value={subject.value}>
                        {subject.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="edit-grade_level">학년</Label>
                <Select value={formData.grade_level} onValueChange={(value) => setFormData({ ...formData, grade_level: value })}>
                  <SelectTrigger>
                    <SelectValue placeholder="학년 선택" />
                  </SelectTrigger>
                  <SelectContent>
                    {gradeLevels.map(grade => (
                      <SelectItem key={grade.value} value={grade.value}>
                        {grade.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="edit-semester">학기</Label>
                <Select value={formData.semester} onValueChange={(value) => setFormData({ ...formData, semester: value })}>
                  <SelectTrigger>
                    <SelectValue placeholder="학기 선택" />
                  </SelectTrigger>
                  <SelectContent>
                    {semesters.map(semester => (
                      <SelectItem key={semester.value} value={semester.value}>
                        {semester.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setIsEditDialogOpen(false)}>
              취소
            </Button>
            <Button 
              onClick={handleSubmit} 
              disabled={
                !formData.name.trim() || 
                !formData.textbook_type.trim() || 
                !formData.grade_level.trim() || 
                !formData.semester.trim() || 
                !formData.subject.trim()
              }
              title={
                !formData.name.trim() ? '교재 이름을 입력하세요' :
                !formData.textbook_type.trim() ? '교재 타입을 선택하세요' :
                !formData.grade_level.trim() ? '학년을 선택하세요' :
                !formData.semester.trim() ? '학기를 선택하세요' :
                !formData.subject.trim() ? '과목을 선택하세요' :
                '모든 필수 항목이 입력되었습니다'
              }
            >
              수정
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default TextbookManagement;
