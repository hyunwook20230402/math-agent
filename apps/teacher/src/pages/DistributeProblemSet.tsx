import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '@shared/hooks/useAuth';
import { Button } from '@shared/ui/button';
import { Input } from '@shared/ui/input';
import { Label } from '@shared/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@shared/ui/card';
import { Checkbox } from '@shared/ui/checkbox';
import { toast } from '@shared/hooks/use-toast';
import { ArrowLeft, Send, Users, BookOpen, Calendar } from 'lucide-react';
import { supabase } from '@shared/supabase/client';
import { textbookApi, problemApi, problemSetApi } from '@shared/lib/api';

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
  const [selectedStudents, setSelectedStudents] = useState<string[]>([]);

  const [formData, setFormData] = useState({
    title: '',
    description: '',
    distributionDate: new Date().toISOString().split('T')[0],
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
      setSelectedStudents(prev => (prev.includes(studentIdFromUrl) ? prev : [...prev, studentIdFromUrl]));
    }
  }, [studentIdFromUrl, students]);

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
        // 회차가 하나뿐이면 자동 선택해 한 단계 줄임
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
        // 배포 제목 기본값: "{회차명}" (비어 있을 때만)
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

  const toggleStudent = (id: string) => {
    setSelectedStudents(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id],
    );
  };

  const toggleAllStudents = () => {
    if (selectedStudents.length === students.length) {
      setSelectedStudents([]);
    } else {
      setSelectedStudents(students.map(s => s.id));
    }
  };

  const distribute = async () => {
    if (!profile?.id) {
      toast({ title: '오류', description: '사용자 정보를 찾을 수 없습니다.', variant: 'destructive' });
      return;
    }
    if (selectedProblemIds.length === 0 || selectedStudents.length === 0) {
      toast({ title: '오류', description: '문제와 학생을 선택해주세요.', variant: 'destructive' });
      return;
    }
    if (!formData.title.trim() || !formData.distributionDate) {
      toast({ title: '오류', description: '배포 제목과 배포 날짜를 입력해주세요.', variant: 'destructive' });
      return;
    }

    setLoading(true);
    try {
      const chapter = chapters.find(c => c.id === selectedChapterId);
      const setName = formData.title.trim() || `${chapter?.name ?? '문제'} - ${formData.distributionDate}`;

      // 1. 배포용 문제세트 자동 생성 (사용자에게 노출 안 함, folder_id=null)
      const problemSet = await problemSetApi.createProblemSet({
        name: setName,
        description: formData.description || `${chapter?.name ?? ''} 문제`,
        folder_id: null,
        set_type: 'quiz',
      });

      // 2. 선택한 문제를 세트에 추가 (내부에서 recalc_set_difficulty 호출)
      await problemSetApi.addProblemsToSet(problemSet.id, selectedProblemIds);

      // 3. 배포 생성
      const { data: distribution, error: distError } = await supabase
        .from('distributions')
        .insert({
          title: formData.title,
          problem_set_id: problemSet.id,
          teacher_id: profile.id,
          description: formData.description,
          distribution_date: formData.distributionDate,
          is_active: true,
        })
        .select()
        .single();
      if (distError) throw distError;

      // 4. 학생 연결
      const studentItems = selectedStudents.map(studentId => ({
        distribution_id: distribution.id,
        student_id: studentId,
      }));
      const { error: studentsError } = await supabase
        .from('distribution_students')
        .insert(studentItems);
      if (studentsError) throw new Error('학생 배포 중 오류가 발생했습니다.');

      toast({
        title: '배포 성공',
        description: `${selectedStudents.length}명에게 ${selectedProblemIds.length}문제를 배포했습니다.`,
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
      <div className="container mx-auto px-4 py-6 max-w-5xl">
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="container mx-auto px-4 py-6 max-w-5xl">
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

  return (
    <div className="container mx-auto px-4 py-6 max-w-5xl">
      {/* 헤더 */}
      <div className="flex items-center gap-4 mb-6">
        <Button variant="outline" size="sm" onClick={() => navigate('/teacher')}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          돌아가기
        </Button>
        <div>
          <h1 className="text-2xl font-bold">문제 배포</h1>
          <p className="text-muted-foreground">교재에서 문제를 골라 학생에게 보내세요</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 왼쪽: 교재 → 문제 선택 */}
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <BookOpen className="h-5 w-5" />
                문제 선택
              </CardTitle>
              <CardDescription>교재를 고르고 보낼 문제를 선택하세요</CardDescription>
            </CardHeader>
            <CardContent>
              {/* 교재 선택 (native select — Radix Portal 금지) */}
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

              {/* 회차 선택 (교재 안의 chapter — 예: 고3 평가원 6월 26년) */}
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

          {/* 배포 설정 */}
          {selectedProblemIds.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Calendar className="h-5 w-5" />
                  배포 설정
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
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
                <div className="space-y-2">
                  <Label htmlFor="distributionDate">배포 날짜 *</Label>
                  <Input
                    id="distributionDate"
                    type="date"
                    value={formData.distributionDate}
                    onChange={(e) => setFormData({ ...formData, distributionDate: e.target.value })}
                  />
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        {/* 오른쪽: 학생 선택 */}
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Users className="h-5 w-5" />
                학생 선택
              </CardTitle>
              <CardDescription>배포할 학생을 선택하세요</CardDescription>
            </CardHeader>
            <CardContent>
              {students.length > 0 && (
                <div className="mb-4">
                  <Button variant="outline" size="sm" onClick={toggleAllStudents}>
                    {selectedStudents.length === students.length ? '전체 해제' : '전체 선택'}
                  </Button>
                </div>
              )}
              <div className="space-y-2">
                {students.map((student) => (
                  <label
                    key={student.id}
                    className="flex items-center gap-3 p-3 border rounded-lg cursor-pointer hover:bg-muted/50"
                  >
                    <Checkbox
                      checked={selectedStudents.includes(student.id)}
                      onCheckedChange={() => toggleStudent(student.id)}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="font-medium">{student.name}</div>
                      <div className="text-sm text-muted-foreground truncate">
                        {student.email}{student.grade ? ` • ${student.grade}` : ''}{student.school ? ` • ${student.school}` : ''}
                      </div>
                    </div>
                  </label>
                ))}
                {students.length === 0 && (
                  <div className="text-center py-8 text-muted-foreground">
                    <Users className="h-12 w-12 mx-auto mb-4" />
                    <p>등록된 학생이 없습니다</p>
                    <Button className="mt-4" onClick={() => navigate('/teacher/students')}>
                      학생 등록하기
                    </Button>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* 배포 요약 */}
          {selectedProblemIds.length > 0 && selectedStudents.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>배포 요약</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex justify-between">
                  <span>선택한 문제:</span>
                  <span className="font-medium">{selectedProblemIds.length}문제</span>
                </div>
                <div className="flex justify-between">
                  <span>배포 대상:</span>
                  <span className="font-medium">{selectedStudents.length}명</span>
                </div>
                <div className="flex justify-between">
                  <span>배포 날짜:</span>
                  <span className="font-medium">
                    {formData.distributionDate
                      ? new Date(formData.distributionDate).toLocaleDateString()
                      : '설정 필요'}
                  </span>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* 배포 버튼 */}
      {selectedProblemIds.length > 0 && selectedStudents.length > 0 && (
        <div className="mt-6 flex justify-center">
          <Button
            onClick={distribute}
            disabled={loading || !formData.title.trim() || !formData.distributionDate}
            size="lg"
            className="px-8"
          >
            {loading ? (
              <>
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                배포 중...
              </>
            ) : (
              <>
                <Send className="h-4 w-4 mr-2" />
                {selectedStudents.length}명에게 배포하기
              </>
            )}
          </Button>
        </div>
      )}
    </div>
  );
};

export default DistributeProblemSet;
