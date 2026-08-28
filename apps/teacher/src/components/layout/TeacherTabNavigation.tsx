import { useNavigate, useLocation } from 'react-router-dom';
import { LayoutDashboard, Send, XCircle, FileText, CalendarCheck, MessageSquare } from 'lucide-react';
import { cn } from '@shared/lib/utils';

const tabs = [
  { path: '/teacher', label: '대시보드', icon: LayoutDashboard },
  { path: '/teacher/distribute', label: '배포하기', icon: Send },
  { path: '/teacher/wrong-answers', label: '오답 관리', icon: XCircle },
  { path: '/teacher/reports', label: '학습보고서', icon: FileText },
  { path: '/teacher/attendance', label: '출석', icon: CalendarCheck },
  { path: '/teacher/messages', label: '메시지', icon: MessageSquare },
];

const TeacherTabNavigation = () => {
  const navigate = useNavigate();
  const location = useLocation();

  const isActive = (path: string) => {
    if (path === '/teacher') {
      // 학생 등록/학생 상세는 대시보드 계열로 본다
      return (
        location.pathname === '/teacher' ||
        location.pathname.startsWith('/teacher/students') ||
        location.pathname.startsWith('/teacher/student/')
      );
    }
    return location.pathname.startsWith(path);
  };

  return (
    <div className="border-b bg-card">
      <div className="container mx-auto px-4">
        <nav className="flex space-x-1 overflow-x-auto">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const active = isActive(tab.path);
            return (
              <button
                key={tab.path}
                onClick={() => navigate(tab.path)}
                className={cn(
                  'flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap',
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

export default TeacherTabNavigation;
