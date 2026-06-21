import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@shared/ui/card';
import { formatDifficultyScore } from '@shared/lib/utils';
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
import { useTextbook } from '@/context/TextbookContext';

interface ProblemSetFormData {
  name: string;
  description: string;
  folder_id: string;
  is_favorite: boolean;
}

const ProblemSetManagement = () => {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const { selectedTextbook, breadcrumb } = useTextbook();
  const [problemSets, setProblemSets] = useState<ProblemSetWithProblems[]>([]);
  const [folders, setFolders] = useState<FolderWithChildren[]>([]);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedFolder, setSelectedFolder] = useState<string>('all');
  
  // 다이얼로그 상태
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [selectedProblemSet, setSelectedProblemSet] = useState<ProblemSetWithProblems | null>(null);
  
  // 문제 선택 상태
  const [selectedProblems, setSelectedProblems] = useState<Set<string>>(new Set());
  const [problemSearchTerm, setProblemSearchTerm] = useState('');
  const [problemCategoryFilter, setProblemCategoryFilter] = useState<string>('all');
  const [problemDifficultyFilter, setProblemDifficultyFilter] = useState<string>('all');
  
  // 폼 데이터
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
      console.log('실제 데이터베이스에서 데이터 로드');
      
      // 실제 폴더 데이터 조회
      const foldersData = await problemSetApi.getFolders();
      setFolders(foldersData);

      // 실제 데이터베이스에서 문제 조회
      console.log('실제 데이터베이스에서 문제 조회');
      console.log('현재 profile:', profile);
      console.log('profile.id:', profile.id);
      
      const actualProblems = await problemApi.getProblems(profile.id);
      console.log('조회된 실제 문제들:', actualProblems);
      setProblems(actualProblems);

      // 실제 문제 세트 데이터 조회 (현재 사용자만)
      console.log('현재 사용자의 문제 세트 조회, profile.id:', profile.id);
      const problemSetsData = await problemSetApi.getProblemSets(profile.id);
      console.log('조회된 문제 세트들:', problemSetsData);
      setProblemSets(problemSetsData);
      
      setLoading(false);
    } catch (error) {
      console.error('데이터 로드 실패:', error);
      
      // 오류 발생 시 빈 데이터로 초기화
      setFolders([]);
      setProblems([]);
      setProblemSets([]);
      
      setLoading(false);
    }
  };

  const handleCreateProblemSet = async () => {
    console.log('handleCreateProblemSet 함수 호출됨');
    console.log('profile:', profile);
    console.log('formData:', formData);
    console.log('selectedProblems:', selectedProblems);
    
    if (!profile) {
      console.log('profile이 없어서 함수 종료');
      return;
    }
    
    // 세트 이름이 없으면 기본값 설정
    const setName = formData.name.trim() || `문제 세트 ${new Date().toLocaleDateString()}`;
    console.log('설정된 세트 이름:', setName);

    try {
      console.log('문제 세트 생성 시작');
      const newProblemSet = await problemSetApi.createProblemSet({
        ...formData,
        name: setName
      });
      
      console.log('문제 세트 생성 성공:', newProblemSet);
      
      // 선택된 문제들을 문제 세트에 연결
      if (selectedProblems.size > 0) {
        console.log('선택된 문제들을 문제 세트에 연결:', Array.from(selectedProblems));
        
        try {
          await problemSetApi.addProblemsToSet(newProblemSet.id, Array.from(selectedProblems));
          console.log('문제들 연결 성공');
        } catch (linkError) {
          console.error('문제 연결 실패:', linkError);
          // 문제 연결이 실패해도 문제 세트는 생성되었으므로 계속 진행
        }
      }
      
      // 데이터 다시 로드하여 최신 상태 반영
      await fetchData();
      setIsCreateDialogOpen(false);
      resetForm();
    } catch (error) {
      console.error('문제 세트 생성 실패:', error);
    }
  };

  const handleUpdateProblemSet = async () => {
    if (!selectedProblemSet) return;

    try {
      const updatedProblemSet = await problemSetApi.updateProblemSet(
        selectedProblemSet.id,
        formData
      );
      
      setProblemSets(prev => 
        prev.map(ps => ps.id === selectedProblemSet.id ? updatedProblemSet : ps)
      );
      setIsEditDialogOpen(false);
      resetForm();
    } catch (error) {
      console.error('문제 세트 수정 실패:', error);
    }
  };

  const handleDeleteProblemSet = async () => {
    if (!selectedProblemSet) return;

    try {
      await problemSetApi.deleteProblemSet(selectedProblemSet.id);
      setProblemSets(prev => prev.filter(ps => ps.id !== selectedProblemSet.id));
      setIsDeleteDialogOpen(false);
      setSelectedProblemSet(null);
    } catch (error) {
      console.error('문제 세트 삭제 실패:', error);
    }
  };

  const resetForm = () => {
    setFormData({
      name: '',
      description: '',
      folder_id: '',
      is_favorite: false
    });
    setSelectedProblemSet(null);
    setSelectedProblems(new Set());
    setProblemSearchTerm('');
    setProblemCategoryFilter('all');
    setProblemDifficultyFilter('all');
  };

  // 문제 필터링
  const filteredProblems = problems.filter(problem => {
    const matchesSearch = problem.title.toLowerCase().includes(problemSearchTerm.toLowerCase()) ||
                         problem.category.toLowerCase().includes(problemSearchTerm.toLowerCase());
    const matchesCategory = problemCategoryFilter === 'all' || problem.category === problemCategoryFilter;
    const matchesDifficulty = problemDifficultyFilter === 'all' || problem.difficulty === problemDifficultyFilter;
    return matchesSearch && matchesCategory && matchesDifficulty;
  });

  // 문제 선택/해제
  const toggleProblemSelection = (problemId: string) => {
    const newSelected = new Set(selectedProblems);
    if (newSelected.has(problemId)) {
      newSelected.delete(problemId);
    } else {
      newSelected.add(problemId);
    }
    setSelectedProblems(newSelected);
  };

  // 전체 선택/해제
  const toggleAllProblems = () => {
    if (selectedProblems.size === filteredProblems.length) {
      setSelectedProblems(new Set());
    } else {
      setSelectedProblems(new Set(filteredProblems.map(p => p.id)));
    }
  };

  // 필터 초기화
  const resetProblemFilters = () => {
    setProblemSearchTerm('');
    setProblemCategoryFilter('all');
    setProblemDifficultyFilter('all');
  };

  const openEditDialog = (problemSet: ProblemSetWithProblems) => {
    setSelectedProblemSet(problemSet);
    setFormData({
      name: problemSet.name,
      description: problemSet.description || '',
      folder_id: problemSet.folder_id || '',
      is_favorite: problemSet.is_favorite || false
    });
    
    // 기존 문제 세트에 포함된 문제들을 선택된 상태로 설정
    const existingProblemIds = new Set(problemSet.problems?.map(p => p.id) || []);
    setSelectedProblems(existingProblemIds);
    
    setIsEditDialogOpen(true);
  };

  const openDeleteDialog = (problemSet: ProblemSetWithProblems) => {
    setSelectedProblemSet(problemSet);
    setIsDeleteDialogOpen(true);
  };

  // 필터링된 문제 세트
  const filteredProblemSets = problemSets.filter(ps => {
    const matchesSearch = ps.name.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesFolder = selectedFolder === 'all' || ps.folder_id === selectedFolder;
    return matchesSearch && matchesFolder;
  });

  if (loading) {
    return (
      <div className="container mx-auto px-4 py-6">
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
          <p className="ml-3 text-muted-foreground">데이터를 불러오는 중...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-6 space-y-6">
      {/* 헤더 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-foreground">문제 세트 관리</h1>
          <p className="text-muted-foreground">문제 세트를 생성하고 관리합니다</p>
        </div>
        <Button onClick={() => setIsCreateDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-2" />
          새 문제 세트 생성
        </Button>
      </div>

      {/* 검색 및 필터 */}
          <div className="flex gap-4">
        <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
            placeholder="문제 세트 검색..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-10"
                />
            </div>
            <Select value={selectedFolder} onValueChange={setSelectedFolder}>
              <SelectTrigger className="w-48">
                <SelectValue placeholder="폴더 선택" />
              </SelectTrigger>
                             <SelectContent>
                 <SelectItem value="all">전체 폴더</SelectItem>
            {folders.map((folder) => (
                   <SelectItem key={folder.id} value={folder.id}>
                <div className="flex items-center gap-2">
                  <Folder className="h-4 w-4" />
                     {folder.name}
                </div>
                   </SelectItem>
                 ))}
               </SelectContent>
            </Select>
          </div>

      {/* 문제 세트 목록 */}
       <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {filteredProblemSets.length === 0 ? (
          <div className="col-span-full text-center py-12">
            <BookOpen className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
            <h3 className="text-lg font-medium mb-2">문제 세트가 없습니다</h3>
            <p className="text-muted-foreground mb-4">
              새 문제 세트를 생성하여 문제들을 관리해보세요
            </p>
            <Button onClick={() => setIsCreateDialogOpen(true)}>
              <Plus className="h-4 w-4 mr-2" />
              첫 번째 문제 세트 만들기
            </Button>
          </div>
        ) : (
          filteredProblemSets.map((problemSet) => (
            <Card key={problemSet.id} className="hover:shadow-md transition-shadow">
              <CardHeader>
              <div className="flex items-start justify-between">
                <div className="flex-1">
                    <CardTitle className="flex items-center gap-2">
                      {problemSet.name}
                      {problemSet.is_favorite && (
                        <Star className="h-4 w-4 fill-yellow-400 text-yellow-400" />
                      )}
                  </CardTitle>
                    <CardDescription>
                      {problemSet.description || '설명이 없습니다'}
                    </CardDescription>
                </div>
                  <div className="flex gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                      onClick={() => openEditDialog(problemSet)}
                    >
                      <Edit className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => openDeleteDialog(problemSet)}
                    >
                      <Trash2 className="h-4 w-4" />
                </Button>
                  </div>
              </div>
            </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <FileText className="h-4 w-4" />
                    <span>{problemSet.problemCount || 0}개 문제</span>
                  </div>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Calendar className="h-4 w-4" />
                    <span>
                      {new Date(problemSet.created_at).toLocaleDateString('ko-KR')}
                    </span>
                  </div>
                  <div className="flex gap-2 pt-2">
                 <Button
                   variant="outline"
                   size="sm"
                   className="flex-1"
                   onClick={() => openEditDialog(problemSet)}
                 >
                      <Edit className="h-4 w-4 mr-2" />
                   편집
                 </Button>
                 <Button
                   variant="outline"
                   size="sm"
                   className="flex-1"
                   onClick={() => navigate(`/teacher/distribute?set=${problemSet.id}`)}
                 >
                      <Share className="h-4 w-4 mr-2" />
                      배포
                 </Button>
               </div>
                </div>
            </CardContent>
          </Card>
          ))
        )}
      </div>

      {/* 생성 다이얼로그 */}
       <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
        <DialogContent className="sm:max-w-[800px] max-h-[90vh] overflow-hidden flex flex-col">
           <DialogHeader>
             <DialogTitle>새 문제 세트 생성</DialogTitle>
             <DialogDescription>
               원하는 문제들을 선택하여 세트로 만들어보세요
             </DialogDescription>
           </DialogHeader>
           
          <div className="flex-1 overflow-hidden flex flex-col gap-4">
            {/* 세트 정보 */}
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="name">세트 이름 *</Label>
                <Input
                  id="name"
                  value={formData.name}
                    onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                  placeholder="예: 1~30번, 확통 단원 문제"
                />
              </div>
                <div className="space-y-2">
                  <Label htmlFor="folder">폴더</Label>
                  <Select 
                    value={formData.folder_id} 
                    onValueChange={(value) => setFormData(prev => ({ ...prev, folder_id: value }))}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="폴더를 선택하세요" />
                    </SelectTrigger>
                    <SelectContent>
                      {folders.map((folder) => (
                        <SelectItem key={folder.id} value={folder.id}>
                          <div className="flex items-center gap-2">
                            <Folder className="h-4 w-4" />
                            {folder.name}
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-2">
               <Label htmlFor="description">설명 (선택사항)</Label>
               <Textarea
                 id="description"
                 value={formData.description}
                  onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                 placeholder="세트에 대한 설명을 입력하세요"
                 rows={2}
               />
             </div>
             <div className="flex items-center space-x-2">
               <Checkbox
                 id="favorite"
                 checked={formData.is_favorite}
                 onCheckedChange={(checked) => 
                    setFormData(prev => ({ ...prev, is_favorite: checked as boolean }))
                 }
               />
               <Label htmlFor="favorite">즐겨찾기에 추가</Label>
                  </div>
                </div>
                
            {/* 문제 선택 */}
            <div className="flex-1 flex flex-col space-y-4">
              <div>
                <h3 className="text-lg font-medium mb-2">문제 선택</h3>
                <div className="text-sm text-muted-foreground mb-4">
                  선택된 문제: {selectedProblems.size}개 | 전체 문제: {problems.length}개 | 필터된 문제: {filteredProblems.length}개
                </div>
                </div>

                {/* 검색 및 필터 */}
              <div className="space-y-3">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      placeholder="문제 제목이나 카테고리로 검색..."
                      value={problemSearchTerm}
                      onChange={(e) => setProblemSearchTerm(e.target.value)}
                      className="pl-10"
                    />
                  </div>
                <div className="flex gap-2">
                  <Select value={problemCategoryFilter} onValueChange={setProblemCategoryFilter}>
                    <SelectTrigger className="w-40">
                      <SelectValue placeholder="전체 카테고리" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">전체 카테고리</SelectItem>
                      {Array.from(new Set(problems.map(p => p.category))).map(category => (
                        <SelectItem key={category} value={category}>{category}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  <Select value={problemDifficultyFilter} onValueChange={setProblemDifficultyFilter}>
                    <SelectTrigger className="w-40">
                      <SelectValue placeholder="전체 난이도" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">전체 난이도</SelectItem>
                      <SelectItem value="1">난이도 1</SelectItem>
                      <SelectItem value="2">난이도 2</SelectItem>
                      <SelectItem value="3">난이도 3</SelectItem>
                      <SelectItem value="4">난이도 4</SelectItem>
                      <SelectItem value="5">난이도 5</SelectItem>
                      </SelectContent>
                    </Select>
                  <Button variant="outline" size="sm" onClick={resetProblemFilters}>
                    필터 초기화
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setSelectedProblems(new Set())}>
                    선택 해제
                  </Button>
                  <Button variant="outline" size="sm" onClick={toggleAllProblems}>
                    필터된 문제 전체 선택
                  </Button>
                </div>
                </div>
                
              {/* 문제 목록 */}
              <div className="flex-1 overflow-auto border rounded-lg p-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {filteredProblems.length === 0 ? (
                    <div className="col-span-2 text-center py-8 text-muted-foreground">
                      <FileText className="h-12 w-12 mx-auto mb-4" />
                      <p>선택 조건에 맞는 문제가 없습니다.</p>
                      <p className="text-sm mt-2">검색어나 필터를 변경해보세요.</p>
                    </div>
                  ) : (
                      filteredProblems.map((problem) => (
                      <div key={problem.id} className="flex items-start gap-3 p-3 border rounded-lg hover:bg-muted/50">
                          <Checkbox
                          checked={selectedProblems.has(problem.id)}
                          onCheckedChange={() => toggleProblemSelection(problem.id)}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-sm truncate">{problem.title}</div>
                          <div className="text-xs text-muted-foreground mt-1">
                            {problem.category} | 난이도: {(problem as any).difficulty_score != null ? formatDifficultyScore((problem as any).difficulty_score) : '-'}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {problem.unit}
                        </div>
                      </div>
                      </div>
                    ))
                    )}
                  </div>
                  </div>
              </div>
           </div>
           
           <DialogFooter>
            <Button variant="outline" onClick={() => setIsCreateDialogOpen(false)}>
               취소
             </Button>
             <Button 
               onClick={handleCreateProblemSet} 
              disabled={selectedProblems.size === 0}
             >
              {selectedProblems.size}개 문제로 세트 생성
             </Button>
           </DialogFooter>
         </DialogContent>
       </Dialog>

      {/* 수정 다이얼로그 */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent className="sm:max-w-[800px] max-h-[80vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle>문제 세트 수정</DialogTitle>
            <DialogDescription>
              문제 세트 정보를 수정하고 문제를 선택하세요
            </DialogDescription>
          </DialogHeader>
          
          <div className="flex-1 overflow-hidden flex flex-col gap-4">
            {/* 세트 정보 */}
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="edit-name">세트 이름 *</Label>
              <Input
                id="edit-name"
                value={formData.name}
                    onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                placeholder="예: 1~30번, 확통 단원 문제"
              />
            </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-folder">폴더</Label>
                  <Select 
                    value={formData.folder_id} 
                    onValueChange={(value) => setFormData(prev => ({ ...prev, folder_id: value }))}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="폴더를 선택하세요" />
                    </SelectTrigger>
                    <SelectContent>
                      {folders.map((folder) => (
                        <SelectItem key={folder.id} value={folder.id}>
                          <div className="flex items-center gap-2">
                            <Folder className="h-4 w-4" />
                            {folder.name}
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-2">
              <Label htmlFor="edit-description">설명 (선택사항)</Label>
              <Textarea
                id="edit-description"
                value={formData.description}
                  onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                placeholder="세트에 대한 설명을 입력하세요"
                rows={2}
              />
            </div>
            <div className="flex items-center space-x-2">
              <Checkbox
                id="edit-favorite"
                checked={formData.is_favorite}
                onCheckedChange={(checked) => 
                    setFormData(prev => ({ ...prev, is_favorite: checked as boolean }))
                }
              />
              <Label htmlFor="edit-favorite">즐겨찾기에 추가</Label>
                </div>
              </div>
              
            {/* 문제 선택 */}
            <div className="flex-1 flex flex-col space-y-4 min-h-0">
              <div>
                <h3 className="text-lg font-medium mb-2">문제 선택</h3>
              <div className="text-sm text-muted-foreground mb-4">
                  선택된 문제: {selectedProblems.size}개 | 전체 문제: {problems.length}개 | 필터된 문제: {filteredProblems.length}개
                </div>
              </div>

              {/* 검색 및 필터 */}
              <div className="space-y-3">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="문제 제목이나 카테고리로 검색..."
                    value={problemSearchTerm}
                    onChange={(e) => setProblemSearchTerm(e.target.value)}
                    className="pl-10"
                  />
                </div>
                <div className="flex gap-2">
                  <Select value={problemCategoryFilter} onValueChange={setProblemCategoryFilter}>
                    <SelectTrigger className="w-40">
                      <SelectValue placeholder="전체 카테고리" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">전체 카테고리</SelectItem>
                      {Array.from(new Set(problems.map(p => p.category))).map(category => (
                        <SelectItem key={category} value={category}>{category}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={problemDifficultyFilter} onValueChange={setProblemDifficultyFilter}>
                    <SelectTrigger className="w-40">
                      <SelectValue placeholder="전체 난이도" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">전체 난이도</SelectItem>
                      <SelectItem value="1">난이도 1</SelectItem>
                      <SelectItem value="2">난이도 2</SelectItem>
                      <SelectItem value="3">난이도 3</SelectItem>
                      <SelectItem value="4">난이도 4</SelectItem>
                      <SelectItem value="5">난이도 5</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button variant="outline" size="sm" onClick={resetProblemFilters}>
                  필터 초기화
                </Button>
                  <Button variant="outline" size="sm" onClick={() => setSelectedProblems(new Set())}>
                    선택 해제
                  </Button>
                  <Button variant="outline" size="sm" onClick={toggleAllProblems}>
                    필터된 문제 전체 선택
                  </Button>
                </div>
              </div>
              
              {/* 문제 목록 */}
              <div className="flex-1 overflow-y-auto border rounded-lg p-4 min-h-0 scrollbar-thin scrollbar-thumb-gray-300 scrollbar-track-gray-100">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {filteredProblems.length === 0 ? (
                    <div className="col-span-2 text-center py-8 text-muted-foreground">
                      <FileText className="h-12 w-12 mx-auto mb-4" />
                      <p>선택 조건에 맞는 문제가 없습니다.</p>
                      <p className="text-sm mt-2">검색어나 필터를 변경해보세요.</p>
                    </div>
                  ) : (
                    filteredProblems.map((problem) => (
                      <div key={problem.id} className="flex items-start gap-3 p-3 border rounded-lg hover:bg-muted/50">
                          <Checkbox
                          checked={selectedProblems.has(problem.id)}
                          onCheckedChange={() => toggleProblemSelection(problem.id)}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-sm truncate">{problem.title}</div>
                          <div className="text-xs text-muted-foreground mt-1">
                            {problem.category} | 난이도: {(problem as any).difficulty_score != null ? formatDifficultyScore((problem as any).difficulty_score) : '-'}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {problem.unit}
                        </div>
                    </div>
                      </div>
                    ))
                  )}
                </div>
                </div>
            </div>
          </div>
          
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsEditDialogOpen(false)}>
              취소
            </Button>
            <Button 
              onClick={handleUpdateProblemSet}
              disabled={!formData.name.trim()}
            >
              <Save className="h-4 w-4 mr-2" />
              저장
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 삭제 다이얼로그 */}
      <Dialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <DialogContent>
           <DialogHeader>
            <DialogTitle>문제 세트 삭제</DialogTitle>
             <DialogDescription>
              정말로 "{selectedProblemSet?.name}" 문제 세트를 삭제하시겠습니까?
              <br />
              이 작업은 되돌릴 수 없습니다.
             </DialogDescription>
           </DialogHeader>
           <DialogFooter>
            <Button variant="outline" onClick={() => setIsDeleteDialogOpen(false)}>
               취소
             </Button>
            <Button variant="destructive" onClick={handleDeleteProblemSet}>
              <Trash2 className="h-4 w-4 mr-2" />
              삭제
               </Button>
           </DialogFooter>
         </DialogContent>
       </Dialog>
     </div>
   );
 };

export default ProblemSetManagement;