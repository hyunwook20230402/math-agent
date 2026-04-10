import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from '@shared/ui/toaster';
import { AuthProvider, useAuth } from '@shared/hooks/useAuth';

import Index from '@/pages/Index';
import EmailConfirm from '@/pages/EmailConfirm';
import StudentDashboard from '@/pages/StudentDashboard';
import SolveProblem from '@/pages/SolveProblem';
import WrongAnswerNote from '@/pages/WrongAnswerNote';
import StillWrongAnswerNote from '@/pages/StillWrongAnswerNote';
import AchievementPage from '@/pages/AchievementPage';
import Header from '@/components/layout/Header';

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
            <Route path="/student/still-wrong-answers/:distributionId" element={<StillWrongAnswerNote />} />
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
      <Router>
        <AppContent />
      </Router>
    </AuthProvider>
  );
}

export default App;
