import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { 
  BookOpen, 
  FileText, 
  FolderOpen, 
  Upload
} from 'lucide-react';

const CMSDashboardNew = () => {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // 초기 로딩
    setLoading(false);
  }, []);

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
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-foreground">수학 문제 CMS</h1>
        <p className="text-muted-foreground mt-2">
          교재/단원 구조에 맞게 문제를 체계적으로 관리하고 학생들에게 배포하세요
        </p>
      </div>

      {/* 주요 기능 카드 */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
        {/* 교재 관리 */}
        <Card className="hover:shadow-lg transition-shadow cursor-pointer" 
              onClick={() => navigate('/cms/textbooks')}>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <BookOpen className="h-8 w-8 text-primary" />
              <Badge variant="secondary">New</Badge>
            </div>
            <CardTitle className="text-lg">교재 관리</CardTitle>
            <CardDescription>
              교재 등록 및 대단원/중단원 구조 관리
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-sm text-muted-foreground">
              • 교재 등록/편집<br/>
              • 대단원/중단원 구성<br/>
              • 트리 구조로 정리
            </div>
          </CardContent>
        </Card>

        {/* 문제 등록 */}
        <Card className="hover:shadow-lg transition-shadow cursor-pointer"
              onClick={() => navigate('/cms/problems')}>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <FileText className="h-8 w-8 text-green-600" />
              <Badge variant="outline">핵심</Badge>
            </div>
            <CardTitle className="text-lg">문제 등록</CardTitle>
            <CardDescription>
              교재/단원에 맞는 문제 등록 및 관리
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-sm text-muted-foreground">
              • 교재/단원 선택<br/>
              • 문제 이미지 업로드<br/>
              • 난이도/태그 설정
            </div>
          </CardContent>
        </Card>

        {/* 문제 세트 관리 */}
        <Card className="hover:shadow-lg transition-shadow cursor-pointer"
              onClick={() => navigate('/cms/problem-sets')}>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <FolderOpen className="h-8 w-8 text-blue-600" />
              <Badge variant="outline">배포</Badge>
            </div>
            <CardTitle className="text-lg">문제 세트 관리</CardTitle>
            <CardDescription>
              중단원 단위 문제 세트 구성 및 배포
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-sm text-muted-foreground">
              • 문제 세트 구성<br/>
              • 학생 배포 설정<br/>
              • 진행 상황 모니터링
            </div>
          </CardContent>
        </Card>


        {/* 배포 관리 */}
        <Card className="hover:shadow-lg transition-shadow cursor-pointer"
              onClick={() => navigate('/cms/distributions')}>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <Upload className="h-8 w-8 text-red-600" />
              <Badge variant="outline">배포</Badge>
            </div>
            <CardTitle className="text-lg">배포 관리</CardTitle>
            <CardDescription>
              배포된 문제 세트 관리 및 삭제
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-sm text-muted-foreground">
              • 배포 목록 확인<br/>
              • 진행 상황 모니터링<br/>
              • 배포 삭제
            </div>
          </CardContent>
        </Card>



      </div>


    </div>
  );
};

export default CMSDashboardNew;
