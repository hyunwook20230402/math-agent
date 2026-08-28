import { useAuth } from '@shared/hooks/useAuth';
import { Button } from '@shared/ui/button';
import { LogOut, User, Library } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@shared/ui/avatar';

// CMS 는 별개 앱(기본 8081). env 로 URL 분리, 없으면 개발 기본값.
const CMS_URL = import.meta.env.VITE_CMS_URL || 'http://localhost:8081/cms';

const Header = () => {
  const { profile, signOut } = useAuth();

  if (!profile) return null;

  return (
    <header className="border-b bg-card">
      <div className="container mx-auto px-4 py-3 flex items-center justify-between">
        <div className="flex items-center space-x-4">
          <h1 className="text-xl font-bold text-primary">학습 관리</h1>
          <span className="text-sm text-muted-foreground">
            {profile.role === 'teacher' ? '선생님' : '학생'} 모드
          </span>
        </div>

        <div className="flex items-center space-x-4">
          {profile.role === 'teacher' && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { window.location.href = CMS_URL; }}
            >
              <Library className="h-4 w-4 mr-2" />
              CMS
            </Button>
          )}

          <div className="flex items-center space-x-2">
            <Avatar className="h-8 w-8">
              <AvatarImage src={profile.avatar_url} />
              <AvatarFallback>
                <User className="h-4 w-4" />
              </AvatarFallback>
            </Avatar>
            <span className="text-sm font-medium">{profile.name}</span>
          </div>
          
          <Button variant="ghost" size="sm" onClick={signOut}>
            <LogOut className="h-4 w-4 mr-2" />
            로그아웃
          </Button>
        </div>
      </div>
    </header>
  );
};

export default Header;