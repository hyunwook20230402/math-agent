import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@shared/ui/card';
import { Button } from '@shared/ui/button';
import { Badge } from '@shared/ui/badge';
import { 
  BookOpen, 
  AlertCircle, 
  RefreshCw,
  CheckCircle,
  XCircle,
  ArrowLeft
} from 'lucide-react';
import { useAuth } from '@shared/hooks/useAuth';
import { useNavigate, useParams } from 'react-router-dom';
import { studentAnswerApi, distributionApi } from '@shared/lib/api';

interface StillWrongProblem {
  id: string;
  title: string;
  firstWrongAnswer: string;
  secondWrongAnswer: string;
  correctAnswer: string;
  attemptCount: number;
}

interface DistributionInfo {
  id: string;
  title: string;
  problemSetName: string;
}

const StillWrongAnswerNote = () => {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const { distributionId } = useParams<{ distributionId: string }>();
  const [stillWrongProblems, setStillWrongProblems] = useState<StillWrongProblem[]>([]);
  const [distributionInfo, setDistributionInfo] = useState<DistributionInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (profile && distributionId) {
      fetchStillWrongProblems();
    }
  }, [profile, distributionId]);

  const fetchStillWrongProblems = async () => {
    if (!profile || !distributionId) return;

    try {
      // 배포 정보 가져오기
      const distributionData = await distributionApi.getDistributionById(distributionId);
      setDistributionInfo({
        id: distributionData.id,
        title: distributionData.title,
        problemSetName: distributionData.problem_set.name
      });

      // 해당 배포의 학생 답안들 가져오기
      const studentAnswers = await studentAnswerApi.getStudentAnswers(profile.id, distributionId);
      
      // 문제별로 그룹화하여 첫 번째 틀린 답안과 최신 답안 찾기
      const problemAnswersMap = new Map();
      studentAnswers.forEach(answer => {
        if (!problemAnswersMap.has(answer.problem_id)) {
          problemAnswersMap.set(answer.problem_id, []);
        }
        problemAnswersMap.get(answer.problem_id).push(answer);
      });

      const stillWrongProblemsData: StillWrongProblem[] = [];
      
      // 문제 세트의 문제들을 순서대로 가져와서 매칭
      const problems = distributionData.problem_set.problems || [];
      
      for (let i = 0; i < problems.length; i++) {
        const problem = problems[i];
        const answers = problemAnswersMap.get(problem.id);
        
        if (answers && answers.length > 0) {
          // 시간순으로 정렬
          const sortedAnswers = answers.sort((a, b) => 
            new Date(a.submitted_at).getTime() - new Date(b.submitted_at).getTime()
          );
          
          const firstAnswer = sortedAnswers[0];
          const latestAnswer = sortedAnswers[sortedAnswers.length - 1];
          
                     // 2회 이상 시도했고, 첫 번째 답안이 틀렸고, 두 번째 답안도 여전히 틀렸다면 추가
           if (sortedAnswers.length >= 2 && !firstAnswer.is_correct && !sortedAnswers[1].is_correct) {
            stillWrongProblemsData.push({
              id: problem.id,
              title: `${i + 1}번 ${distributionData.problem_set.name} ${i + 1}번`,
              firstWrongAnswer: firstAnswer.answer,
              secondWrongAnswer: sortedAnswers[1].answer,
              correctAnswer: problem.correct_answer || '정답 정보 없음',
              attemptCount: 2 // 항상 2회로 고정
            });
          }
        }
      }

      setStillWrongProblems(stillWrongProblemsData);
      
    } catch (error) {
      console.error('두번 틀린 문제 목록 조회 실패:', error);
    }

    setLoading(false);
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
    <div className="container mx-auto px-4 py-6 space-y-6">
      <div className="flex items-center gap-4">
        <Button
          variant="ghost"
          onClick={() => navigate('/student/dashboard')}
          className="flex items-center gap-2"
        >
          <ArrowLeft className="h-4 w-4" />
          대시보드로 돌아가기
        </Button>
      </div>

      <div>
        <h1 className="text-3xl font-bold text-foreground">두번 틀린 문제들 목록</h1>
        <p className="text-muted-foreground">
          {distributionInfo ? `${distributionInfo.problemSetName} - ${distributionInfo.title}` : '로딩 중...'}
        </p>
      </div>

      <Card>
        <CardHeader>
                     <CardTitle className="flex items-center gap-2">
             <XCircle className="h-5 w-5" />
             두번 틀린 문제들
           </CardTitle>
           <CardDescription>
             처음 틀린 문제들 중에서 두번째 시도에서도 틀린 문제들입니다
           </CardDescription>
        </CardHeader>
        <CardContent>
          {stillWrongProblems.length > 0 ? (
            <div className="space-y-4">
              {stillWrongProblems.map((problem, index) => (
                <div key={problem.id} className="p-4 border rounded-lg">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                                             <div className="flex items-center gap-2 mb-2">
                         <h3 className="font-medium text-lg">
                           {problem.title}
                         </h3>
                         <Badge variant="destructive">
                           2회 시도
                         </Badge>
                       </div>
                      
                      <div className="space-y-2 text-sm">
                        <div className="flex items-center gap-2">
                          <XCircle className="h-4 w-4 text-red-500" />
                          <span className="text-muted-foreground">첫 시도 답안:</span>
                          <span className="font-medium">{problem.firstWrongAnswer}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <XCircle className="h-4 w-4 text-orange-500" />
                          <span className="text-muted-foreground">두번째 시도 답안:</span>
                          <span className="font-medium">{problem.secondWrongAnswer}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <CheckCircle className="h-4 w-4 text-green-500" />
                          <span className="text-muted-foreground">정답:</span>
                          <span className="font-medium">{problem.correctAnswer}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
                     ) : (
             <div className="text-center py-8 text-muted-foreground">
               <CheckCircle className="h-12 w-12 mx-auto mb-4 text-green-500" />
             </div>
           )}
        </CardContent>
      </Card>
    </div>
  );
};

export default StillWrongAnswerNote;
