import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { 
  TrendingUp, 
  Target, 
  Award, 
  Calendar,
  BarChart3,
  LineChart,
  PieChart,
  Trophy,
  Star,
  Clock
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

interface Achievement {
  id: string;
  student_id: string;
  unit: string;
  total_problems: number;
  correct_answers: number;
  accuracy: number;
  last_updated: string;
}

interface WeeklyProgress {
  week: string;
  accuracy: number;
  problems_solved: number;
}

interface UnitPerformance {
  unit: string;
  accuracy: number;
  total_problems: number;
  correct_answers: number;
}

const AchievementPage = () => {
  const { profile } = useAuth();
  const [achievements, setAchievements] = useState<Achievement[]>([]);
  const [weeklyProgress, setWeeklyProgress] = useState<WeeklyProgress[]>([]);
  const [unitPerformance, setUnitPerformance] = useState<UnitPerformance[]>([]);
  const [loading, setLoading] = useState(true);
  const [overallStats, setOverallStats] = useState({
    totalProblems: 0,
    totalCorrect: 0,
    overallAccuracy: 0,
    streakDays: 0,
    rank: 0,
    improvement: 0
  });

  useEffect(() => {
    if (profile) {
      fetchAchievementData();
    }
  }, [profile]);

  const fetchAchievementData = async () => {
    if (!profile) return;

    // Fetch student answers with problem details
    const { data: answersData, error } = await supabase
      .from('student_answers')
      .select(`
        *,
        problem:problems(*)
      `)
      .eq('student_id', profile.id)
      .order('submitted_at', { ascending: false });

    if (error) {
      console.error('Error fetching achievement data:', error);
      return;
    }

    if (answersData) {
      // Calculate overall stats
      const totalProblems = answersData.length;
      const totalCorrect = answersData.filter(a => a.is_correct).length;
      const overallAccuracy = totalProblems > 0 ? Math.round((totalCorrect / totalProblems) * 100) : 0;

      // Group by unit for unit performance
      const unitMap = new Map<string, UnitPerformance>();
      
      answersData.forEach((answer: any) => {
        const unit = answer.problem.unit || '기타';
        
        if (!unitMap.has(unit)) {
          unitMap.set(unit, {
            unit,
            accuracy: 0,
            total_problems: 0,
            correct_answers: 0
          });
        }
        
        const unitData = unitMap.get(unit)!;
        unitData.total_problems++;
        if (answer.is_correct) {
          unitData.correct_answers++;
        }
      });

      // Calculate accuracy for each unit
      unitMap.forEach(unit => {
        unit.accuracy = unit.total_problems > 0 
          ? Math.round((unit.correct_answers / unit.total_problems) * 100) 
          : 0;
      });

      // Generate weekly progress (mock data for now)
      const weeklyData: WeeklyProgress[] = [];
      const now = new Date();
      for (let i = 3; i >= 0; i--) {
        const weekStart = new Date(now);
        weekStart.setDate(now.getDate() - (i * 7));
        
        // Filter answers for this week
        const weekAnswers = answersData.filter((answer: any) => {
          const answerDate = new Date(answer.submitted_at);
          const weekEnd = new Date(weekStart);
          weekEnd.setDate(weekStart.getDate() + 6);
          return answerDate >= weekStart && answerDate <= weekEnd;
        });
        
        const weekAccuracy = weekAnswers.length > 0 
          ? Math.round((weekAnswers.filter((a: any) => a.is_correct).length / weekAnswers.length) * 100)
          : 0;
        
        weeklyData.push({
          week: `${weekStart.getMonth() + 1}/${weekStart.getDate()}`,
          accuracy: weekAccuracy,
          problems_solved: weekAnswers.length
        });
      }

      setUnitPerformance(Array.from(unitMap.values()));
      setWeeklyProgress(weeklyData);
      
      setOverallStats({
        totalProblems,
        totalCorrect,
        overallAccuracy,
        streakDays: 5, // Mock data
        rank: 3, // Mock data
        improvement: 15 // Mock data
      });
    }

    setLoading(false);
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

  const getRankIcon = (rank: number) => {
    if (rank === 1) return '🥇';
    if (rank === 2) return '🥈';
    if (rank === 3) return '🥉';
    return '🏅';
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
          <h1 className="text-3xl font-bold text-foreground">성취도</h1>
          <p className="text-muted-foreground">학습 성과와 진도를 확인하세요</p>
        </div>
        <Badge variant="outline" className="flex items-center gap-2">
          <Trophy className="h-4 w-4" />
          {getRankIcon(overallStats.rank)} {overallStats.rank}위
        </Badge>
      </div>

      {/* Overall Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-2">
              <Target className="h-5 w-5 text-blue-500" />
              <div>
                <p className="text-sm text-muted-foreground">총 문제 수</p>
                <p className="text-2xl font-bold">{overallStats.totalProblems}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-2">
              <Award className="h-5 w-5 text-green-500" />
              <div>
                <p className="text-sm text-muted-foreground">정답 수</p>
                <p className="text-2xl font-bold">{overallStats.totalCorrect}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-purple-500" />
              <div>
                <p className="text-sm text-muted-foreground">전체 정답률</p>
                <p className={`text-2xl font-bold ${getAccuracyColor(overallStats.overallAccuracy)}`}>
                  {overallStats.overallAccuracy}%
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-2">
              <Star className="h-5 w-5 text-yellow-500" />
              <div>
                <p className="text-sm text-muted-foreground">연속 학습</p>
                <p className="text-2xl font-bold">{overallStats.streakDays}일</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Weekly Progress Chart */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <LineChart className="h-5 w-5" />
            주간 성과 추이
          </CardTitle>
          <CardDescription>최근 4주간의 학습 성과를 확인하세요</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {weeklyProgress.map((week, index) => (
              <div key={index} className="flex items-center gap-4">
                <div className="w-16 text-sm font-medium">{week.week}</div>
                <div className="flex-1">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm text-muted-foreground">
                      {week.problems_solved}문제 해결
                    </span>
                    <Badge variant={getAccuracyBadgeVariant(week.accuracy)}>
                      {week.accuracy}%
                    </Badge>
                  </div>
                  <Progress value={week.accuracy} className="h-2" />
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Unit Performance */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <PieChart className="h-5 w-5" />
              단원별 성과
            </CardTitle>
            <CardDescription>각 단원별 정답률을 확인하세요</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {unitPerformance.map((unit) => (
              <div key={unit.unit} className="flex items-center justify-between p-3 border rounded-lg">
                <div>
                  <h4 className="font-medium">{unit.unit}</h4>
                  <p className="text-sm text-muted-foreground">
                    {unit.correct_answers}/{unit.total_problems} 문제 정답
                  </p>
                </div>
                <div className="text-right">
                  <Badge variant={getAccuracyBadgeVariant(unit.accuracy)}>
                    {unit.accuracy}%
                  </Badge>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Recent Achievements */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Trophy className="h-5 w-5" />
              최근 성취
            </CardTitle>
            <CardDescription>획득한 성취와 배지를 확인하세요</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-3 p-3 border rounded-lg">
              <div className="w-10 h-10 bg-yellow-100 rounded-full flex items-center justify-center">
                <Star className="h-5 w-5 text-yellow-600" />
              </div>
              <div>
                <h4 className="font-medium">연속 학습 달성</h4>
                <p className="text-sm text-muted-foreground">
                  {overallStats.streakDays}일 연속으로 학습했습니다!
                </p>
              </div>
            </div>
            
            <div className="flex items-center gap-3 p-3 border rounded-lg">
              <div className="w-10 h-10 bg-green-100 rounded-full flex items-center justify-center">
                <Target className="h-5 w-5 text-green-600" />
              </div>
              <div>
                <h4 className="font-medium">목표 달성</h4>
                <p className="text-sm text-muted-foreground">
                  이번 주 목표를 달성했습니다!
                </p>
              </div>
            </div>
            
            <div className="flex items-center gap-3 p-3 border rounded-lg">
              <div className="w-10 h-10 bg-blue-100 rounded-full flex items-center justify-center">
                <TrendingUp className="h-5 w-5 text-blue-600" />
              </div>
              <div>
                <h4 className="font-medium">성과 향상</h4>
                <p className="text-sm text-muted-foreground">
                  지난 주 대비 {overallStats.improvement}% 향상했습니다!
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Learning Insights */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BarChart3 className="h-5 w-5" />
            학습 인사이트
          </CardTitle>
          <CardDescription>AI가 분석한 학습 패턴과 개선점을 확인하세요</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="p-4 border rounded-lg">
              <h4 className="font-medium mb-2 flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-green-500" />
                강점 단원
              </h4>
              <p className="text-sm text-muted-foreground">
                {unitPerformance.length > 0 
                  ? unitPerformance.reduce((a, b) => a.accuracy > b.accuracy ? a : b).unit
                  : '데이터 없음'
                }
              </p>
            </div>
            <div className="p-4 border rounded-lg">
              <h4 className="font-medium mb-2 flex items-center gap-2">
                <Target className="h-4 w-4 text-yellow-500" />
                개선 필요 단원
              </h4>
              <p className="text-sm text-muted-foreground">
                {unitPerformance.length > 0 
                  ? unitPerformance.reduce((a, b) => a.accuracy < b.accuracy ? a : b).unit
                  : '데이터 없음'
                }
              </p>
            </div>
            <div className="p-4 border rounded-lg">
              <h4 className="font-medium mb-2 flex items-center gap-2">
                <Clock className="h-4 w-4 text-blue-500" />
                권장 학습 시간
              </h4>
              <p className="text-sm text-muted-foreground">
                {Math.ceil(overallStats.totalProblems * 2)}분/일
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default AchievementPage;
