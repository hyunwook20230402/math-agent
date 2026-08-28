// @ts-nocheck
import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '@shared/hooks/useAuth';
import { Button } from '@shared/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@shared/ui/card';
import { Progress } from '@shared/ui/progress';
import { Badge } from '@shared/ui/badge';
import { toast } from '@shared/hooks/use-toast';
import { 
  ArrowLeft, 
  ArrowRight, 
  CheckCircle, 
  XCircle, 
  Clock, 
  Send,
  AlertCircle
} from 'lucide-react';
import { distributionApi, studentAnswerApi, wrongAnswerApi, wrongAnswerReviewApi } from '@shared/lib/api';
import { checkAnswer, normalizeAnswer } from '@shared/lib/answerNormalizer';
// 회차 규칙은 대시보드와 **같은 원본**을 쓴다. 버튼을 감추는 것만으로는 못 막는다 —
// 제출 뒤 브라우저 뒤로가기로 이 화면이 그대로 다시 열리기 때문(canAttemptToday 주석 참조).
import {
  canAttemptToday,
  buildReviewStages,
  AUTO_REVIEW_KINDS,
  toDateStr,
  type ProblemAttemptStat,
} from '@shared/lib/reviewSchedule';
import { renderShortMath } from '@shared/lib/mathRender';
import 'katex/dist/katex.min.css';
import type { DistributionWithDetails } from '@shared/types/database';
import StuckHelperModal from '@/components/tutor/StuckHelperModal';

// 보기 번호 표기. 교사가 보기 내용을 채운 문제에서 ① x+2 처럼 앞에 붙인다.
const CHOICE_MARKS = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];

interface Problem {
  id: string;
  title: string;
  answer_type: 'multiple_choice' | 'short_answer';
  correct_answer: string;
  choices?: string[];
  image_url?: string;
  unit?: string;
  difficulty_score?: number;
  difficulty?: string;
}

