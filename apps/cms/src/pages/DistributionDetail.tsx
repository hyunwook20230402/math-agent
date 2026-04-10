// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { 
  ArrowLeft, 
  Users, 
  Calendar, 
  CheckCircle, 
  Clock, 
  AlertCircle,
  Trash2,
  UserMinus
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { distributionApi, studentAnswerApi } from '@/lib/api';
import type { DistributionWithDetails } from '@/types/database';

const DistributionDetail = () => {
  const { distributionId } = useParams<{ distributionId: string }>();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const [distribution, setDistribution] = useState<DistributionWithDetails | null>(null);
  const [studentStats, setStudentStats] = useState<{[key: string]: {completed: number, total: number, accuracy: number}}>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (distributionId) {
      fetchDistributionDetail();
    }
  }, [distributionId]);

  const fetchDistributionDetail = async () => {
    try {
      setLoading(true);
      const data = await distributionApi.getDistributionById(distributionId!);
      if (!data) {
        alert('배포를 찾을 수 없습니다.');
        navigate('/cms/distributions');
        return;
      }
      setDistribution(data);
      
      // 각 학생별 진행 상황 조회
      const stats: {[key: string]: {completed: number, total: number, accuracy: number}} = {};
      
      for (const studentData of data.students) {
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
            answer.distribution_id === distributionId &&
            data.problem_set.problems.some(problem => 
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
          
          const completed = uniqueAnsweredProblems.length;
          const total = data.problem_set.problems.length;
          const correctAnswers = uniqueAnsweredProblems.filter(answer => answer.is_correct).length;
          const accuracy = completed > 0 ? Math.round((correctAnswers / completed) * 100) : 0;
          
          stats[studentId] = {
            completed,
            total,
            accuracy
          };
        } catch (error) {
          console.error(`학생 ${studentData.student?.name || studentData.name || 'Unknown'} 진행 상황 조회 실패:`, error);
          const student = studentData.student || studentData;
          const studentId = student.id || student.student_id || student.profile_id || student.user_id;
          if (studentId) {
            stats[studentId] = { completed: 0, total: data.problem_set.problems.length, accuracy: 0 };
          }
        }
      }
      
      setStudentStats(stats);
    } catch (error) {
      console.error('배포 상세 조회 실패:', error);
      alert('배포 정보를 불러오는데 실패했습니다.');
    } finally {
      setLoading(false);
    }
  };

  const getStatusBadge = (distribution: DistributionWithDetails) => {
    const now = new Date();
    const distributionDate = new Date(distribution.distribution_date);
    
    // 완료 상태 확인 - 모든 학생이 완료했는지 확인
    const allStudentsCompleted = Object.values(studentStats).every(stat => 
      stat.completed === stat.total && stat.total > 0
    );
    const hasStudents = Object.keys(studentStats).length > 0;

    if (hasStudents && allStudentsCompleted) {
      return <Badge variant="default" className="bg-green-600">완료</Badge>;
    } else if (now.toDateString() === distributionDate.toDateString()) {
      return <Badge variant="default" className="bg-green-600">오늘</Badge>;
    } else if (now < distributionDate) {
      return <Badge variant="outline" className="text-blue-600">예정</Badge>;
    } else {
      return <Badge variant="secondary">완료</Badge>;
    }
  };

  // 학생 배포 취소 함수
  const handleRemoveStudentFromDistribution = async (studentId: string, studentName: string) => {
    if (!confirm(`정말로 ${studentName} 학생의 배포를 취소하시겠습니까?\n\n이 학생은 더 이상 이 배포에 접근할 수 없습니다.`)) {
      return;
    }

    try {
      await distributionApi.removeStudentFromDistribution(distributionId!, studentId);
      // 취소 후 상세 정보 새로고침
      fetchDistributionDetail();
    } catch (error) {
      console.error('학생 배포 취소 실패:', error);
      alert('학생 배포 취소 중 오류가 발생했습니다.');
    }
  };

  // 전체 배포 삭제 함수
  const handleDeleteDistribution = async () => {
    if (!confirm('정말로 이 배포를 완전히 삭제하시겠습니까?\n\n모든 학생의 배포가 취소되고 되돌릴 수 없습니다.')) {
      return;
    }

    try {
      await distributionApi.deleteDistribution(distributionId!);
      navigate('/cms/distributions');
    } catch (error) {
      console.error('배포 삭제 실패:', error);
      alert('배포 삭제 중 오류가 발생했습니다.');
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

  if (!distribution) {
    return (
      <div className="container mx-auto px-4 py-6">
        <div className="text-center">
          <AlertCircle className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
          <h2 className="text-xl font-semibold mb-2">배포를 찾을 수 없습니다</h2>
          <p className="text-muted-foreground mb-4">
            요청한 배포가 존재하지 않거나 삭제되었습니다.
          </p>
          <Button onClick={() => navigate('/cms/distributions')}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            배포 목록으로 돌아가기
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-6 space-y-6">
      {/* 헤더 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="outline" onClick={() => navigate('/cms/distributions')}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            뒤로
          </Button>
          <div>
            <h1 className="text-3xl font-bold text-foreground">{distribution.title}</h1>
            <p className="text-muted-foreground">
              {distribution.problem_set.name} • {distribution.students.length}명의 학생
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {getStatusBadge(distribution)}
          <Button 
            variant="destructive" 
            onClick={handleDeleteDistribution}
            title="전체 배포 삭제"
          >
            <Trash2 className="h-4 w-4 mr-2" />
            전체 삭제
          </Button>
        </div>
      </div>

      {/* 배포 정보 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Calendar className="h-5 w-5" />
            배포 정보
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <p className="text-sm text-muted-foreground">문제 세트</p>
              <p className="font-medium">{distribution.problem_set.name}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">문제 수</p>
              <p className="font-medium">{distribution.problem_set.problem_count}문제</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">배포 날짜</p>
              <p className="font-medium">
                {new Date(distribution.distribution_date).toLocaleDateString()}
              </p>
            </div>
          </div>
          {distribution.description && (
            <div className="mt-4">
              <p className="text-sm text-muted-foreground">설명</p>
              <p className="text-sm">{distribution.description}</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 학생 목록 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="h-5 w-5" />
            배포된 학생 목록 ({distribution.students.length}명)
          </CardTitle>
          <CardDescription>
            각 학생의 진행 상황을 확인하고 개별 배포를 취소할 수 있습니다
          </CardDescription>
        </CardHeader>
        <CardContent>
          {distribution.students.length === 0 ? (
            <div className="text-center py-8">
              <Users className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <p className="text-muted-foreground">배포된 학생이 없습니다.</p>
            </div>
          ) : (
            <div className="space-y-4">
              {distribution.students.map((student) => {
                const stats = studentStats[student.id] || { completed: 0, total: distribution.problem_set.problem_count, accuracy: 0 };
                const progress = stats.total > 0 ? (stats.completed / stats.total) * 100 : 0;
                
                return (
                  <div key={student.id} className="flex items-center justify-between p-4 border rounded-lg">
                    <div className="flex items-center gap-4">
                      <div className="w-12 h-12 bg-muted rounded-full flex items-center justify-center">
                        <Users className="h-6 w-6 text-muted-foreground" />
                      </div>
                      <div>
                        <h3 className="font-medium">{student.name}</h3>
                        <p className="text-sm text-muted-foreground">{student.email}</p>
                        <div className="flex items-center gap-4 mt-2">
                          <div className="flex items-center gap-2">
                            <CheckCircle className="h-4 w-4 text-green-600" />
                            <span className="text-sm">
                              {stats.completed}/{stats.total} 완료
                            </span>
                          </div>
                          {stats.completed > 0 && (
                            <div className="flex items-center gap-2">
                              <Clock className="h-4 w-4 text-blue-600" />
                              <span className="text-sm">
                                정답률: {stats.accuracy}%
                              </span>
                            </div>
                          )}
                        </div>
                        <div className="w-48 bg-gray-200 rounded-full h-2 mt-2">
                          <div 
                            className="bg-blue-600 h-2 rounded-full transition-all duration-300" 
                            style={{ width: `${progress}%` }}
                          ></div>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button 
                        variant="outline" 
                        size="sm"
                        onClick={() => handleRemoveStudentFromDistribution(student.id, student.name)}
                        title="이 학생의 배포 취소"
                      >
                        <UserMinus className="h-4 w-4 mr-2" />
                        배포 취소
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default DistributionDetail;
