import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from '@shared/ui/toaster';
import { AuthProvider, useAuth } from '@shared/hooks/useAuth';

import Index from '@/pages/Index';
import EmailConfirm from '@/pages/EmailConfirm';
import TeacherDashboard from '@/pages/TeacherDashboard';
import StudentRegistration from '@/pages/StudentRegistration';
import DistributeProblemSet from '@/pages/DistributeProblemSet';
import StudentAnalysis from '@/pages/StudentAnalysis';
import DistributionPage from '@/pages/DistributionPage';
import AnalysisPage from '@/pages/AnalysisPage';
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
            <Route path="/teacher" element={<TeacherDashboard />} />
            <Route path="/teacher/students" element={<StudentRegistration />} />
            <Route path="/teacher/distribute" element={<DistributeProblemSet />} />
            <Route path="/teacher/student/:studentId" element={<StudentAnalysis />} />
            <Route path="/teacher/distributions" element={<DistributionPage />} />
            <Route path="/teacher/analysis" element={<AnalysisPage />} />
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
