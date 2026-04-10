import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { 
  Search, 
  Filter, 
  FileText, 
  Tag, 
  BarChart3, 
  Plus,
  Eye,
  Download
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { problemApi } from '@/lib/api';
import type { Problem } from '@/types/database';

const ProblemSearch = () => {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const [problems, setProblems] = useState<Problem[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [selectedDifficulty, setSelectedDifficulty] = useState<string>('all');
  const [selectedAnswerType, setSelectedAnswerType] = useState<string>('all');
  const [selectedUnit, setSelectedUnit] = useState<string>('all');

  // 카테고리 옵션
  const categories = [
    { value: 'all', label: '전체' },
    { value: '수학', label: '수학' },
    { value: '기하', label: '기하' },
    { value: '대수', label: '대수' },
    { value: '미적분', label: '미적분' },
    { value: '확률과통계', label: '확률과통계' }
  ];

  // 난이도 옵션
  const difficulties = [
    { value: 'all', label: '전체' },
    { value: 'easy', label: '쉬움' },
    { value: 'medium', label: '보통' },
    { value: 'hard', label: '어려움' }
  ];

  // 답안 타입 옵션
  const answerTypes = [
    { value: 'all', label: '전체' },
    { value: 'multiple_choice', label: '객관식' },
    { value: 'short_answer', label: '주관식' }
  ];

  // 단원 옵션 (실제 데이터에서 추출)
  const units = [
    { value: 'all', label: '전체' },
    { value: '1단원', label: '1단원' },
    { value: '2단원', label: '2단원' },
    { value: '3단원', label: '3단원' },
    { value: '기말고사', label: '기말고사' },
    { value: '중간고사', label: '중간고사' }
  ];

  useEffect(() => {
    if (profile) {
      fetchProblems();
    }
  }, [profile]);

  const fetchProblems = async () => {
    try {
      setLoading(true);
      const data = await problemApi.getProblems(profile?.id);
      setProblems(data);
    } catch (error) {
      console.error('문제 조회 실패:', error);
    } finally {
      setLoading(false);
    }
  };

  // 필터링된 문제 목록
  const filteredProblems = problems.filter(problem => {
    const matchesSearch = problem.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         problem.unit.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         problem.category.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesCategory = selectedCategory === 'all' || problem.category === selectedCategory;
    const matchesDifficulty = selectedDifficulty === 'all' || problem.difficulty === selectedDifficulty;
    const matchesAnswerType = selectedAnswerType === 'all' || problem.answer_type === selectedAnswerType;
    const matchesUnit = selectedUnit === 'all' || problem.unit === selectedUnit;

    return matchesSearch && matchesCategory && matchesDifficulty && matchesAnswerType && matchesUnit;
  });

  const getDifficultyColor = (difficulty: string) => {
    switch (difficulty) {
      case 'easy': return 'bg-green-100 text-green-800';
      case 'medium': return 'bg-yellow-100 text-yellow-800';
      case 'hard': return 'bg-red-100 text-red-800';
      default: return 'bg-gray-100 text-gray-800';
    }
  };

  const getAnswerTypeLabel = (type: string) => {
    return type === 'multiple_choice' ? '객관식' : '주관식';
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
          <h1 className="text-3xl font-bold text-foreground">문제 검색</h1>
          <p className="text-muted-foreground">
            다양한 조건으로 문제를 검색하고 필터링하세요
          </p>
        </div>
        <Button onClick={() => navigate('/cms/problems/new')}>
          <Plus className="h-4 w-4 mr-2" />
          새 문제 등록
        </Button>
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
          <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
            <div>
              <Input
                placeholder="문제 제목, 단원, 카테고리 검색..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>
            <Select value={selectedCategory} onValueChange={setSelectedCategory}>
              <SelectTrigger>
                <SelectValue placeholder="카테고리" />
              </SelectTrigger>
              <SelectContent>
                {categories.map(category => (
                  <SelectItem key={category.value} value={category.value}>
                    {category.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={selectedDifficulty} onValueChange={setSelectedDifficulty}>
              <SelectTrigger>
                <SelectValue placeholder="난이도" />
              </SelectTrigger>
              <SelectContent>
                {difficulties.map(difficulty => (
                  <SelectItem key={difficulty.value} value={difficulty.value}>
                    {difficulty.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={selectedAnswerType} onValueChange={setSelectedAnswerType}>
              <SelectTrigger>
                <SelectValue placeholder="답안 타입" />
              </SelectTrigger>
              <SelectContent>
                {answerTypes.map(type => (
                  <SelectItem key={type.value} value={type.value}>
                    {type.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={selectedUnit} onValueChange={setSelectedUnit}>
              <SelectTrigger>
                <SelectValue placeholder="단원" />
              </SelectTrigger>
              <SelectContent>
                {units.map(unit => (
                  <SelectItem key={unit.value} value={unit.value}>
                    {unit.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* 검색 결과 */}
      <Card>
        <CardHeader>
          <CardTitle>검색 결과 ({filteredProblems.length}개)</CardTitle>
          <CardDescription>
            검색 조건에 맞는 문제들을 확인하세요
          </CardDescription>
        </CardHeader>
        <CardContent>
          {filteredProblems.length === 0 ? (
            <div className="text-center py-8">
              <Search className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <p className="text-muted-foreground">검색 조건에 맞는 문제가 없습니다.</p>
              <p className="text-sm text-muted-foreground mt-2">
                검색 조건을 변경하거나 새로운 문제를 등록해보세요.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {filteredProblems.map((problem) => (
                <div key={problem.id} className="flex items-center justify-between p-4 border rounded-lg hover:bg-muted/50">
                  <div className="flex items-center gap-4">
                    <div className="flex-shrink-0">
                      <div className="w-16 h-16 bg-muted rounded flex items-center justify-center">
                        <FileText className="h-6 w-6 text-muted-foreground" />
                      </div>
                    </div>
                    <div>
                      <h3 className="font-medium">{problem.title}</h3>
                      <p className="text-sm text-muted-foreground">
                        {problem.category} • {problem.unit} • 문제 #{problem.problem_number}
                      </p>
                      <div className="flex gap-2 mt-2">
                        <Badge variant="outline" className={getDifficultyColor(problem.difficulty)}>
                          {problem.difficulty === 'easy' ? '쉬움' : 
                           problem.difficulty === 'medium' ? '보통' : '어려움'}
                        </Badge>
                        <Badge variant="outline">
                          {getAnswerTypeLabel(problem.answer_type)}
                        </Badge>
                        {problem.tags && problem.tags.length > 0 && (
                          <Badge variant="secondary">
                            {problem.tags.length}개 태그
                          </Badge>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm">
                      <Eye className="h-4 w-4" />
                    </Button>
                    <Button 
                      variant="outline" 
                      size="sm"
                      onClick={() => navigate(`/cms/problems/${problem.id}`)}
                    >
                      <FileText className="h-4 w-4" />
                    </Button>
                    <Button variant="outline" size="sm">
                      <Download className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default ProblemSearch;
