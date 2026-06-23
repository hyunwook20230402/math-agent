import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useParams } from 'react-router-dom';
import { MathJaxContext } from 'better-react-mathjax';
import { Toaster } from '@shared/ui/toaster';
import { AuthProvider, useAuth } from '@shared/hooks/useAuth';

// MathJax 전역 설정 — CMS 와 동일. 막힌 지점 도우미 힌트의 LaTeX(\( \) / \[ \])를 렌더.
// MathJax 는 구분자가 빠진 raw 수식도 관대하게 렌더해 KaTeX 정규식 파싱보다 견고(11차).
const MATHJAX_CONFIG = {
  loader: { load: ['[tex]/ams'] },
  tex: {
    inlineMath: [['\\(', '\\)']],
    displayMath: [['\\[', '\\]']],
    packages: { '[+]': ['ams'] },
  },
  options: {
    enableMenu: false,
  },
};

import Index from '@/pages/Index';
import EmailConfirm from '@/pages/EmailConfirm';
import StudentDashboard from '@/pages/StudentDashboard';
import SolveProblem from '@/pages/SolveProblem';
import WrongAnswerNote from '@/pages/WrongAnswerNote';
import AchievementPage from '@/pages/AchievementPage';
import Header from '@/components/layout/Header';

// 구 "두번 틀린 문제" 경로 → 통합 오답 페이지로 리다이렉트 (북마크·기존 링크 호환)
function StillWrongRedirect() {
  const { distributionId } = useParams<{ distributionId: string }>();
  return <Navigate to={`/student/wrong-answers/${distributionId}`} replace />;
}

function AppContent() {
  const { profile, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {profile && <Header />}

      <Routes>
        <Route path="/" element={<Index />} />
        <Route path="/auth/confirm" element={<EmailConfirm />} />

        {profile && (
          <>
            <Route path="/student" element={<StudentDashboard />} />
            <Route path="/student/dashboard" element={<StudentDashboard />} />
            <Route path="/student/problems/:distributionId" element={<SolveProblem />} />
            <Route path="/student/wrong-answers/:distributionId" element={<WrongAnswerNote />} />
            {/* 구 "두번 틀린 문제" 페이지는 통합됨 — 기존 링크는 통합 오답 페이지로 리다이렉트 */}
            <Route path="/student/still-wrong-answers/:distributionId" element={<StillWrongRedirect />} />
            <Route path="/student/achievements" element={<AchievementPage />} />
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
      <MathJaxContext version={3} config={MATHJAX_CONFIG}>
        <Router>
          <AppContent />
        </Router>
      </MathJaxContext>
    </AuthProvider>
  );
}

export default App;
