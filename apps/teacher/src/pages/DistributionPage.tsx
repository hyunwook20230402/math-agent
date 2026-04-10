import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@shared/ui/card';
import { Button } from '@shared/ui/button';
import { Input } from '@shared/ui/input';
import { Badge } from '@shared/ui/badge';
import { Checkbox } from '@shared/ui/checkbox';
import { Calendar } from '@shared/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@shared/ui/popover';
import { 
  Users, 
  BookOpen, 
  Calendar as CalendarIcon,
  Clock,
  Eye,
  EyeOff,
  Share,
  Settings,
  Target
} from 'lucide-react';
import { format } from 'date-fns';
import { supabase } from '@shared/supabase/client';
import { useAuth } from '@shared/hooks/useAuth';

interface ProblemSet {
  id: string;
  name: string;
  description?: string;
  problem_count: number;
  folder_id?: string;
  is_published: boolean;
  published_at?: string;
  expires_at?: string;
}

interface Student {
  id: string;
  name: string;
  email: string;
  class_name?: string;
}

interface Distribution {
  id: string;
  problem_set_id: string;
  student_id: string;
  is_active: boolean;
  assigned_at: string;
  expires_at?: string;
}

const DistributionPage = () => {
  const { profile } = useAuth();
  const [problemSets, setProblemSets] = useState<ProblemSet[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
  const [distributions, setDistributions] = useState<Distribution[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedSet, setSelectedSet] = useState<string | null>(null);
  const [selectedStudents, setSelectedStudents] = useState<string[]>([]);
  const [publishDate, setPublishDate] = useState<Date>();
  const [expireDate, setExpireDate] = useState<Date>();

  useEffect(() => {
    if (profile) {
      fetchData();
    }
  }, [profile]);

  const fetchData = async () => {
    if (!profile) return;

    // Fetch problem sets
    const { data: setsData } = await supabase
      .from('problem_sets')
      .select('*')
      .eq('teacher_id', profile.id)
      .order('created_at', { ascending: false });

    // Fetch students (assuming there's a students table)
    const { data: studentsData } = await supabase
      .from('profiles')
      .select('*')
      .eq('role', 'student')
      .order('name');

    // Fetch distributions
    const { data: distributionsData } = await supabase
      .from('distributions')
      .select('*')
      .eq('teacher_id', profile.id);

    if (setsData) setProblemSets(setsData);
    if (studentsData) setStudents(studentsData);
    if (distributionsData) setDistributions(distributionsData);
    setLoading(false);
  };

  const publishToStudents = async () => {
    if (!selectedSet || selectedStudents.length === 0 || !profile) return;

    const distributionsToCreate = selectedStudents.map(studentId => ({
      problem_set_id: selectedSet,
      student_id: studentId,
      teacher_id: profile.id,
      is_active: true,
      assigned_at: new Date().toISOString(),
      expires_at: expireDate?.toISOString()
    }));

    const { error } = await supabase
      .from('distributions')
      .insert(distributionsToCreate);

    if (error) {
      console.error('Error publishing to students:', error);
      return;
    }

    // Update problem set as published
    await supabase
      .from('problem_sets')
      .update({ 
        is_published: true, 
        published_at: new Date().toISOString(),
        expires_at: expireDate?.toISOString()
      })
      .eq('id', selectedSet);

    fetchData();
    setSelectedSet(null);
    setSelectedStudents([]);
    setPublishDate(undefined);
    setExpireDate(undefined);
  };

  const toggleStudentSelection = (studentId: string) => {
    setSelectedStudents(prev => 
      prev.includes(studentId) 
        ? prev.filter(id => id !== studentId)
        : [...prev, studentId]
    );
  };

  const getDistributionStatus = (setId: string) => {
    const setDistributions = distributions.filter(d => d.problem_set_id === setId);
    const activeDistributions = setDistributions.filter(d => d.is_active);
    
    return {
      total: setDistributions.length,
      active: activeDistributions.length,
      students: students.filter(s => activeDistributions.some(d => d.student_id === s.id))
    };
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
          <h1 className="text-3xl font-bold text-foreground">학생 배포</h1>
          <p className="text-muted-foreground">문제 세트를 학생들에게 배포하고 관리하세요</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Problem Sets */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BookOpen className="h-5 w-5" />
              문제 세트
            </CardTitle>
            <CardDescription>배포할 문제 세트를 선택하세요</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {problemSets.map((set) => {
              const status = getDistributionStatus(set.id);
              return (
                <div
                  key={set.id}
                  className={`p-4 border rounded-lg cursor-pointer transition-colors ${
                    selectedSet === set.id 
                      ? 'border-primary bg-primary/5' 
                      : 'border-border hover:border-primary/50'
                  }`}
                  onClick={() => setSelectedSet(set.id)}
                >
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="font-medium">{set.name}</h3>
                    <Badge variant={set.is_published ? "default" : "secondary"}>
                      {set.is_published ? "배포됨" : "미배포"}
                    </Badge>
                  </div>
                  <p className="text-sm text-muted-foreground mb-2">
                    {set.description || "설명 없음"}
                  </p>
                  <div className="flex items-center gap-4 text-sm text-muted-foreground">
                    <span>{set.problem_count}문제</span>
                    {status.active > 0 && (
                      <span className="flex items-center gap-1">
                        <Users className="h-4 w-4" />
                        {status.active}명 배포됨
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>

        {/* Students */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="h-5 w-5" />
              학생 선택
            </CardTitle>
            <CardDescription>배포할 학생들을 선택하세요</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Input
              placeholder="학생 이름으로 검색..."
              className="mb-4"
            />
            <div className="space-y-2 max-h-96 overflow-y-auto">
              {students.map((student) => (
                <div
                  key={student.id}
                  className="flex items-center space-x-2 p-2 rounded-lg hover:bg-muted/50"
                >
                  <Checkbox
                    id={student.id}
                    checked={selectedStudents.includes(student.id)}
                    onCheckedChange={() => toggleStudentSelection(student.id)}
                  />
                  <label
                    htmlFor={student.id}
                    className="flex-1 cursor-pointer"
                  >
                    <div className="font-medium">{student.name}</div>
                    <div className="text-sm text-muted-foreground">
                      {student.email}
                      {student.class_name && ` • ${student.class_name}`}
                    </div>
                  </label>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Distribution Settings */}
      {selectedSet && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Settings className="h-5 w-5" />
              배포 설정
            </CardTitle>
            <CardDescription>배포 기간과 옵션을 설정하세요</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium mb-2 block">배포 시작일</label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline" className="w-full justify-start text-left font-normal">
                      <CalendarIcon className="mr-2 h-4 w-4" />
                      {publishDate ? format(publishDate, "PPP") : "날짜 선택"}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0">
                    <Calendar
                      mode="single"
                      selected={publishDate}
                      onSelect={setPublishDate}
                      initialFocus
                    />
                  </PopoverContent>
                </Popover>
              </div>
              <div>
                <label className="text-sm font-medium mb-2 block">배포 종료일 (선택사항)</label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline" className="w-full justify-start text-left font-normal">
                      <CalendarIcon className="mr-2 h-4 w-4" />
                      {expireDate ? format(expireDate, "PPP") : "날짜 선택"}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0">
                    <Calendar
                      mode="single"
                      selected={expireDate}
                      onSelect={setExpireDate}
                      initialFocus
                    />
                  </PopoverContent>
                </Popover>
              </div>
            </div>
            
            <div className="flex items-center justify-between pt-4">
              <div className="text-sm text-muted-foreground">
                {selectedStudents.length}명의 학생에게 배포됩니다
              </div>
              <Button 
                onClick={publishToStudents}
                disabled={selectedStudents.length === 0}
                className="flex items-center gap-2"
              >
                <Share className="h-4 w-4" />
                배포하기
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Active Distributions */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Target className="h-5 w-5" />
            활성 배포 현황
          </CardTitle>
          <CardDescription>현재 배포 중인 문제 세트들을 확인하세요</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {problemSets.filter(set => set.is_published).map((set) => {
              const status = getDistributionStatus(set.id);
              return (
                <div key={set.id} className="flex items-center justify-between p-4 border rounded-lg">
                  <div>
                    <h3 className="font-medium">{set.name}</h3>
                    <p className="text-sm text-muted-foreground">
                      {status.active}명의 학생에게 배포됨
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">
                      {set.published_at && format(new Date(set.published_at), "yyyy.MM.dd")}
                    </Badge>
                    {set.expires_at && (
                      <Badge variant="secondary">
                        ~{format(new Date(set.expires_at), "yyyy.MM.dd")}
                      </Badge>
                    )}
                  </div>
                </div>
              );
            })}
            {problemSets.filter(set => set.is_published).length === 0 && (
              <div className="text-center py-8 text-muted-foreground">
                배포 중인 문제 세트가 없습니다
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default DistributionPage;
