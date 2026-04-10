// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { 
  Users, 
  Calendar, 
  CheckCircle, 
  Clock, 
  AlertCircle,
  Eye,
  Edit,
  Trash2
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { distributionApi, studentAnswerApi } from '@/lib/api';
import type { DistributionWithDetails } from '@/types/database';

const DistributionManagement = () => {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const [distributions, setDistributions] = useState<DistributionWithDetails[]>([]);
  const [distributionStats, setDistributionStats] = useState<{[key: string]: {completed: number, total: number}}>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (profile) {
      fetchDistributions();
    }
  }, [profile]);

  const fetchDistributions = async () => {
    try {
      setLoading(true);
      const data = await distributionApi.getDistributions();
      setDistributions(data);
      
      // 각 배포별 학생 진행 상황 조회
      const stats: {[key: string]: {completed: number, total: number}} = {};
      
      for (const distribution of data) {
        let completedCount = 0;
        const totalStudents = distribution.students.length;
        
        for (const studentData of distribution.students) {
          try {
            // 중첩된 구조 처리: {student: {...}} 형태
            const student = studentData.student || studentData;
            
            // 학생 ID가 유효한지 확인
            const studentId = student.id || student.student_id || student.profile_id || student.user_id;
            if (!studentId) {
              console.warn(`학생 ${student.name || student.student_name || student.email || 'Unknown'}의 ID가 없습니다. 건너뜁니다.`);
              continue;
            }
            
            const answers = await studentAnswerApi.getStudentAnswers(studentId);
            const relevantAnswers = answers.filter(answer => 
              answer.distribution_id === distribution.id &&
              distribution.problem_set.problems.some(problem => 
                problem.id === answer.problem_id
              )
            );
            
            // 각 문제별 최신 답안만 사용 (중복 제거)
            const latestAnswersByProblem = new Map();
            relevantAnswers.forEach(answer => {
              const existing = latestAnswersByProblem.get(answer.problem_id);
              if (!existing || new Date(answer.submitted_at) > new Date(existing.submitted_at)) {
                latestAnswersByProblem.set(answer.problem_id, answer);
              }
            });
            
            const uniqueAnsweredProblems = Array.from(latestAnswersByProblem.values());
            
            if (uniqueAnsweredProblems.length === distribution.problem_set.problems.length) {
              completedCount++;
            }
          } catch (error) {
            console.error(`학생 ${studentData.student?.name || studentData.name || 'Unknown'} 진행 상황 조회 실패:`, error);
          }
        }
        
        stats[distribution.id] = {
          completed: completedCount,
          total: totalStudents
        };
      }
      
      setDistributionStats(stats);
    } catch (error) {
      console.error('배포 조회 실패:', error);
    } finally {
      setLoading(false);
    }
  };

  const getStatusBadge = (distribution: DistributionWithDetails) => {
    const now = new Date();
    const distributionDate = new Date(distribution.distribution_date);
    
    // 완료 상태 확인
    const stats = distributionStats[distribution.id];
    const isCompleted = stats && stats.completed === stats.total && stats.total > 0;

    if (isCompleted) {
      return <Badge variant="default" className="bg-green-600">완료</Badge>;
    } else if (now.toDateString() === distributionDate.toDateString()) {
      return <Badge variant="default" className="bg-green-600">오늘</Badge>;
    } else if (now < distributionDate) {
      return <Badge variant="outline" className="text-blue-600">예정</Badge>;
    } else {
      return <Badge variant="secondary">완료</Badge>;
    }
  };

  // 배포 삭제 함수
  const handleDeleteDistribution = async (distributionId: string) => {
    if (!confirm('정말로 이 배포를 삭제하시겠습니까?')) {
      return;
    }

    try {
      await distributionApi.deleteDistribution(distributionId);
      // 삭제 후 목록 새로고침
      fetchDistributions();
    } catch (error) {
      console.error('배포 삭제 실패:', error);
      alert('배포 삭제 중 오류가 발생했습니다.');
    }
  };

  // 배포 보기 함수
  const handleViewDistribution = (distributionId: string) => {
    navigate(`/cms/distributions/${distributionId}`);
  };

  // 학생 배포 취소 함수
  const handleRemoveStudentFromDistribution = async (distributionId: string, studentId: string, studentName: string) => {
    if (!confirm(`정말로 ${studentName} 학생의 배포를 취소하시겠습니까?\n\n이 학생은 더 이상 이 배포에 접근할 수 없습니다.`)) {
      return;
    }

    try {
      await distributionApi.removeStudentFromDistribution(distributionId, studentId);
      // 취소 후 목록 새로고침
      fetchDistributions();
    } catch (error) {
      console.error('학생 배포 취소 실패:', error);
      alert('학생 배포 취소 중 오류가 발생했습니다.');
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
          <h1 className="text-3xl font-bold text-foreground">배포 관리</h1>
          <p className="text-muted-foreground">
            완성된 문제 세트를 학생들에게 배포하고 관리하세요
          </p>
        </div>
        <Button onClick={() => navigate('/cms/distributions/new')}>
          <Users className="h-4 w-4 mr-2" />
          새 배포 생성
        </Button>
      </div>

      {/* 통계 카드 */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">총 배포 수</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{distributions.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">진행중</CardTitle>
            <CheckCircle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {distributions.filter(d => {
                const now = new Date();
                const startDate = new Date(d.start_date);
                const endDate = new Date(d.end_date);
                return now >= startDate && now <= endDate;
              }).length}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">예정</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {distributions.filter(d => {
                const now = new Date();
                const startDate = new Date(d.start_date);
                return now < startDate;
              }).length}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">종료</CardTitle>
            <AlertCircle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {distributions.filter(d => {
                const now = new Date();
                const endDate = new Date(d.end_date);
                return now > endDate;
              }).length}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* 배포 목록 */}
      <Card>
        <CardHeader>
          <CardTitle>배포 목록 ({distributions.length}개)</CardTitle>
          <CardDescription>
            생성된 배포들을 확인하고 관리하세요
          </CardDescription>
        </CardHeader>
        <CardContent>
          {distributions.length === 0 ? (
            <div className="text-center py-8">
              <Users className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <p className="text-muted-foreground">생성된 배포가 없습니다.</p>
              <Button 
                variant="outline" 
                className="mt-4"
                onClick={() => navigate('/cms/distributions/new')}
              >
                <Users className="h-4 w-4 mr-2" />
                첫 배포 생성하기
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              {distributions.map((distribution) => (
                <div key={distribution.id} className="flex items-center justify-between p-4 border rounded-lg hover:bg-muted/50">
                  <div className="flex items-center gap-4">
                    <div className="flex-shrink-0">
                      <div className="w-16 h-16 bg-muted rounded flex items-center justify-center">
                        <Users className="h-6 w-6 text-muted-foreground" />
                      </div>
                    </div>
                    <div>
                      <h3 className="font-medium">{distribution.title}</h3>
                      <p className="text-sm text-muted-foreground">
                        {distribution.problem_set?.name} • {distribution.students.length}명의 학생 • {distribution.problem_set?.problems?.length || 0}문제
                      </p>
                      {distributionStats[distribution.id] && (
                        <p className="text-xs text-muted-foreground mt-1">
                          완료: {distributionStats[distribution.id].completed}/{distributionStats[distribution.id].total}명 
                          ({distributionStats[distribution.id].total > 0 ? Math.round((distributionStats[distribution.id].completed / distributionStats[distribution.id].total) * 100) : 0}%)
                        </p>
                      )}
                      <div className="flex gap-2 mt-2">
                        {getStatusBadge(distribution)}
                        <Badge variant="outline">
                          {distribution.problem_set?.problems?.length || 0}문제
                        </Badge>
                        <Badge variant="outline">
                          {new Date(distribution.distribution_date).toLocaleDateString()}
                        </Badge>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button 
                      variant="outline" 
                      size="sm"
                      onClick={() => handleViewDistribution(distribution.id)}
                      title="배포 보기"
                    >
                      <Eye className="h-4 w-4" />
                    </Button>
                    <Button 
                      variant="outline" 
                      size="sm"
                      onClick={() => navigate(`/cms/distributions/${distribution.id}`)}
                      title="배포 편집"
                    >
                      <Edit className="h-4 w-4" />
                    </Button>
                    <Button 
                      variant="outline" 
                      size="sm"
                      onClick={() => handleDeleteDistribution(distribution.id)}
                      title="배포 삭제"
                    >
                      <Trash2 className="h-4 w-4" />
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

export default DistributionManagement;
