import { Outlet } from 'react-router-dom';
import { TextbookProvider } from '@/context/TextbookContext';
import Header from './Header';

const CMSLayoutInner = () => {
  return (
    <div className="min-h-screen bg-background flex flex-col">
      <Header />
      <main className="flex-1 flex flex-col">
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
