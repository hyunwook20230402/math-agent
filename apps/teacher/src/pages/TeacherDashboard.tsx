import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@shared/ui/card';
import { Button } from '@shared/ui/button';
import { Input } from '@shared/ui/input';
import { Badge } from '@shared/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@shared/ui/avatar';
import { Progress } from '@shared/ui/progress';
import {
  Users,
  Search,
  TrendingUp,
  CheckCircle,
  Clock,
  Target,
  Eye,
  BookOpen,
  ClipboardList,
  Send,
} from 'lucide-react';
import { useAuth } from '@shared/hooks/useAuth';
import { useNavigate } from 'react-router-dom';
import { studentApi, analyticsApi } from '@shared/lib/api';
import type { ClassSummaryRow, ProgressRow, AchievementRow } from '@shared/lib/api';
import type { Profile } from '@shared/types/database';

const TeacherDashboard = () => {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const [students, setStudents] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  // 학생 목록 페이지네이션 (30명+ 대응)
  const STUDENTS_PER_PAGE = 10;
  const [currentPage, setCurrentPage] = useState(1);
  // 학생별 성취도 요약 (student_id → 요약). 정답률 배지에 사용.
  const [summaryByStudent, setSummaryByStudent] = useState<Record<string, ClassSummaryRow>>({});
  // 학생별 진행률 (student_id → 진행률). 통계 카드·분포 막대·진행률 바에 사용.
  const [progressByStudent, setProgressByStudent] = useState<Record<string, ProgressRow>>({});

  // 개별 학생 과제 상세표
  const [selectedDetailStudent, setSelectedDetailStudent] = useState<string>('');
  const [studentAchievements, setStudentAchievements] = useState<AchievementRow[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    if (profile) {
      fetchData();
    }
  }, [profile]);

  const fetchData = async () => {
    if (!profile) return;
    try {
      const actualStudents = await studentApi.getStudentsByTeacher(profile.email);
      setStudents(actualStudents);

      // 반 전체 정답률 요약 + 진행률 (DB RPC — 학생별 최신 시도 기준). 병렬 조회.
      try {
        const [summary, progress] = await Promise.all([
          analyticsApi.getClassSummary(profile.id),
          analyticsApi.getClassProgress(profile.id),
        ]);
        const summaryMap: Record<string, ClassSummaryRow> = {};
        summary.forEach((row) => { summaryMap[row.student_id] = row; });
        setSummaryByStudent(summaryMap);

        const progressMap: Record<string, ProgressRow> = {};
        progress.forEach((row) => { progressMap[row.student_id] = row; });
        setProgressByStudent(progressMap);
      } catch (error) {
        console.warn('반 요약/진행률 조회 실패:', error);
        setSummaryByStudent({});
        setProgressByStudent({});
      }

      setLoading(false);
    } catch (error) {
      console.error('데이터 로드 실패:', error);
      setLoading(false);
    }
  };

  // 학생 목록 로드되면 개별 상세표 기본 선택 = 첫 학생
  useEffect(() => {
    if (students.length > 0 && !selectedDetailStudent) {
      setSelectedDetailStudent(students[0].id);
    }
  }, [students, selectedDetailStudent]);

  // 개별 상세표: 선택 학생의 배포별 성취도 로드
  useEffect(() => {
    if (!selectedDetailStudent) {
      setStudentAchievements([]);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        setDetailLoading(true);
        const data = await analyticsApi.getStudentAchievement(selectedDetailStudent);
        if (!cancelled) setStudentAchievements(data);
      } catch (e) {
        console.error('개별 학생 과제 조회 오류:', e);
        if (!cancelled) setStudentAchievements([]);
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [selectedDetailStudent]);

  const filteredStudents = students.filter(student => {
    const q = searchTerm.toLowerCase();
    return (
      student.name.toLowerCase().includes(q) ||
      (student.email || '').toLowerCase().includes(q)
    );
  });

  // 검색어가 바뀌면 1페이지로 리셋
  useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm]);

  // ── 진행률 통계 (전체 배포 합산 기준. 실측 RPC get_teacher_class_progress) ──
  const progressList = students.map((s) => progressByStudent[s.id]?.progress_pct ?? 0);
  const totalStudents = students.length;
  const completedCount = progressList.filter((p) => p >= 100).length;        // 100% = 완료
  const inProgressCount = progressList.filter((p) => p > 0 && p < 100).length; // 1~99% = 진행중
  const notStartedCount = progressList.filter((p) => p <= 0).length;          // 0% = 미시작
  const avgProgress = progressList.length > 0
    ? Math.round((progressList.reduce((a, b) => a + b, 0) / progressList.length) * 10) / 10
    : 0;
  const pctOf = (n: number) => totalStudents > 0 ? `${Math.round((n / totalStudents) * 1000) / 10}%` : '0%';

  // 페이지네이션 계산
  const totalPages = Math.max(1, Math.ceil(filteredStudents.length / STUDENTS_PER_PAGE));
  const pageStart = (currentPage - 1) * STUDENTS_PER_PAGE;
  const pagedStudents = filteredStudents.slice(pageStart, pageStart + STUDENTS_PER_PAGE);

  const statCards = [
    { icon: Users, label: '전체 학생', value: `${totalStudents}명`, sub: '전체', tone: 'text-foreground' },
    { icon: Target, label: '전체 평균 진행률', value: `${avgProgress}%`, sub: '', tone: 'text-primary' },
    { icon: CheckCircle, label: '완료한 학생', value: `${completedCount}명`, sub: pctOf(completedCount), tone: 'text-emerald-600' },
    { icon: TrendingUp, label: '진행 중 학생', value: `${inProgressCount}명`, sub: pctOf(inProgressCount), tone: 'text-sky-600' },
    { icon: Clock, label: '미시작 학생', value: `${notStartedCount}명`, sub: pctOf(notStartedCount), tone: 'text-rose-600' },
  ];

  if (loading) {
    return (
      <div className="container mx-auto px-4 py-6">
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
          <p className="ml-3 text-gray-600">데이터를 불러오는 중...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-6 max-w-7xl">
      <div className="flex flex-col lg:flex-row gap-6">
        {/* ───────── 좌측 사이드바: 오늘 수업 학생 ───────── */}
        <aside className="w-full lg:w-80 lg:flex-shrink-0">
          <Card className="lg:sticky lg:top-6">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg">오늘 수업 학생</CardTitle>
                <span className="text-sm text-muted-foreground">전체 {totalStudents}명</span>
              </div>
              <div className="relative mt-2">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="학생 이름 검색..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-10 h-9"
                />
              </div>
            </CardHeader>
            <CardContent>
              {filteredStudents.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Users className="h-12 w-12 mx-auto mb-4" />
                  {students.length === 0 ? (
                    <>
                      <p>등록된 학생이 없습니다</p>
                      <p className="text-sm mt-2">학생 등록 후 과제를 배포해보세요</p>
                      <Button className="mt-4" onClick={() => navigate('/teacher/students')}>
                        학생 등록하기
                      </Button>
                    </>
                  ) : (
                    <p>검색 결과가 없습니다</p>
                  )}
                </div>
              ) : (
                <>
                  <div className="space-y-2 max-h-[560px] overflow-y-auto pr-1">
                    {pagedStudents.map((student) => {
                      const prog = progressByStudent[student.id]?.progress_pct ?? 0;
                      const s = summaryByStudent[student.id];
                      return (
                        <div
                          key={student.id}
                          className="p-3 border rounded-lg hover:bg-muted/50 cursor-pointer"
                          onClick={() => navigate(`/teacher/student/${student.id}`)}
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            <Avatar className="h-9 w-9 shrink-0">
                              <AvatarImage src={student.avatar_url || ''} />
                              <AvatarFallback>{student.name.charAt(0)}</AvatarFallback>
                            </Avatar>
                            <div className="min-w-0 flex-1">
                              <p className="font-medium truncate">{student.name}</p>
                              <p className="text-xs text-muted-foreground truncate">{student.email}</p>
                            </div>
                            {s && s.attempted > 0 && (
                              <span className={`text-xs shrink-0 ${s.accuracy < 50 ? 'text-rose-600' : 'text-emerald-600'}`}>
                                정답률 {s.accuracy}%
                              </span>
                            )}
                          </div>
                          {/* 진행률 바 */}
                          <div className="flex items-center gap-2 mt-2">
                            <Progress value={prog} className="h-1.5 flex-1" />
                            <span className="text-xs text-muted-foreground tabular-nums w-9 text-right">{Math.round(prog)}%</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* 페이지네이션 */}
                  {totalPages > 1 && (
                    <div className="flex items-center justify-center gap-3 pt-3 mt-1 border-t">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={currentPage === 1}
                        onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                      >
                        ‹
                      </Button>
                      <span className="text-sm tabular-nums">{currentPage} / {totalPages}</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={currentPage === totalPages}
                        onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                      >
                        ›
                      </Button>
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </aside>

        {/* ───────── 우측 메인 ───────── */}
        <main className="flex-1 min-w-0 space-y-6">
          {/* 헤더 */}
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-foreground">학생 과제 진행률 현황</h1>
              <p className="text-muted-foreground">학생별 진행률·성취도를 한눈에 확인하세요</p>
            </div>
            <Button variant="outline" onClick={() => navigate('/teacher/students')}>
              <Users className="h-4 w-4 mr-2" />
              학생 등록
            </Button>
          </div>

          {/* 통계 카드 5개 */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
            {statCards.map((stat) => (
              <Card key={stat.label}>
                <CardContent className="p-4">
                  <div className="flex items-start justify-between">
                    <div className="min-w-0">
                      <p className="text-xs text-muted-foreground font-medium truncate">{stat.label}</p>
                      <p className={`text-2xl font-bold mt-1.5 ${stat.tone}`}>{stat.value}</p>
                      {stat.sub && <p className="text-xs text-muted-foreground mt-1">{stat.sub}</p>}
                    </div>
                    <stat.icon className="h-5 w-5 text-muted-foreground shrink-0" />
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* 개별 학생 과제 상세 현황 */}
          <Card>
            <CardHeader>
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <CardTitle>개별 학생 과제 상세 현황</CardTitle>
                <select
                  value={selectedDetailStudent}
                  onChange={(e) => setSelectedDetailStudent(e.target.value)}
                  disabled={students.length === 0}
                  className="h-9 px-3 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
                >
                  <option value="">학생을 선택하세요</option>
                  {students.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
            </CardHeader>
            <CardContent>
              {detailLoading ? (
                <div className="flex justify-center py-8">
                  <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary"></div>
                </div>
              ) : !selectedDetailStudent ? (
                <p className="text-sm text-muted-foreground text-center py-8">학생을 선택하세요</p>
              ) : studentAchievements.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">배포된 과제가 없습니다</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-muted-foreground">
                        <th className="text-left py-2.5 pr-4 font-medium">과제 / 학습 콘텐츠</th>
                        <th className="text-center py-2.5 px-3 font-medium whitespace-nowrap">전체 문항</th>
                        <th className="text-center py-2.5 px-3 font-medium whitespace-nowrap">완료 문항</th>
                        <th className="text-center py-2.5 px-3 font-medium whitespace-nowrap">정답률</th>
                        <th className="text-left py-2.5 px-3 font-medium w-40">진행률</th>
                        <th className="text-center py-2.5 pl-3 font-medium whitespace-nowrap">상태</th>
                      </tr>
                    </thead>
                    <tbody>
                      {studentAchievements.map((a) => {
                        const total = a.total_problems || 0;
                        const done = a.attempted || 0;
                        const prog = total > 0 ? Math.round((done / total) * 100) : 0;
                        const status = done === 0 ? '미시작' : (done >= total && total > 0 ? '완료' : '진행 중');
                        const statusCls = status === '완료'
                          ? 'border-emerald-300 text-emerald-600'
                          : status === '진행 중'
                            ? 'border-sky-300 text-sky-600'
                            : 'text-muted-foreground';
                        return (
                          <tr key={a.distribution_id} className="border-b last:border-0">
                            <td className="py-3 pr-4 max-w-[220px]">
                              <div className="font-medium truncate" title={a.distribution_title}>{a.distribution_title}</div>
                              <div className="text-xs text-muted-foreground">문제 {total}개</div>
                            </td>
                            <td className="text-center py-3 px-3 tabular-nums">{total}개</td>
                            <td className="text-center py-3 px-3 tabular-nums">{done}개</td>
                            <td className="text-center py-3 px-3 tabular-nums">{done > 0 ? `${a.accuracy}%` : '-'}</td>
                            <td className="py-3 px-3">
                              <div className="flex items-center gap-2">
                                <Progress value={prog} className="h-1.5 flex-1" />
                                <span className="text-xs text-muted-foreground tabular-nums w-9 text-right">{prog}%</span>
                              </div>
                            </td>
                            <td className="text-center py-3 pl-3">
                              <Badge variant="outline" className={`text-xs ${statusCls}`}>{status}</Badge>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* 학생에게 과제 배포하기 (진입 카드) */}
          <Card>
            <CardHeader>
              <CardTitle>학생에게 과제 배포하기</CardTitle>
              <CardDescription>학생에게 새로운 과제를 배포하거나 배포 내역을 확인하세요</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="border rounded-lg p-5">
                  <div className="flex items-center gap-2 mb-2">
                    <BookOpen className="h-5 w-5 text-primary" />
                    <h3 className="font-semibold">문제 / 과제 배포</h3>
                  </div>
                  <p className="text-sm text-muted-foreground mb-4">선택한 학생에게 문제 또는 과제를 배포합니다.</p>
                  <Button variant="outline" className="w-full" onClick={() => navigate('/teacher/distribute')}>
                    <Send className="h-4 w-4 mr-2" />
                    과제 배포하기
                  </Button>
                </div>
                <div className="border rounded-lg p-5">
                  <div className="flex items-center gap-2 mb-2">
                    <ClipboardList className="h-5 w-5 text-primary" />
                    <h3 className="font-semibold">배포 내역 보기</h3>
                  </div>
                  <p className="text-sm text-muted-foreground mb-4">이전에 배포한 과제 내역과 결과를 확인합니다.</p>
                  <Button variant="outline" className="w-full" onClick={() => navigate('/teacher/distributions')}>
                    <Eye className="h-4 w-4 mr-2" />
                    배포 내역 보기
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </main>
      </div>
    </div>
  );
};

export default TeacherDashboard;
