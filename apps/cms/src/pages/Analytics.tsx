import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@shared/ui/card';
import { Button } from '@shared/ui/button';
import { Badge } from '@shared/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@shared/ui/select';
import { 
  BarChart3, 
  TrendingUp, 
  Users, 
  FileText, 
  Star,
  Target,
  Calendar,
  CheckCircle
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@shared/hooks/useAuth';
import { problemApi, problemSetApi, distributionApi } from '@shared/lib/api';
import type { Problem, ProblemSet, DistributionWithDetails } from '@shared/types/database';

const Analytics = () => {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const [problems, setProblems] = useState<Problem[]>([]);
  const [problemSets, setProblemSets] = useState<ProblemSet[]>([]);
  const [distributions, setDistributions] = useState<DistributionWithDetails[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedPeriod, setSelectedPeriod] = useState<string>('all');

  useEffect(() => {
    if (profile) {
      fetchData();
    }
  }, [profile]);

  const fetchData = async () => {
    try {
      setLoading(true);
      const [problemsData, problemSetsData, distributionsData] = await Promise.all([
        problemApi.getProblems(profile?.id),
        problemSetApi.getProblemSetsByFolder(''),
        distributionApi.getDistributions()
      ]);
      
      setProblems(problemsData);
      setProblemSets(problemSetsData);
      setDistributions(distributionsData);
    } catch (error) {
      console.error('데이터 조회 실패:', error);
    } finally {
      setLoading(false);
    }
  };

  // 통계 계산
  const stats = {
    totalProblems: problems.length,
    totalProblemSets: problemSets.length,
    totalDistributions: distributions.length,
    totalStudents: distributions.reduce((acc, dist) => acc + dist.students.length, 0),
    averageProblemsPerSet: problemSets.length > 0 ? (problems.length / problemSets.length).toFixed(1) : '0',
    publishedSets: problemSets.filter(set => set.is_published).length,
    activeDistributions: distributions.filter(d => {
      const now = new Date();
      const distributionDate = new Date(d.distribution_date);
      // 배포 날짜가 오늘인 경우 활성으로 간주
      return now.toDateString() === distributionDate.toDateString();
    }).length
  };

  // 카테고리별 문제 분포
  const categoryStats = problems.reduce((acc, problem) => {
    acc[problem.category] = (acc[problem.category] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  // 난이도별 문제 분포
  const difficultyStats = problems.reduce((acc, problem) => {
    acc[problem.difficulty] = (acc[problem.difficulty] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

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
          <h1 className="text-3xl font-bold text-foreground">통계 분석</h1>
          <p className="text-muted-foreground">
            문제 및 세트 사용 통계, 학생 성취도를 확인하세요
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={selectedPeriod} onValueChange={setSelectedPeriod}>
            <SelectTrigger className="w-32">
              <SelectValue placeholder="기간" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">전체</SelectItem>
              <SelectItem value="week">이번 주</SelectItem>
              <SelectItem value="month">이번 달</SelectItem>
              <SelectItem value="year">올해</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* 주요 통계 카드 */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">총 문제 수</CardTitle>
            <FileText className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.totalProblems}</div>
            <p className="text-xs text-muted-foreground">
              등록된 문제 개수
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">문제 세트</CardTitle>
            <Star className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.totalProblemSets}</div>
            <p className="text-xs text-muted-foreground">
              생성된 세트 개수
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">배포된 세트</CardTitle>
            <Target className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.publishedSets}</div>
            <p className="text-xs text-muted-foreground">
              학생에게 공개된 세트
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">활성 배포</CardTitle>
            <CheckCircle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.activeDistributions}</div>
            <p className="text-xs text-muted-foreground">
              현재 진행중인 배포
            </p>
          </CardContent>
        </Card>
      </div>

      {/* 상세 통계 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 카테고리별 문제 분포 */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BarChart3 className="h-5 w-5" />
              카테고리별 문제 분포
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {Object.entries(categoryStats).map(([category, count]) => (
                <div key={category} className="flex items-center justify-between">
                  <span className="text-sm font-medium">{category}</span>
                  <div className="flex items-center gap-2">
                    <div className="w-32 bg-gray-200 rounded-full h-2">
                      <div 
                        className="bg-primary h-2 rounded-full" 
                        style={{ width: `${(count / stats.totalProblems) * 100}%` }}
                      ></div>
                    </div>
                    <span className="text-sm text-muted-foreground w-8">{count}</span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* 난이도별 문제 분포 */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5" />
              난이도별 문제 분포
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {Object.entries(difficultyStats).map(([difficulty, count]) => (
                <div key={difficulty} className="flex items-center justify-between">
                  <span className="text-sm font-medium">
                    {difficulty === 'easy' ? '쉬움' : 
                     difficulty === 'medium' ? '보통' : '어려움'}
                  </span>
                  <div className="flex items-center gap-2">
                    <div className="w-32 bg-gray-200 rounded-full h-2">
                      <div 
                        className={`h-2 rounded-full ${
                          difficulty === 'easy' ? 'bg-green-500' :
                          difficulty === 'medium' ? 'bg-yellow-500' : 'bg-red-500'
                        }`}
                        style={{ width: `${(count / stats.totalProblems) * 100}%` }}
                      ></div>
                    </div>
                    <span className="text-sm text-muted-foreground w-8">{count}</span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* 최근 활동 */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Calendar className="h-5 w-5" />
              최근 활동
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {distributions.slice(0, 5).map((distribution) => (
                <div key={distribution.id} className="flex items-center justify-between p-2 border rounded">
                  <div>
                    <p className="text-sm font-medium">{distribution.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(distribution.created_at).toLocaleDateString()}
                    </p>
                  </div>
                  <Badge variant="outline">
                    {distribution.students.length}명
                  </Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* 성취도 요약 */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="h-5 w-5" />
              학생 성취도 요약
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="text-center">
                <div className="text-2xl font-bold text-green-600">85%</div>
                <p className="text-sm text-muted-foreground">평균 정답률</p>
              </div>
              <div className="grid grid-cols-2 gap-4 text-center">
                <div>
                  <div className="text-lg font-bold">{stats.totalStudents}</div>
                  <p className="text-xs text-muted-foreground">총 학생 수</p>
                </div>
                <div>
                  <div className="text-lg font-bold">{stats.activeDistributions}</div>
                  <p className="text-xs text-muted-foreground">진행중인 배포</p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default Analytics;
