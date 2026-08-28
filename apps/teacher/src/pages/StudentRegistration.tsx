import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@shared/hooks/useAuth';
import { Button } from '@shared/ui/button';
import { Input } from '@shared/ui/input';
import { Textarea } from '@shared/ui/textarea';
import { Label } from '@shared/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@shared/ui/card';
import { toast } from '@shared/hooks/use-toast';
import { ArrowLeft, UserPlus, Search, AlertCircle, Pencil, Phone } from 'lucide-react';
import { supabase } from '@shared/supabase/client';
import { ENROLL_SOURCES, ENROLL_SOURCE_LABEL, type EnrollSource } from '@shared/lib/api';

interface StudentProfile {
  id: string;
  email: string;
  name: string;
  role: string;
  grade?: string;
  school?: string;
  teacher_id?: string;
  parent_phone?: string | null;
  student_phone?: string | null;
  class_name?: string | null;
  enroll_source?: string | null;
  enroll_source_note?: string | null;
  enroll_reason?: string | null;
  created_at: string;
}

// 전화번호는 숫자만 저장한다 (문자 발송 직전 형식 검증은 백엔드 담당)
const normalizePhone = (raw: string) => raw.replace(/[^0-9]/g, '');

const gradeOptions = [
  '중학교 1학년',
  '중학교 2학년',
  '중학교 3학년',
  '고등학교 1학년',
  '고등학교 2학년',
  '고등학교 3학년',
];

/** 등록 폼과 편집 패널이 **같은 모양**을 쓰도록 한 곳에 모은 값 */
interface StudentForm {
  name: string;
  grade: string;
  school: string;
  className: string;
  parentPhone: string;
  studentPhone: string;
  enrollSource: string;       // '' | EnrollSource
  enrollSourceNote: string;
  enrollReason: string;
}

const emptyForm: StudentForm = {
  name: '', grade: '', school: '', className: '',
  parentPhone: '', studentPhone: '',
  enrollSource: '', enrollSourceNote: '', enrollReason: '',
};

const formOf = (s: StudentProfile): StudentForm => ({
  name: s.name || '',
  grade: s.grade || '',
  school: s.school || '',
  className: s.class_name || '',
  parentPhone: s.parent_phone || '',
  studentPhone: s.student_phone || '',
  enrollSource: s.enroll_source || '',
  enrollSourceNote: s.enroll_source_note || '',
  enrollReason: s.enroll_reason || '',
});

/** 폼 → DB 컬럼. 빈 문자열은 NULL 로 (빈칸과 '없음'을 구분하지 않는다) */
const toProfilePatch = (f: StudentForm) => ({
  name: f.name.trim(),
  grade: f.grade,
  school: f.school.trim(),
  class_name: f.className.trim() || null,
  parent_phone: normalizePhone(f.parentPhone) || null,
  student_phone: normalizePhone(f.studentPhone) || null,
  enroll_source: f.enrollSource || null,
  enroll_source_note: f.enrollSourceNote.trim() || null,
  enroll_reason: f.enrollReason.trim() || null,
});

const isValid = (f: StudentForm) => !!f.name.trim() && !!f.grade && !!f.school.trim();

// 새 반 이름을 직접 치는 모드로 들어가는 select 값
const NEW_CLASS = '__new__';

/**
 * 학생 정보 입력 칸 묶음.
 *
 * 등록 폼과 목록의 편집 패널이 **이 컴포넌트 하나**를 같이 쓴다. 두 벌로 두면
 * 한쪽에만 칸을 더하는 식으로 조용히 갈라진다(기존에 편집은 연락처만 됐던 이유).
 */
