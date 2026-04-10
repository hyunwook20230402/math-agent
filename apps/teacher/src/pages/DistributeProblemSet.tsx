import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '@shared/hooks/useAuth';
import { Button } from '@shared/ui/button';
import { Input } from '@shared/ui/input';
import { Label } from '@shared/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@shared/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@shared/ui/select';
import { Checkbox } from '@shared/ui/checkbox';
import { toast } from '@shared/hooks/use-toast';
import { ArrowLeft, Send, Users, BookOpen, Calendar, Clock } from 'lucide-react';
import { supabase } from '@shared/supabase/client';

interface ProblemSet {
  id: string;
  name: string;
  description: string;
  total_problems: number;
  created_at: string;
}

interface Student {
  id: string;
  name: string;
  email: string;
  grade: string;
  school: string;
}

interface Distribution {
  id: string;
  title: string;
  problem_set_id: string;
  description: string;
  distribution_date: string;
  is_active: boolean;
}

const DistributeProblemSet = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { profile } = useAuth();
  
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [problemSets, setProblemSets] = useState<ProblemSet[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
  const [selectedProblemSet, setSelectedProblemSet] = useState<ProblemSet | null>(null);
  const [selectedStudents, setSelectedStudents] = useState<string[]>([]);
  const [formData, setFormData] = useState({
    title: '',
    description: '',
    distributionDate: '' // 배포 날짜
  });

  // URL 파라미터에서 문제 세트 ID 가져오기
  const problemSetIdFromUrl = searchParams.get('set');

  useEffect(() => {
    const initializeData = async () => {
      try {
        setInitialLoading(true);
        setError(null);
        await Promise.all([
          fetchProblemSets(),
          fetchStudents()
        ]);
      } catch (error) {
        console.error('초기 데이터 로딩 오류:', error);
        setError('데이터를 불러오는데 실패했습니다. 페이지를 새로고침해주세요.');
      } finally {
        setInitialLoading(false);
      }
    };

    if (profile) {
      initializeData();
    }
  }, [profile]);

  // URL 파라미터가 있으면 해당 문제 세트 자동 선택
  useEffect(() => {
    if (problemSetIdFromUrl && problemSets.length > 0) {
      const problemSet = problemSets.find(ps => ps.id === problemSetIdFromUrl);
      if (problemSet) {
        setSelectedProblemSet(problemSet);
        setFormData(prev => ({
          ...prev,
          title: `${problemSet.name} 배포`,
          description: problemSet.description || `${problemSet.name} 문제 세트입니다.`,
          distributionDate: new Date().toISOString().split('T')[0] // 오늘 날짜로 기본 설정
        }));
      }
    }
  }, [problemSetIdFromUrl, problemSets]);

  const fetchProblemSets = async () => {
    try {
      if (!profile?.id) {
        throw new Error('프로필 정보가 없습니다.');
      }

      console.log('배포 페이지 - 문제 세트 조회 시작, profile.id:', profile.id);

      // 문제 세트 조회
      const { data: problemSetsData, error: problemSetsError } = await supabase
        .from('problem_sets')
        .select('*')
        .eq('teacher_id', profile.id)
        .order('created_at', { ascending: false });

      console.log('배포 페이지 - 문제 세트 조회 결과:', problemSetsData);
      console.log('배포 페이지 - 문제 세트 조회 오류:', problemSetsError);

      if (problemSetsError) throw problemSetsError;

      // 각 문제 세트별로 문제 수 조회
      const problemSetsWithCount = await Promise.all(
        (problemSetsData || []).map(async (set) => {
          try {
            const { count, error: countError } = await supabase
              .from('problem_set_items')
              .select('*', { count: 'exact', head: true })
              .eq('problem_set_id', set.id);

            if (countError) {
              console.error(`문제 세트 ${set.id} 문제 수 조회 오류:`, countError);
              return { ...set, total_problems: 0 };
            }

            console.log(`문제 세트 ${set.name} 문제 수:`, count);
            return { ...set, total_problems: count || 0 };
          } catch (error) {
            console.error(`문제 세트 ${set.id} 처리 오류:`, error);
            return { ...set, total_problems: 0 };
          }
        })
      );
      
      console.log('배포 페이지 - 최종 문제 세트 목록:', problemSetsWithCount);
      setProblemSets(problemSetsWithCount);
    } catch (error) {
      console.error('문제 세트 조회 오류:', error);
      throw error;
    }
  };

  const fetchStudents = async () => {
    try {
      if (!profile?.id) {
        throw new Error('프로필 정보가 없습니다.');
      }

      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('teacher_id', profile.id)
        .eq('role', 'student')
        .order('name');

      if (error) throw error;
      setStudents(data || []);
    } catch (error) {
      console.error('학생 목록 조회 오류:', error);
      throw error;
    }
  };

  const handleProblemSetSelect = (problemSet: ProblemSet) => {
    setSelectedProblemSet(problemSet);
    setFormData(prev => ({
      ...prev,
      title: `${problemSet.name} 배포`,
      description: problemSet.description || `${problemSet.name} 문제 세트입니다.`
    }));
  };

  const handleStudentToggle = (studentId: string) => {
    setSelectedStudents(prev => 
      prev.includes(studentId)
        ? prev.filter(id => id !== studentId)
        : [...prev, studentId]
    );
  };

  const handleSelectAllStudents = () => {
    if (selectedStudents.length === students.length) {
      setSelectedStudents([]);
    } else {
      setSelectedStudents(students.map(s => s.id));
    }
  };



  const distributeProblemSet = async () => {
    if (!profile?.id) {
      toast({
        title: "오류",
        description: "사용자 정보를 찾을 수 없습니다.",
        variant: "destructive"
      });
      return;
    }

    if (!selectedProblemSet || selectedStudents.length === 0) {
      toast({
        title: "오류",
        description: "문제 세트와 학생을 선택해주세요.",
        variant: "destructive"
      });
      return;
    }

    if (!formData.title.trim() || !formData.distributionDate) {
      toast({
        title: "오류",
        description: "배포 제목과 배포 날짜를 입력해주세요.",
        variant: "destructive"
      });
      return;
    }

    setLoading(true);
    try {
      // 1. 배포 생성
      const { data: distribution, error: distributionError } = await supabase
        .from('distributions')
        .insert({
          title: formData.title,
          problem_set_id: selectedProblemSet.id,
          teacher_id: profile.id,
          description: formData.description,
          distribution_date: formData.distributionDate,
          is_active: true
        })
        .select()
        .single();

      if (distributionError) throw distributionError;

      // 2. 학생들을 배포에 추가
      const studentItems = selectedStudents.map(studentId => ({
        distribution_id: distribution.id,
        student_id: studentId
      }));

      const { error: studentsError } = await supabase
        .from('distribution_students')
        .insert(studentItems);

      if (studentsError) {
        console.error('학생 배포 오류:', studentsError);
        throw new Error('학생 배포 중 오류가 발생했습니다.');
      }

      // 3. 문제들을 배포에 추가
      const { data: problems, error: problemsError } = await supabase
        .from('problem_set_items')
        .select('problem_id, sort_order')
        .eq('problem_set_id', selectedProblemSet.id)
        .order('sort_order');

      if (problemsError) {
        console.error('문제 조회 오류:', problemsError);
        throw new Error('문제 조회 중 오류가 발생했습니다.');
      }

      if (!problems || problems.length === 0) {
        throw new Error('선택한 문제 세트에 문제가 없습니다.');
      }

      const problemItems = problems.map((item, index) => ({
        distribution_id: distribution.id,
        problem_id: item.problem_id,
        sort_order: index + 1
      }));

      const { error: distributionProblemsError } = await supabase
        .from('distribution_problems')
        .insert(problemItems);

      if (distributionProblemsError) {
        console.error('문제 배포 오류:', distributionProblemsError);
        throw new Error('문제 배포 중 오류가 발생했습니다.');
      }

      toast({
        title: "배포 성공",
        description: `${selectedStudents.length}명의 학생에게 문제 세트가 배포되었습니다.`
      });

      // 배포 완료 후 대시보드로 이동
      setTimeout(() => {
        navigate('/teacher');
      }, 1500);

    } catch (error: any) {
      console.error('배포 오류:', error);
      const errorMessage = error.message || '문제 세트 배포 중 오류가 발생했습니다.';
      toast({
        title: "배포 실패",
        description: errorMessage,
        variant: "destructive"
      });
    } finally {
      setLoading(false);
    }
  };

  // 로딩 상태 처리
  if (initialLoading) {
    return (
      <div className="container mx-auto px-4 py-6 max-w-4xl">
        <div className="flex items-center gap-4 mb-6">
          <Button variant="outline" size="sm" onClick={() => navigate('/teacher')}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            돌아가기
          </Button>
          <div>
            <h1 className="text-2xl font-bold">문제 세트 배포</h1>
            <p className="text-muted-foreground">학생들에게 문제 세트를 배포하세요</p>
          </div>
        </div>
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
        </div>
      </div>
    );
  }

  // 에러 상태 처리
  if (error) {
    return (
      <div className="container mx-auto px-4 py-6 max-w-4xl">
        <div className="flex items-center gap-4 mb-6">
          <Button variant="outline" size="sm" onClick={() => navigate('/teacher')}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            돌아가기
          </Button>
          <div>
            <h1 className="text-2xl font-bold">문제 세트 배포</h1>
            <p className="text-muted-foreground">학생들에게 문제 세트를 배포하세요</p>
          </div>
        </div>
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <div className="text-center">
              <div className="text-red-500 text-6xl mb-4">⚠️</div>
              <h2 className="text-xl font-semibold mb-2">오류가 발생했습니다</h2>
              <p className="text-muted-foreground mb-4">{error}</p>
              <div className="flex gap-2">
                <Button onClick={() => window.location.reload()}>
                  페이지 새로고침
                </Button>
                <Button variant="outline" onClick={() => navigate('/teacher')}>
                  대시보드로 돌아가기
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-6 max-w-4xl">
      {/* 헤더 */}
      <div className="flex items-center gap-4 mb-6">
        <Button variant="outline" size="sm" onClick={() => navigate('/teacher')}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          돌아가기
        </Button>
        <div>
          <h1 className="text-2xl font-bold">문제 세트 배포</h1>
          <p className="text-muted-foreground">학생들에게 문제 세트를 배포하세요</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 왼쪽: 문제 세트 선택 */}
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <BookOpen className="h-5 w-5" />
                문제 세트 선택
              </CardTitle>
              <CardDescription>
                배포할 문제 세트를 선택하세요
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {problemSets.map((problemSet) => (
                  <div
                    key={problemSet.id}
                    className={`p-3 border rounded-lg cursor-pointer transition-colors ${
                      selectedProblemSet?.id === problemSet.id
                        ? 'border-primary bg-primary/5'
                        : 'border-border hover:border-primary/50'
                    }`}
                    onClick={() => handleProblemSetSelect(problemSet)}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="font-medium">{problemSet.name}</h3>
                        <p className="text-sm text-muted-foreground">
                          {problemSet.total_problems || 0}문제
                        </p>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {new Date(problemSet.created_at).toLocaleDateString()}
                      </div>
                    </div>
                  </div>
                ))}
                {problemSets.length === 0 && (
                  <div className="text-center py-8 text-muted-foreground">
                    <BookOpen className="h-12 w-12 mx-auto mb-4" />
                    <p>배포할 문제 세트가 없습니다</p>
                    <Button className="mt-4" onClick={() => navigate('/cms/problem-sets')}>
                      문제 세트 만들기
                    </Button>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* 배포 설정 */}
          {selectedProblemSet && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Calendar className="h-5 w-5" />
                  배포 설정
                </CardTitle>
                <CardDescription>
                  배포 정보를 입력하세요
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="title">배포 제목 *</Label>
                  <Input
                    id="title"
                    value={formData.title}
                    onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                    placeholder="배포 제목을 입력하세요"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="description">설명</Label>
                  <Input
                    id="description"
                    value={formData.description}
                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                    placeholder="배포 설명을 입력하세요"
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
              <CardDescription>
                배포할 학생들을 선택하세요
              </CardDescription>
            </CardHeader>
            <CardContent>
              {students.length > 0 && (
                <div className="mb-4">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleSelectAllStudents}
                  >
                    {selectedStudents.length === students.length ? '전체 해제' : '전체 선택'}
                  </Button>
                </div>
              )}

              <div className="space-y-2">
                {students.map((student) => (
                  <div
                    key={student.id}
                    className="flex items-center space-x-3 p-3 border rounded-lg"
                  >
                    <Checkbox
                      id={student.id}
                      checked={selectedStudents.includes(student.id)}
                      onCheckedChange={() => handleStudentToggle(student.id)}
                    />
                    <Label htmlFor={student.id} className="flex-1 cursor-pointer">
                      <div>
                        <div className="font-medium">{student.name}</div>
                        <div className="text-sm text-muted-foreground">
                          {student.email} • {student.grade} • {student.school}
                        </div>
                      </div>
                    </Label>
                  </div>
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
          {selectedProblemSet && selectedStudents.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>배포 요약</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex justify-between">
                  <span>문제 세트:</span>
                  <span className="font-medium">{selectedProblemSet.name}</span>
                </div>
                <div className="flex justify-between">
                  <span>문제 수:</span>
                  <span className="font-medium">{selectedProblemSet.total_problems || 0}문제</span>
                </div>
                <div className="flex justify-between">
                  <span>배포 대상:</span>
                  <span className="font-medium">{selectedStudents.length}명</span>
                </div>
                <div className="flex justify-between">
                  <span>문제 제공 날짜:</span>
                  <span className="font-medium">
                    {formData.distributionDate
                      ? new Date(formData.distributionDate).toLocaleDateString()
                      : '설정 필요'
                    }
                  </span>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* 배포 버튼 */}
      {selectedProblemSet && selectedStudents.length > 0 && (
        <div className="mt-6 flex justify-center">
          <Button
            onClick={distributeProblemSet}
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
