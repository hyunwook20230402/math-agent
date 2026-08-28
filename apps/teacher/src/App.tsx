import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { Toaster } from '@shared/ui/toaster';
import { AuthProvider, useAuth } from '@shared/hooks/useAuth';

import Index from '@/pages/Index';
import EmailConfirm from '@/pages/EmailConfirm';
import TeacherDashboard from '@/pages/TeacherDashboard';
import StudentRegistration from '@/pages/StudentRegistration';
import DistributeProblemSet from '@/pages/DistributeProblemSet';
import StudentAnalysis from '@/pages/StudentAnalysis';
import WrongAnswerManagement from '@/pages/WrongAnswerManagement';
import MonthlyReport from '@/pages/MonthlyReport';
import Attendance from '@/pages/Attendance';
import Messages from '@/pages/Messages';
import PrintWrongAnswerSheet from '@/pages/PrintWrongAnswerSheet';
import Header from '@/components/layout/Header';
import TeacherTabNavigation from '@/components/layout/TeacherTabNavigation';
import RequireTeacher from '@/components/auth/RequireTeacher';

function AppContent() {
  const { profile, loading } = useAuth();
  const location = useLocation();
  // 인쇄 전용 라우트는 헤더/탭 없이 종이 레이아웃만 렌더한다
  const isPrint = location.pathname.startsWith('/teacher/print');

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {profile && profile.role === 'teacher' && !isPrint && <Header />}
      {profile && profile.role === 'teacher' && !isPrint && <TeacherTabNavigation />}

      <Routes>
        <Route path="/" element={<Index />} />
        <Route path="/auth/confirm" element={<EmailConfirm />} />

        {profile && (
          <>
            <Route path="/teacher" element={<RequireTeacher><TeacherDashboard /></RequireTeacher>} />
            <Route path="/teacher/students" element={<RequireTeacher><StudentRegistration /></RequireTeacher>} />
            <Route path="/teacher/distribute" element={<RequireTeacher><DistributeProblemSet /></RequireTeacher>} />
            <Route path="/teacher/student/:studentId" element={<RequireTeacher><StudentAnalysis /></RequireTeacher>} />
            <Route path="/teacher/wrong-answers" element={<RequireTeacher><WrongAnswerManagement /></RequireTeacher>} />
            <Route path="/teacher/reports" element={<RequireTeacher><MonthlyReport /></RequireTeacher>} />
            <Route path="/teacher/attendance" element={<RequireTeacher><Attendance /></RequireTeacher>} />
            <Route path="/teacher/messages" element={<RequireTeacher><Messages /></RequireTeacher>} />
            <Route path="/teacher/print/wrong-answers" element={<RequireTeacher><PrintWrongAnswerSheet /></RequireTeacher>} />
          </>
        )}

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>

      <Toaster />
    </div>
  );
}

function App() {
  return (
    <AuthProvider>
      <Router>
        <AppContent />
      </Router>
    </AuthProvider>
  );
}

export default App;