const StudentFields = ({
  value, onChange, classOptions, idPrefix,
}: {
  value: StudentForm;
  onChange: (next: StudentForm) => void;
  classOptions: string[];
  idPrefix: string;
}) => {
  // 목록에 없는 반이면(=새로 치는 중) 처음부터 입력칸을 보여준다
  const [newClass, setNewClass] = useState(
    () => !!value.className && !classOptions.includes(value.className),
  );
  const set = (patch: Partial<StudentForm>) => onChange({ ...value, ...patch });

  // 지인소개는 "누가 소개했는지"가 실제로 중요하고, 기타는 경로 자체를 적어야 한다
  const needsNote = value.enrollSource === 'etc' || value.enrollSource === 'referral';

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-name`}>학생 이름 *</Label>
          <Input
            id={`${idPrefix}-name`}
            value={value.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder="학생 이름"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-grade`}>학년 *</Label>
          <select
            id={`${idPrefix}-grade`}
            value={value.grade}
            onChange={(e) => set({ grade: e.target.value })}
            className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
          >
            <option value="">학년 선택</option>
            {gradeOptions.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-school`}>학교 이름 *</Label>
          <Input
            id={`${idPrefix}-school`}
            value={value.school}
            onChange={(e) => set({ school: e.target.value })}
            placeholder="예: 야탑고등학교"
          />
        </div>

        {/* 반 이름 — 이미 쓴 반에서 고르거나 새로 친다.
            자유 입력만 두면 '고1목' 과 '고1 목요반' 처럼 오타로 반이 갈라진다. */}
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-class`}>반 이름 (선택)</Label>
          {newClass ? (
            <div className="flex gap-2">
              <Input
                id={`${idPrefix}-class`}
                value={value.className}
                onChange={(e) => set({ className: e.target.value })}
                placeholder="예: 고1 목요반"
                autoFocus
              />
              {classOptions.length > 0 && (
                <Button
                  type="button" variant="outline" size="sm" className="shrink-0"
                  onClick={() => { setNewClass(false); set({ className: '' }); }}
                >
                  목록에서
                </Button>
              )}
            </div>
          ) : (
            <select
              id={`${idPrefix}-class`}
              value={value.className}
              onChange={(e) => {
                if (e.target.value === NEW_CLASS) { setNewClass(true); set({ className: '' }); }
                else set({ className: e.target.value });
              }}
              className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
            >
              <option value="">반 없음</option>
              {classOptions.map((c) => <option key={c} value={c}>{c}</option>)}
              <option value={NEW_CLASS}>+ 새 반 이름 직접 입력…</option>
            </select>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-parent`}>학부모 연락처 (권장)</Label>
          <Input
            id={`${idPrefix}-parent`}
            value={value.parentPhone}
            onChange={(e) => set({ parentPhone: e.target.value })}
            placeholder="01012345678"
            inputMode="numeric"
          />
          <p className="text-xs text-muted-foreground">출석 알림·학습보고서 문자를 받을 번호입니다</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-student`}>학생 연락처 (선택)</Label>
          <Input
            id={`${idPrefix}-student`}
            value={value.studentPhone}
            onChange={(e) => set({ studentPhone: e.target.value })}
            placeholder="01012345678"
            inputMode="numeric"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-source`}>등록경로 (선택)</Label>
          <select
            id={`${idPrefix}-source`}
            value={value.enrollSource}
            onChange={(e) => set({ enrollSource: e.target.value })}
            className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
          >
            <option value="">선택 안 함</option>
            {ENROLL_SOURCES.map((s) => (
              <option key={s} value={s}>{ENROLL_SOURCE_LABEL[s as EnrollSource]}</option>
            ))}
          </select>
        </div>
        {needsNote && (
          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-source-note`}>
              {value.enrollSource === 'referral' ? '소개해 준 사람 (선택)' : '어떤 경로인지 (선택)'}
            </Label>
            <Input
              id={`${idPrefix}-source-note`}
              value={value.enrollSourceNote}
              onChange={(e) => set({ enrollSourceNote: e.target.value })}
              placeholder={value.enrollSource === 'referral' ? '예: 김철수 어머니' : '예: 학교 앞 현수막'}
            />
          </div>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-reason`}>등록이유 (선택)</Label>
        <Textarea
          id={`${idPrefix}-reason`}
          value={value.enrollReason}
          onChange={(e) => set({ enrollReason: e.target.value })}
          placeholder="예: 2학기 내신 대비. 함수 단원에서 성적이 크게 떨어져 기초부터 다시."
          rows={2}
        />
      </div>
    </div>
  );
};

const StudentRegistration = () => {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const [loading, setLoading] = useState(false);
  const [searchEmail, setSearchEmail] = useState('');
  const [selectedStudent, setSelectedStudent] = useState<StudentProfile | null>(null);
  const [listRefreshKey, setListRefreshKey] = useState(0);
  const [formData, setFormData] = useState<StudentForm>(emptyForm);
  const [email, setEmail] = useState('');

  // 이미 쓴 반 이름 목록 — 등록 폼과 편집 패널이 같이 쓴다
  const [classOptions, setClassOptions] = useState<string[]>([]);

  const loadClassOptions = useCallback(async () => {
    if (!profile?.id) return;
    const { data, error } = await supabase
      .from('profiles')
      .select('class_name')
      .eq('teacher_id', profile.id)
      .eq('role', 'student')
      .not('class_name', 'is', null);
    if (error) {
      console.warn('반 목록 조회 실패:', error);
      return;
    }
    const names = [...new Set((data || []).map((r: any) => r.class_name).filter(Boolean) as string[])];
    setClassOptions(names.sort((a, b) => a.localeCompare(b, 'ko')));
  }, [profile?.id]);

  useEffect(() => { loadClassOptions(); }, [loadClassOptions, listRefreshKey]);

  // 학생 검색
  const searchStudent = async () => {
    if (!searchEmail.trim()) {
      toast({ title: '오류', description: '이메일을 입력해주세요.', variant: 'destructive' });
      return;
    }

    setLoading(true);
    try {
      // 회원가입된 학생 중 아직 선생님에게 등록되지 않은 학생만
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('email', searchEmail.trim())
        .eq('role', 'student')
        .is('teacher_id', null);

      if (error) throw error;

      if (data && data.length > 0) {
        setSelectedStudent(data[0]);
        setEmail(data[0].email);
        setFormData(formOf(data[0]));
        toast({ title: '학생 발견', description: '회원가입된 학생을 찾았습니다. 정보를 채우고 등록해주세요.' });
      } else {
        setSelectedStudent(null);
        toast({
          title: '학생을 찾을 수 없습니다',
          description: '해당 이메일로 회원가입된 학생이 없거나 이미 등록된 학생입니다.',
          variant: 'destructive',
        });
      }
    } catch (error: any) {
      console.error('학생 검색 오류:', error);
      toast({ title: '검색 오류', description: '학생 검색 중 오류가 발생했습니다.', variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  const resetForm = () => {
    setSelectedStudent(null);
    setEmail('');
    setFormData(emptyForm);
  };

  // 학생 등록
  const registerStudent = async () => {
    if (!selectedStudent || !profile) {
      toast({ title: '오류', description: '등록할 학생을 선택해주세요.', variant: 'destructive' });
      return;
    }
    if (!isValid(formData)) {
      toast({ title: '오류', description: '이름·학년·학교를 입력해주세요.', variant: 'destructive' });
      return;
    }

    setLoading(true);
    try {
      const { error } = await supabase
        .from('profiles')
        .update({ teacher_id: profile.id, ...toProfilePatch(formData) })
        .eq('id', selectedStudent.id)
        .select();
      if (error) throw error;

      // 등록 후 검증: teacher_id 가 실제로 붙었는지
      const { data: verifyResult, error: verifyError } = await supabase
        .from('profiles')
        .select('id, name, teacher_id')
        .eq('id', selectedStudent.id)
        .single();
      if (verifyError) throw new Error('등록 검증 실패');
      if (verifyResult.teacher_id !== profile.id) {
        throw new Error('teacher_id가 올바르게 설정되지 않았습니다.');
      }

      toast({ title: '등록 성공', description: `${formData.name} 학생이 성공적으로 등록되었습니다.` });
      setSearchEmail('');
      resetForm();
      setListRefreshKey((k) => k + 1);
    } catch (error: any) {
      console.error('학생 등록 오류:', error);
      let errorMessage = '학생 등록 중 오류가 발생했습니다. 다시 시도해주세요.';
      if (error.message?.includes('teacher_id')) {
        errorMessage = '선생님 정보 연결에 실패했습니다. 페이지를 새로고침 후 다시 시도해주세요.';
      } else if (error.message?.includes('검증')) {
        errorMessage = '등록 검증에 실패했습니다. 잠시 후 다시 시도해주세요.';
      }
      toast({ title: '등록 실패', description: errorMessage, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="container mx-auto px-4 py-6 max-w-2xl">
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
          <CardDescription>등록할 학생의 이메일을 입력하여 검색하세요</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2">
            <Input
              className="flex-1"
              placeholder="학생 이메일 입력"
              value={searchEmail}
              onChange={(e) => setSearchEmail(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && searchStudent()}
            />
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
              이름·학년·학교만 필수입니다. 나머지는 나중에 목록에서 채워도 됩니다.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">이메일</Label>
              <Input id="email" value={email} disabled className="bg-muted" />
              <p className="text-xs text-muted-foreground">회원가입된 이메일입니다</p>
            </div>

            <StudentFields
              value={formData}
              onChange={setFormData}
              classOptions={classOptions}
              idPrefix="new"
            />

            <div className="flex items-start gap-2 p-3 bg-blue-50 border border-blue-200 rounded-lg">
              <AlertCircle className="h-4 w-4 text-blue-600 mt-0.5" />
              <div className="text-sm text-blue-800">
                <p className="font-medium">등록 전 확인사항</p>
                <p>• 학생이 이미 회원가입되어 있어야 합니다</p>
                <p>• 다른 선생님에게 등록되지 않은 학생만 등록 가능합니다</p>
                <p>• 등록 후에는 학생이 선생님의 과제를 받을 수 있습니다</p>
              </div>
            </div>

            <div className="flex gap-2 pt-2">
              <Button onClick={registerStudent} disabled={loading || !isValid(formData)} className="flex-1">
                {loading ? '등록 중...' : '학생 등록'}
              </Button>
              <Button variant="outline" onClick={resetForm}>취소</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 등록된 학생 목록 */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>내가 등록한 학생들</CardTitle>
          <CardDescription>이름을 눌러 정보를 수정할 수 있습니다</CardDescription>
        </CardHeader>
        <CardContent>
          <RegisteredStudentsList
            teacherId={profile?.id}
            refreshKey={listRefreshKey}
            classOptions={classOptions}
            onSaved={() => setListRefreshKey((k) => k + 1)}
          />
        </CardContent>
      </Card>
    </div>
  );
};

/** 등록된 학생 목록 — 행마다 **전체 정보 편집**(예전엔 연락처만 됐다) */
const RegisteredStudentsList = ({
  teacherId, refreshKey, classOptions, onSaved,
}: {
  teacherId?: string;
  refreshKey: number;
  classOptions: string[];
  onSaved: () => void;
}) => {
  const [students, setStudents] = useState<StudentProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<StudentForm>(emptyForm);
  const [saving, setSaving] = useState(false);

  const fetchStudents = useCallback(async () => {
    if (!teacherId) return;
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
  }, [teacherId]);

  useEffect(() => { fetchStudents(); }, [fetchStudents, refreshKey]);

  const startEdit = (student: StudentProfile) => {
    setEditingId(student.id);
    setEditForm(formOf(student));
  };

  const save = async (studentId: string) => {
    if (!isValid(editForm)) {
      toast({ title: '오류', description: '이름·학년·학교는 비울 수 없습니다.', variant: 'destructive' });
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase
        .from('profiles')
        .update(toProfilePatch(editForm))
        .eq('id', studentId);
      if (error) throw error;
      toast({ title: '저장 완료', description: '학생 정보가 저장되었습니다.' });
      setEditingId(null);
      await fetchStudents();
      onSaved();                       // 새 반 이름이 생겼을 수 있어 목록을 다시 뽑는다
    } catch (error: any) {
      toast({ title: '저장 실패', description: error.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="text-center py-4">로딩 중...</div>;

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
      {students.map((student) => {
        const source = student.enroll_source
          ? ENROLL_SOURCE_LABEL[student.enroll_source as EnrollSource] ?? student.enroll_source
          : null;
        return (
          <div key={student.id} className="p-3 border rounded-lg">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-medium flex items-center gap-2 flex-wrap">
                  {student.name}
                  {student.class_name && (
                    <span className="text-xs font-normal rounded px-1.5 py-0.5 bg-primary/10 text-primary">
                      {student.class_name}
                    </span>
                  )}
                  {source && (
                    <span className="text-xs font-normal rounded px-1.5 py-0.5 bg-muted text-muted-foreground">
                      {source}{student.enroll_source_note ? ` · ${student.enroll_source_note}` : ''}
                    </span>
                  )}
                </p>
                <p className="text-sm text-muted-foreground">{student.email}</p>
                <p className="text-xs text-muted-foreground">
                  {student.grade || '학년 미입력'} • {student.school || '학교 미입력'}
                </p>
                <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
                  <Phone className="h-3 w-3" />
                  학부모 {student.parent_phone || '미등록'} · 학생 {student.student_phone || '미등록'}
                </p>
                {student.enroll_reason && (
                  <p className="text-xs text-muted-foreground mt-1 whitespace-pre-wrap">
                    등록이유: {student.enroll_reason}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-xs text-muted-foreground">
                  {new Date(student.created_at).toLocaleDateString()}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => (editingId === student.id ? setEditingId(null) : startEdit(student))}
                >
                  <Pencil className="h-3 w-3 mr-1" />
                  {editingId === student.id ? '닫기' : '수정'}
                </Button>
              </div>
            </div>

            {editingId === student.id && (
              <div className="mt-3 pt-3 border-t">
                <StudentFields
                  value={editForm}
                  onChange={setEditForm}
                  classOptions={classOptions}
                  idPrefix={`edit-${student.id}`}
                />
                <div className="flex gap-2 mt-4">
                  <Button size="sm" onClick={() => save(student.id)} disabled={saving || !isValid(editForm)}>
                    {saving ? '저장 중...' : '저장'}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setEditingId(null)}>취소</Button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default StudentRegistration;