const SolveProblem = () => {
  const { distributionId } = useParams<{ distributionId: string }>();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const [searchParams] = useSearchParams();
  
  // 진입하자마자 배포를 불러오므로 처음부터 true — false 로 두면 데이터가 오기 전에
  // "문제를 찾을 수 없습니다" 화면이 먼저 번쩍인다.
  const [loading, setLoading] = useState(true);
  const [distribution, setDistribution] = useState<DistributionWithDetails | null>(null);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [currentProblemIndex, setCurrentProblemIndex] = useState(0);
  const [answers, setAnswers] = useState<{ [key: string]: string }>({});
  const [submitted, setSubmitted] = useState(false);
  const [results, setResults] = useState<{ [key: string]: boolean }>({});
  const [attemptCounts, setAttemptCounts] = useState<{ [key: string]: number }>({});
  const [timeSpent, setTimeSpent] = useState(0);
  const [isWrongAnswersOnly, setIsWrongAnswersOnly] = useState(false);
  // 이번 화면에서 student_answers 저장에 **성공한** 문제 → 정답여부.
  // 제출이 부분 실패한 뒤 다시 제출할 때 중복 insert(=회차 두 칸 뛰기)를 막는다.
  const recordedRef = useRef<{ [problemId: string]: boolean }>({});
  // 제출이 진행 중인가. loading 은 다른 effect 가 되돌릴 수 있어 이중 제출을 못 막는다.
  const submittingRef = useRef(false);
  // 문제별 전체 시도 요약(배포 무관) — "오늘 또 풀어도 되는가" 판정의 근거.
  const [attemptStats, setAttemptStats] = useState<{ [problemId: string]: ProblemAttemptStat }>({});
  const [statsLoaded, setStatsLoaded] = useState(false);

  // 배포 날짜를 URL 파라미터로 변환하는 함수
  // ⚠️ toISOString() 은 UTC 라 KST 오전 배포가 전날로 밀린다 — 대시보드 날짜 필터가
  //    그 값을 그대로 쓰므로, 돌아갔을 때 **엉뚱한 날짜**가 선택된다. 로컬 기준으로 뽑는다.
  const getDistributionDateParam = () => {
    if (!distribution?.distribution_date) return '';
    return toDateStr(new Date(distribution.distribution_date));
  };

  // 컴포넌트 마운트 시 기존 시도 횟수 로드
  //
  // ⚠️ deps 에 problems 가 있어 **두 번 발사된다**(problems=[] 일 때 1차, 채워진 뒤 2차).
  //    취소 플래그가 없으면 늦게 도착한 1차가 정상 값을 `{}` 로 덮어써 attempt_number 가
  //    NaN → null 이 되고 NOT NULL(23502)로 **제출이 통째로 실패**한다(검토에서 확인).
  useEffect(() => {
    if (!profile?.id || !distributionId || problems.length === 0) return;
    let cancelled = false;

    (async () => {
      try {
        const existingAnswers = await studentAnswerApi.getStudentAnswers(profile.id, distributionId);
        if (cancelled) return;
        const counts: { [key: string]: number } = {};
        problems.forEach(problem => {
          counts[problem.id] = existingAnswers.filter(a => a.problem_id === problem.id).length;
        });
        setAttemptCounts(counts);
      } catch (error) {
        console.error('시도 횟수 로드 실패:', error);
      }
    })();

    return () => { cancelled = true; };
  }, [profile?.id, distributionId, problems]);

  // 문제별 **전체** 시도 요약 — 하루에 복습 한 회차 가드의 근거(배포 무관, 선생님 표와 같은 기준).
  useEffect(() => {
    if (!profile?.id) return;
    let cancelled = false;

    (async () => {
      try {
        const stats = await studentAnswerApi.getProblemAttemptStats(profile.id);
        if (cancelled) return;
        setAttemptStats(stats);
      } catch (error) {
        // 못 읽으면 가드를 걸 수 없다. 막기보다 통과시킨다 — 학생이 숙제를 못 하는 게 더 나쁘다.
        console.warn('시도 요약 조회 실패 (하루 한 회차 가드 미적용):', error);
      } finally {
        if (!cancelled) setStatsLoaded(true);
      }
    })();

    return () => { cancelled = true; };
  }, [profile?.id]);

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
    // 부분 실패 후 재제출 때, 이미 저장된 문제는 다시 안 보낸다(중복 = 회차 두 칸 뛰기).
    // 그래서 여기서 고쳐도 반영될 수 없다 — 조용히 버리지 말고 막고 알린다.
    if (currentProblem.id in recordedRef.current) {
      toast({
        title: "이미 저장된 답이에요",
        description: "이 문제는 저장이 끝나 고칠 수 없어요. 다음 회차에 다시 풀게 됩니다.",
        variant: "default"
      });
      return;
    }
    setAnswers(prev => ({
      ...prev,
      [currentProblem.id]: answer
    }));
  };

  /**
   * 답안이 실제로 채워졌는가.
   *
   * ⚠️ 옛 검사는 `!answers[id]` 였다 — 공백 한 칸(`" "`)은 **truthy 라 그냥 통과**해서
   *    빈 답이 제출되고 오답으로 박제됐다. 주관식은 반드시 trim 해서 본다.
   *    (객관식 값은 언제나 보기 번호 문자열이라 trim 해도 무해하다.)
   */
  const isAnswered = (problemId: string) => (answers[problemId] ?? '').trim() !== '';

  /** 아직 안 푼 문제의 화면상 번호(1-based). 제출 가능 여부와 안내 문구의 근거. */
  const getUnansweredIndexes = () =>
    problems.reduce<number[]>((acc, p, i) => (isAnswered(p.id) ? acc : [...acc, i]), []);

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
    // 이중 제출 차단. loading 은 다른 effect(재마운트·auth 갱신)가 되돌릴 수 있어 못 믿는다.
    if (submittingRef.current) return;

    // 제출은 **전부 답한 경우에만**. 객관식은 고르고 주관식은 채워야 한다.
    // 버튼도 막아 두지만(아래 disabled) 여기서 한 번 더 본다 — 화면 조건이 바뀌어도
    // 빈 답이 student_answers 에 박히면 그게 곧 오답 이력이 되고 회차가 한 칸 넘어간다.
    if (problems.length === 0) return;

    // 오늘 몫을 이미 끝낸 문제는 제출을 막는다(뒤로가기로 이 화면에 다시 들어온 경우).
    if (blockedToday) {
      toast({
        title: "오늘 몫은 이미 마쳤어요",
        description: "복습은 하루에 한 번씩 나눠 풀어야 효과가 있어요. 내일 다시 만나요!",
        variant: "default"
      });
      return;
    }

    const unanswered = getUnansweredIndexes();
    if (unanswered.length > 0) {
      toast({
        title: "아직 다 못 풀었어요",
        description:
          `${unanswered.length}문제가 비어 있습니다 — ` +
          `${unanswered.slice(0, 8).map(i => `문제 ${i + 1}`).join(', ')}` +
          `${unanswered.length > 8 ? ' 외' : ''}. 모두 답해야 제출할 수 있어요.`,
        variant: "destructive"
      });
      setCurrentProblemIndex(unanswered[0]);   // 첫 빈 문제로 데려다 준다
      return;
    }

    submittingRef.current = true;
    setLoading(true);
    try {
      // ★이미 저장에 성공한 문제는 다시 안 보낸다.
      //   student_answers 는 append-only 라 **한 행 = 한 회차**다. 일부만 저장된 채 실패해서
      //   학생이 다시 제출하면, 성공했던 문제만 행이 하나 더 쌓여 **회차가 두 칸 뛴다**
      //   → 선생님 오답 표에 같은 날짜가 두 칸에 찍힌다.
      const results: { [key: string]: boolean } = { ...recordedRef.current };
      const pending = problems.filter(problem => !(problem.id in recordedRef.current));

      const settled = await Promise.allSettled(pending.map(async (problem) => {
        // 정답 비교 - 형식 차이(①/"3번"/"3")를 흡수하도록 정규화 후 비교
        const check = checkAnswer(answers[problem.id], problem.correct_answer, problem.answer_type);
        // 정답 정보가 없는 문제(correct_answer 빈 값)는 오답으로 박제하지 않고 정답 처리
        // (학생 책임 아님 — CMS 에서 정답 채워지면 재채점 가능). 오답 노트에도 안 넣음.
        const isCorrect = check.hasCorrectAnswer ? check.isCorrect : true;

        // 이게 성공해야 회차가 오른다 — 실패하면 아래 기록도 안 남아 재시도 대상이 된다
        await studentAnswerApi.submitAnswer({
          student_id: profile.id,
          problem_id: problem.id,
          answer: answers[problem.id],
          is_correct: isCorrect,
          attempt_number: (attemptCounts[problem.id] ?? 0) + 1, // 없으면 NaN→null→23502 (기본 0)
          distribution_id: distributionId
        });
        recordedRef.current[problem.id] = isCorrect;
        results[problem.id] = isCorrect;

        // 오답 노트는 보조 기록 — 실패해도 제출은 성립한다(회차의 근거는 student_answers).
        try {
          if (!isCorrect) {
            await wrongAnswerApi.addWrongAnswer({
              student_id: profile.id,
              problem_id: problem.id,
              wrong_answer: answers[problem.id],
              attempt_number: (attemptCounts[problem.id] ?? 0) + 1 // 시도 횟수 포함
            });
          } else {
            await wrongAnswerApi.removeWrongAnswer(profile.id, problem.id);
          }
        } catch (error) {
          console.warn('오답 노트 갱신 실패:', error);
        }
      }));

      const failed = settled.filter(r => r.status === 'rejected');
      if (failed.length > 0) {
        console.error('답안 저장 실패:', failed.map(f => (f as PromiseRejectedResult).reason));
        toast({
          title: "일부 답안을 저장하지 못했어요",
          description: `${failed.length}문제가 저장되지 않았습니다. 다시 제출해 주세요 — 이미 저장된 문제는 중복으로 저장되지 않습니다.`,
          variant: "destructive"
        });
        return;   // finally 에서 loading 이 풀려 다시 제출할 수 있다
      }

      setResults(results);
      setSubmitted(true);

      const correctCount = Object.values(results).filter(Boolean).length;
      const accuracy = (correctCount / problems.length) * 100;

      toast({
        title: "제출 완료",
        description: `정답률: ${accuracy.toFixed(1)}% (${correctCount}/${problems.length})`
      });

      // ★자동 채점이 끝났으니 **복습 배포 3개**(다음 수업·2주·4주)를 바로 만든다.
      //   선생님이 손으로 예약하던 걸 대체한다. 담기는 문제는 **첫 시도에서 틀린 것**이고,
      //   그 묶음은 나중에 맞혀도 안 바뀐다(RPC 가 DISTINCT ON 으로 첫 시도를 본다).
      //
      //   조건 둘: 원본 배포일 것(복습을 풀었다고 또 만들지 않는다) + 오답만 다시 푸는
      //   화면이 아닐 것(그건 2회차라 이미 원본에서 만들어졌다).
      //
      //   ⚠️ **실패해도 제출은 성립시킨다.** 여기서 throw 하면 학생이 "제출 실패" 로 읽고
      //   다시 누르는데, 그러면 student_answers 에 행이 더 쌓여 **회차가 두 칸 뛴다**
      //   (위 recordedRef 주석의 그 사고). 못 만든 건 선생님 화면의 안전망이 잡는다.
      if (!isWrongAnswersOnly && !distribution?.review_kind) {
        try {
          const created = await wrongAnswerReviewApi.autoCreateReviews({
            distributionId,
            studentId: profile.id,
            // 기준일은 **오늘**(실제로 푼 날). 배포 예정일이 아니라 푼 날에서 회차를 깐다.
            stages: buildReviewStages(toDateStr(new Date()), AUTO_REVIEW_KINDS),
          });
          if (created.length > 0) {
            console.info(`[review] 복습 배포 ${created.length}건 생성`);
          }
        } catch (error) {
          console.warn('복습 배포 자동 생성 실패:', error);
        }
      }
    } catch (error) {
      console.error('답안 제출 오류:', error);
      toast({
        title: "오류",
        description: "답안 제출 중 오류가 발생했습니다.",
        variant: "destructive"
      });
    } finally {
      setLoading(false);
      submittingRef.current = false;
    }
  };

  const formatTime = (seconds: number) => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const getCurrentProblem = () => problems[currentProblemIndex];

  // ⚠️ 아래 파생 상수들은 렌더 때 바로 계산된다 — useState/useRef 선언 아래여야 한다(TDZ, dev-rules).
  //
  // 이 화면의 문제들 중 **오늘 더 풀 수 있는 게 하나도 없으면** 제출을 막는다.
  // 대시보드에서 버튼을 감추는 것만으로는 못 막는다 — 제출 뒤 브라우저 뒤로가기 한 번이면
  // 이 URL 이 그대로 다시 열려 같은 날 회차를 계속 올릴 수 있다(검토에서 3개 관점이 확인).
  // 통계를 못 읽었으면(statsLoaded=false 또는 조회 실패) 막지 않는다 — 못 푸는 게 더 나쁘다.
  const blockedToday =
    statsLoaded &&
    !submitted &&
    problems.length > 0 &&
    Object.keys(attemptStats).length > 0 &&
    problems.every(p => !canAttemptToday(attemptStats[p.id]));

  if (loading) {
    return (
      <div className="container mx-auto px-4 py-6">
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
        </div>
      </div>
    );
  }

  if (blockedToday) {
    return (
      <div className="container mx-auto px-4 py-6">
        <div className="text-center max-w-md mx-auto">
          <CheckCircle className="h-12 w-12 text-emerald-600 mx-auto mb-4" />
          <h2 className="text-xl font-semibold mb-2">수고하셨습니다</h2>
          <p className="text-muted-foreground mb-4">
            오늘 몫은 이미 마쳤어요. 복습은 며칠에 걸쳐 나눠 풀어야 오래 남아요 — 내일 다시 만나요!
          </p>
          <Button onClick={() => navigate('/student')}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            대시보드로 돌아가기
          </Button>
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

            {/*
              여기 있던 "전체 다시 풀기" 는 뺐다. 그 자리에서 또 제출하면 student_answers 에
              행이 하나 더 쌓여 **회차가 그냥 넘어간다** — 선생님 오답 표의 2·3·4회차 칸이
              전부 같은 날짜로 채워져 "월요일 오답을 며칠에 걸쳐 다시 푼다"는 규칙이 무너진다.
              다시 푸는 길은 대시보드의 "오답 숙제하기 (N회차)" 하나로 모은다.
            */}
            <Button
              variant="outline"
              className="w-full"
              onClick={() => {
                const dateParam = getDistributionDateParam();
                const url = dateParam ? `/student?date=${dateParam}` : '/student';
                navigate(url);
              }}
            >
              <ArrowLeft className="h-4 w-4 mr-2" />
              대시보드로
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const currentProblem = getCurrentProblem();
  const progress = ((currentProblemIndex + 1) / problems.length) * 100;
  // ⚠️ 렌더 때 바로 계산되는 파생 상수 — 반드시 useState/useRef 선언 **아래**에 둔다(TDZ, dev-rules).
  const unansweredIndexes = getUnansweredIndexes();
  const allAnswered = problems.length > 0 && unansweredIndexes.length === 0;

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

      {/* 2단 레이아웃: 좌측 문제 / 우측 막힌 지점 도우미 채팅 (데스크톱) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* 좌측: 문제 카드 */}
        <div className="lg:col-span-2">
      <Card>
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
                {/* 라디오 값은 언제나 **보기 번호**다. 보기 내용을 값으로 쓰면
                    정답 판정(normalizeAnswer)이 문자열에서 첫 숫자를 뽑는 탓에
                    "x+2" 가 2번으로 읽혀 오채점된다.
                    보기 내용(choices)은 교사가 직접 채운 경우에만 있고 — 지면에 보기가
                    인쇄된 문제는 비어 있어 번호만 보여준다. */}
                {Array.from(
                  { length: currentProblem.choices?.length || 5 },
                  (_, index) => {
                    const value = String(index + 1);
                    const text = currentProblem.choices?.[index]?.trim();
                    // 옛 답안은 "1번" 으로 저장돼 있어 그대로 비교하면 선택이 안 보인다.
                    const picked =
                      normalizeAnswer(answers[currentProblem.id], 'multiple_choice') === value;
                    return (
                      <label key={index} className="flex items-center space-x-2 cursor-pointer p-2 rounded hover:bg-muted">
                        <input
                          type="radio"
                          name={`problem-${currentProblem.id}`}
                          value={value}
                          checked={picked}
                          onChange={(e) => handleAnswerChange(e.target.value)}
                          className="h-4 w-4"
                        />
                        <span className="text-sm">
                          {CHOICE_MARKS[index] ?? `${value}.`}
                          {text
                            ? <span className="ml-1" dangerouslySetInnerHTML={{ __html: renderShortMath(text) }} />
                            : <span className="ml-1">{value}번</span>}
                        </span>
                      </label>
                    );
                  },
                )}
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

          {/* 아직 안 푼 문제 안내 — 제출 버튼이 왜 막혀 있는지 보이게 한다 */}
          {unansweredIndexes.length > 0 && (
            <div className="flex items-center justify-between gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              <span className="flex items-center gap-2">
                <AlertCircle className="h-4 w-4 shrink-0" />
                아직 {unansweredIndexes.length}문제가 비어 있어요 (문제{' '}
                {unansweredIndexes.slice(0, 5).map(i => i + 1).join(', ')}
                {unansweredIndexes.length > 5 ? ' 외' : ''})
              </span>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => setCurrentProblemIndex(unansweredIndexes[0])}
              >
                이동
              </Button>
            </div>
          )}

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
              // 제출은 **전 문항**을 채웠을 때만. 마지막 문제 하나만 보던 옛 조건은
              // 중간에 비운 문제를 그냥 통과시켰다.
              <Button
                onClick={handleSubmit}
                disabled={loading || !allAnswered}
              >
                <Send className="h-4 w-4 mr-2" />
                제출하기
              </Button>
            ) : (
              <Button
                onClick={handleNext}
                disabled={!isAnswered(currentProblem.id)}
              >
                다음
                <ArrowRight className="h-4 w-4 ml-2" />
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
        </div>

        {/* 우측: 막힌 지점 도우미 채팅 (상시 노출). 데스크톱은 sticky, 모바일은 문제 아래로 스택 */}
        <div className="lg:col-span-1">
          <div className="lg:sticky lg:top-6 h-[70vh] lg:h-[calc(100vh-7rem)]">
            <StuckHelperModal problemId={currentProblem.id} mode="panel" key={currentProblem.id} />
          </div>
        </div>
      </div>
    </div>
  );
};

export default SolveProblem;
