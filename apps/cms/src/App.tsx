import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from '@shared/ui/toaster';
import { AuthProvider, useAuth } from '@shared/hooks/useAuth';

import Index from '@/pages/Index';
import EmailConfirm from '@/pages/EmailConfirm';
import CMSLayout from '@/components/layout/CMSLayout';
import TextbookManagementNew from '@/pages/TextbookManagementNew';
import AddProblem from '@/pages/AddProblem';
import AddProblemNew from '@/pages/AddProblemNew';
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
          <Route path="problems/new" element={<AddProblemNew />} />
          <Route path="problems/:id" element={<AddProblem />} />
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
