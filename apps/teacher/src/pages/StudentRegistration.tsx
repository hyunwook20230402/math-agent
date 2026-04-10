import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@shared/hooks/useAuth';
import { Button } from '@shared/ui/button';
import { Input } from '@shared/ui/input';
import { Label } from '@shared/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@shared/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@shared/ui/select';
import { toast } from '@shared/hooks/use-toast';
import { ArrowLeft, UserPlus, Search, AlertCircle } from 'lucide-react';
import { supabase } from '@shared/supabase/client';

interface StudentProfile {
  id: string;
  email: string;
  name: string;
  role: string;
  grade?: string;
  school?: string;
  teacher_id?: string;
  created_at: string;
}

const StudentRegistration = () => {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const [loading, setLoading] = useState(false);
  const [searchEmail, setSearchEmail] = useState('');
  const [searchResults, setSearchResults] = useState<StudentProfile[]>([]);
  const [selectedStudent, setSelectedStudent] = useState<StudentProfile | null>(null);
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    grade: '',
    school: ''
  });

  // 학년 옵션
  const gradeOptions = [
    '중학교 1학년',
    '중학교 2학년', 
    '중학교 3학년',
    '고등학교 1학년',
    '고등학교 2학년',
    '고등학교 3학년'
  ];

  // 학생 검색
  const searchStudent = async () => {
    if (!searchEmail.trim()) {
      toast({
        title: "오류",
        description: "이메일을 입력해주세요.",
        variant: "destructive"
      });
      return;
    }

    setLoading(true);
    try {
      // 회원가입된 학생 중에서 검색
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('email', searchEmail.trim())
        .eq('role', 'student')
        .is('teacher_id', null); // 아직 선생님에게 등록되지 않은 학생만

      if (error) throw error;

      if (data && data.length > 0) {
        setSearchResults(data);
        setSelectedStudent(data[0]);
        setFormData({
          name: data[0].name || '',
          email: data[0].email,
          grade: data[0].grade || '',
          school: data[0].school || ''
        });
        toast({
          title: "학생 발견",
          description: "회원가입된 학생을 찾았습니다. 정보를 확인하고 등록해주세요."
        });
      } else {
        setSearchResults([]);
        setSelectedStudent(null);
        toast({
          title: "학생을 찾을 수 없습니다",
          description: "해당 이메일로 회원가입된 학생이 없거나 이미 등록된 학생입니다.",
          variant: "destructive"
        });
      }
    } catch (error: any) {
      console.error('학생 검색 오류:', error);
      toast({
        title: "검색 오류",
        description: "학생 검색 중 오류가 발생했습니다.",
        variant: "destructive"
      });
    } finally {
      setLoading(false);
    }
  };

  // 학생 등록
  const registerStudent = async () => {
    if (!selectedStudent || !profile) {
      toast({
        title: "오류",
        description: "등록할 학생을 선택해주세요.",
        variant: "destructive"
      });
      return;
    }

    if (!formData.name.trim() || !formData.grade || !formData.school.trim()) {
      toast({
        title: "오류",
        description: "모든 필드를 입력해주세요.",
        variant: "destructive"
      });
      return;
    }

    setLoading(true);
    try {
      console.log('학생 등록 시작:', {
        studentId: selectedStudent.id,
        studentName: formData.name,
        teacherId: profile.id,
        teacherEmail: profile.email
      });

      // 학생 정보 업데이트 (teacher_id 연결 및 추가 정보 입력)
      const { data: updateResult, error } = await supabase
        .from('profiles')
        .update({
          teacher_id: profile.id,
          grade: formData.grade,
          school: formData.school,
          name: formData.name.trim()
        })
        .eq('id', selectedStudent.id)
        .select();

      if (error) {
        console.error('학생 등록 오류:', error);
        throw error;
      }

      console.log('학생 등록 성공:', updateResult);

      // 등록 후 검증: teacher_id가 올바르게 설정되었는지 확인
      const { data: verifyResult, error: verifyError } = await supabase
        .from('profiles')
        .select('id, name, teacher_id')
        .eq('id', selectedStudent.id)
        .single();

      if (verifyError) {
        console.error('등록 검증 오류:', verifyError);
        throw new Error('등록 검증 실패');
      }

      if (verifyResult.teacher_id !== profile.id) {
        console.error('teacher_id 검증 실패:', {
          expected: profile.id,
          actual: verifyResult.teacher_id
        });
        throw new Error('teacher_id가 올바르게 설정되지 않았습니다.');
      }

      console.log('등록 검증 성공:', verifyResult);

      toast({
        title: "등록 성공",
        description: `${formData.name} 학생이 성공적으로 등록되었습니다.`
      });

      // 폼 초기화
      setSearchEmail('');
      setSearchResults([]);
      setSelectedStudent(null);
      setFormData({
        name: '',
        email: '',
        grade: '',
        school: ''
      });

      // 잠시 후 대시보드로 이동
      setTimeout(() => {
        navigate('/teacher');
      }, 1500);

    } catch (error: any) {
      console.error('학생 등록 오류:', error);
      
      let errorMessage = "학생 등록 중 오류가 발생했습니다. 다시 시도해주세요.";
      
      if (error.message?.includes('teacher_id')) {
        errorMessage = "선생님 정보 연결에 실패했습니다. 페이지를 새로고침 후 다시 시도해주세요.";
      } else if (error.message?.includes('검증')) {
        errorMessage = "등록 검증에 실패했습니다. 잠시 후 다시 시도해주세요.";
      }
      
      toast({
        title: "등록 실패",
        description: errorMessage,
        variant: "destructive"
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="container mx-auto px-4 py-6 max-w-2xl">
      {/* 헤더 */}
      <div className="flex items-center gap-4 mb-6">
        <Button variant="outline" size="sm" onClick={() => navigate('/teacher')}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          돌아가기
        </Button>
        <div>
          <h1 className="text-2xl font-bold">학생 등록</h1>
          <p className="text-muted-foreground">회원가입한 학생을 등록하여 관리하세요</p>
        </div>
      </div>

      {/* 학생 검색 */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Search className="h-5 w-5" />
            학생 검색
          </CardTitle>
          <CardDescription>
            등록할 학생의 이메일을 입력하여 검색하세요
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2">
            <div className="flex-1">
              <Input
                placeholder="학생 이메일 입력"
                value={searchEmail}
                onChange={(e) => setSearchEmail(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && searchStudent()}
              />
            </div>
            <Button onClick={searchStudent} disabled={loading}>
              {loading ? '검색 중...' : '검색'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* 학생 정보 입력 */}
      {selectedStudent && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <UserPlus className="h-5 w-5" />
              학생 정보 입력
            </CardTitle>
            <CardDescription>
              학생의 상세 정보를 입력하고 등록하세요
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="name">학생 이름 *</Label>
                <Input
                  id="name"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="학생 이름"
                />
              </div>
              
              <div className="space-y-2">
                <Label htmlFor="email">이메일</Label>
                <Input
                  id="email"
                  value={formData.email}
                  disabled
                  className="bg-muted"
                />
                <p className="text-xs text-muted-foreground">회원가입된 이메일입니다</p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="grade">학년 *</Label>
                <Select value={formData.grade} onValueChange={(value) => setFormData({ ...formData, grade: value })}>
                  <SelectTrigger>
                    <SelectValue placeholder="학년 선택" />
                  </SelectTrigger>
                  <SelectContent>
                    {gradeOptions.map((grade) => (
                      <SelectItem key={grade} value={grade}>
                        {grade}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              
              <div className="space-y-2">
                <Label htmlFor="school">학교 이름 *</Label>
                <Input
                  id="school"
                  value={formData.school}
                  onChange={(e) => setFormData({ ...formData, school: e.target.value })}
                  placeholder="학교 이름"
                />
              </div>
            </div>

            <div className="flex items-start gap-2 p-3 bg-blue-50 border border-blue-200 rounded-lg">
              <AlertCircle className="h-4 w-4 text-blue-600 mt-0.5" />
              <div className="text-sm text-blue-800">
                <p className="font-medium">등록 전 확인사항</p>
                <p>• 학생이 이미 회원가입되어 있어야 합니다</p>
                <p>• 다른 선생님에게 등록되지 않은 학생만 등록 가능합니다</p>
                <p>• 등록 후에는 학생이 선생님의 과제를 받을 수 있습니다</p>
              </div>
            </div>

            <div className="flex gap-2 pt-4">
              <Button 
                onClick={registerStudent} 
                disabled={loading || !formData.name.trim() || !formData.grade || !formData.school.trim()}
                className="flex-1"
              >
                {loading ? '등록 중...' : '학생 등록'}
              </Button>
              <Button 
                variant="outline" 
                onClick={() => {
                  setSelectedStudent(null);
                  setSearchResults([]);
                  setFormData({ name: '', email: '', grade: '', school: '' });
                }}
              >
                취소
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 등록된 학생 목록 */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>내가 등록한 학생들</CardTitle>
          <CardDescription>
            현재 등록된 학생 목록입니다
          </CardDescription>
        </CardHeader>
        <CardContent>
          <RegisteredStudentsList teacherId={profile?.id} />
        </CardContent>
      </Card>
    </div>
  );
};

// 등록된 학생 목록 컴포넌트
const RegisteredStudentsList = ({ teacherId }: { teacherId?: string }) => {
  const [students, setStudents] = useState<StudentProfile[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (teacherId) {
      fetchStudents();
    }
  }, [teacherId]);

  const fetchStudents = async () => {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('teacher_id', teacherId)
        .eq('role', 'student')
        .order('created_at', { ascending: false });

      if (error) throw error;
      setStudents(data || []);
    } catch (error) {
      console.error('학생 목록 조회 오류:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return <div className="text-center py-4">로딩 중...</div>;
  }

  if (students.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        <UserPlus className="h-12 w-12 mx-auto mb-4" />
        <p>등록된 학생이 없습니다</p>
        <p className="text-sm">위에서 학생을 검색하여 등록해보세요</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {students.map((student) => (
        <div key={student.id} className="flex items-center justify-between p-3 border rounded-lg">
          <div>
            <p className="font-medium">{student.name}</p>
            <p className="text-sm text-muted-foreground">{student.email}</p>
            <p className="text-xs text-muted-foreground">
              {student.grade} • {student.school}
            </p>
          </div>
          <div className="text-xs text-muted-foreground">
            {new Date(student.created_at).toLocaleDateString()}
          </div>
        </div>
      ))}
    </div>
  );
};

export default StudentRegistration;
