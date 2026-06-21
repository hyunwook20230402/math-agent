import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@shared/ui/card';
import { formatDifficultyScore, getDifficultyColor as getDifficultyColorShared } from '@shared/lib/utils';
import { Button } from '@shared/ui/button';
import { Input } from '@shared/ui/input';
import { Badge } from '@shared/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@shared/ui/select';
import {
  Plus,
  Search,
  Filter,
  FileText,
  Tag,
  BarChart3,
  Edit,
  Trash2,
  Upload,
  Eye,
  Download,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  BookOpen
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@shared/hooks/useAuth';
import { problemApi } from '@shared/lib/api';
import { supabase } from '@shared/supabase/client';
import { useTextbook } from '@/context/TextbookContext';

// 데이터베이스에서 가져온 실제 문제 타입
interface Problem {
  id: string;
  teacher_id: string;
  title: string;
  problem_number: number;
  difficulty_score: number;
  difficulty: string; // GENERATED
  category: string;
  unit: string;
  image_url: string;
  answer_type: string;
  correct_answer: string;
  choices: any;
  explanation: string;
  tags?: any;
  created_at: string;
  updated_at: string;
  problem_sets_new?: any;
}

const ProblemManagement = () => {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const { selectedTextbook, selectedChapter, selectedSubchapter, breadcrumb } = useTextbook();
  const [problems, setProblems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [selectedDifficulty, setSelectedDifficulty] = useState<string>('all');
  const [selectedAnswerType, setSelectedAnswerType] = useState<string>('all');
  const [deletedProblemIds, setDeletedProblemIds] = useState<Set<string>>(new Set());
  
  // 페이지네이션 상태
  const [currentPage, setCurrentPage] = useState(1);
  const [totalProblems, setTotalProblems] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [problemsPerPage] = useState(10); // 한 페이지당 10개

  // 카테고리 옵션
  const categories = [
    { value: 'all', label: '전체' },
    { value: '수학', label: '수학' },
    { value: '기하', label: '기하' },
    { value: '대수', label: '대수' },
    { value: '미적분', label: '미적분' },
    { value: '확률과통계', label: '확률과통계' }
  ];

  // 난이도 옵션 (5단계)
  const difficulties = [
    { value: 'all', label: '전체' },
    { value: 'very_easy', label: '아주 쉬움' },
    { value: 'easy', label: '쉬움' },
    { value: 'medium', label: '보통' },
    { value: 'hard', label: '어려움' },
    { value: 'very_hard', label: '최상위' },
  ];

  // 답안 타입 옵션
  const answerTypes = [
    { value: 'all', label: '전체' },
    { value: 'multiple_choice', label: '객관식' },
    { value: 'short_answer', label: '주관식' }
  ];

  useEffect(() => {
    if (profile) {
      fetchProblems();
    }
  }, [profile, currentPage, searchTerm, selectedCategory, selectedDifficulty, selectedAnswerType, deletedProblemIds, selectedTextbook?.id, selectedChapter?.id, selectedSubchapter?.id]);

  // 페이지 포커스 시 데이터 새로고침
  useEffect(() => {
    const handleFocus = () => {
      if (profile) {
        console.log('페이지 포커스 - 데이터 새로고침');
        fetchProblems();
      }
    };

    // 페이지 가시성 변경 시에도 새로고침
    const handleVisibilityChange = () => {
      if (!document.hidden && profile) {
        console.log('페이지 가시성 변경 - 데이터 새로고침');
        fetchProblems();
      }
    };

    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    
    return () => {
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [profile]);

  const fetchProblems = async () => {
    try {
      setLoading(true);

      // 교재 필터 적용하여 서버 쿼리
      let query = supabase
        .from('problems')
        .select('*')
        .eq('teacher_id', profile?.id)
        .order('created_at', { ascending: false });

      if (selectedTextbook) {
        query = query.eq('textbook_id', selectedTextbook.id);
      }
      if (selectedChapter) {
        query = query.eq('chapter_id', selectedChapter.id);
      }
      if (selectedSubchapter) {
        query = query.eq('subchapter_id', selectedSubchapter.id);
      }

      const { data: problemsData, error } = await query;

      if (error) {
        console.error('문제 조회 오류:', error);
      }

      let allProblems = problemsData || [];

      // 삭제된 문제들을 제외
      let filteredProblems = allProblems.filter(problem => !deletedProblemIds.has(problem.id));

      // 클라이언트 사이드 필터링
      if (searchTerm) {
        filteredProblems = filteredProblems.filter(p =>
          p.title?.toLowerCase().includes(searchTerm.toLowerCase()) ||
          p.unit?.toLowerCase().includes(searchTerm.toLowerCase()) ||
          p.category?.toLowerCase().includes(searchTerm.toLowerCase())
        );
      }
      if (selectedCategory !== 'all') {
        filteredProblems = filteredProblems.filter(p => p.category === selectedCategory);
      }
      if (selectedDifficulty !== 'all') {
        filteredProblems = filteredProblems.filter(p => p.difficulty === selectedDifficulty);
      }
      if (selectedAnswerType !== 'all') {
        filteredProblems = filteredProblems.filter(p => p.answer_type === selectedAnswerType);
      }

      setProblems(filteredProblems);
      setTotalProblems(filteredProblems.length);
      setTotalPages(Math.ceil(filteredProblems.length / problemsPerPage));
    } catch (error) {
      console.error('문제 조회 실패:', error);
      setProblems([]);
      setTotalProblems(0);
      setTotalPages(0);
    } finally {
      setLoading(false);
    }
  };

  // 페이지 변경 핸들러
  const handlePageChange = (page: number) => {
    setCurrentPage(page);
  };

  // 필터 변경 시 페이지 초기화
  const handleFilterChange = () => {
    setCurrentPage(1);
  };

  // 검색어 변경 핸들러
  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchTerm(e.target.value);
    setCurrentPage(1); // 검색 시 첫 페이지로
  };

  // 카테고리 변경 핸들러
  const handleCategoryChange = (value: string) => {
    setSelectedCategory(value);
    handleFilterChange();
  };

  // 난이도 변경 핸들러
  const handleDifficultyChange = (value: string) => {
    setSelectedDifficulty(value);
    handleFilterChange();
  };

  // 답안 타입 변경 핸들러
  const handleAnswerTypeChange = (value: string) => {
    setSelectedAnswerType(value);
    handleFilterChange();
  };

  // 페이지네이션 컴포넌트
  const Pagination = () => {
    const maxVisiblePages = 5;
    const startPage = Math.max(1, currentPage - Math.floor(maxVisiblePages / 2));
    const endPage = Math.min(totalPages, startPage + maxVisiblePages - 1);

    return (
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          총 {totalProblems}개 문제 중 {(currentPage - 1) * problemsPerPage + 1}-
          {Math.min(currentPage * problemsPerPage, totalProblems)}개 표시
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => handlePageChange(1)}
            disabled={currentPage === 1}
          >
            <ChevronsLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => handlePageChange(currentPage - 1)}
            disabled={currentPage === 1}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          
          {Array.from({ length: endPage - startPage + 1 }, (_, i) => startPage + i).map(page => (
            <Button
              key={page}
              variant={currentPage === page ? "default" : "outline"}
              size="sm"
              onClick={() => handlePageChange(page)}
            >
              {page}
            </Button>
          ))}
          
          <Button
            variant="outline"
            size="sm"
            onClick={() => handlePageChange(currentPage + 1)}
            disabled={currentPage === totalPages}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => handlePageChange(totalPages)}
            disabled={currentPage === totalPages}
          >
            <ChevronsRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    );
  };

  // 필터링된 문제 목록 (클라이언트 사이드 필터링은 제거, 서버 사이드로 처리)
  const filteredProblems = problems;

  // 난이도 표기/색상은 공통 유틸(4단계 Lv1~4)로 통일. 옛 1~10 데이터는 Lv4 로 흡수됨.
  const getDifficultyColor = getDifficultyColorShared;
  const getDifficultyLabel = formatDifficultyScore;

  const getAnswerTypeLabel = (answerType: string) => {
    switch (answerType) {
      case 'multiple_choice': return '객관식';
      case 'short_answer': return '주관식';
      case 'essay': return '서술형';
      default: return '미정';
    }
  };

  const handleViewProblem = (problemId: string) => {
    // 문제 보기 로직
    console.log('문제 보기:', problemId);
  };

  const handleDeleteProblem = async (problemId: string) => {
    if (!confirm('정말로 이 문제를 삭제하시겠습니까?')) return;

    try {
      const { error } = await supabase
        .from('problems')
        .delete()
        .eq('id', problemId)
        .eq('teacher_id', profile?.id);

      if (error) throw error;

      setDeletedProblemIds(prev => new Set([...prev, problemId]));
      setProblems(prev => prev.filter(p => p.id !== problemId));
      setTotalProblems(prev => prev - 1);
    } catch (error) {
      console.error('문제 삭제 실패:', error);
      alert('문제 삭제에 실패했습니다.');
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
          <h1 className="text-2xl font-bold text-foreground">문제 관리</h1>
          {selectedTextbook ? (
            <p className="text-muted-foreground">
              {breadcrumb} 의 문제를 관리합니다
            </p>
          ) : (
            <p className="text-muted-foreground">
              교재를 선택하면 해당 교재의 문제만 표시됩니다
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => fetchProblems()}>
            <Search className="h-4 w-4 mr-2" />
            새로고침
          </Button>
          <Button size="sm" onClick={() => navigate('/cms/problems/new')}>
            <Plus className="h-4 w-4 mr-2" />
            새 문제 등록
          </Button>
        </div>
      </div>

      {/* 통계 카드 */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">총 문제 수</CardTitle>
            <FileText className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalProblems}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">객관식</CardTitle>
            <Tag className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {problems.filter(p => p.answer_type === 'multiple_choice').length}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">주관식</CardTitle>
            <FileText className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {problems.filter(p => p.answer_type === 'short_answer').length}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">이미지 포함</CardTitle>
            <Upload className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {problems.filter(p => {
                // 실제 이미지 URL인지 확인 (placeholder나 빈 값 제외)
                return p.image_url && 
                       p.image_url !== 'https://via.placeholder.com/400x300?text=No+Image' && 
                       p.image_url.trim() !== '' &&
                       !p.image_url.includes('placeholder');
              }).length}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* 검색 및 필터 */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Search className="h-5 w-5" />
            검색 및 필터
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div>
              <Input
                placeholder="문제 제목, 단원, 카테고리 검색..."
                value={searchTerm}
                onChange={handleSearchChange}
              />
            </div>
            <Select value={selectedCategory} onValueChange={handleCategoryChange}>
              <SelectTrigger>
                <SelectValue placeholder="카테고리 선택" />
              </SelectTrigger>
              <SelectContent>
                {categories.map(category => (
                  <SelectItem key={category.value} value={category.value}>
                    {category.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={selectedDifficulty} onValueChange={handleDifficultyChange}>
              <SelectTrigger>
                <SelectValue placeholder="난이도 선택" />
              </SelectTrigger>
              <SelectContent>
                {difficulties.map(difficulty => (
                  <SelectItem key={difficulty.value} value={difficulty.value}>
                    {difficulty.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={selectedAnswerType} onValueChange={handleAnswerTypeChange}>
              <SelectTrigger>
                <SelectValue placeholder="답안 타입 선택" />
              </SelectTrigger>
              <SelectContent>
                {answerTypes.map(type => (
                  <SelectItem key={type.value} value={type.value}>
                    {type.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* 문제 목록 */}
      <Card>
        <CardHeader>
          <CardTitle>문제 목록 ({filteredProblems.length}개)</CardTitle>
          <CardDescription>
            등록된 문제들을 확인하고 관리하세요
            {filteredProblems.some(p => p.id.startsWith('temp_')) && (
              <span className="text-orange-600 ml-2">
                (임시 저장된 문제 포함)
              </span>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {filteredProblems.length === 0 ? (
            <div className="text-center py-8">
              <FileText className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <p className="text-muted-foreground">등록된 문제가 없습니다.</p>
              <p className="text-sm text-muted-foreground mt-2">
                새로운 문제를 등록해보세요.
              </p>
              <div className="flex gap-2 justify-center mt-4">
              <Button 
                variant="outline" 
                  onClick={() => fetchProblems()}
                >
                  <Search className="h-4 w-4 mr-2" />
                  새로고침
                </Button>
                <Button 
                onClick={() => navigate('/cms/problems/new')}
              >
                <Plus className="h-4 w-4 mr-2" />
                  새 문제 등록
              </Button>
              </div>
            </div>
          ) : (
            <>
              <div className="space-y-4">
                {filteredProblems.map((problem) => (
                  <div key={problem.id} className="flex items-center justify-between p-4 border rounded-lg hover:bg-muted/50">
                    <div className="flex items-center gap-4">
                      <div className="flex-shrink-0">
                        {problem.image_url && problem.image_url !== 'https://via.placeholder.com/400x300?text=No+Image' ? (
                          <div className="w-16 h-16 bg-muted rounded flex items-center justify-center">
                            <Upload className="h-6 w-6 text-muted-foreground" />
                          </div>
                        ) : (
                          <div className="w-16 h-16 bg-muted rounded flex items-center justify-center">
                            <FileText className="h-6 w-6 text-muted-foreground" />
                          </div>
                        )}
                      </div>
                      <div>
                        <h3 className="font-medium">{problem.title}</h3>
                        <p className="text-sm text-muted-foreground">
                          {problem.category} • 
                          {problem.unit} • 
                          문제 #{problem.problem_number}
                        </p>
                        <div className="flex gap-2 mt-2">
                          <Badge variant="outline" className={getDifficultyColor(problem.difficulty_score ?? 2)}>
                            {getDifficultyLabel(problem.difficulty_score ?? 2)}
                          </Badge>
                          <Badge variant="outline">
                            {getAnswerTypeLabel(problem.answer_type)}
                          </Badge>
                          {problem.id.startsWith('temp_') && (
                            <Badge variant="destructive" className="text-xs">
                              임시저장
                            </Badge>
                          )}
                          {problem.tags && problem.tags.length > 0 && (
                            <Badge variant="secondary">
                              {problem.tags.length}개 태그
                            </Badge>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button 
                        variant="outline" 
                        size="sm"
                        onClick={() => handleViewProblem(problem.id)}
                        title="문제 보기"
                      >
                        <Eye className="h-4 w-4" />
                      </Button>
                      <Button 
                        variant="outline" 
                        size="sm"
                        onClick={() => navigate(`/cms/problems/new?edit=${problem.id}`)}
                        title="문제 편집"
                      >
                        <Edit className="h-4 w-4" />
                      </Button>
                      <Button 
                        variant="outline" 
                        size="sm"
                        onClick={() => handleDeleteProblem(problem.id)}
                        title="문제 삭제"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
              
              {/* 페이지네이션 */}
              {totalPages > 1 && (
                <div className="mt-6 pt-4 border-t">
                  <Pagination />
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default ProblemManagement;
