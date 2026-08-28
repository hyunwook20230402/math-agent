import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '@shared/hooks/useAuth';
import { Button } from '@shared/ui/button';

// 학생 앱은 별개(기본 8083). env 로 분리, 없으면 개발 기본값.
const STUDENT_URL = import.meta.env.VITE_STUDENT_URL || 'http://localhost:8083';

// 8082 는 선생님 전용 — 학생 계정으로 들어오면 선생님 화면이 통째로 열리던 것을 막는다.
const RequireTeacher = ({ children }: { children: React.ReactNode }) => {
  const { profile, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (!profile) return <Navigate to="/" replace />;

  if (profile.role !== 'teacher') {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 px-4 text-center">
        <h2 className="text-xl font-semibold">학생 계정입니다</h2>
        <p className="text-sm text-muted-foreground">
          이 화면은 선생님 전용입니다. 학생 페이지에서 학습을 이어가 주세요.
        </p>
        <Button onClick={() => { window.location.href = STUDENT_URL; }}>
          학생 페이지로 이동
        </Button>
      </div>
    );
  }

  return <>{children}</>;
};

export default RequireTeacher;
