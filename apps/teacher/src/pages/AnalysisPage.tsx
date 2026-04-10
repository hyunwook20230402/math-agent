import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { 
  BarChart3, 
  TrendingUp, 
  Users, 
  Target,
  AlertCircle,
  CheckCircle,
  XCircle,
  Calendar,
  Download,
  Filter
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

interface Student {
  id: string;
  name: string;
  email: string;
  class_name?: string;
}

interface ProblemAnalysis {
  problem_id: string;
  question: string;
  correct_count: number;
  wrong_count: number;
  accuracy: number;
  difficulty: number;
  unit: string;
}

interface StudentAnalysis {
  student_id: string;
  student_name: string;
  total_problems: number;
  correct_answers: number;
  accuracy: number;
  recent_improvement: number;
}

interface SetAnalysis {
  set_id: string;
  set_name: string;
  total_students: number;
  average_accuracy: number;
  completion_rate: number;
}

const AnalysisPage = () => {
  const { profile } = useAuth();
  const [students, setStudents] = useState<Student[]>([]);
  const [problemAnalysis, setProblemAnalysis] = useState<ProblemAnalysis[]>([]);
  const [studentAnalysis, setStudentAnalysis] = useState<StudentAnalysis[]>([]);
  const [setAnalysis, setSetAnalysis] = useState<SetAnalysis[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedView, setSelectedView] = useState<'students' | 'problems' | 'sets'>('students');
  const [selectedUnit, setSelectedUnit] = useState<string>('all');
  const [dateRange, setDateRange] = useState<string>('week');

  useEffect(() => {
    if (profile) {
      fetchAnalysisData();
    }
  }, [profile, selectedView, selectedUnit, dateRange]);

  const fetchAnalysisData = async () => {
    if (!profile) return;

    // Fetch students
    const { data: studentsData } = await supabase
      .from('profiles')
      .select('*')
      .eq('role', 'student')
      .order('name');

    if (studentsData) setStudents(studentsData);

    // Fetch student answers for analysis
    const { data: answersData, error } = await supabase
      .from('student_answers')
      .select(`
        *,
        problem:problems(*),
        student:profiles(name)
      `)
      .eq('problems.teacher_id', profile.id);

    if (error) {
      console.error('Error fetching analysis data:', error);
      return;
    }

    if (answersData) {
      // Filter by date range
      const filteredAnswers = filterByDateRange(answersData, dateRange);
      
      // Filter by unit if selected
      const unitFilteredAnswers = selectedUnit === 'all' 
        ? filteredAnswers 
        : filteredAnswers.filter((answer: any) => answer.problem.unit === selectedUnit);

      // Generate problem analysis
      const problemMap = new Map<string, ProblemAnalysis>();
      
      unitFilteredAnswers.forEach((answer: any) => {
        const problemId = answer.problem_id;
        
        if (!problemMap.has(problemId)) {
          problemMap.set(problemId, {
            problem_id: problemId,
            question: answer.problem.question,
            correct_count: 0,
            wrong_count: 0,
            accuracy: 0,
            difficulty: answer.problem.difficulty,
            unit: answer.problem.unit
          });
        }
        
        const problem = problemMap.get(problemId)!;
        if (answer.is_correct) {
          problem.correct_count++;
        } else {
          problem.wrong_count++;
        }
      });

      // Calculate accuracy for each problem
      problemMap.forEach(problem => {
        const total = problem.correct_count + problem.wrong_count;
        problem.accuracy = total > 0 ? Math.round((problem.correct_count / total) * 100) : 0;
      });

      // Generate student analysis
      const studentMap = new Map<string, StudentAnalysis>();
      
      unitFilteredAnswers.forEach((answer: any) => {
        const studentId = answer.student_id;
        
        if (!studentMap.has(studentId)) {
          studentMap.set(studentId, {
            student_id: studentId,
            student_name: answer.student.name,
            total_problems: 0,
            correct_answers: 0,
            accuracy: 0,
            recent_improvement: 0
          });
        }
        
        const student = studentMap.get(studentId)!;
        student.total_problems++;
        if (answer.is_correct) {
          student.correct_answers++;
        }
      });

      // Calculate accuracy for each student
      studentMap.forEach(student => {
        student.accuracy = student.total_problems > 0 
          ? Math.round((student.correct_answers / student.total_problems) * 100) 
          : 0;
      });

      setProblemAnalysis(Array.from(problemMap.values()));
      setStudentAnalysis(Array.from(studentMap.values()));
      setLoading(false);
    }
  };

  const filterByDateRange = (data: any[], range: string) => {
    const now = new Date();
    const startDate = new Date();
    
    switch (range) {
      case 'week':
        startDate.setDate(now.getDate() - 7);
        break;
      case 'month':
        startDate.setMonth(now.getMonth() - 1);
        break;
      case 'quarter':
        startDate.setMonth(now.getMonth() - 3);
        break;
      default:
        return data;
    }
    
    return data.filter((item: any) => {
      const itemDate = new Date(item.submitted_at);
      return itemDate >= startDate && itemDate <= now;
    });
  };

  const exportData = (type: string) => {
    // TODO: Implement CSV export
    console.log(`Exporting ${type} data`);
  };

  const getAccuracyColor = (accuracy: number) => {
    if (accuracy >= 90) return 'text-green-600';
    if (accuracy >= 70) return 'text-yellow-600';
    return 'text-red-600';
  };

  const getAccuracyBadgeVariant = (accuracy: number) => {
    if (accuracy >= 90) return 'default';
    if (accuracy >= 70) return 'secondary';
    return 'destructive';
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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-foreground">분석 대시보드</h1>
          <p className="text-muted-foreground">학생들의 성과와 문제별 분석을 확인하세요</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => exportData('all')}>
            <Download className="h-4 w-4 mr-2" />
            데이터 내보내기
          </Button>
        </div>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="p-6">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <Filter className="h-4 w-4" />
              <span className="text-sm font-medium">분석 기준:</span>
            </div>
            <Select value={selectedView} onValueChange={(value: any) => setSelectedView(value)}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="students">학생별 분석</SelectItem>
                <SelectItem value="problems">문제별 분석</SelectItem>
                <SelectItem value="sets">세트별 분석</SelectItem>
              </SelectContent>
            </Select>
            <Select value={selectedUnit} onValueChange={setSelectedUnit}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">전체 단원</SelectItem>
                <SelectItem value="수학1">수학1</SelectItem>
                <SelectItem value="수학2">수학2</SelectItem>
                <SelectItem value="미적분">미적분</SelectItem>
              </SelectContent>
            </Select>
            <Select value={dateRange} onValueChange={setDateRange}>
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="week">최근 1주</SelectItem>
                <SelectItem value="month">최근 1개월</SelectItem>
                <SelectItem value="quarter">최근 3개월</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Overall Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-2">
              <Users className="h-5 w-5 text-blue-500" />
              <div>
                <p className="text-sm text-muted-foreground">활성 학생</p>
                <p className="text-2xl font-bold">{studentAnalysis.length}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-2">
              <Target className="h-5 w-5 text-green-500" />
              <div>
                <p className="text-sm text-muted-foreground">평균 정답률</p>
                <p className="text-2xl font-bold">
                  {studentAnalysis.length > 0 
                    ? Math.round(studentAnalysis.reduce((sum, s) => sum + s.accuracy, 0) / studentAnalysis.length)
                    : 0}%
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-red-500" />
              <div>
                <p className="text-sm text-muted-foreground">어려운 문제</p>
                <p className="text-2xl font-bold">
                  {problemAnalysis.filter(p => p.accuracy < 50).length}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-purple-500" />
              <div>
                <p className="text-sm text-muted-foreground">개선 필요 학생</p>
                <p className="text-2xl font-bold">
                  {studentAnalysis.filter(s => s.accuracy < 70).length}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Analysis Content */}
      {selectedView === 'students' && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="h-5 w-5" />
              학생별 성과 분석
            </CardTitle>
            <CardDescription>각 학생의 정답률과 개선 현황을 확인하세요</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {studentAnalysis.map((student) => (
                <div key={student.student_id} className="flex items-center justify-between p-4 border rounded-lg">
                  <div className="flex items-center gap-4">
                    <div>
                      <h4 className="font-medium">{student.student_name}</h4>
                      <p className="text-sm text-muted-foreground">
                        {student.total_problems}문제 해결
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="text-right">
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-muted-foreground">정답률:</span>
                        <Badge variant={getAccuracyBadgeVariant(student.accuracy)}>
                          {student.accuracy}%
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {student.correct_answers}/{student.total_problems} 정답
                      </p>
                    </div>
                    <div className="w-32">
                      <Progress value={student.accuracy} className="h-2" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {selectedView === 'problems' && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Target className="h-5 w-5" />
              문제별 정답률 분석
            </CardTitle>
            <CardDescription>각 문제의 난이도와 학생들의 성과를 확인하세요</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {problemAnalysis.map((problem) => (
                <div key={problem.problem_id} className="flex items-center justify-between p-4 border rounded-lg">
                  <div className="flex-1">
                    <h4 className="font-medium text-sm mb-1">
                      {problem.question.substring(0, 60)}...
                    </h4>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span>{problem.unit}</span>
                      <span>난이도: {problem.difficulty}/5</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="text-right">
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-muted-foreground">정답률:</span>
                        <Badge variant={getAccuracyBadgeVariant(problem.accuracy)}>
                          {problem.accuracy}%
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {problem.correct_count}/{problem.correct_count + problem.wrong_count} 정답
                      </p>
                    </div>
                    <div className="w-32">
                      <Progress value={problem.accuracy} className="h-2" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {selectedView === 'sets' && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BarChart3 className="h-5 w-5" />
              세트별 성과 분석
            </CardTitle>
            <CardDescription>문제 세트별 학생들의 성과를 확인하세요</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {setAnalysis.map((set) => (
                <div key={set.set_id} className="flex items-center justify-between p-4 border rounded-lg">
                  <div>
                    <h4 className="font-medium">{set.set_name}</h4>
                    <p className="text-sm text-muted-foreground">
                      {set.total_students}명의 학생이 참여
                    </p>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="text-right">
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-muted-foreground">평균 정답률:</span>
                        <Badge variant={getAccuracyBadgeVariant(set.average_accuracy)}>
                          {set.average_accuracy}%
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        완료율: {set.completion_rate}%
                      </p>
                    </div>
                    <div className="w-32">
                      <Progress value={set.average_accuracy} className="h-2" />
                    </div>
                  </div>
                </div>
              ))}
              {setAnalysis.length === 0 && (
                <div className="text-center py-8 text-muted-foreground">
                  <BarChart3 className="h-12 w-12 mx-auto mb-4" />
                  <p>세트별 분석 데이터가 없습니다</p>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Recommendations */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5" />
            개선 제안
          </CardTitle>
          <CardDescription>분석 결과를 바탕으로 한 개선 방안을 제시합니다</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="p-4 border rounded-lg">
              <h4 className="font-medium mb-2 flex items-center gap-2">
                <AlertCircle className="h-4 w-4 text-red-500" />
                주의 필요 학생
              </h4>
              <p className="text-sm text-muted-foreground">
                {studentAnalysis.filter(s => s.accuracy < 50).length}명의 학생이 50% 미만의 정답률을 보이고 있습니다.
              </p>
            </div>
            <div className="p-4 border rounded-lg">
              <h4 className="font-medium mb-2 flex items-center gap-2">
                <Target className="h-4 w-4 text-yellow-500" />
                어려운 문제
              </h4>
              <p className="text-sm text-muted-foreground">
                {problemAnalysis.filter(p => p.accuracy < 30).length}개의 문제가 30% 미만의 정답률을 보입니다.
              </p>
            </div>
            <div className="p-4 border rounded-lg">
              <h4 className="font-medium mb-2 flex items-center gap-2">
                <CheckCircle className="h-4 w-4 text-green-500" />
                우수 성과
              </h4>
              <p className="text-sm text-muted-foreground">
                {studentAnalysis.filter(s => s.accuracy >= 90).length}명의 학생이 90% 이상의 정답률을 달성했습니다.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default AnalysisPage;
