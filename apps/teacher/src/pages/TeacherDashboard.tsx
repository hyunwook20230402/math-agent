import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@shared/ui/card';
import { Button } from '@shared/ui/button';
import { Input } from '@shared/ui/input';
import { Badge } from '@shared/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@shared/ui/avatar';
import { 
  Users, 
  Plus, 
  Search, 
  Filter,
  Calendar,
  TrendingUp,
  AlertCircle,
  CheckCircle,
  Clock,
  Eye,
  Edit,
  MessageSquare,
  FileText,
  Award,
  BookOpen
} from 'lucide-react';
import { useAuth } from '@shared/hooks/useAuth';
import { useNavigate } from 'react-router-dom';
import { profileApi, distributionApi, studentApi } from '@shared/lib/api';
import type { Profile, DistributionWithDetails } from '@shared/types/database';


interface RecentActivity {
  id: string;
  type: 'assignment' | 'completion' | 'feedback';
  studentName: string;
  description: string;
  timestamp: string;
  status: 'success' | 'warning' | 'info';
}

const TeacherDashboard = () => {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const [students, setStudents] = useState<Profile[]>([]);
  const [distributions, setDistributions] = useState<DistributionWithDetails[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedFilter, setSelectedFilter] = useState<string>('all');
  

  const [recentActivities, setRecentActivities] = useState<RecentActivity[]>([]);

  useEffect(() => {
    if (profile) {
      fetchData();
    }
  }, [profile]);

  const fetchData = async () => {
    if (!profile) return;

    try {
      console.log('실제 데이터 로드 시작:', profile.email);
      
                  // 실제 데이터: 김현욱 선생님에게 등록된 학생들만 가져오기
                  console.log('선생님 이메일:', profile.email);
                  console.log('profile 객체:', profile);
                  const actualStudents = await studentApi.getStudentsByTeacher(profile.email);
                  console.log('등록된 학생들:', actualStudents);
                  console.log('학생 수:', actualStudents.length);
                  setStudents(actualStudents);

      // 문제 세트는 더 이상 사용하지 않음

      // 더미 배포 데이터
      // 실제 배포 데이터 조회 (현재는 빈 배열)
      setDistributions([]);

      // 실제 최근 활동 데이터 조회 (현재는 빈 배열)
      setRecentActivities([]);

      setLoading(false);
    } catch (error) {
      console.error('데이터 로드 실패:', error);
      setLoading(false);
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'success':
        return <CheckCircle className="h-4 w-4 text-green-500" />;
      case 'warning':
        return <AlertCircle className="h-4 w-4 text-yellow-500" />;
      case 'info':
        return <Clock className="h-4 w-4 text-blue-500" />;
      default:
        return <Activity className="h-4 w-4 text-gray-500" />;
    }
  };

  const getActivityIcon = (type: string) => {
    switch (type) {
      case 'assignment':
        return <BookOpen className="h-4 w-4" />;
      case 'completion':
        return <CheckCircle className="h-4 w-4" />;
      case 'feedback':
        return <MessageSquare className="h-4 w-4" />;
      default:
        return <Activity className="h-4 w-4" />;
    }
  };

  const filteredStudents = students.filter(student =>
    student.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

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
    <div className="container mx-auto px-4 py-6 space-y-6">
      {/* 헤더 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-foreground">선생님 대시보드</h1>
          <p className="text-muted-foreground">학생 등록, 학습 배포, 성과 분석</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => navigate('/teacher/students')}>
            <Users className="h-4 w-4 mr-2" />
            학생 등록
          </Button>
        </div>
      </div>


      {/* 학생 목록 및 최근 활동 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 학생 목록 */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>내 학생들</CardTitle>
                <CardDescription>학생별 학습 현황 및 성과</CardDescription>
              </div>
              <Button variant="outline" size="sm" onClick={() => navigate('/teacher/students')}>
                전체 보기
              </Button>
            </div>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="학생 검색..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-10"
                />
              </div>
              <Button variant="outline" size="sm">
                <Filter className="h-4 w-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {filteredStudents.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Users className="h-12 w-12 mx-auto mb-4" />
                  <p>등록된 학생이 없습니다</p>
                  <p className="text-sm mt-2">학생 등록 후 과제를 배포해보세요</p>
                  <Button className="mt-4" onClick={() => navigate('/teacher/students')}>
                    학생 등록하기
                  </Button>
                </div>
              ) : (
                filteredStudents.slice(0, 5).map((student) => (
                  <div key={student.id} className="flex items-center justify-between p-3 border rounded-lg hover:bg-muted/50 cursor-pointer"
                       onClick={() => navigate(`/teacher/student/${student.id}`)}>
                    <div className="flex items-center gap-3">
                      <Avatar className="h-10 w-10">
                        <AvatarImage src={student.avatar_url || ''} />
                        <AvatarFallback>{student.name.charAt(0)}</AvatarFallback>
                      </Avatar>
                      <div>
                        <p className="font-medium">{student.name}</p>
                        <p className="text-sm text-muted-foreground">{student.email}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-xs">
                        <TrendingUp className="h-3 w-3 mr-1" />
                        분석
                      </Badge>
                      <Button variant="ghost" size="sm" onClick={(e) => {
                        e.stopPropagation();
                        navigate(`/teacher/student/${student.id}`);
                      }}>
                        <Eye className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>

        {/* 최근 활동 */}
      <Card>
        <CardHeader>
            <CardTitle>최근 활동</CardTitle>
            <CardDescription>학생들의 학습 활동 및 알림</CardDescription>
        </CardHeader>
        <CardContent>
            <div className="space-y-3">
              {recentActivities.map((activity) => (
                <div key={activity.id} className="flex items-start gap-3 p-3 border rounded-lg">
                  <div className="flex-shrink-0 mt-1">
                    {getStatusIcon(activity.status)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      {getActivityIcon(activity.type)}
                      <p className="font-medium text-sm">{activity.studentName}</p>
                      <Badge variant="outline" className="text-xs">
                        {activity.type === 'assignment' ? '배포' : 
                         activity.type === 'completion' ? '완료' : '피드백'}
                      </Badge>
                  </div>
                    <p className="text-sm text-muted-foreground mt-1">
                      {activity.description}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {new Date(activity.timestamp).toLocaleString()}
                    </p>
                  </div>
                </div>
              ))}
            </div>
        </CardContent>
      </Card>
      </div>

      {/* 배포 현황 */}
      <div className="grid grid-cols-1 gap-6">
        <Card>
        <CardHeader>
            <CardTitle>배포 현황</CardTitle>
            <CardDescription>학생들에게 배포된 학습 과제</CardDescription>
        </CardHeader>
        <CardContent>
            <div className="space-y-3">
              {distributions.slice(0, 3).map((distribution) => (
                <div key={distribution.id} className="flex items-center justify-between p-3 border rounded-lg">
                  <div className="flex items-center gap-3">
                    <Calendar className="h-5 w-5 text-primary" />
                     <div>
                      <p className="font-medium">{distribution.title}</p>
                       <p className="text-sm text-muted-foreground">
                        {distribution.students.length}명 • {distribution.problem_set.name}
                       </p>
                     </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={distribution.is_active ? "default" : "outline"} className="text-xs">
                      {distribution.is_active ? "진행중" : "완료"}
                    </Badge>
                    <Button variant="outline" size="sm" 
                            onClick={() => navigate(`/teacher/analysis/${distribution.id}`)}>
                      분석
                     </Button>
                  </div>
                   </div>
                 ))}
              {distributions.length === 0 && (
               <div className="text-center py-8 text-muted-foreground">
                  <Calendar className="h-12 w-12 mx-auto mb-4" />
                  <p>배포된 과제가 없습니다</p>
                  <Button className="mt-4" onClick={() => navigate('/teacher/distribute')}>
                    첫 번째 과제 배포하기
                 </Button>
               </div>
             )}
           </div>
          </CardContent>
        </Card>
      </div>


     </div>
   );
 };

export default TeacherDashboard;