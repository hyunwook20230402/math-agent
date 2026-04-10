import { useNavigate, useLocation } from 'react-router-dom';
import { BookOpen, FileText, FolderOpen, Send, BarChart3 } from 'lucide-react';
import { cn } from '@shared/lib/utils';

const tabs = [
  { path: '/cms/textbooks', label: '교재', icon: BookOpen },
  { path: '/cms/problems', label: '문제', icon: FileText },
  { path: '/cms/problem-sets', label: '세트', icon: FolderOpen },
  { path: '/cms/distributions', label: '배포', icon: Send },
  { path: '/cms/analytics', label: '분석', icon: BarChart3 },
];

const CMSTabNavigation = () => {
  const navigate = useNavigate();
  const location = useLocation();

  const isActive = (path: string) => {
    if (path === '/cms/textbooks') {
      return location.pathname === '/cms/textbooks' || location.pathname === '/cms';
    }
    return location.pathname.startsWith(path);
  };

  return (
    <div className="border-b bg-card">
      <div className="container mx-auto px-4">
        <nav className="flex space-x-1">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const active = isActive(tab.path);
            return (
              <button
                key={tab.path}
                onClick={() => navigate(tab.path)}
                className={cn(
                  'flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors',
                  active
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/30'
                )}
              >
                <Icon className="h-4 w-4" />
                {tab.label}
              </button>
            );
          })}
        </nav>
      </div>
    </div>
  );
};

export default CMSTabNavigation;
