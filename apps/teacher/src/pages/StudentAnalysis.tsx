import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@shared/ui/card';
import { Button } from '@shared/ui/button';
import { Badge } from '@shared/ui/badge';
import { Progress } from '@shared/ui/progress';
import { Avatar, AvatarFallback, AvatarImage } from '@shared/ui/avatar';
import { 
  ArrowLeft,
  CalendarIcon,
  Target,
  CheckCircle,
  XCircle,
  BookOpen,
  TrendingUp,
  AlertCircle,
  Clock,
  User,
  BarChart3
} from 'lucide-react';
import { useAuth } from '@shared/hooks/useAuth';
import { distributionApi, studentAnswerApi, wrongAnswerApi, studentApi } from '@shared/lib/api';
import { format } from 'date-fns';
import { Calendar } from '@shared/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@shared/ui/popover';
import { DateRange } from 'react-day-picker';
import type { 
  DistributionWithDetails, 
  StudentAnswer, 
  WrongAnswer,
  Profile
} from '@shared/types/database';

interface StudentStats {
  totalProblems: number;
  totalAnswers: number;
  accuracy: number;
  correctCount: number;
  wrongAnswers: number;
  completedSets: number;
  totalAttempts: number;
  solvedProblems: number;
}

const StudentAnalysis = () => {
  const { studentId } = useParams<{ studentId: string }>();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const [student, setStudent] = useState<Profile | null>(null);
  const [allDistributions, setAllDistributions] = useState<DistributionWithDetails[]>([]);
  const [filteredDistributions, setFilteredDistributions] = useState<DistributionWithDetails[]>([]);
  const [studentAnswers, setStudentAnswers] = useState<StudentAnswer[]>([]);
  const [wrongAnswers, setWrongAnswers] = useState<WrongAnswer[]>([]);
  const [dateRange, setDateRange] = useState<DateRange | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<StudentStats>({
    totalProblems: 0,
    totalAnswers: 0,
    accuracy: 0,
    correctCount: 0,
    wrongAnswers: 0,
    completedSets: 0,
    totalAttempts: 0,
    solvedProblems: 0
  });

  useEffect(() => {
    if (studentId && profile) {
      fetchStudentData();
    }
  }, [studentId, profile]);

  // 초기 로드 시 오늘 날짜로 필터 설정
  useEffect(() => {
    if (allDistributions.length > 0 && !dateRange) {
      const today = new Date();
      const todayRange: DateRange = {
        from: today,
        to: today
      };
      setDateRange(todayRange);
    }
  }, [allDistributions, dateRange]);

  // 날짜 범위가 변경될 때마다 필터링 적용
  useEffect(() => {
    applyDateFilter();
  }, [dateRange, allDistributions]);

  // 필터링된 배포가 변경될 때마다 통계 재계산
  useEffect(() => {
    if (filteredDistributions.length > 0) {
      calculateStats(filteredDistributions, studentAnswers);
    } else {
      setStats({
        totalProblems: 0,
        totalAnswers: 0,
        accuracy: 0,
        correctCount: 0,
        wrongAnswers: 0,
        completedSets: 0,
        totalAttempts: 0,
        solvedProblems: 0
      });
    }
  }, [filteredDistributions, studentAnswers]);

  const fetchStudentData = async () => {
    if (!studentId || !profile) return;

    try {
      setLoading(true);

      // 1. 학생 정보 조회
      const students = await studentApi.getStudentsByTeacher(profile.email);
      const targetStudent = students.find(s => s.id === studentId);
      if (!targetStudent) {
        console.error('학생을 찾을 수 없습니다:', studentId);
        navigate('/teacher');
        return;
      }
      setStudent(targetStudent);

      // 2. 해당 학생의 배포된 문제 세트 조회
      let distributionsData: DistributionWithDetails[] = [];
      try {
        distributionsData = await distributionApi.getStudentDistributions(studentId);
        console.log('학생 분석 - 조회된 배포 데이터:', distributionsData);
      } catch (error) {
        console.warn('배포된 문제 세트 조회 실패:', error);
        distributionsData = [];
      }
      
      setAllDistributions(distributionsData);

      // 3. 학생 답안 조회
      let allStudentAnswers: StudentAnswer[] = [];
      for (const distribution of distributionsData) {
        try {
          const distributionAnswers = await studentAnswerApi.getStudentAnswers(studentId, distribution.id);
          allStudentAnswers = [...allStudentAnswers, ...distributionAnswers];
        } catch (error) {
          console.warn(`배포 ${distribution.id} 답안 조회 실패:`, error);
        }
      }
      console.log('전체 학생 답안 조회 성공:', allStudentAnswers.length);
      setStudentAnswers(allStudentAnswers);

      // 4. 오답 목록 조회
      let wrongAnswersData: WrongAnswer[] = [];
      try {
        wrongAnswersData = await wrongAnswerApi.getWrongAnswers(studentId);
        console.log('오답 목록 조회 성공:', wrongAnswersData.length);
      } catch (error) {
        console.warn('오답 목록 조회 실패:', error);
        wrongAnswersData = [];
      }
      setWrongAnswers(wrongAnswersData);

      setLoading(false);
    } catch (error) {
      console.error('학생 데이터 조회 실패:', error);
      setLoading(false);
    }
  };

  // 날짜 필터 적용 함수
  const applyDateFilter = () => {
    if (!dateRange?.from || !dateRange?.to) {
      const today = new Date();
      const todayRange: DateRange = {
        from: today,
        to: today
      };
      setDateRange(todayRange);
      return;
    }

    const fromDate = new Date(dateRange.from);
    const toDate = new Date(dateRange.to);
    const fromDateStr = fromDate.toISOString().split('T')[0];
    const toDateStr = toDate.toISOString().split('T')[0];

    console.log('=== 날짜 필터 적용 ===');
    console.log('선택한 날짜 범위:', { fromDateStr, toDateStr });

    const filtered = allDistributions.filter(distribution => {
      const dateValue = distribution.distribution_date;
      
      if (!dateValue) {
        return false;
      }
            
      try {
        const distributionDate = new Date(dateValue);
        if (isNaN(distributionDate.getTime())) {
          return false;
        }

        const distributionDateStr = distributionDate.toISOString().split('T')[0];
        const isInRange = distributionDateStr >= fromDateStr && distributionDateStr <= toDateStr;
            
        return isInRange;
      } catch (error) {
        console.error(`배포 "${distribution.title}" 날짜 파싱 오류:`, error);
        return false;
      }
    });

    console.log('필터링 결과:', {
      전체: allDistributions.length,
      필터링후: filtered.length
    });

    setFilteredDistributions(filtered);
  };

  // 통계 계산 함수
  const calculateStats = (distributions: DistributionWithDetails[], allStudentAnswers: StudentAnswer[]) => {
    if (distributions.length === 0) {
      return;
    }
    
    // 필터링된 배포의 문제들만 추출
    const filteredProblemIds = new Set();
    distributions.forEach(dist => {
      const problemIds = dist.problem_set.problems?.map(p => p.id) || [];
      problemIds.forEach(id => filteredProblemIds.add(id));
    });
    
    // 필터링된 배포의 답안만 추출
    const filteredAnswers = allStudentAnswers.filter(answer => 
      filteredProblemIds.has(answer.problem_id)
    );
    
    // 문제별 최신 답안만 추출
    const latestAnswersByProblem = new Map();
    filteredAnswers.forEach(answer => {
      const existing = latestAnswersByProblem.get(answer.problem_id);
      if (!existing || new Date(answer.submitted_at) > new Date(existing.submitted_at)) {
        latestAnswersByProblem.set(answer.problem_id, answer);
      }
    });
    
    const latestAnswers = Array.from(latestAnswersByProblem.values());
    const correctCount = latestAnswers.filter(a => a.is_correct).length;
    const wrongCount = latestAnswers.filter(a => !a.is_correct).length;
    const uniqueAnsweredProblems = latestAnswers.length;
    
    // 디버깅 로그 추가
    console.log('=== 학생 분석 통계 계산 디버깅 ===');
    console.log('필터링된 배포 수:', distributions.length);
    console.log('필터링된 배포들:', distributions.map(d => ({ id: d.id, title: d.title, problemCount: d.problem_set.problems?.length || 0 })));
    console.log('필터링된 문제 ID들:', Array.from(filteredProblemIds));
    console.log('필터링된 답안 수:', filteredAnswers.length);
    console.log('답안들:', filteredAnswers.map(a => ({ problem_id: a.problem_id, distribution_id: a.distribution_id, is_correct: a.is_correct, submitted_at: a.submitted_at })));
    console.log('최신 답안 수:', latestAnswers.length);
    console.log('최신 답안들:', latestAnswers.map(a => ({ problem_id: a.problem_id, is_correct: a.is_correct })));
    console.log('정답 수:', correctCount);
    console.log('오답 수:', wrongCount);
    
    // 정답률 계산
    const finalAccuracy = uniqueAnsweredProblems > 0 ? (correctCount / uniqueAnsweredProblems) * 100 : 0;
    
    // 배포된 문제의 총 수 계산 (날짜 필터 기간 내의 모든 배포된 문제)
    const totalProblems = distributions.reduce((sum, dist) => {
      return sum + (dist.problem_set.problems?.length || 0);
    }, 0);
    
    // 해결한 문제 수 = 총 문제 수 - 남은 오답
    // (총 배포된 문제에서 아직 틀린 문제를 제외한 나머지)
    const solvedProblems = totalProblems - wrongCount;
    
    // 완료한 세트 계산
    const completedSets = distributions.filter(dist => {
      const problemIds = dist.problem_set.problems?.map(p => p.id) || [];
      const distributionAnswers = filteredAnswers.filter(answer => 
        answer.distribution_id === dist.id && problemIds.includes(answer.problem_id)
      );
      
      const latestAnswersForDistribution = new Map();
      distributionAnswers.forEach(answer => {
        const existing = latestAnswersForDistribution.get(answer.problem_id);
        if (!existing || new Date(answer.submitted_at) > new Date(existing.submitted_at)) {
          latestAnswersForDistribution.set(answer.problem_id, answer);
        }
      });
      
      const uniqueAnsweredProblems = Array.from(latestAnswersForDistribution.values());
      return uniqueAnsweredProblems.length === problemIds.length && problemIds.length > 0;
    }).length;
    
    setStats({
      totalProblems: totalProblems,
      totalAnswers: filteredAnswers.length,
      accuracy: Math.round(finalAccuracy),
      correctCount: correctCount,
      wrongAnswers: wrongCount,
      completedSets,
      totalAttempts: filteredAnswers.length,
      solvedProblems: solvedProblems
    });
  };

  // 배포별 진행률 계산
  const getProgressForDistribution = (distribution: DistributionWithDetails) => {
    const problemIds = distribution.problem_set.problems?.map(p => p.id) || [];
    
    const relevantAnswers = studentAnswers.filter(answer => {
      const matchesProblem = problemIds.includes(answer.problem_id);
      const matchesDistribution = answer.distribution_id === distribution.id;
      return matchesProblem && matchesDistribution;
    });
    
    // 각 문제당 가장 최근 답안만 사용
    const uniqueAnswers = relevantAnswers.reduce((acc, answer) => {
      const existing = acc.find(a => a.problem_id === answer.problem_id);
      if (!existing || new Date(answer.submitted_at) > new Date(existing.submitted_at)) {
        return acc.filter(a => a.problem_id !== answer.problem_id).concat(answer);
      }
      return acc;
    }, [] as typeof relevantAnswers);
    
    const completed = uniqueAnswers.length;
    const total = problemIds.length;
    const correctAnswers = uniqueAnswers.filter(answer => answer.is_correct).length;
    const accuracy = completed > 0 ? Math.round((correctAnswers / completed) * 100) : 0;
    
    return {
      completed,
      total,
      accuracy,
      totalAttempts: relevantAnswers.length
    };
  };

  // 오답만 필터링하는 함수
  const getWrongAnswersForDistribution = (distribution: DistributionWithDetails) => {
    const problemIds = distribution.problem_set.problems?.map(p => p.id) || [];
    
    const relevantAnswers = studentAnswers.filter(answer => {
      const matchesProblem = problemIds.includes(answer.problem_id);
      const matchesDistribution = answer.distribution_id === distribution.id;
      return matchesProblem && matchesDistribution;
    });
    
    // 가장 최근 시도 시간을 찾기
    const latestAttemptTime = relevantAnswers.reduce((latest, answer) => {
      const answerTime = new Date(answer.submitted_at);
      return answerTime > latest ? answerTime : latest;
    }, new Date(0));
    
    // 가장 최근 시도에서 틀린 문제들만 필터링
    const latestWrongAnswers = relevantAnswers.filter(answer => {
      const answerTime = new Date(answer.submitted_at);
      const isLatestAttempt = Math.abs(answerTime.getTime() - latestAttemptTime.getTime()) < 1000;
      const isWrong = !answer.is_correct;
      return isLatestAttempt && isWrong;
    });
    
    // 중복 제거
    const uniqueWrongProblemIds = [...new Set(latestWrongAnswers.map(answer => answer.problem_id))];
    
    return uniqueWrongProblemIds;
  };

  if (loading) {
    return (
      <div className="container mx-auto px-4 py-6">
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
          <p className="ml-3 text-gray-600">학생 데이터를 불러오는 중...</p>
        </div>
      </div>
    );
  }

  if (!student) {
    return (
      <div className="container mx-auto px-4 py-6">
        <div className="text-center py-8">
          <AlertCircle className="h-12 w-12 mx-auto mb-4 text-red-500" />
          <h2 className="text-xl font-semibold mb-2">학생을 찾을 수 없습니다</h2>
          <p className="text-muted-foreground mb-4">요청한 학생 정보를 찾을 수 없습니다.</p>
          <Button onClick={() => navigate('/teacher')}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            선생님 대시보드로 돌아가기
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
          <Button variant="outline" onClick={() => navigate('/teacher')}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            돌아가기
          </Button>
          <div className="flex items-center gap-3">
            <Avatar className="h-12 w-12">
              <AvatarImage src={student.avatar_url || ''} />
              <AvatarFallback>{student.name.charAt(0)}</AvatarFallback>
            </Avatar>
            <div>
              <h1 className="text-3xl font-bold text-foreground">{student.name} 학생 분석</h1>
              <p className="text-muted-foreground">{student.email}</p>
            </div>
          </div>
        </div>
      </div>

      {/* 날짜 필터 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CalendarIcon className="h-5 w-5" />
            기간별 필터
          </CardTitle>
          <CardDescription>날짜를 선택하여 특정 기간의 학습 현황을 확인하세요</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-4">
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" className="justify-start text-left font-normal">
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {dateRange?.from ? (
                    dateRange.to ? (
                      <>
                        {format(dateRange.from, "LLL dd, y")} -{" "}
                        {format(dateRange.to, "LLL dd, y")}
                      </>
                    ) : (
                      format(dateRange.from, "LLL dd, y")
                    )
                  ) : (
                    <span>날짜 범위 선택</span>
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  initialFocus
                  mode="range"
                  defaultMonth={new Date()}
                  selected={dateRange}
                  onSelect={setDateRange}
                  numberOfMonths={2}
                />
              </PopoverContent>
            </Popover>
            <Button variant="outline" onClick={() => {
              const today = new Date();
              const todayRange: DateRange = {
                from: today,
                to: today
              };
              setDateRange(todayRange);
            }}>
              <CalendarIcon className="mr-2 h-4 w-4" />
              오늘 날짜로 초기화
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* 통계 카드 */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">총 문제 수</CardTitle>
            <Target className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.totalProblems}</div>
            <p className="text-xs text-muted-foreground">
              배포된 문제 수
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">해결한 문제</CardTitle>
            <CheckCircle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.solvedProblems}</div>
            <p className="text-xs text-muted-foreground">
              풀어본 문제 수
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">남은 오답</CardTitle>
            <XCircle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.wrongAnswers}</div>
            <p className="text-xs text-muted-foreground">
              아직 틀린 문제
            </p>
          </CardContent>
        </Card>
      </div>

      {/* 배포된 문제집 분석 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BookOpen className="h-5 w-5" />
            배포된 문제집 분석 ({filteredDistributions.length}개)
          </CardTitle>
          <CardDescription>학생의 문제집별 학습 현황을 확인하세요</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {filteredDistributions.map((distribution) => {
              const progress = getProgressForDistribution(distribution);
              const wrongProblemIds = getWrongAnswersForDistribution(distribution);
              
              return (
                <div key={distribution.id} className="p-4 border rounded-lg">
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <h3 className="font-medium text-lg">{distribution.title}</h3>
                      <p className="text-sm text-muted-foreground">
                        {distribution.problem_set.name} • {distribution.problem_set.problems?.length || 0}문제
                      </p>
                      <p className="text-sm text-muted-foreground">
                        배포 날짜: {(() => {
                          try {
                            const dateValue = distribution.distribution_date;
                            if (!dateValue) return '날짜 없음';
                            const date = new Date(dateValue);
                            if (isNaN(date.getTime())) return '날짜 오류';
                            return format(date, "yyyy.MM.dd");
                          } catch (error) {
                            return '날짜 오류';
                          }
                        })()}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant={progress.accuracy >= 80 ? "default" : progress.accuracy >= 60 ? "secondary" : "destructive"}>
                        {progress.accuracy}% 정답률
                      </Badge>
                      {wrongProblemIds.length === 0 && progress.completed > 0 && (
                        <Badge variant="default" className="bg-green-500">
                          <CheckCircle className="h-3 w-3 mr-1" />
                          완료
                        </Badge>
                      )}
                    </div>
                  </div>
                  
                  <div className="space-y-3">
                    <div className="flex items-center justify-between text-sm">
                      <span>진행률</span>
                      <span>{progress.completed}/{progress.total}</span>
                    </div>
                    <Progress value={(progress.completed / progress.total) * 100} className="h-2" />
                    
                    <div className="grid grid-cols-2 gap-4 text-sm">
                      <div className="flex items-center gap-2">
                        <CheckCircle className="h-4 w-4 text-green-500" />
                        <span>정답: {progress.completed - wrongProblemIds.length}문제</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <XCircle className="h-4 w-4 text-red-500" />
                        <span>오답: {wrongProblemIds.length}문제</span>
                      </div>
                    </div>
                    
                    {wrongProblemIds.length > 0 && (
                      <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded-lg">
                        <div className="flex items-center gap-2 mb-2">
                          <AlertCircle className="h-4 w-4 text-red-500" />
                          <span className="font-medium text-red-700">오답 문제</span>
                        </div>
                        <p className="text-sm text-red-600">
                          {wrongProblemIds.length}개 문제를 아직 틀리고 있습니다.
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            
            {filteredDistributions.length === 0 && (
              <div className="text-center py-8 text-muted-foreground">
                <BookOpen className="h-12 w-12 mx-auto mb-4" />
                <p>
                  {dateRange?.from && dateRange?.to 
                    ? `${format(dateRange.from, "MM.dd")}~${format(dateRange.to, "MM.dd")} 기간에 배포된 문제집이 없습니다`
                    : "선택한 기간에 배포된 문제집이 없습니다"
                  }
                </p>
                <p className="text-sm mt-2">다른 날짜를 선택해보세요</p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default StudentAnalysis;
