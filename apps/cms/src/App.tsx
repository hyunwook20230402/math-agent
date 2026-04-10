import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from '@shared/ui/toaster';
import { AuthProvider, useAuth } from '@shared/hooks/useAuth';

import Index from '@/pages/Index';
import EmailConfirm from '@/pages/EmailConfirm';
import CMSLayout from '@/components/layout/CMSLayout';
import TextbookManagementNew from '@/pages/TextbookManagementNew';
import ProblemManagement from '@/pages/ProblemManagement';
import AddProblem from '@/pages/AddProblem';
import AddProblemNew from '@/pages/AddProblemNew';
import ProblemSetManagement from '@/pages/ProblemSetManagement';
import DistributionManagement from '@/pages/DistributionManagement';
import DistributionDetail from '@/pages/DistributionDetail';
import Analytics from '@/pages/Analytics';
import PdfReview from '@/pages/PdfReview';

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
    <Routes>
      <Route path="/" element={<Index />} />
      <Route path="/auth/confirm" element={<EmailConfirm />} />

      {profile && (
        <Route path="/cms" element={<CMSLayout />}>
          <Route index element={<Navigate to="/cms/textbooks" replace />} />
          <Route path="textbooks" element={<TextbookManagementNew />} />
          <Route path="problems" element={<ProblemManagement />} />
          <Route path="problems/new" element={<AddProblemNew />} />
          <Route path="problems/:id" element={<AddProblem />} />
          <Route path="problem-sets" element={<ProblemSetManagement />} />
          <Route path="distributions" element={<DistributionManagement />} />
          <Route path="distributions/:distributionId" element={<DistributionDetail />} />
          <Route path="analytics" element={<Analytics />} />
          <Route path="import/:jobId" element={<PdfReview />} />
        </Route>
      )}

      {/* 레거시 리다이렉트 */}
      <Route path="/cms/import" element={<Navigate to="/cms/textbooks" replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function App() {
  return (
    <AuthProvider>
      <Router>
        <AppContent />
        <Toaster />
      </Router>
    </AuthProvider>
  );
}

export default App;
