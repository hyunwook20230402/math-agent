
import { useAuth } from '@/hooks/useAuth';
import AuthForm from '@/components/auth/AuthForm';
import TeacherDashboard from './teacher/TeacherDashboard';
import StudentDashboard from './student/StudentDashboard';

const Index = () => {
  const { user, profile, loading } = useAuth();

  console.log('Index component render:', { user: !!user, profile, loading });

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-muted-foreground">로딩 중...</p>
          <p className="text-xs text-muted-foreground mt-2">인증 상태를 확인하고 있습니다...</p>
        </div>
      </div>
    );
  }

  if (!user || !profile) {
    console.log('Showing AuthForm - no user or profile');
    return <AuthForm />;
  }

  console.log('Auth state:', { user: !!user, profile, role: profile?.role });

  return (
    <div className="min-h-screen bg-background">
      <main>
        {profile.role === 'teacher' ? <TeacherDashboard /> : <StudentDashboard />}
      </main>
    </div>
  );
};

export default Index;
