import { Outlet } from 'react-router-dom';
import { TextbookProvider, useTextbook } from '@/context/TextbookContext';
import Header from './Header';
import CMSTabNavigation from './CMSTabNavigation';
import { BookOpen, ChevronRight, X } from 'lucide-react';
import { Button } from '@shared/ui/button';

const TextbookBreadcrumb = () => {
  const { selectedTextbook, selectedChapter, selectedSubchapter, clearSelection } = useTextbook();

  if (!selectedTextbook) return null;

  return (
    <div className="border-b bg-muted/30">
      <div className="container mx-auto px-4 py-2 flex items-center justify-between">
        <div className="flex items-center gap-1 text-sm">
          <BookOpen className="h-4 w-4 text-muted-foreground" />
          <span className="font-medium">{selectedTextbook.name}</span>
          {selectedChapter && (
            <>
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
              <span>{selectedChapter.name}</span>
            </>
          )}
          {selectedSubchapter && (
            <>
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
              <span>{selectedSubchapter.name}</span>
            </>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={clearSelection} className="h-6 px-2">
          <X className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
};

const CMSLayoutInner = () => {
  return (
    <div className="min-h-screen bg-background">
      <Header />
      <CMSTabNavigation />
      <TextbookBreadcrumb />
      <main>
        <Outlet />
      </main>
    </div>
  );
};

const CMSLayout = () => {
  return (
    <TextbookProvider>
      <CMSLayoutInner />
    </TextbookProvider>
  );
};

export default CMSLayout;
