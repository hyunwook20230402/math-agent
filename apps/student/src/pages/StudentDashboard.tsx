// @ts-nocheck
import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { 
  BookOpen, 
  Target, 
  AlertCircle, 
  RefreshCw,
  CheckCircle,
  XCircle,
  Clock,
  CalendarIcon,
  Play,
  Star
} from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { distributionApi, studentAnswerApi, wrongAnswerApi, distributionAttemptApi } from '@/lib/api';
import { format } from 'date-fns';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { DateRange } from 'react-day-picker';
import type { 
  DistributionWithDetails, 
  StudentAnswer, 
  WrongAnswer,
  StudentAchievementWithDetails 
} from '@/types/database';
import { toast } from '@/components/ui/use-toast';

interface RecentActivity {
  id: string;
  type: 'solve' | 'complete' | 'improve';
  problem_set_name: string;
  accuracy: number;
  completed_at: string;
}

const StudentDashboard = () => {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [allDistributions, setAllDistributions] = useState<DistributionWithDetails[]>([]);
  const [filteredDistributions, setFilteredDistributions] = useState<DistributionWithDetails[]>([]);
  const [studentAnswers, setStudentAnswers] = useState<StudentAnswer[]>([]);
  const [wrongAnswers, setWrongAnswers] = useState<WrongAnswer[]>([]);
  const [achievements, setAchievements] = useState<StudentAchievementWithDetails[]>([]);
  const [recentActivities, setRecentActivities] = useState<RecentActivity[]>([]);
  const [dateRange, setDateRange] = useState<DateRange | undefined>(undefined);
  const [isInitialLoad, setIsInitialLoad] = useState(true);
  const [distributionAttempts, setDistributionAttempts] = useState<{ [key: string]: number }>({});
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage] = useState(6);
  const [stats, setStats] = useState({
    totalProblems: 0,
    totalAnswers: 0,
    accuracy: 0,
    correctCount: 0,
    wrongAnswers: 0,
    completedSets: 0,
    totalAttempts: 0
  });

  useEffect(() => {
    if (profile) {
      fetchDashboardData();
    }
  }, [profile]);

  // 초기 로드 시 날짜 필터 설정 (URL 파라미터 우선, 없으면 오늘 날짜)
  useEffect(() => {
    if (isInitialLoad && allDistributions.length > 0) {
      const dateParam = searchParams.get('date');
      
      if (dateParam) {
        // URL 파라미터에서 날짜가 있으면 해당 날짜로 설정
        const targetDate = new Date(dateParam);
        if (!isNaN(targetDate.getTime())) {
          const targetRange: DateRange = {
            from: targetDate,
            to: targetDate
          };
          setDateRange(targetRange);
          setIsInitialLoad(false);
          console.log('URL 파라미터에서 날짜 감지: 필터 설정', dateParam);
          return;
        }
      }
      
      // URL 파라미터가 없거나 유효하지 않으면 오늘 날짜로 설정
      const today = new Date();
      const todayRange: DateRange = {
        from: today,
        to: today
      };
      setDateRange(todayRange);
      setIsInitialLoad(false);
      console.log('초기 로드: 오늘 날짜로 필터 설정', today.toISOString().split('T')[0]);
    }
  }, [isInitialLoad, allDistributions, searchParams]);

  // 날짜 범위가 변경될 때마다 필터링 적용
  useEffect(() => {
    applyDateFilter();
    setCurrentPage(1); // 필터 변경 시 첫 페이지로 리셋
  }, [dateRange, allDistributions]);

  // 필터링된 배포가 변경될 때마다 통계 재계산
  useEffect(() => {
    console.log('통계 재계산 트리거:', {
      필터링된배포수: filteredDistributions.length,
      학생답안수: studentAnswers.length,
      시도횟수: stats.totalAttempts
    });
    
    if (filteredDistributions.length > 0) {
      calculateStats(filteredDistributions, studentAnswers, stats.totalAttempts);
    } else {
      // 필터링된 배포가 없으면 통계를 0으로 초기화
      setStats({
        totalProblems: 0,
        totalAnswers: 0,
        accuracy: 0,
        correctCount: 0,
        wrongAnswers: 0,
        completedSets: 0,
        totalAttempts: stats.totalAttempts
      });
    }
  }, [filteredDistributions, studentAnswers]);

  // 통계 계산 함수 (필터링된 배포 기준)
  const calculateStats = (distributions: DistributionWithDetails[], allStudentAnswers: StudentAnswer[], totalAttempts: number) => {
    console.log('=== 통계 계산 시작 (필터링된 배포 기준) ===');
    console.log('입력 데이터:', {
      필터링된배포수: distributions.length,
      전체학생답안수: allStudentAnswers.length,
      시도횟수: totalAttempts
    });
    
    if (distributions.length === 0) {
      console.log('필터링된 배포가 없음 - 통계 계산 중단');
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
    
    console.log('필터링된 문제 ID들:', Array.from(filteredProblemIds));
    console.log('필터링된 답안 수:', filteredAnswers.length);
    
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
    
    // 정답률 계산
    const finalAccuracy = uniqueAnsweredProblems > 0 ? (correctCount / uniqueAnsweredProblems) * 100 : 0;
    
    // 배포별 정답/오답 수 계산
    let totalCorrectAnswersByDistribution = 0;
    let totalWrongAnswersByDistribution = 0;
    for (const distribution of distributions) {
      const problemIds = distribution.problem_set.problems?.map(p => p.id) || [];
      const distributionAnswers = filteredAnswers.filter(answer => 
        answer.distribution_id === distribution.id && problemIds.includes(answer.problem_id)
      );
      
      // 각 문제별 최신 답안만 사용
      const latestAnswersForDistribution = new Map();
      distributionAnswers.forEach(answer => {
        const existing = latestAnswersForDistribution.get(answer.problem_id);
        if (!existing || new Date(answer.submitted_at) > new Date(existing.submitted_at)) {
          latestAnswersForDistribution.set(answer.problem_id, answer);
        }
      });
      
      const correctAnswersInDistribution = Array.from(latestAnswersForDistribution.values())
        .filter(answer => answer.is_correct).length;
      const wrongAnswersInDistribution = Array.from(latestAnswersForDistribution.values())
        .filter(answer => !answer.is_correct).length;
      
      totalCorrectAnswersByDistribution += correctAnswersInDistribution;
      totalWrongAnswersByDistribution += wrongAnswersInDistribution;
      
      console.log(`배포 ${distribution.problem_set.name}:`, {
        정답: correctAnswersInDistribution,
        오답: wrongAnswersInDistribution,
        총문제: problemIds.length
      });
    }
    
    // 배포된 문제의 총 수 계산 (필터링된 배포만)
    const totalProblems = distributions.reduce((sum, dist) => {
      const problemCount = dist.problem_set.problems?.length || 0;
      console.log(`배포 "${dist.title}"의 문제 개수:`, {
        배포ID: dist.id,
        문제세트이름: dist.problem_set.name,
        문제개수: problemCount,
        문제목록: dist.problem_set.problems?.map(p => p.id) || []
      });
      return sum + problemCount;
    }, 0);
    
    // 완료한 세트 계산 (필터링된 배포만)
    const completedSets = distributions.filter(dist => {
      const problemIds = dist.problem_set.problems?.map(p => p.id) || [];
      
      // 해당 배포의 모든 답안 중에서 각 문제별 최신 답안만 추출
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
      
      console.log(`배포 ${dist.id} 완료 여부:`, {
        totalProblems: problemIds.length,
        answeredProblems: uniqueAnsweredProblems.length,
        isCompleted: uniqueAnsweredProblems.length === problemIds.length && problemIds.length > 0
      });
      
      return uniqueAnsweredProblems.length === problemIds.length && problemIds.length > 0;
    }).length;
    
    console.log('필터링된 통계 계산 결과:', {
      totalProblems,
      totalAnswers: filteredAnswers.length,
      uniqueAnsweredProblems,
      correctCount,
      totalCorrectAnswersByDistribution,
      wrongCount,
      totalWrongAnswersByDistribution,
      finalAccuracy: Math.round(finalAccuracy),
      completedSets,
      totalAttempts
    });
    
    setStats({
      totalProblems: totalProblems,
      totalAnswers: filteredAnswers.length,
      accuracy: Math.round(finalAccuracy),
      correctCount: totalCorrectAnswersByDistribution,
      wrongAnswers: totalWrongAnswersByDistribution,
      completedSets,
      totalAttempts
    });
  };

  // 날짜 필터 적용 함수
  const applyDateFilter = () => {
    if (!dateRange?.from || !dateRange?.to) {
      // 필터가 설정되지 않으면 오늘 날짜로 설정
      const today = new Date();
      const todayRange: DateRange = {
        from: today,
        to: today
      };
      setDateRange(todayRange);
      console.log('필터가 설정되지 않음: 오늘 날짜로 자동 설정', today.toISOString().split('T')[0]);
      return;
    }

    const fromDate = new Date(dateRange.from);
    const toDate = new Date(dateRange.to);
    const fromDateStr = fromDate.toISOString().split('T')[0];
    const toDateStr = toDate.toISOString().split('T')[0];

    console.log('=== 날짜 필터 적용 ===');
    console.log('선택한 날짜 범위:', { fromDateStr, toDateStr });
    console.log('전체 배포 수:', allDistributions.length);

    const filtered = allDistributions.filter(distribution => {
      const dateValue = distribution.distribution_date;
      
      if (!dateValue) {
        console.log(`배포 "${distribution.title}": 날짜 값이 없음`);
              return false;
            }
            
      try {
        const distributionDate = new Date(dateValue);
        if (isNaN(distributionDate.getTime())) {
          console.log(`배포 "${distribution.title}": 유효하지 않은 날짜 - ${dateValue}`);
          return false;
        }

        const distributionDateStr = distributionDate.toISOString().split('T')[0];
            const isInRange = distributionDateStr >= fromDateStr && distributionDateStr <= toDateStr;
            
            console.log(`배포 "${distribution.title}":`, {
          원본날짜: dateValue,
              변환된날짜: distributionDateStr,
              시작일: fromDateStr,
              종료일: toDateStr,
          포함여부: isInRange
            });
            
            return isInRange;
      } catch (error) {
        console.error(`배포 "${distribution.title}" 날짜 파싱 오류:`, error);
        return false;
      }
    });

    console.log('필터링 결과:', {
      전체: allDistributions.length,
      필터링후: filtered.length,
      남은배포: filtered.map(d => `${d.title} (${new Date(d.distribution_date).toISOString().split('T')[0]})`)
    });

    setFilteredDistributions(filtered);
    
    console.log('필터링 완료:', {
      전체배포: allDistributions.length,
      필터링된배포: filtered.length,
      학생답안수: studentAnswers.length
    });
  };

  const fetchDashboardData = async () => {
    if (!profile) return;

    try {
      // 배포된 문제 세트 조회 (학생에게 배포된 것만)
      let distributionsData: DistributionWithDetails[] = [];
      try {
        console.log('학생 대시보드 - 현재 profile.id:', profile.id);
        distributionsData = await distributionApi.getStudentDistributions(profile.id);
        console.log('학생 대시보드 - 조회된 배포 데이터:', distributionsData);
        
        // 각 배포의 문제 세트 구조 확인
        distributionsData.forEach((dist, index) => {
          console.log(`배포 ${index + 1}:`, {
            id: dist.id,
            title: dist.title,
            distribution_date: dist.distribution_date,
            problem_set_name: dist.problem_set?.name,
            problems_count: dist.problem_set?.problems?.length
          });
        });
      } catch (error) {
        console.warn('배포된 문제 세트 조회 실패 (테이블이 없을 수 있음):', error);
        distributionsData = [];
      }
      
      // 모든 배포 데이터 저장 (필터링은 별도 함수에서 처리)
      setAllDistributions(distributionsData);

      // 각 배포별 도전횟수 계산
      const attemptCounts: { [key: string]: number } = {};
      try {
        const allAttempts = await distributionAttemptApi.getTotalAttemptCount(profile.id);
        for (const distribution of distributionsData) {
          const distributionAttempts = allAttempts.filter(attempt => attempt.distribution_id === distribution.id);
          attemptCounts[distribution.id] = distributionAttempts.length;
        }
        setDistributionAttempts(attemptCounts);
        console.log('배포별 도전횟수:', attemptCounts);
      } catch (error) {
        console.warn('도전횟수 조회 실패:', error);
      }

      // 학생 답안 조회 - 각 배포별로 조회
      let allStudentAnswers: StudentAnswer[] = [];
      for (const distribution of distributionsData) {
        try {
          const distributionAnswers = await studentAnswerApi.getStudentAnswers(profile.id, distribution.id);
          allStudentAnswers = [...allStudentAnswers, ...distributionAnswers];
        } catch (error) {
          console.warn(`배포 ${distribution.id} 답안 조회 실패:`, error);
        }
      }
      console.log('전체 학생 답안 조회 성공:', allStudentAnswers.length);
      setStudentAnswers(allStudentAnswers);

      // 오답 목록 조회
      let wrongAnswersData: WrongAnswer[] = [];
      try {
        wrongAnswersData = await wrongAnswerApi.getWrongAnswers(profile.id);
        console.log('오답 목록 조회 성공:', wrongAnswersData.length);
      } catch (error) {
        console.warn('오답 목록 조회 실패:', error);
        wrongAnswersData = [];
      }
      setWrongAnswers(wrongAnswersData);

      // 성취도 조회 (임시로 빈 배열 사용)
      let achievementsData: StudentAchievementWithDetails[] = [];
      setAchievements(achievementsData);

      // 총 도전 횟수 조회 및 누락된 도전 기록 생성
      let totalAttempts = 0;
      try {
        const allAttempts = await distributionAttemptApi.getTotalAttemptCount(profile.id);
        
        // 답안이 있지만 도전 기록이 없는 배포들에 대해 도전 기록 생성
        for (const distribution of distributionsData) {
          const problemIds = distribution.problem_set.problems?.map(p => p.id) || [];
          const distributionAnswers = allStudentAnswers.filter(answer => 
            answer.distribution_id === distribution.id && problemIds.includes(answer.problem_id)
          );
          
          // 답안이 있지만 해당 배포에 대한 도전 기록이 없는 경우
          if (distributionAnswers.length > 0) {
            const existingAttempt = allAttempts.find(attempt => attempt.distribution_id === distribution.id);
            if (!existingAttempt) {
              try {
                await distributionAttemptApi.addAttempt(profile.id, distribution.id, 'initial');
                console.log(`누락된 도전 기록 생성: initial - 배포 ${distribution.id}`);
              } catch (error) {
                console.warn(`도전 기록 생성 실패: ${distribution.id}`, error);
              }
            }
          }
        }
        
        // 다시 총 도전 횟수 조회
        const updatedAttempts = await distributionAttemptApi.getTotalAttemptCount(profile.id);
        totalAttempts = updatedAttempts.length;
        console.log('총 도전 횟수 (수정 후):', totalAttempts);
      } catch (error) {
        console.warn('도전 횟수 조회 실패:', error);
      }

      // 통계 계산은 필터링된 배포가 설정된 후 useEffect에서 처리됨

      // 최근 활동 생성
      generateRecentActivities(achievementsData, allStudentAnswers);
    } catch (error) {
      console.error('대시보드 데이터 조회 실패:', error);
    }
  };

  const generateRecentActivities = (
    achievements: StudentAchievementWithDetails[], 
    answers: StudentAnswer[]
  ) => {
    const activities: RecentActivity[] = [];
    
    // 최근 성취도 기반 활동
    achievements.slice(0, 3).forEach(achievement => {
      activities.push({
        id: achievement.id,
        type: 'complete',
        problem_set_name: achievement.problem_set.name,
        accuracy: achievement.accuracy_rate,
        completed_at: achievement.completed_at || achievement.created_at
      });
    });
    
    // 최근 답안 기반 활동
    const recentAnswers = answers
      .sort((a, b) => new Date(b.submitted_at).getTime() - new Date(a.submitted_at).getTime())
      .slice(0, 2);
    
    recentAnswers.forEach(answer => {
      activities.push({
        id: `answer-${answer.id}`,
        type: 'solve',
        problem_set_name: '개별 문제',
        accuracy: answer.is_correct ? 100 : 0,
        completed_at: answer.submitted_at
      });
    });
    
    setRecentActivities(activities.sort((a, b) => 
      new Date(b.completed_at).getTime() - new Date(a.completed_at).getTime()
    ).slice(0, 5));
  };

  const startProblemSet = async (distributionId: string) => {
    if (!profile) return;
    
    try {
      // 도전 횟수 기록 추가
      const progress = getProgressForDistribution(filteredDistributions.find(d => d.id === distributionId));
      const attemptType = progress.completed > 0 ? 'full_retry' : 'initial';
      
      await distributionAttemptApi.addAttempt(profile.id, distributionId, attemptType);
      console.log(`도전 기록 추가: ${attemptType} - 배포 ${distributionId}, 완료된 문제: ${progress.completed}/${progress.total}`);
    } catch (error) {
      console.error('도전 기록 추가 실패:', error);
    }
    
    navigate(`/student/problems/${distributionId}`);
  };

  const getActivityIcon = (type: string) => {
    switch (type) {
      case 'solve':
        return <Play className="h-4 w-4 text-blue-500" />;
      case 'complete':
        return <CheckCircle className="h-4 w-4 text-green-500" />;
      case 'improve':
        return <TrendingUp className="h-4 w-4 text-purple-500" />;
      default:
        return <BookOpen className="h-4 w-4" />;
    }
  };

  const getActivityText = (type: string) => {
    switch (type) {
      case 'solve':
        return '문제 풀이 시작';
      case 'complete':
        return '문제 세트 완료';
      case 'improve':
        return '성과 향상';
      default:
        return '활동';
    }
  };




  // 배포별 도전횟수 계산
  const getAttemptCountForDistribution = async (distributionId: string) => {
    if (!profile) return 0;
    
    try {
      const attempts = await distributionAttemptApi.getTotalAttemptCount(profile.id);
      const distributionAttempts = attempts.filter(attempt => attempt.distribution_id === distributionId);
      return distributionAttempts.length;
    } catch (error) {
      console.error('도전횟수 조회 실패:', error);
      return 0;
    }
  };

  // 배포된 문제 세트의 진행률 계산
  // 페이지네이션 계산
  const getPaginatedDistributions = () => {
    const startIndex = (currentPage - 1) * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    return filteredDistributions.slice(startIndex, endIndex);
  };

  const totalPages = Math.ceil(filteredDistributions.length / itemsPerPage);

  const getProgressForDistribution = (distribution: DistributionWithDetails | undefined) => {
    if (!distribution) return { completed: 0, total: 0, accuracy: 0, totalAttempts: 0, averageAttempts: 0 };
    // 해당 배포의 문제 세트에 포함된 문제들의 ID 목록
    const problemIds = distribution.problem_set.problems.map(p => p.id);
    console.log(`배포 ${distribution.id}의 문제 ID들:`, problemIds);
    console.log(`배포 ${distribution.id}의 문제 세트 이름:`, distribution.problem_set.name);
    
    // 학생이 해당 배포에서 해당 문제들에 대해 답안을 제출한 것들
    // distribution_id가 있는 답안만 해당 배포에서 인식 (null인 답안은 무시)
    const relevantAnswers = studentAnswers.filter(answer => {
      const matchesProblem = problemIds.includes(answer.problem_id);
      const matchesDistribution = answer.distribution_id === distribution.id;
      
      // 더 자세한 디버깅 정보
      console.log(`답안 ${answer.id}:`, {
        problem_id: answer.problem_id,
        distribution_id: answer.distribution_id,
        target_distribution_id: distribution.id,
        problemIds_includes: problemIds.includes(answer.problem_id),
        matchesProblem,
        matchesDistribution
      });
      
      return matchesProblem && matchesDistribution;
    });
    
    console.log(`배포 ${distribution.id}의 관련 답안들:`, relevantAnswers);
    
    // 각 문제당 가장 최근 답안만 사용 (중복 제거)
    const uniqueAnswers = relevantAnswers.reduce((acc, answer) => {
      const existing = acc.find(a => a.problem_id === answer.problem_id);
      if (!existing || new Date(answer.submitted_at) > new Date(existing.submitted_at)) {
        // 기존 답안이 없거나 현재 답안이 더 최근이면 교체
        return acc.filter(a => a.problem_id !== answer.problem_id).concat(answer);
      }
      return acc;
    }, [] as typeof relevantAnswers);
    
    console.log(`배포 ${distribution.id}의 중복 제거된 답안들:`, uniqueAnswers);
    
    const completed = uniqueAnswers.length;
    const total = problemIds.length; // 실제 문제 개수 사용
    
    // 정답률 계산 (오답 해결 여부 판단용)
    const correctAnswers = uniqueAnswers.filter(answer => answer.is_correct).length;
    const accuracy = completed > 0 ? Math.round((correctAnswers / completed) * 100) : 0;
    
    // 총 시도 횟수 계산
    const totalAttempts = relevantAnswers.length;
    const averageAttempts = completed > 0 ? Math.round(totalAttempts / completed * 10) / 10 : 0;
    
    console.log(`배포 ${distribution.id} 진행률: ${completed}/${total}, 정확도: ${accuracy}%, 평균 시도: ${averageAttempts}회`);
    
    return {
      completed,
      total,
      accuracy,
      totalAttempts,
      averageAttempts
    };
  };

  // 오답만 필터링하는 함수 - 가장 최근 시도에서 틀린 문제들만 반환
  const getWrongAnswersForDistribution = (distribution: DistributionWithDetails) => {
    const problemIds = distribution.problem_set.problems.map(p => p.id);
    console.log(`오답 필터링 - 배포 ${distribution.id}의 문제 ID들:`, problemIds);
    
    const relevantAnswers = studentAnswers.filter(answer => {
      const matchesProblem = problemIds.includes(answer.problem_id);
      const matchesDistribution = answer.distribution_id === distribution.id;
      
      return matchesProblem && matchesDistribution;
    });
    
    console.log(`오답 필터링 - 관련된 모든 답안들:`, relevantAnswers);
    
    // 가장 최근 시도 시간을 찾기
    const latestAttemptTime = relevantAnswers.reduce((latest, answer) => {
      const answerTime = new Date(answer.submitted_at);
      return answerTime > latest ? answerTime : latest;
    }, new Date(0));
    
    console.log(`오답 필터링 - 가장 최근 시도 시간:`, latestAttemptTime);
    
    // 가장 최근 시도에서 틀린 문제들만 필터링
    const latestWrongAnswers = relevantAnswers.filter(answer => {
      const answerTime = new Date(answer.submitted_at);
      const isLatestAttempt = Math.abs(answerTime.getTime() - latestAttemptTime.getTime()) < 1000; // 1초 이내 차이
      const isWrong = !answer.is_correct;
      
      console.log(`오답 필터링 - 답안 ${answer.id}:`, {
        problem_id: answer.problem_id,
        submitted_at: answer.submitted_at,
        is_correct: answer.is_correct,
        isLatestAttempt,
        isWrong,
        included: isLatestAttempt && isWrong
      });
      
      return isLatestAttempt && isWrong;
    });
    
    console.log(`오답 필터링 - 가장 최근 시도에서 틀린 문제들:`, latestWrongAnswers);
    
    // 중복 제거 (같은 문제를 여러 번 틀렸을 경우)
    const uniqueWrongProblemIds = [...new Set(latestWrongAnswers.map(answer => answer.problem_id))];
    
    console.log(`오답 필터링 - 최종 오답 문제 ID들:`, uniqueWrongProblemIds);
    
    return uniqueWrongProblemIds;
  };

  // 오답만 다시 풀기 시작
  const startWrongAnswersOnly = async (distributionId: string) => {
    if (!profile) return;
    
    const distribution = filteredDistributions.find(d => d.id === distributionId);
    if (!distribution) return;
    
    const wrongProblemIds = getWrongAnswersForDistribution(distribution);
    if (wrongProblemIds.length === 0) {
      toast({
        title: "오답 없음",
        description: "이 문제 세트에는 오답이 없습니다.",
        variant: "default"
      });
      return;
    }
    
    try {
      // 도전 횟수 기록 추가
      await distributionAttemptApi.addAttempt(profile.id, distributionId, 'wrong_only');
      console.log(`도전 기록 추가: wrong_only - 배포 ${distributionId}`);
    } catch (error) {
      console.error('도전 기록 추가 실패:', error);
    }
    
    // 오답 문제 ID들을 URL 파라미터로 전달
    const wrongIdsParam = wrongProblemIds.join(',');
    navigate(`/student/problems/${distributionId}?wrongOnly=true&wrongIds=${wrongIdsParam}`);
  };

  return (
    <div className="container mx-auto px-4 py-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-foreground">학생 대시보드</h1>
          <p className="text-muted-foreground">문제를 풀고 성과를 확인하세요</p>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={fetchDashboardData} variant="outline" size="sm">
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>

             {/* 날짜 필터 */}
       <Card>
         <CardHeader>
           <CardTitle className="flex items-center gap-2">
             <CalendarIcon className="h-5 w-5" />
             기간별 필터
           </CardTitle>
           <CardDescription>처음에는 오늘 배포된 문제집만 표시됩니다. 날짜를 선택하여 다른 기간의 문제집도 확인하세요</CardDescription>
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
                   onSelect={(range) => {
                     setDateRange(range);
                     // 날짜를 선택하면 URL 파라미터 제거
                     if (range?.from && range?.to) {
                       navigate('/student', { replace: true });
                     }
                   }}
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
               console.log('필터 초기화: 오늘 날짜로 설정', today.toISOString().split('T')[0]);
             }}>
               <CalendarIcon className="mr-2 h-4 w-4" />
               오늘 날짜로 초기화
             </Button>
           </div>
         </CardContent>
       </Card>

      {/* 빠른 액션 - 숨김 처리 */}
      {/* <div className="grid grid-cols-1 md:grid-cols-1 gap-4">
        <Button 
          variant="outline" 
          className="h-20 flex flex-col items-center justify-center gap-2"
          onClick={() => navigate('/student/wrong-answers')}
        >
          <XCircle className="h-6 w-6" />
          <span>오답 노트</span>
        </Button>
      </div> */}

      {/* 상단 통계 */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center space-x-2">
              <Target className="h-8 w-8 text-blue-600" />
              <div>
                <p className="text-sm font-medium text-muted-foreground">총 문제 수</p>
                <p className="text-2xl font-bold">{stats.totalProblems}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center space-x-2">
              <CheckCircle className="h-8 w-8 text-green-600" />
              <div>
                <p className="text-sm font-medium text-muted-foreground">해결한 문제</p>
                <p className="text-2xl font-bold">{stats.correctCount || 0}</p>
              </div>
            </div>
          </CardContent>
        </Card>



        <Card>
          <CardContent className="p-6">
            <div className="flex items-center space-x-2">
              <AlertCircle className="h-8 w-8 text-red-600" />
              <div>
                <p className="text-sm font-medium text-muted-foreground">남은 오답</p>
                <p className="text-2xl font-bold">{stats.wrongAnswers}</p>
              </div>
            </div>
          </CardContent>
        </Card>

      </div>

      {/* 자동 채점 및 오답 확인 안내 */}
      <div className="text-left py-4">
        <div className="inline-flex items-center gap-2">
          <Star className="h-6 w-6 text-yellow-500" />
          <span className="text-2xl font-bold text-foreground">채점 및 오답 확인하기</span>
        </div>
      </div>

      {/* 배포된 문제집 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BookOpen className="h-5 w-5" />
          배포된 문제집 ({filteredDistributions.length}개)
          </CardTitle>
          <CardDescription>선생님이 배포한 문제집들을 확인하고 풀어보세요</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {getPaginatedDistributions().map((distribution) => {
              const progress = getProgressForDistribution(distribution);
              
              // 오답을 모두 해결했는지 확인 (모든 문제를 풀었고 정답률이 100%인 경우)
              const hasAllWrongAnswersSolved = progress.completed > 0 && progress.accuracy === 100;
              
              return (
                <div key={distribution.id} className={`p-4 border rounded-lg hover:shadow-md transition-shadow ${
                  hasAllWrongAnswersSolved ? 'bg-blue-100 border-blue-300' : ''
                }`}>
                  <div className="flex items-start justify-between mb-2">
                    <h3 className="font-medium">{distribution.title}</h3>
                  </div>
                  <p className="text-sm text-muted-foreground mb-3">
                    {distribution.description || distribution.problem_set.description || "설명 없음"}
                  </p>
                  <div className="space-y-2 mb-4">
                    <div className="flex items-center justify-between text-sm">
                      <span>진행률</span>
                      <span>{progress.completed}/{progress.total}</span>
                    </div>
                    <Progress value={(progress.completed / progress.total) * 100} className="h-2" />
                    {/* 첫시도 정답률 숨김
                    {progress.completed > 0 && (
                      <div className="text-sm text-muted-foreground">
                        첫 시도 정답률: {progress.firstAttemptAccuracy.toFixed(1)}%
                      </div>
                    )}
                    */}
                  </div>
                  <div className="flex items-center justify-between text-sm text-muted-foreground mb-3">
                    <span>{distribution.problem_set.problems?.length || 0}문제</span>
                    <span className="flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      배포 날짜: {(() => {
                        try {
                          const dateValue = distribution.distribution_date;
                          if (!dateValue) return '날짜 없음';
                          const date = new Date(dateValue);
                          if (isNaN(date.getTime())) return '날짜 오류';
                          return format(date, "MM.dd");
                        } catch (error) {
                          console.error('날짜 파싱 오류:', error, distribution);
                          return '날짜 오류';
                        }
                      })()}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-sm text-muted-foreground mb-3">
                    <span className="flex items-center gap-1">
                      <Play className="h-3 w-3" />
                      도전횟수: {distributionAttempts[distribution.id] || 0}회
                    </span>
                  </div>
                  <div className="space-y-2">
                    <Button 
                      className="w-full" 
                      onClick={() => startProblemSet(distribution.id)}
                    >
                      {progress.completed > 0 ? '전체 다시 풀기' : '문제 풀기'}
                    </Button>
                    {progress.completed > 0 && (
                      <>
                        <Button 
                          variant="outline"
                          className="w-full" 
                          onClick={() => startWrongAnswersOnly(distribution.id)}
                        >
                          <XCircle className="h-4 w-4 mr-2" />
                          오답만 다시 풀기
                        </Button>
                                        <Button 
                  variant="outline"
                  className="w-full" 
                  onClick={() => navigate(`/student/wrong-answers/${distribution.id}`)}
                >
                  <AlertCircle className="h-4 w-4 mr-2" />
                  처음 틀린 문제들 목록
                </Button>
                
                <Button 
                  variant="outline"
                  className="w-full" 
                  onClick={() => navigate(`/student/still-wrong-answers/${distribution.id}`)}
                >
                  <div className="flex items-center mr-2">
                    <AlertCircle className="h-4 w-4" />
                    <AlertCircle className="h-4 w-4 -ml-1" />
                  </div>
                  두번 틀린 문제들 목록
                </Button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
            
            {filteredDistributions.length === 0 && (
              <div className="col-span-full text-center py-8 text-muted-foreground">
                <BookOpen className="h-12 w-12 mx-auto mb-4" />
                 <p>
                   {dateRange?.from && dateRange?.to 
                     ? `${format(dateRange.from, "MM.dd")}~${format(dateRange.to, "MM.dd")} 기간에 배포된 문제집이 없습니다`
                     : "오늘 배포된 문제집이 없습니다"
                   }
                 </p>
                 <p className="text-sm mt-2">다른 날짜를 선택해보세요</p>
              </div>
            )}
          </div>
          
          {/* 페이지네이션 */}
          {totalPages >= 1 && (
            <div className="flex items-center justify-center gap-2 mt-6">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                disabled={currentPage === 1}
              >
                이전
              </Button>
              
              <div className="flex items-center gap-1">
                {Array.from({ length: totalPages }, (_, i) => i + 1).map(page => (
                  <Button
                    key={page}
                    variant={currentPage === page ? "default" : "outline"}
                    size="sm"
                    onClick={() => setCurrentPage(page)}
                    className="w-8 h-8 p-0"
                  >
                    {page}
                  </Button>
                ))}
              </div>
              
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                disabled={currentPage === totalPages}
              >
                다음
              </Button>
            </div>
          )}
        </CardContent>
      </Card>




    </div>
  );
};

export default StudentDashboard;