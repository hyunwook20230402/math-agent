// @ts-nocheck
import { useState, useEffect } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { toast } from '@/hooks/use-toast';
import { 
  ArrowLeft, 
  ArrowRight, 
  CheckCircle, 
  XCircle, 
  Clock, 
  BookOpen,
  Send,
  AlertCircle
} from 'lucide-react';
import { distributionApi, studentAnswerApi, wrongAnswerApi, distributionAttemptApi } from '@/lib/api';
import type { DistributionWithDetails } from '@/types/database';

interface Problem {
  id: string;
  title: string;
  answer_type: 'multiple_choice' | 'short_answer';
  correct_answer: string;
  choices?: string[];
  image_url?: string;
  unit?: string;
  difficulty?: string;
}

const SolveProblem = () => {
  const { distributionId } = useParams<{ distributionId: string }>();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const [searchParams] = useSearchParams();
  
  const [loading, setLoading] = useState(false);
  const [distribution, setDistribution] = useState<DistributionWithDetails | null>(null);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [currentProblemIndex, setCurrentProblemIndex] = useState(0);
  const [answers, setAnswers] = useState<{ [key: string]: string }>({});
  const [submitted, setSubmitted] = useState(false);
  const [results, setResults] = useState<{ [key: string]: boolean }>({});
  const [attemptCounts, setAttemptCounts] = useState<{ [key: string]: number }>({});
  const [timeSpent, setTimeSpent] = useState(0);
  const [isWrongAnswersOnly, setIsWrongAnswersOnly] = useState(false);

  // 배포 날짜를 URL 파라미터로 변환하는 함수
  const getDistributionDateParam = () => {
    if (!distribution?.distribution_date) return '';
    const date = new Date(distribution.distribution_date);
    return date.toISOString().split('T')[0]; // YYYY-MM-DD 형식
  };

  // 컴포넌트 마운트 시 기존 시도 횟수 로드
  useEffect(() => {
    const loadAttemptCounts = async () => {
      if (!profile?.id || !distributionId) return;
      
      try {
        const existingAnswers = await studentAnswerApi.getStudentAnswers(profile.id, distributionId);
        const counts: { [key: string]: number } = {};
        
        problems.forEach(problem => {
          const problemAnswers = existingAnswers.filter(answer => answer.problem_id === problem.id);
          counts[problem.id] = problemAnswers.length;
        });
        
        setAttemptCounts(counts);
      } catch (error) {
        console.error('시도 횟수 로드 실패:', error);
      }
    };
    
    loadAttemptCounts();
  }, [profile?.id, distributionId, problems]);

  useEffect(() => {
    if (distributionId && profile) {
      fetchDistributionData();
      const timer = setInterval(() => {
        setTimeSpent(prev => prev + 1);
      }, 1000);
      return () => clearInterval(timer);
    }
  }, [distributionId, profile]);

  const fetchDistributionData = async () => {
    try {
      if (!distributionId) return;

      // 배포 정보 조회
      const distributionData = await distributionApi.getDistributionById(distributionId);
      
      if (!distributionData) {
        toast({
          title: "오류",
          description: "배포를 찾을 수 없습니다.",
          variant: "destructive"
        });
        navigate('/student');
        return;
      }

      setDistribution(distributionData);

      // 문제 세트의 문제들을 설정
      const problemList = (distributionData as any).problem_set?.problems || [];
      console.log('받아온 문제 데이터:', problemList);
      
      // 문제 데이터가 이미 올바른 구조로 되어 있으므로 직접 사용
      let extractedProblems = problemList.map((problem: any) => ({
        id: problem.id,
        title: problem.title,
        problem_number: problem.problem_number,
        difficulty: problem.difficulty,
        unit: problem.unit,
        answer_type: problem.answer_type,
        correct_answer: problem.correct_answer,
        choices: problem.choices,
        explanation: problem.explanation,
        image_url: problem.image_url,
        teacher_id: problem.teacher_id,
        created_at: problem.created_at,
        updated_at: problem.updated_at
      }));
      
      // 오답만 필터링하는 경우
      const wrongOnly = searchParams.get('wrongOnly') === 'true';
      const wrongIds = searchParams.get('wrongIds')?.split(',') || [];
      
      if (wrongOnly && wrongIds.length > 0) {
        setIsWrongAnswersOnly(true);
        extractedProblems = extractedProblems.filter(problem => 
          wrongIds.includes(problem.id)
        );
        console.log('오답만 필터링된 문제:', extractedProblems);
      }
      
      console.log('추출된 문제 데이터:', extractedProblems);
      console.log('추출된 첫 번째 문제의 answer_type:', extractedProblems[0]?.answer_type);
      
      setProblems(extractedProblems);

    } catch (error) {
      console.error('배포 데이터 조회 오류:', error);
      toast({
        title: "오류",
        description: "문제를 불러오는데 실패했습니다.",
        variant: "destructive"
      });
    } finally {
      setLoading(false);
    }
  };

  const handleAnswerChange = (answer: string) => {
    const currentProblem = problems[currentProblemIndex];
    setAnswers(prev => ({
      ...prev,
      [currentProblem.id]: answer
    }));
  };

  const handleNext = () => {
    if (currentProblemIndex < problems.length - 1) {
      setCurrentProblemIndex(prev => prev + 1);
    }
  };

  const handlePrevious = () => {
    if (currentProblemIndex > 0) {
      setCurrentProblemIndex(prev => prev - 1);
    }
  };

  const handleSubmit = async () => {
    if (!profile || !distributionId) return;

    const unansweredProblems = problems.filter(problem => !answers[problem.id]);
    if (unansweredProblems.length > 0) {
      toast({
        title: "미답 문제",
        description: `${unansweredProblems.length}개의 문제가 답안되지 않았습니다.`,
        variant: "destructive"
      });
      return;
    }

    setLoading(true);
    try {
      // 답안 제출 및 결과 계산
      const results: { [key: string]: boolean } = {};
      const answerPromises = problems.map(async (problem) => {
        // 정답 비교 - 단순 문자열 비교
        const isCorrect = answers[problem.id] === problem.correct_answer;
        
        results[problem.id] = isCorrect;

        // 학생 답안 저장
        await studentAnswerApi.submitAnswer({
          student_id: profile.id,
          problem_id: problem.id,
          answer: answers[problem.id],
          is_correct: isCorrect,
          attempt_number: attemptCounts[problem.id] + 1, // 시도 횟수 증가
          distribution_id: distributionId
        });

        // 오답인 경우 오답 노트에 추가 (최신 오답만 유지)
        if (!isCorrect) {
          try {
            await wrongAnswerApi.addWrongAnswer({
              student_id: profile.id,
              problem_id: problem.id,
              wrong_answer: answers[problem.id],
              attempt_number: attemptCounts[problem.id] + 1 // 시도 횟수 포함
            });
          } catch (error) {
            console.warn('오답 추가 실패:', error);
            // 오답 추가 실패해도 전체 제출 프로세스는 계속 진행
          }
        } else {
          // 정답인 경우 오답 노트에서 제거
          try {
            await wrongAnswerApi.removeWrongAnswer(profile.id, problem.id);
          } catch (error) {
            console.warn('오답 제거 실패:', error);
          }
        }
      });

      await Promise.all(answerPromises);
      setResults(results);
      setSubmitted(true);

      const correctCount = Object.values(results).filter(Boolean).length;
      const accuracy = (correctCount / problems.length) * 100;

      toast({
        title: "제출 완료",
        description: `정답률: ${accuracy.toFixed(1)}% (${correctCount}/${problems.length})`
      });
    } catch (error) {
      console.error('답안 제출 오류:', error);
      toast({
        title: "오류",
        description: "답안 제출 중 오류가 발생했습니다.",
        variant: "destructive"
      });
    } finally {
      setLoading(false);
    }
  };

  const formatTime = (seconds: number) => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const getCurrentProblem = () => problems[currentProblemIndex];

  if (loading) {
    return (
      <div className="container mx-auto px-4 py-6">
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
        </div>
      </div>
    );
  }

  if (!distribution || problems.length === 0) {
    return (
      <div className="container mx-auto px-4 py-6">
        <div className="text-center">
          <AlertCircle className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
          <h2 className="text-xl font-semibold mb-2">문제를 찾을 수 없습니다</h2>
          <p className="text-muted-foreground mb-4">
            배포된 문제가 없거나 접근할 수 없습니다.
          </p>
          <Button onClick={() => navigate('/student')}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            대시보드로 돌아가기
          </Button>
        </div>
      </div>
    );
  }

  if (submitted) {
    const correctCount = Object.values(results).filter(Boolean).length;
    const accuracy = (correctCount / problems.length) * 100;

    return (
      <div className="container mx-auto px-4 py-6">
        <Card className="max-w-2xl mx-auto">
          <CardHeader className="text-center">
            <CardTitle className="text-2xl">제출 완료!</CardTitle>
            <CardDescription>
              문제 풀이가 완료되었습니다.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* 결과 요약 */}
            <div className="grid grid-cols-2 gap-4">
              <div className="text-center p-4 bg-muted rounded-lg">
                <div className="text-2xl font-bold text-green-600">{correctCount}</div>
                <div className="text-sm text-muted-foreground">정답</div>
              </div>
              <div className="text-center p-4 bg-muted rounded-lg">
                <div className="text-2xl font-bold text-red-600">{problems.length - correctCount}</div>
                <div className="text-sm text-muted-foreground">오답</div>
              </div>
            </div>
            
            {/* 정답률 */}
            <div className="text-center">
              <div className="text-3xl font-bold mb-2">{accuracy.toFixed(1)}%</div>
              <div className="text-muted-foreground">정답률</div>
              <Progress value={accuracy} className="mt-2" />
            </div>

            {/* 소요 시간 - 숨김 처리 */}
            {/* <div className="text-center">
              <Clock className="h-6 w-6 mx-auto mb-2 text-muted-foreground" />
              <div className="text-lg font-medium">{formatTime(timeSpent)}</div>
              <div className="text-sm text-muted-foreground">소요 시간</div>
            </div> */}

            {/* 개별 문제 결과 */}
            <div className="space-y-3">
              <h3 className="text-lg font-semibold text-center">문제별 결과</h3>
              <div className={`grid gap-2 ${
                problems.length <= 10 ? 'grid-cols-5' : 
                problems.length <= 15 ? 'grid-cols-6' : 
                problems.length <= 20 ? 'grid-cols-7' : 'grid-cols-8'
              }`}>
                {problems.map((problem, index) => {
                  const isCorrect = results[problem.id];
                  return (
                    <div
                      key={problem.id}
                      className={`p-2 rounded-lg text-center border-2 transition-colors ${
                        isCorrect 
                          ? 'bg-green-50 border-green-200 text-green-800 hover:bg-green-100' 
                          : 'bg-red-50 border-red-200 text-red-800 hover:bg-red-100'
                      }`}
                      title={`${index + 1}번 문제: ${isCorrect ? '정답' : '오답'}`}
                    >
                      <div className="text-xs font-medium mb-1">
                        {index + 1}번
                      </div>
                      <div className="text-base font-bold">
                        {isCorrect ? '✓' : '✗'}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="text-center text-sm text-muted-foreground">
                ✓ 정답 | ✗ 오답
              </div>
            </div>

            <div className="flex gap-2">
              <Button 
                variant="outline" 
                className="flex-1"
                onClick={() => {
                  const dateParam = getDistributionDateParam();
                  const url = dateParam ? `/student?date=${dateParam}` : '/student';
                  navigate(url);
                }}
              >
                <ArrowLeft className="h-4 w-4 mr-2" />
                대시보드로
              </Button>
              <Button 
                className="flex-1"
                onClick={async () => {
                  if (profile && distributionId) {
                    try {
                      // 도전 횟수 기록 추가
                      await distributionAttemptApi.addAttempt(profile.id, distributionId, 'full_retry');
                      console.log(`도전 기록 추가: full_retry - 배포 ${distributionId}`);
                    } catch (error) {
                      console.error('도전 기록 추가 실패:', error);
                    }
                  }
                  
                  setSubmitted(false);
                  setResults({});
                  setAnswers({});
                  setCurrentProblemIndex(0);
                  setTimeSpent(0);
                }}
              >
                <BookOpen className="h-4 w-4 mr-2" />
                전체 다시 풀기
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const currentProblem = getCurrentProblem();
  const progress = ((currentProblemIndex + 1) / problems.length) * 100;

  return (
    <div className="container mx-auto px-4 py-6">
      <div className="mb-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-2xl font-bold">
              {isWrongAnswersOnly ? '오답 다시 풀기' : '문제 풀기'}
            </h1>
            <p className="text-muted-foreground">
              {distribution?.problem_set?.name || '문제 세트'}
              {isWrongAnswersOnly && ' - 오답만'}
            </p>
          </div>
          <div className="flex items-center gap-4">
            {/* 소요 시간 - 숨김 처리 */}
            {/* <div className="text-right">
              <div className="text-sm text-muted-foreground">소요 시간</div>
              <div className="font-mono">{formatTime(timeSpent)}</div>
            </div> */}
            <Button variant="outline" onClick={() => {
              const dateParam = getDistributionDateParam();
              const url = dateParam ? `/student?date=${dateParam}` : '/student';
              navigate(url);
            }}>
              <ArrowLeft className="h-4 w-4 mr-2" />
              대시보드로
            </Button>
          </div>
        </div>
        
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">진행률:</span>
            <span className="font-medium">
              {currentProblemIndex + 1} / {problems.length}
            </span>
          </div>
          <Progress 
            value={((currentProblemIndex + 1) / problems.length) * 100} 
            className="w-32" 
          />
        </div>
      </div>

      {/* 문제 카드 */}
      <Card className="max-w-4xl mx-auto">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>문제 {currentProblemIndex + 1}</CardTitle>
            <Badge variant="outline">
              {currentProblem.answer_type === 'multiple_choice' ? '객관식' : '주관식'}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* 문제 내용 */}
          <div>
            <h3 className="text-lg font-medium mb-4">{currentProblem.title}</h3>
            {currentProblem.image_url && (
              <div className="mb-4">
                <img 
                  src={currentProblem.image_url} 
                  alt="문제 이미지" 
                  className="max-w-full h-auto rounded-lg"
                />
              </div>
            )}
          </div>

          {/* 답안 입력 */}
          <div>
            <label className="block text-sm font-medium mb-2">답안</label>
            {currentProblem.answer_type === 'multiple_choice' ? (
              <div className="space-y-2">
                {/* choices가 있으면 사용하고, 없으면 1~5번 생성 */}
                {(currentProblem.choices && currentProblem.choices.length > 0 
                  ? currentProblem.choices 
                  : ['1번', '2번', '3번', '4번', '5번']
                ).map((choice, index) => (
                  <label key={index} className="flex items-center space-x-2 cursor-pointer p-2 rounded hover:bg-muted">
                    <input
                      type="radio"
                      name={`problem-${currentProblem.id}`}
                      value={choice}
                      checked={answers[currentProblem.id] === choice}
                      onChange={(e) => handleAnswerChange(e.target.value)}
                      className="h-4 w-4"
                    />
                    <span className="text-sm">{choice}</span>
                  </label>
                ))}
              </div>
            ) : (
              <input
                type="text"
                value={answers[currentProblem.id] || ''}
                onChange={(e) => handleAnswerChange(e.target.value)}
                placeholder="답안을 입력하세요"
                className="w-full p-2 border rounded-md"
              />
            )}
          </div>

          {/* 네비게이션 */}
          <div className="flex justify-between pt-4">
            <Button
              variant="outline"
              onClick={handlePrevious}
              disabled={currentProblemIndex === 0}
            >
              <ArrowLeft className="h-4 w-4 mr-2" />
              이전
            </Button>
            
            {currentProblemIndex === problems.length - 1 ? (
              <Button
                onClick={handleSubmit}
                disabled={loading || !answers[currentProblem.id]}
              >
                <Send className="h-4 w-4 mr-2" />
                제출하기
              </Button>
            ) : (
              <Button
                onClick={handleNext}
                disabled={!answers[currentProblem.id]}
              >
                다음
                <ArrowRight className="h-4 w-4 ml-2" />
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default SolveProblem;
