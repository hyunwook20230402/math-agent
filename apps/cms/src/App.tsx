import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from '@shared/ui/toaster';
import { AuthProvider, useAuth } from '@shared/hooks/useAuth';

import Index from '@/pages/Index';
import EmailConfirm from '@/pages/EmailConfirm';
import CMSDashboardNew from '@/pages/CMSDashboardNew';
import CMSDashboard from '@/pages/CMSDashboard';
import ProblemManagement from '@/pages/ProblemManagement';
import AddProblem from '@/pages/AddProblem';
import AddProblemNew from '@/pages/AddProblemNew';
import TextbookManagement from '@/pages/TextbookManagement';
import TextbookManagementNew from '@/pages/TextbookManagementNew';
import ProblemSetManagement from '@/pages/ProblemSetManagement';
import DistributionManagement from '@/pages/DistributionManagement';
import DistributionDetail from '@/pages/DistributionDetail';
import ProblemSearch from '@/pages/ProblemSearch';
import Analytics from '@/pages/Analytics';
import PdfImport from '@/pages/PdfImport';
import PdfReview from '@/pages/PdfReview';
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
            <Route path="/cms" element={<CMSDashboardNew />} />
            <Route path="/cms/old" element={<CMSDashboard />} />
            <Route path="/cms/problems" element={<ProblemManagement />} />
            <Route path="/cms/problems/new" element={<AddProblemNew />} />
            <Route path="/cms/problems/:id" element={<AddProblem />} />
            <Route path="/cms/textbooks" element={<TextbookManagementNew />} />
            <Route path="/cms/textbooks/old" element={<TextbookManagement />} />
            <Route path="/cms/problem-sets" element={<ProblemSetManagement />} />
            <Route path="/cms/distributions" element={<DistributionManagement />} />
            <Route path="/cms/distributions/:distributionId" element={<DistributionDetail />} />
            <Route path="/cms/search" element={<ProblemSearch />} />
            <Route path="/cms/analytics" element={<Analytics />} />
            <Route path="/cms/import" element={<PdfImport />} />
            <Route path="/cms/import/:jobId" element={<PdfReview />} />
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
