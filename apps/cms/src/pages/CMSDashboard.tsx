import React from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { 
  BookOpen, 
  FileText, 
  Plus, 
  Search, 
  Filter, 
  Tag, 
  BarChart3, 
  Star, 
  Users, 
  Calendar,
  FolderOpen,
  Settings,
  Upload,
  Target
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';

const CMSDashboard = () => {
  const navigate = useNavigate();

  return (
    <div className="container mx-auto px-4 py-6">
      {/* 헤더 */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-foreground mb-2">CMS 관리 시스템</h1>
        <p className="text-muted-foreground">
          문제 등록부터 교재 구성, 문제 세트 생성까지 체계적으로 관리하세요
        </p>
      </div>

      {/* 메인 기능 카드들 */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
        
        {/* 1. 문제 관리 */}
        <Card className="hover:shadow-lg transition-shadow cursor-pointer"
              onClick={() => navigate('/cms/problems')}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5 text-primary" />
              문제 관리
            </CardTitle>
            <CardDescription>
              개별 문제를 등록하고 관리하세요
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Plus className="h-4 w-4" />
                <span>새 문제 등록</span>
              </div>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Upload className="h-4 w-4" />
                <span>이미지 업로드</span>
              </div>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Tag className="h-4 w-4" />
                <span>카테고리/태그 관리</span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* 2. 교재 관리 */}
        <Card className="hover:shadow-lg transition-shadow cursor-pointer"
              onClick={() => navigate('/cms/textbooks')}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BookOpen className="h-5 w-5 text-primary" />
              교재 관리
            </CardTitle>
            <CardDescription>
              교과서/문제집 단위로 교재를 구성하세요
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <FolderOpen className="h-4 w-4" />
                <span>교재 생성 및 구성</span>
              </div>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Target className="h-4 w-4" />
                <span>학년/학기별 분류</span>
              </div>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Settings className="h-4 w-4" />
                <span>교재 설정 관리</span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* 3. 문제 세트 관리 */}
        <Card className="hover:shadow-lg transition-shadow cursor-pointer"
              onClick={() => navigate('/cms/problem-sets')}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Star className="h-5 w-5 text-primary" />
              문제 세트 관리
            </CardTitle>
            <CardDescription>
              쪽지시험, 단원별 문제 모음을 만들세요
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Plus className="h-4 w-4" />
                <span>새 문제 세트 생성</span>
              </div>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <BarChart3 className="h-4 w-4" />
                <span>난이도별 구성</span>
              </div>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Calendar className="h-4 w-4" />
                <span>시험 일정 관리</span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* 4. 문제 검색 */}
        <Card className="hover:shadow-lg transition-shadow cursor-pointer"
              onClick={() => navigate('/cms/search')}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Search className="h-5 w-5 text-primary" />
              문제 검색
            </CardTitle>
            <CardDescription>
              등록된 문제를 다양한 조건으로 검색하세요
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Filter className="h-4 w-4" />
                <span>다양한 필터 조건</span>
              </div>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Tag className="h-4 w-4" />
                <span>태그 기반 검색</span>
              </div>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <BarChart3 className="h-4 w-4" />
                <span>난이도별 분류</span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* 5. 배포 관리 */}
        <Card className="hover:shadow-lg transition-shadow cursor-pointer"
              onClick={() => navigate('/cms/distributions')}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="h-5 w-5 text-primary" />
              배포 관리
            </CardTitle>
            <CardDescription>
              완성된 문제 세트를 학생들에게 배포하세요
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <BookOpen className="h-4 w-4" />
                <span>세트 검토 및 승인</span>
              </div>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Users className="h-4 w-4" />
                <span>학생별 배포 설정</span>
              </div>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Calendar className="h-4 w-4" />
                <span>배포 일정 관리</span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* 6. 통계 분석 */}
        <Card className="hover:shadow-lg transition-shadow cursor-pointer"
              onClick={() => navigate('/cms/analytics')}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BarChart3 className="h-5 w-5 text-primary" />
              통계 분석
            </CardTitle>
            <CardDescription>
              문제 및 세트 사용 통계를 확인하세요
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <FileText className="h-4 w-4" />
                <span>문제별 사용 통계</span>
              </div>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <BookOpen className="h-4 w-4" />
                <span>세트별 인기도</span>
              </div>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Users className="h-4 w-4" />
                <span>학생별 성취도</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* 빠른 작업 */}
      <Card>
        <CardHeader>
          <CardTitle>빠른 작업</CardTitle>
          <CardDescription>자주 사용하는 기능에 빠르게 접근하세요</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Button 
              variant="outline" 
              onClick={() => navigate('/cms/problems/new')}
              className="flex items-center gap-2"
            >
              <Plus className="h-4 w-4" />
              새 문제 등록
            </Button>
            <Button 
              variant="outline" 
              onClick={() => navigate('/cms/textbooks/new')}
              className="flex items-center gap-2"
            >
              <BookOpen className="h-4 w-4" />
              새 교재 생성
            </Button>
            <Button 
              variant="outline" 
              onClick={() => navigate('/cms/problem-sets/new')}
              className="flex items-center gap-2"
            >
              <Star className="h-4 w-4" />
              새 문제 세트
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default CMSDashboard;
