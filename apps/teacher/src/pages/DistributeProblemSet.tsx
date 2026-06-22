import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '@shared/hooks/useAuth';
import { Button } from '@shared/ui/button';
import { Input } from '@shared/ui/input';
import { Label } from '@shared/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@shared/ui/card';
import { Checkbox } from '@shared/ui/checkbox';
import { toast } from '@shared/hooks/use-toast';
import { ArrowLeft, Send, Users, BookOpen, CalendarDays } from 'lucide-react';
import { supabase } from '@shared/supabase/client';
import { textbookApi, problemApi, problemSetApi, distributionApi, analyticsApi } from '@shared/lib/api';
import type { AchievementRow } from '@shared/lib/api';
import DistributionCalendar, { type DistributionByDate } from '@/components/DistributionCalendar';

interface Textbook {
  id: string;
  name: string;
  grade?: string;
}

interface Chapter {
  id: string;
  name: string;
  sort_order: number;
}

interface ProblemRow {
  id: string;
  title: string;
  problem_number: number;
  unit: string;
  difficulty: string;
}

interface Student {
  id: string;
  name: string;
  email: string;
  grade: string;
  school: string;
}

// 교재에서 문제를 골라 학생에게 바로 배포.
// "문제세트"는 사용자에게 노출하지 않고, 배포 시 내부적으로 problem_set 을 자동 생성한다
// (학생 풀이 화면이 distribution.problem_set_id → problem_set_items 를 읽기 때문에 필수).
const DistributeProblemSet = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { profile } = useAuth();

  const [initialLoading, setInitialLoading] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [textbooks, setTextbooks] = useState<Textbook[]>([]);
  const [selectedTextbookId, setSelectedTextbookId] = useState<string>('');
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [selectedChapterId, setSelectedChapterId] = useState<string>('');
  const [problems, setProblems] = useState<ProblemRow[]>([]);
  const [problemsLoading, setProblemsLoading] = useState(false);
  const [selectedProblemIds, setSelectedProblemIds] = useState<string[]>([]);

  const [students, setStudents] = useState<Student[]>([]);
  const [selectedStudent, setSelectedStudent] = useState<string>('');

  // 선택한 학생의 성취도(상단 통계 칩: 최근 진행률/완료/남은 과제)
  const [achievements, setAchievements] = useState<AchievementRow[] | null>(null);

  // 선택한 학생의 월별 배포 내역 (달력 셀 메모)
  const [currentMonth, setCurrentMonth] = useState<{ year: number; month: number }>(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() + 1 };
  });
  const [distributionsByMonth, setDistributionsByMonth] = useState<DistributionByDate[]>([]);
  const [monthDataLoading, setMonthDataLoading] = useState(false);

  const today = new Date().toISOString().split('T')[0];
  const [formData, setFormData] = useState({
    title: '',
    description: '',
    startDate: today,    // 배포 시작 날짜 (달력 클릭으로도 갱신)
    startTime: '09:00',  // 배포 시작 시간
    dueDate: today,      // 배포 마감 날짜
    dueTime: '23:59',    // 배포 마감 시간
  });

  // 학생별 배포 진입(?student=:id) 시 미리 선택
  const studentIdFromUrl = searchParams.get('student');

  useEffect(() => {
    if (!profile) return;
    const init = async () => {
      try {
        setInitialLoading(true);
        setError(null);
        await Promise.all([fetchTextbooks(), fetchStudents()]);
      } catch (e) {
        console.error('초기 데이터 로딩 오류:', e);
        setError('데이터를 불러오는데 실패했습니다. 페이지를 새로고침해주세요.');
      } finally {
        setInitialLoading(false);
      }
    };
    init();
  }, [profile]);

  // URL 파라미터 학생 자동 선택 (학생 목록 로딩 후)
  useEffect(() => {
    if (studentIdFromUrl && students.some(s => s.id === studentIdFromUrl)) {
      setSelectedStudent(studentIdFromUrl);
    }
  }, [studentIdFromUrl, students]);

  // 선택한 학생 + 현재 보고 있는 달의 배포 내역 조회 (달력 셀 메모)
  useEffect(() => {
    if (!selectedStudent) {
      setDistributionsByMonth([]);
      return;
    }
    let cancelled = false;
    const loadMonth = async () => {
      try {
        setMonthDataLoading(true);
        const data = await distributionApi.getDistributionsByStudentAndMonth(
          selectedStudent,
          currentMonth.year,
          currentMonth.month,
        );
        if (!cancelled) setDistributionsByMonth(data);
      } catch (e) {
        console.error('월별 배포 조회 오류:', e);
        if (!cancelled) {
          toast({ title: '오류', description: '달력 데이터를 불러오지 못했습니다.', variant: 'destructive' });
        }
      } finally {
        if (!cancelled) setMonthDataLoading(false);
      }
    };
    loadMonth();
    return () => { cancelled = true; };
  }, [selectedStudent, currentMonth]);

  // 선택한 학생의 성취도(통계 칩)
  useEffect(() => {
    if (!selectedStudent) {
      setAchievements(null);
      return;
    }
    let cancelled = false;
    const loadAchievement = async () => {
      try {
        const data = await analyticsApi.getStudentAchievement(selectedStudent);
        if (!cancelled) setAchievements(data);
      } catch (e) {
        console.error('학생 성취도 조회 오류:', e);
        if (!cancelled) setAchievements(null);
      }
    };
    loadAchievement();
    return () => { cancelled = true; };
  }, [selectedStudent]);

  // 교재 선택 시 회차(chapter) 목록 로딩
  useEffect(() => {
    setSelectedChapterId('');
    setProblems([]);
    setSelectedProblemIds([]);
    if (!selectedTextbookId) {
      setChapters([]);
      return;
    }
    const loadChapters = async () => {
      try {
        const data = await textbookApi.getChaptersByTextbook(selectedTextbookId);
        setChapters(data as Chapter[]);
        if (data.length === 1) {
          setSelectedChapterId(data[0].id);
        }
      } catch (e) {
        console.error('회차 목록 조회 오류:', e);
        toast({ title: '오류', description: '회차 목록을 불러오지 못했습니다.', variant: 'destructive' });
      }
    };
    loadChapters();
  }, [selectedTextbookId]);

  // 회차 선택 시 그 회차 문제 목록 로딩
  useEffect(() => {
    if (!selectedChapterId || !profile?.id) {
      setProblems([]);
      setSelectedProblemIds([]);
      return;
    }
    const loadProblems = async () => {
      try {
        setProblemsLoading(true);
        const data = await problemApi.getProblems(profile.id, {
          textbookId: selectedTextbookId,
          chapterId: selectedChapterId,
        });
        setProblems(data as ProblemRow[]);
        setSelectedProblemIds([]);
        const ch = chapters.find(c => c.id === selectedChapterId);
        if (ch && !formData.title.trim()) {
          setFormData(prev => ({ ...prev, title: `${ch.name}` }));
        }
      } catch (e) {
        console.error('문제 목록 조회 오류:', e);
        toast({ title: '오류', description: '문제 목록을 불러오지 못했습니다.', variant: 'destructive' });
      } finally {
        setProblemsLoading(false);
      }
    };
    loadProblems();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedChapterId, profile]);

  const fetchTextbooks = async () => {
    const data = await textbookApi.getTextbooks();
    setTextbooks(data as Textbook[]);
  };

  const fetchStudents = async () => {
    if (!profile?.id) throw new Error('프로필 정보가 없습니다.');
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('teacher_id', profile.id)
      .eq('role', 'student')
      .order('name');
    if (error) throw error;
    setStudents(data || []);
  };

  const toggleProblem = (id: string) => {
    setSelectedProblemIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id],
    );
  };

  const toggleAllProblems = () => {
    if (selectedProblemIds.length === problems.length) {
      setSelectedProblemIds([]);
    } else {
      setSelectedProblemIds(problems.map(p => p.id));
    }
  };

  // 상단 통계 칩 (선택 학생 기준) — achievements 로 프론트 계산
  const stats = (() => {
    if (!achievements || achievements.length === 0) return null;
    // achievements 는 RPC 가 distribution_date DESC 정렬 → 첫 항목이 최근 배포
    const recent = achievements[0];
    const recentProgress = recent && recent.total_problems > 0
      ? Math.round((recent.attempted / recent.total_problems) * 100)
      : 0;
    const completed = achievements.filter(a => a.total_problems > 0 && a.attempted >= a.total_problems).length;
    const remaining = achievements.length - completed;
    return { recentProgress, completed, remaining };
  })();

  const selectedStudentName = students.find(s => s.id === selectedStudent)?.name ?? '';

  const distribute = async () => {
    if (!profile?.id) {
      toast({ title: '오류', description: '사용자 정보를 찾을 수 없습니다.', variant: 'destructive' });
      return;
    }
    if (!selectedStudent) {
      toast({ title: '오류', description: '학생을 선택해주세요.', variant: 'destructive' });
      return;
    }
    if (selectedProblemIds.length === 0) {
      toast({ title: '오류', description: '문제를 선택해주세요.', variant: 'destructive' });
      return;
    }
    if (!formData.title.trim()) {
      toast({ title: '오류', description: '배포 제목을 입력해주세요.', variant: 'destructive' });
      return;
    }
    if (!formData.startDate || !formData.dueDate) {
      toast({ title: '오류', description: '배포 시작/마감 날짜를 선택해주세요.', variant: 'destructive' });
      return;
    }

    // 시작/마감 시각 ISO (로컬 시각 기준)
    const startAt = `${formData.startDate}T${formData.startTime || '00:00'}:00`;
    const dueAt = `${formData.dueDate}T${formData.dueTime || '23:59'}:00`;
    if (new Date(dueAt).getTime() < new Date(startAt).getTime()) {
      toast({ title: '오류', description: '마감 시각이 시작 시각보다 빠를 수 없습니다.', variant: 'destructive' });
      return;
    }

    setLoading(true);
    try {
      const chapter = chapters.find(c => c.id === selectedChapterId);
      const setName = formData.title.trim() || `${chapter?.name ?? '문제'} - ${formData.startDate}`;

      // 1. 배포용 문제세트 자동 생성 (사용자에게 노출 안 함, folder_id=null)
      const problemSet = await problemSetApi.createProblemSet({
        name: setName,
        description: formData.description || `${chapter?.name ?? ''} 문제`,
        folder_id: null,
        set_type: 'quiz',
      });

      // 2. 선택한 문제를 세트에 추가
      await problemSetApi.addProblemsToSet(problemSet.id, selectedProblemIds);

      // 3. 배포 생성 (distribution_date=시작 시각, due_at=마감 시각)
      const { data: distribution, error: distError } = await supabase
        .from('distributions')
        .insert({
          title: formData.title,
          problem_set_id: problemSet.id,
          teacher_id: profile.id,
          description: formData.description,
          distribution_date: startAt,
          due_at: dueAt,
          is_active: true,
        })
        .select()
        .single();
      if (distError) throw distError;

      // 4. 학생 연결 (단일 학생)
      const { error: studentsError } = await supabase
        .from('distribution_students')
        .insert({
          distribution_id: distribution.id,
          student_id: selectedStudent,
        });
      if (studentsError) throw new Error('학생 배포 중 오류가 발생했습니다.');

      // 5. 배포 시작 날짜가 현재 보고 있는 달이면 달력에 즉시 반영 (낙관적 업데이트)
      const startDateObj = new Date(formData.startDate);
      if (startDateObj.getFullYear() === currentMonth.year && startDateObj.getMonth() + 1 === currentMonth.month) {
        setDistributionsByMonth(prev => [
          ...prev,
          {
            distribution_id: distribution.id,
            title: formData.title,
            distribution_date: startAt,
          },
        ]);
      }

      toast({
        title: '배포 성공',
        description: `${selectedStudentName || '학생'}에게 ${selectedProblemIds.length}문제를 배포했습니다.`,
      });
      setTimeout(() => navigate('/teacher'), 1200);
    } catch (e: any) {
      console.error('배포 오류:', e);
      toast({ title: '배포 실패', description: e.message || '배포 중 오류가 발생했습니다.', variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  if (initialLoading) {
    return (
      <div className="container mx-auto px-4 py-6 max-w-6xl">
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="container mx-auto px-4 py-6 max-w-6xl">
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <div className="text-red-500 text-5xl mb-4">⚠️</div>
            <h2 className="text-xl font-semibold mb-2">오류가 발생했습니다</h2>
            <p className="text-muted-foreground mb-4">{error}</p>
            <div className="flex gap-2">
              <Button onClick={() => window.location.reload()}>새로고침</Button>
              <Button variant="outline" onClick={() => navigate('/teacher')}>대시보드로</Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const canDistribute = !!selectedStudent && selectedProblemIds.length > 0 && !!formData.title.trim();

  return (
    <div className="container mx-auto px-4 py-6 max-w-6xl pb-28">
      {/* 헤더 */}
      <div className="flex items-center gap-4 mb-6">
        <Button variant="outline" size="sm" onClick={() => navigate('/teacher')}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          돌아가기
        </Button>
        <div>
          <h1 className="text-2xl font-bold">과제 배포하기</h1>
          <p className="text-muted-foreground">학생에게 문제 세트를 선택하여 배포할 수 있습니다.</p>
        </div>
      </div>

      {/* 상단 가로 바: 학생 선택(필수) + 통계 칩 */}
      <Card className="mb-6">
        <CardContent className="p-4">
          <div className="flex flex-col md:flex-row md:items-center gap-4">
            <div className="flex items-center gap-3 md:flex-1 min-w-0">
              <Label htmlFor="student" className="shrink-0 font-semibold">학생 선택 (필수)</Label>
              {students.length === 0 ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <span>등록된 학생이 없습니다</span>
                  <Button size="sm" variant="outline" onClick={() => navigate('/teacher/students')}>학생 등록</Button>
                </div>
              ) : (
                <select
                  id="student"
                  value={selectedStudent}
                  onChange={(e) => setSelectedStudent(e.target.value)}
                  className="flex-1 min-w-0 h-10 px-3 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="">학생을 선택하세요</option>
                  {students.map((student) => (
                    <option key={student.id} value={student.id}>
                      {student.name}{student.grade ? ` (${student.grade})` : ''}
                    </option>
                  ))}
                </select>
              )}
            </div>

            {/* 통계 칩 */}
            {selectedStudent && stats && (
              <div className="flex flex-wrap gap-2 shrink-0">
                <div className="px-3 py-1.5 rounded-md bg-muted text-sm">
                  최근 진행률 <span className="font-semibold text-primary">{stats.recentProgress}%</span>
                </div>
                <div className="px-3 py-1.5 rounded-md bg-muted text-sm">
                  완료 과제 <span className="font-semibold text-emerald-600">{stats.completed}개</span>
                </div>
                <div className="px-3 py-1.5 rounded-md bg-muted text-sm">
                  남은 과제 <span className="font-semibold text-rose-600">{stats.remaining}개</span>
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* 2열 본문: 좌측 큰 달력 / 우측 문제 선택 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 좌측: 배포 날짜 선택 (달력) */}
        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CalendarDays className="h-5 w-5" />
              배포 날짜 선택
            </CardTitle>
            <CardDescription>
              날짜를 클릭해 배포 시작일을 정하세요. 칸 안의 메모는 이 학생에게 이미 보낸 과제입니다.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <DistributionCalendar
              selectedDate={formData.startDate}
              onSelectDate={(date) => setFormData({ ...formData, startDate: date, dueDate: date })}
              distributions={distributionsByMonth}
              currentMonth={currentMonth}
              onMonthChange={(year, month) => setCurrentMonth({ year, month })}
              loading={monthDataLoading}
            />
            {!selectedStudent && (
              <p className="text-xs text-muted-foreground mt-3 text-center">
                학생을 선택하면 그 학생에게 배포한 과제가 달력에 표시됩니다.
              </p>
            )}
          </CardContent>
        </Card>

        {/* 우측: 문제 세트 선택 (교재 → 회차 → 문제) */}
        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BookOpen className="h-5 w-5" />
              문제 세트 선택
            </CardTitle>
            <CardDescription>교재를 고르고 보낼 문제를 선택하세요</CardDescription>
          </CardHeader>
          <CardContent>
            {/* 교재 선택 (native select) */}
            <div className="mb-4">
              <Label htmlFor="textbook" className="mb-1.5 block">교재</Label>
              <select
                id="textbook"
                value={selectedTextbookId}
                onChange={(e) => setSelectedTextbookId(e.target.value)}
                className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="">교재를 선택하세요</option>
                {textbooks.map((tb) => (
                  <option key={tb.id} value={tb.id}>{tb.name}</option>
                ))}
              </select>
            </div>

            {/* 회차 선택 */}
            {selectedTextbookId && chapters.length > 0 && (
              <div className="mb-4">
                <Label htmlFor="chapter" className="mb-1.5 block">회차</Label>
                <select
                  id="chapter"
                  value={selectedChapterId}
                  onChange={(e) => setSelectedChapterId(e.target.value)}
                  className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="">회차를 선택하세요</option>
                  {chapters.map((ch) => (
                    <option key={ch.id} value={ch.id}>{ch.name}</option>
                  ))}
                </select>
              </div>
            )}

            {/* 문제 목록 */}
            {!selectedTextbookId ? (
              <div className="text-center py-8 text-muted-foreground">
                <BookOpen className="h-12 w-12 mx-auto mb-3" />
                <p>교재를 먼저 선택하세요</p>
              </div>
            ) : !selectedChapterId ? (
              <div className="text-center py-8 text-muted-foreground">
                <BookOpen className="h-12 w-12 mx-auto mb-3" />
                <p>회차를 선택하세요</p>
              </div>
            ) : problemsLoading ? (
              <div className="flex justify-center py-8">
                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary"></div>
              </div>
            ) : problems.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <p>이 회차에 등록된 문제가 없습니다</p>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between mb-2">
                  <Button variant="outline" size="sm" onClick={toggleAllProblems}>
                    {selectedProblemIds.length === problems.length ? '전체 해제' : '전체 선택'}
                  </Button>
                  <span className="text-sm text-muted-foreground">
                    {selectedProblemIds.length} / {problems.length} 선택
                  </span>
                </div>
                <div className="space-y-2 max-h-[420px] overflow-y-auto pr-1">
                  {problems.map((p) => (
                    <label
                      key={p.id}
                      className="flex items-center gap-3 p-2.5 border rounded-lg cursor-pointer hover:bg-muted/50"
                    >
                      <Checkbox
                        checked={selectedProblemIds.includes(p.id)}
                        onCheckedChange={() => toggleProblem(p.id)}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="font-medium truncate">{p.title || `${p.problem_number}번`}</div>
                        <div className="text-xs text-muted-foreground truncate">{p.unit}</div>
                      </div>
                    </label>
                  ))}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* 하단: 배포 설정 (제목/설명 + 시작/마감 시간) */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CalendarDays className="h-5 w-5" />
            배포 설정
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="title">배포 제목 *</Label>
              <Input
                id="title"
                value={formData.title}
                onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                placeholder="예: 고3 모의고사 1차"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="description">설명</Label>
              <Input
                id="description"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder="배포 설명(선택)"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* 시작 시간 */}
            <div className="space-y-2">
              <Label>시작 시간 *</Label>
              <div className="flex gap-2">
                <Input
                  type="date"
                  value={formData.startDate}
                  onChange={(e) => setFormData({ ...formData, startDate: e.target.value })}
                  className="flex-1"
                />
                <Input
                  type="time"
                  value={formData.startTime}
                  onChange={(e) => setFormData({ ...formData, startTime: e.target.value })}
                  className="w-32"
                />
              </div>
            </div>
            {/* 마감 시간 */}
            <div className="space-y-2">
              <Label>마감 시간 *</Label>
              <div className="flex gap-2">
                <Input
                  type="date"
                  value={formData.dueDate}
                  onChange={(e) => setFormData({ ...formData, dueDate: e.target.value })}
                  className="flex-1"
                />
                <Input
                  type="time"
                  value={formData.dueTime}
                  onChange={(e) => setFormData({ ...formData, dueTime: e.target.value })}
                  className="w-32"
                />
              </div>
            </div>
          </div>

          {/* 마감 < 시작 경고 */}
          {formData.startDate && formData.dueDate &&
            new Date(`${formData.dueDate}T${formData.dueTime || '23:59'}:00`).getTime() <
            new Date(`${formData.startDate}T${formData.startTime || '00:00'}:00`).getTime() && (
            <p className="text-sm text-red-500">마감 시각이 시작 시각보다 빠를 수 없습니다.</p>
          )}
        </CardContent>
      </Card>

      {/* 고정 하단 바: 요약 + 배포 버튼 */}
      <div className="fixed bottom-0 left-0 right-0 z-40 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="container mx-auto px-4 py-3 max-w-6xl flex items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm text-muted-foreground min-w-0">
            <span className="flex items-center gap-1.5">
              <Users className="h-4 w-4" />
              {selectedStudentName || '학생 미선택'}
            </span>
            <span className="flex items-center gap-1.5">
              <BookOpen className="h-4 w-4" />
              문제 {selectedProblemIds.length}개
            </span>
            <span className="flex items-center gap-1.5">
              <CalendarDays className="h-4 w-4" />
              {formData.startDate
                ? `${new Date(formData.startDate).toLocaleDateString('ko-KR')} ${formData.startTime} ~ ${formData.dueTime}`
                : '일정 미설정'}
            </span>
          </div>
          <Button onClick={distribute} disabled={loading || !canDistribute} size="lg" className="shrink-0 px-6">
            {loading ? (
              <>
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                배포 중...
              </>
            ) : (
              <>
                <Send className="h-4 w-4 mr-2" />
                과제 배포하기
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default DistributeProblemSet;
