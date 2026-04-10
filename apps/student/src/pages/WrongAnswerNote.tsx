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

interface WrongProblem {
  id: string;
  title: string;
  firstWrongAnswer: string;
  correctAnswer: string;
}

interface DistributionInfo {
  id: string;
  title: string;
  problemSetName: string;
}

const WrongAnswerNote = () => {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const { distributionId } = useParams<{ distributionId: string }>();
  const [wrongProblems, setWrongProblems] = useState<WrongProblem[]>([]);
  const [distributionInfo, setDistributionInfo] = useState<DistributionInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (profile && distributionId) {
      fetchWrongProblems();
    }
  }, [profile, distributionId]);

  // 디버깅용: 실제 배포 ID로 테스트
  useEffect(() => {
    if (profile) {
      console.log('현재 distributionId:', distributionId);
      console.log('실제 데이터가 있는 distributionId: 0ac2152d-82bb-4d87-ace1-c2d49d4f9e12');
    }
  }, [profile, distributionId]);

  const fetchWrongProblems = async () => {
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
      
      // 문제별로 그룹화하여 첫 번째 틀린 답안 찾기
      const problemAnswersMap = new Map();
      studentAnswers.forEach(answer => {
        if (!problemAnswersMap.has(answer.problem_id)) {
          problemAnswersMap.set(answer.problem_id, []);
        }
        problemAnswersMap.get(answer.problem_id).push(answer);
      });

      const wrongProblemsData: WrongProblem[] = [];
      
      // 문제 세트의 문제들을 순서대로 가져와서 매칭
      const problems = distributionData.problem_set.problems || [];
      
      for (let i = 0; i < problems.length; i++) {
        const problem = problems[i];
        const answers = problemAnswersMap.get(problem.id);
        
        if (answers) {
          // 시간순으로 정렬해서 첫 번째 답안 찾기
          const sortedAnswers = answers.sort((a, b) => 
            new Date(a.submitted_at).getTime() - new Date(b.submitted_at).getTime()
          );
          
          // 첫 번째 답안이 틀렸다면 추가
          const firstAnswer = sortedAnswers[0];
          if (!firstAnswer.is_correct) {
            wrongProblemsData.push({
              id: problem.id,
              title: `${i + 1}번 ${distributionData.problem_set.name} ${i + 1}번`,
              firstWrongAnswer: firstAnswer.answer,
              correctAnswer: problem.correct_answer || '정답 정보 없음'
            });
          }
        }
      }

      setWrongProblems(wrongProblemsData);
      
    } catch (error) {
      console.error('처음 틀린 문제 목록 조회 실패:', error);
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
        <h1 className="text-3xl font-bold text-foreground">처음 틀린 문제들 목록</h1>
        <p className="text-muted-foreground">
          {distributionInfo ? `${distributionInfo.problemSetName} - ${distributionInfo.title}` : '로딩 중...'}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertCircle className="h-5 w-5" />
            처음 시도에서 틀린 문제들
          </CardTitle>
          <CardDescription>
            각 문제의 첫 번째 시도에서 틀린 문제들입니다
          </CardDescription>
        </CardHeader>
        <CardContent>
          {wrongProblems.length > 0 ? (
            <div className="space-y-4">
              {wrongProblems.map((problem, index) => (
                <div key={problem.id} className="p-4 border rounded-lg">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <h3 className="font-medium text-lg mb-2">
                        {problem.title}
                      </h3>
                      
                      <div className="space-y-2 text-sm">
                        <div className="flex items-center gap-2">
                          <XCircle className="h-4 w-4 text-red-500" />
                          <span className="text-muted-foreground">첫 시도 답안:</span>
                          <span className="font-medium">{problem.firstWrongAnswer}</span>
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
              <p>첫 시도에서 틀린 문제가 없습니다!</p>
              <p className="text-sm">모든 문제를 첫 번째 시도에서 맞혔습니다.</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default WrongAnswerNote;
