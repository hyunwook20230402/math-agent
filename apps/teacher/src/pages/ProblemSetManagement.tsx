import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@shared/ui/card';
import { Button } from '@shared/ui/button';
import { Input } from '@shared/ui/input';
import { Badge } from '@shared/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@shared/ui/dialog';
import { Label } from '@shared/ui/label';
import { Textarea } from '@shared/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@shared/ui/select';
import { Checkbox } from '@shared/ui/checkbox';
import { 
  Plus, 
  Copy, 
  Edit, 
  Trash2, 
  GripVertical, 
  BookOpen,
  Users,
  Calendar,
  Star,
  Folder,
  Search,
  Save,
  X,
  Share,
  FileText
} from 'lucide-react';
import { useAuth } from '@shared/hooks/useAuth';
import { useNavigate } from 'react-router-dom';
import { problemSetApi, problemApi } from '@shared/lib/api';
import type { ProblemSetWithProblems, FolderWithChildren, Problem } from '@shared/types/database';

interface ProblemSetFormData {
  name: string;
  description: string;
  folder_id: string;
  is_favorite: boolean;
}

const ProblemSetManagement = () => {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const [problemSets, setProblemSets] = useState<ProblemSetWithProblems[]>([]);
  const [folders, setFolders] = useState<FolderWithChildren[]>([]);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedFolder, setSelectedFolder] = useState<string>('');
  
  // 다이얼로그 상태
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isAddProblemsDialogOpen, setIsAddProblemsDialogOpen] = useState(false);
  const [editingProblemSet, setEditingProblemSet] = useState<ProblemSetWithProblems | null>(null);
  const [selectedProblemSet, setSelectedProblemSet] = useState<ProblemSetWithProblems | null>(null);
  const [formData, setFormData] = useState<ProblemSetFormData>({
    name: '',
    description: '',
    folder_id: '',
    is_favorite: false
  });

  useEffect(() => {
    if (profile) {
      fetchData();
    }
  }, [profile]);

  const fetchData = async () => {
    if (!profile) return;

    try {
      // 폴더 목록 조회
      try {
        const foldersData = await folderApi.getFolders();
        setFolders(foldersData);
        console.log('폴더 조회 성공:', foldersData.length);
        
        // 폴더가 없으면 기본 폴더 생성 시도
        if (foldersData.length === 0) {
          console.log('폴더가 없습니다. 기본 폴더를 생성합니다...');
          // 잠시 대기 후 다시 폴더 조회
          setTimeout(async () => {
            try {
              const newFoldersData = await folderApi.getFolders();
              setFolders(newFoldersData);
              console.log('기본 폴더 생성 후 조회 성공:', newFoldersData.length);
            } catch (retryError) {
              console.error('폴더 재조회 실패:', retryError);
            }
          }, 1000);
        }
      } catch (error) {
        console.error('폴더 조회 실패:', error);
        setFolders([]);
      }

      // 문제 목록 조회
      try {
        const problemsData = await problemApi.getProblems(profile.id);
        setProblems(problemsData);
        console.log('문제 조회 성공:', problemsData.length);
      } catch (error) {
        console.error('문제 조회 실패:', error);
        setProblems([]);
      }

      // 문제 세트 목록 조회 (전체)
      try {
        const problemSetsData = await problemSetApi.getProblemSetsByFolder('');
        setProblemSets(problemSetsData);
        console.log('문제 세트 조회 성공:', problemSetsData.length);
      } catch (error) {
        console.error('문제 세트 조회 실패:', error);
        setProblemSets([]);
      }
      
      setLoading(false);
    } catch (error) {
      console.error('데이터 조회 실패:', error);
      setLoading(false);
    }
  };

  const openCreateDialog = () => {
    setFormData({
      name: '',
      description: '',
      folder_id: '',
      is_favorite: false
    });
    setIsCreateDialogOpen(true);
  };

  const openEditDialog = (problemSet: ProblemSetWithProblems) => {
    setFormData({
      name: problemSet.name,
      description: problemSet.description || '',
      folder_id: problemSet.folder_id,
      is_favorite: problemSet.is_favorite
    });
    setEditingProblemSet(problemSet);
    setIsEditDialogOpen(true);
  };

  const handleCreateProblemSet = async () => {
    if (!profile || !formData.name.trim() || !formData.folder_id) return;

    try {
      console.log('문제 세트 생성 시도:', formData);
      const newProblemSet = await problemSetApi.createProblemSet({
        name: formData.name,
        description: formData.description,
        folder_id: formData.folder_id,
        is_favorite: formData.is_favorite
      });

      console.log('문제 세트 생성 성공:', newProblemSet);
      setIsCreateDialogOpen(false);
      fetchData();
    } catch (error) {
      console.error('문제 세트 생성 실패:', error);
      alert('문제 세트 생성에 실패했습니다. 다시 시도해주세요.');
    }
  };

  const handleUpdateProblemSet = async () => {
    if (!editingProblemSet || !formData.name.trim() || !formData.folder_id) return;

    try {
      await problemSetApi.updateProblemSet(editingProblemSet.id, {
        name: formData.name,
        description: formData.description,
        folder_id: formData.folder_id,
        is_favorite: formData.is_favorite
      });

      setIsEditDialogOpen(false);
      setEditingProblemSet(null);
      fetchData();
    } catch (error) {
      console.error('문제 세트 수정 실패:', error);
    }
  };

  const duplicateProblemSet = async (problemSet: ProblemSetWithProblems) => {
    if (!profile) return;

    try {
      // 새 문제 세트 생성
      const newProblemSet = await problemSetApi.createProblemSet({
        name: `${problemSet.name} (복사본)`,
        description: problemSet.description,
        folder_id: problemSet.folder_id,
        is_favorite: false
      });

      // 문제들을 새 세트에 추가
      if (problemSet.problems.length > 0) {
        const problemIds = problemSet.problems.map(p => p.id);
        await problemSetApi.addProblemsToSet(newProblemSet.id, problemIds);
      }

      fetchData();
    } catch (error) {
      console.error('문제 세트 복사 실패:', error);
    }
  };

  const deleteProblemSet = async (setId: string) => {
    if (!confirm('정말로 이 문제 세트를 삭제하시겠습니까?')) return;

    try {
      await problemSetApi.deleteProblemSet(setId);
      fetchData();
    } catch (error) {
      console.error('문제 세트 삭제 실패:', error);
    }
  };

  const toggleFavorite = async (problemSet: ProblemSetWithProblems) => {
    try {
      await problemSetApi.updateProblemSet(problemSet.id, {
        is_favorite: !problemSet.is_favorite
      });
      
      // 로컬 상태 업데이트
      setProblemSets(prev => prev.map(set => 
        set.id === problemSet.id 
          ? { ...set, is_favorite: !set.is_favorite }
          : set
      ));
    } catch (error) {
      console.error('즐겨찾기 토글 실패:', error);
    }
  };

  // 문제 세트에 문제 추가 다이얼로그 열기
  const openAddProblemsDialog = (problemSet: ProblemSetWithProblems) => {
    setSelectedProblemSet(problemSet);
    setIsAddProblemsDialogOpen(true);
  };

  // 문제를 세트에 추가
  const addProblemsToSet = async (problemIds: string[]) => {
    if (!selectedProblemSet) return;

    try {
      await problemSetApi.addProblemsToSet(selectedProblemSet.id, problemIds);
      alert('문제가 세트에 추가되었습니다!');
      setIsAddProblemsDialogOpen(false);
      setSelectedProblemSet(null);
      fetchData(); // 데이터 새로고침
    } catch (error) {
      console.error('문제 세트 추가 실패:', error);
      alert('문제 세트 추가에 실패했습니다.');
    }
  };

  // 문제 세트의 문제 순서 재정렬
  const reorderProblemsInSet = async (problemSetId: string) => {
    if (!confirm('문제를 번호 순으로 재정렬하시겠습니까?')) return;

    try {
      await problemSetApi.reorderProblemsInSet(problemSetId);
      alert('문제 순서가 재정렬되었습니다!');
      fetchData(); // 데이터 새로고침
    } catch (error) {
      console.error('문제 순서 재정렬 실패:', error);
      alert('문제 순서 재정렬에 실패했습니다.');
    }
  };

  // 폴더를 평면적으로 변환하는 함수
  const flattenFolders = (folders: FolderWithChildren[]): any[] => {
    const result: any[] = [];
    const flatten = (folderList: FolderWithChildren[]) => {
      folderList.forEach(folder => {
        result.push({
          id: folder.id,
          name: folder.name,
          description: folder.description,
          folder_type: folder.folder_type,
          parent_id: folder.parent_id,
          sort_order: folder.sort_order,
          created_at: folder.created_at,
          updated_at: folder.updated_at,
          created_by: folder.created_by
        });
        if (folder.children && folder.children.length > 0) {
          flatten(folder.children);
        }
      });
    };
    flatten(folders);
    return result;
  };

  // 평면화된 폴더 목록
  const flatFolders = flattenFolders(folders);

  // 필터링된 문제 세트
  const filteredSets = problemSets.filter(set => {
    const matchesSearch = set.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         set.description?.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesFolder = !selectedFolder || set.folder_id === selectedFolder;
    return matchesSearch && matchesFolder;
  });



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
    <div className="container mx-auto px-4 py-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-foreground">문제 세트 관리</h1>
          <p className="text-muted-foreground">문제들을 묶어서 세트로 관리하세요</p>
        </div>
        <Button onClick={openCreateDialog} className="flex items-center gap-2">
          <Plus className="h-4 w-4" />
          새 세트 만들기
        </Button>
      </div>

      {/* Search and Filters */}
      <Card>
        <CardContent className="p-6">
          <div className="flex gap-4">
            <div className="flex-1">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="세트 이름으로 검색..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-10"
                />
              </div>
            </div>
                         <Select value={selectedFolder} onValueChange={setSelectedFolder}>
               <SelectTrigger className="w-48">
                 <SelectValue placeholder="폴더 선택" />
               </SelectTrigger>
                                 <SelectContent>
                    <SelectItem value="">전체 폴더</SelectItem>
                    {flatFolders.map(folder => (
                      <SelectItem key={folder.id} value={folder.id}>
                        {folder.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
             </Select>
            <Button variant="outline" onClick={() => {
              setSearchTerm('');
              setSelectedFolder('');
            }}>
              초기화
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Problem Sets Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {filteredSets.map((set) => (
          <Card key={set.id} className="hover:shadow-lg transition-shadow">
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <CardTitle className="text-lg flex items-center gap-2">
                    <BookOpen className="h-5 w-5 text-primary" />
                    {set.name}
                  </CardTitle>
                  {set.description && (
                    <CardDescription className="mt-2">
                      {set.description}
                    </CardDescription>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => toggleFavorite(set)}
                  className={set.is_favorite ? 'text-yellow-500' : 'text-muted-foreground'}
                >
                  <Star className={`h-4 w-4 ${set.is_favorite ? 'fill-current' : ''}`} />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-4 text-sm text-muted-foreground">
                  <div className="flex items-center gap-1">
                    <Users className="h-4 w-4" />
                    {set.problem_count}문제
                  </div>
                  <div className="flex items-center gap-1">
                    <Calendar className="h-4 w-4" />
                    {new Date(set.created_at).toLocaleDateString()}
                  </div>
                </div>
              </div>

              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => openEditDialog(set)}
                  className="flex-1"
                >
                  <Edit className="h-4 w-4 mr-1" />
                  편집
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => openAddProblemsDialog(set)}
                  title="문제 추가"
                >
                  <Plus className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => duplicateProblemSet(set)}
                  title="복사"
                  className="hidden"
                >
                  <Copy className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => navigate(`/teacher/distribute?set=${set.id}`)}
                  title="배포"
                >
                  <Share className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => deleteProblemSet(set.id)}
                  className="text-destructive hover:text-destructive"
                  title="삭제"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              
              {/* 문제 순서 재정렬 버튼 */}
              {set.problems.length > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => reorderProblemsInSet(set.id)}
                  className="mt-2 w-full"
                  title="문제 번호 순으로 재정렬"
                >
                  <GripVertical className="h-4 w-4 mr-1" />
                  순서 재정렬
                </Button>
              )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {filteredSets.length === 0 && (
        <div className="text-center py-12">
          <BookOpen className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
          <h3 className="text-lg font-medium text-muted-foreground mb-2">
            문제 세트가 없습니다
          </h3>
          <p className="text-muted-foreground mb-4">
            첫 번째 문제 세트를 만들어보세요
          </p>
          <Button onClick={openCreateDialog}>
            <Plus className="h-4 w-4 mr-2" />
            새 세트 만들기
          </Button>
        </div>
      )}

      {/* 문제 세트 생성 다이얼로그 */}
      <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>새 문제 세트 생성</DialogTitle>
            <DialogDescription>
              문제들을 묶어서 세트로 만들어보세요
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4">
            <div>
              <Label htmlFor="name">세트 이름</Label>
              <Input
                id="name"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="예: 1~30번, 확통 단원 문제"
              />
            </div>
            
            <div>
              <Label htmlFor="description">설명 (선택사항)</Label>
              <Textarea
                id="description"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder="세트에 대한 설명을 입력하세요"
                rows={3}
              />
            </div>
            
                         <div>
               <Label htmlFor="folder">폴더 선택</Label>
               <Select 
                 value={formData.folder_id} 
                 onValueChange={(value) => setFormData({ ...formData, folder_id: value })}
               >
                 <SelectTrigger>
                   <SelectValue placeholder="폴더를 선택하세요" />
                 </SelectTrigger>
                 <SelectContent>
                   {flatFolders.length > 0 ? (
                     flatFolders.map(folder => (
                       <SelectItem key={folder.id} value={folder.id}>
                         {folder.name}
                       </SelectItem>
                     ))
                   ) : (
                     <SelectItem value="" disabled>
                       폴더가 없습니다
                     </SelectItem>
                   )}
                 </SelectContent>
               </Select>
               {flatFolders.length === 0 && (
                 <p className="text-sm text-muted-foreground mt-1">
                   먼저 폴더를 생성해주세요
                 </p>
               )}
             </div>
            
            <div className="flex items-center space-x-2">
              <Checkbox
                id="favorite"
                checked={formData.is_favorite}
                onCheckedChange={(checked) => 
                  setFormData({ ...formData, is_favorite: checked as boolean })
                }
              />
              <Label htmlFor="favorite">즐겨찾기에 추가</Label>
            </div>
          </div>
          
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsCreateDialogOpen(false)}>
              <X className="h-4 w-4 mr-2" />
              취소
            </Button>
            <Button 
              onClick={handleCreateProblemSet} 
              disabled={!formData.name.trim() || !formData.folder_id}
            >
              <Save className="h-4 w-4 mr-2" />
              생성
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 문제 세트 수정 다이얼로그 */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>문제 세트 수정</DialogTitle>
            <DialogDescription>
              문제 세트 정보를 수정하세요
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4">
            <div>
              <Label htmlFor="edit-name">세트 이름</Label>
              <Input
                id="edit-name"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="예: 1~30번, 확통 단원 문제"
              />
            </div>
            
            <div>
              <Label htmlFor="edit-description">설명 (선택사항)</Label>
              <Textarea
                id="edit-description"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder="세트에 대한 설명을 입력하세요"
                rows={3}
              />
            </div>
            
                         <div>
               <Label htmlFor="edit-folder">폴더 선택</Label>
               <Select 
                 value={formData.folder_id} 
                 onValueChange={(value) => setFormData({ ...formData, folder_id: value })}
               >
                 <SelectTrigger>
                   <SelectValue placeholder="폴더를 선택하세요" />
                 </SelectTrigger>
                 <SelectContent>
                   {flatFolders.length > 0 ? (
                     flatFolders.map(folder => (
                       <SelectItem key={folder.id} value={folder.id}>
                         {folder.name}
                       </SelectItem>
                     ))
                   ) : (
                     <SelectItem value="" disabled>
                       폴더가 없습니다
                     </SelectItem>
                   )}
                 </SelectContent>
               </Select>
             </div>
            
            <div className="flex items-center space-x-2">
              <Checkbox
                id="edit-favorite"
                checked={formData.is_favorite}
                onCheckedChange={(checked) => 
                  setFormData({ ...formData, is_favorite: checked as boolean })
                }
              />
              <Label htmlFor="edit-favorite">즐겨찾기에 추가</Label>
            </div>
          </div>
          
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsEditDialogOpen(false)}>
              <X className="h-4 w-4 mr-2" />
              취소
            </Button>
            <Button 
              onClick={handleUpdateProblemSet} 
              disabled={!formData.name.trim() || !formData.folder_id}
            >
              <Save className="h-4 w-4 mr-2" />
              수정
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 문제 추가 다이얼로그 */}
      <Dialog open={isAddProblemsDialogOpen} onOpenChange={setIsAddProblemsDialogOpen}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>문제 세트에 문제 추가</DialogTitle>
            <DialogDescription>
              "{selectedProblemSet?.name}" 세트에 추가할 문제를 선택하세요
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4">
            {problems.length > 0 ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-h-96 overflow-y-auto">
                {problems.map((problem) => (
                  <div key={problem.id} className="flex items-center space-x-3 p-3 border rounded-lg">
                    <Checkbox
                      id={`problem-${problem.id}`}
                      onCheckedChange={(checked) => {
                        if (checked) {
                          // 문제를 세트에 추가
                          addProblemsToSet([problem.id]);
                        }
                      }}
                    />
                    <div className="flex-1">
                      <Label htmlFor={`problem-${problem.id}`} className="font-medium">
                        {problem.title}
                      </Label>
                      <p className="text-sm text-muted-foreground">
                        카테고리: {problem.unit || '기타'} | 난이도: {problem.difficulty}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-8 text-muted-foreground">
                <FileText className="h-12 w-12 mx-auto mb-4" />
                <p>등록된 문제가 없습니다</p>
                <Button 
                  className="mt-4" 
                  onClick={() => navigate('/teacher/add-problem')}
                >
                  새 문제 등록
                </Button>
              </div>
            )}
          </div>
          
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsAddProblemsDialogOpen(false)}>
              닫기
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default ProblemSetManagement;
