import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@shared/ui/card';
import { Button } from '@shared/ui/button';
import { Input } from '@shared/ui/input';
import { Badge } from '@shared/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@shared/ui/dialog';
import { Label } from '@shared/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@shared/ui/select';
import { 
  Plus, 
  Folder, 
  FolderOpen, 
  Edit, 
  Trash2, 
  ChevronRight,
  BookOpen,
  Users,
  Calendar,
  Save,
  X
} from 'lucide-react';
import { useAuth } from '@shared/hooks/useAuth';
import { useNavigate } from 'react-router-dom';
import { problemSetApi } from '@shared/lib/api';
import type { FolderWithChildren, ProblemSet } from '@shared/types/database';

interface FolderFormData {
  name: string;
  folder_type: 'grade' | 'semester' | 'textbook';
  parent_id?: string;
}

const FolderManagement = () => {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const [folders, setFolders] = useState<FolderWithChildren[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  
  // 폴더 생성/수정 다이얼로그 상태
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingFolder, setEditingFolder] = useState<FolderWithChildren | null>(null);
  const [formData, setFormData] = useState<FolderFormData>({
    name: '',
    folder_type: 'grade'
  });

  useEffect(() => {
    if (profile) {
      fetchFolders();
    }
  }, [profile]);

  const fetchFolders = async () => {
    if (!profile) return;

    try {
      const foldersData = await folderApi.getFolders();
      setFolders(foldersData);
      setLoading(false);
    } catch (error) {
      console.error('폴더 조회 실패:', error);
      setLoading(false);
    }
  };

  const openCreateDialog = (type: 'grade' | 'semester' | 'textbook', parentId?: string) => {
    setFormData({
      name: '',
      folder_type: type,
      parent_id: parentId
    });
    setEditingFolder(null);
    setIsDialogOpen(true);
  };

  const openEditDialog = (folder: FolderWithChildren) => {
    setFormData({
      name: folder.name,
      folder_type: folder.folder_type,
      parent_id: folder.parent_id || undefined
    });
    setEditingFolder(folder);
    setIsDialogOpen(true);
  };

  const handleSubmit = async () => {
    if (!profile || !formData.name.trim()) return;

    try {
      if (editingFolder) {
        // 폴더 수정
        await folderApi.updateFolder(editingFolder.id, {
          name: formData.name,
          folder_type: formData.folder_type,
          parent_id: formData.parent_id
        });
      } else {
        // 폴더 생성
        await folderApi.createFolder({
          name: formData.name,
          folder_type: formData.folder_type,
          parent_id: formData.parent_id,
          teacher_id: profile.id
        });
      }
      
      setIsDialogOpen(false);
      fetchFolders();
    } catch (error) {
      console.error('폴더 저장 실패:', error);
    }
  };

  const deleteFolder = async (folderId: string) => {
    if (!confirm('정말로 이 폴더를 삭제하시겠습니까? 하위 폴더와 문제 세트도 함께 삭제됩니다.')) return;

    try {
      await folderApi.deleteFolder(folderId);
      fetchFolders();
    } catch (error) {
      console.error('폴더 삭제 실패:', error);
    }
  };

  const toggleExpanded = (folderId: string) => {
    const newExpanded = new Set(expandedFolders);
    if (newExpanded.has(folderId)) {
      newExpanded.delete(folderId);
    } else {
      newExpanded.add(folderId);
    }
    setExpandedFolders(newExpanded);
  };

  // 폴더 타입별 이름 가져오기
  const getFolderTypeName = (type: string) => {
    switch (type) {
      case 'grade': return '학년';
      case 'semester': return '학기';
      case 'textbook': return '교재';
      default: return type;
    }
  };

  // 부모 폴더 옵션 가져오기
  const getParentOptions = () => {
    const options: { id: string; name: string; type: string }[] = [];
    
    const addFolderOptions = (folderList: FolderWithChildren[], level: number = 0) => {
      folderList.forEach(folder => {
        if (editingFolder && folder.id === editingFolder.id) return; // 자기 자신은 제외
        
        const prefix = '　'.repeat(level);
        options.push({
          id: folder.id,
          name: `${prefix}${folder.name}`,
          type: folder.folder_type
        });
        
        if (folder.children && folder.children.length > 0) {
          addFolderOptions(folder.children, level + 1);
        }
      });
    };
    
    addFolderOptions(folders);
    return options;
  };

  const renderFolder = (folder: FolderWithChildren, level: number = 0) => {
    const isExpanded = expandedFolders.has(folder.id);
    const hasChildren = folder.children && folder.children.length > 0;
    const problemSetCount = folder.problem_sets?.length || 0;

    return (
      <div key={folder.id} className="space-y-2">
        <Card className={`hover:shadow-md transition-shadow ${level > 0 ? 'ml-6' : ''}`}>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => toggleExpanded(folder.id)}
                  className="p-1 h-auto"
                >
                  {hasChildren ? (
                    <ChevronRight className={`h-4 w-4 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
                  ) : (
                    <div className="w-4 h-4" />
                  )}
                </Button>
                <div className="flex items-center gap-2">
                  {isExpanded ? (
                    <FolderOpen className="h-5 w-5 text-primary" />
                  ) : (
                    <Folder className="h-5 w-5 text-muted-foreground" />
                  )}
                  <CardTitle className="text-lg">{folder.name}</CardTitle>
                  <Badge variant="outline">
                    {getFolderTypeName(folder.folder_type)}
                  </Badge>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <div className="text-sm text-muted-foreground flex items-center gap-1">
                  <BookOpen className="h-4 w-4" />
                  {problemSetCount}개 세트
                </div>
                
                {/* 하위 폴더 추가 버튼들 */}
                {folder.folder_type === 'grade' && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => openCreateDialog('semester', folder.id)}
                    title="학기 추가"
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                )}
                
                {folder.folder_type === 'semester' && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => openCreateDialog('textbook', folder.id)}
                    title="교재 추가"
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                )}
                
                {/* 편집 버튼 */}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => openEditDialog(folder)}
                  title="편집"
                >
                  <Edit className="h-4 w-4" />
                </Button>
                
                {/* 삭제 버튼 */}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => deleteFolder(folder.id)}
                  className="text-destructive hover:text-destructive"
                  title="삭제"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </CardHeader>
        </Card>
        
        {isExpanded && hasChildren && (
          <div className="space-y-2">
            {folder.children!.map(child => renderFolder(child, level + 1))}
          </div>
        )}
      </div>
    );
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
    <div className="container mx-auto px-4 py-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-foreground">폴더 관리</h1>
          <p className="text-muted-foreground">학년/학기/교재별로 문제를 체계적으로 관리하세요</p>
        </div>
        <Button 
          onClick={() => openCreateDialog('grade')} 
          className="flex items-center gap-2"
        >
          <Plus className="h-4 w-4" />
          새 학년 추가
        </Button>
      </div>

      {/* Folder Structure */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Folder className="h-4 w-4" />
          폴더 구조: 학년 → 학기 → 교재
        </div>
        
        {folders.length === 0 ? (
          <div className="text-center py-12">
            <Folder className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            <h3 className="text-lg font-medium text-muted-foreground mb-2">
              폴더가 없습니다
            </h3>
            <p className="text-muted-foreground mb-4">
              첫 번째 학년 폴더를 만들어보세요
            </p>
            <Button onClick={() => openCreateDialog('grade')}>
              <Plus className="h-4 w-4 mr-2" />
              새 학년 추가
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {folders.map(folder => renderFolder(folder))}
          </div>
        )}
      </div>

      {/* Quick Actions */}
      <Card>
        <CardHeader>
          <CardTitle>빠른 작업</CardTitle>
          <CardDescription>자주 사용하는 폴더 구조를 빠르게 생성하세요</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Button
              variant="outline"
              onClick={() => openCreateDialog('grade')}
            >
              고등학교 1학년
            </Button>
            <Button
              variant="outline"
              onClick={() => openCreateDialog('grade')}
            >
              중학교 3학년
            </Button>
            <Button
              variant="outline"
              onClick={() => openCreateDialog('grade')}
            >
              초등학교 6학년
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* 폴더 생성/수정 다이얼로그 */}
      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editingFolder ? '폴더 수정' : '새 폴더 생성'}
            </DialogTitle>
            <DialogDescription>
              {editingFolder 
                ? '폴더 정보를 수정하세요'
                : `${getFolderTypeName(formData.folder_type)} 폴더를 생성하세요`
              }
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4">
            <div>
              <Label htmlFor="name">폴더 이름</Label>
              <Input
                id="name"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder={`${getFolderTypeName(formData.folder_type)} 이름을 입력하세요`}
              />
            </div>
            
            {!editingFolder && (
              <div>
                <Label htmlFor="folder_type">폴더 타입</Label>
                <Select 
                  value={formData.folder_type} 
                  onValueChange={(value: 'grade' | 'semester' | 'textbook') => 
                    setFormData({ ...formData, folder_type: value })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="grade">학년</SelectItem>
                    <SelectItem value="semester">학기</SelectItem>
                    <SelectItem value="textbook">교재</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
            
            {formData.folder_type !== 'grade' && (
              <div>
                <Label htmlFor="parent">상위 폴더</Label>
                <Select 
                  value={formData.parent_id || ''} 
                  onValueChange={(value) => 
                    setFormData({ ...formData, parent_id: value || undefined })
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="상위 폴더 선택" />
                  </SelectTrigger>
                  <SelectContent>
                    {getParentOptions().map(option => (
                      <SelectItem key={option.id} value={option.id}>
                        {option.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsDialogOpen(false)}>
              <X className="h-4 w-4 mr-2" />
              취소
            </Button>
            <Button onClick={handleSubmit} disabled={!formData.name.trim()}>
              <Save className="h-4 w-4 mr-2" />
              {editingFolder ? '수정' : '생성'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default FolderManagement;
