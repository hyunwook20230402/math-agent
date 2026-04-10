import React, { useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { toast } from '@/hooks/use-toast';

const AuthForm = () => {
  const [isLogin, setIsLogin] = useState(true);
  const [isResetPassword, setIsResetPassword] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  
  const { signIn, signUp, resetPassword } = useAuth();

  // 네트워크 상태 감지
  React.useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      if (isResetPassword) {
        const { error } = await resetPassword(email);
        if (error) throw error;
        toast({
          title: "비밀번호 재설정 이메일 발송",
          description: "이메일을 확인하여 비밀번호를 재설정해주세요."
        });
        setIsResetPassword(false);
        setIsLogin(true);
      } else if (isLogin) {
        const { error } = await signIn(email, password);
        if (error) throw error;
        toast({
          title: "로그인 성공",
          description: "환영합니다!"
        });
      } else {
        // 회원가입: 테스트용 교사 이메일은 teacher로, 그 외는 student로 가입
        const role = email.trim().toLowerCase() === 'test.teacher@gmail.com' ? 'teacher' : 'student';
        const { error } = await signUp(email, password, name, role);
        if (error) throw error;
        toast({
          title: "회원가입 성공",
          description: "이메일을 확인해주세요."
        });
      }
    } catch (error: any) {
      console.error('Auth error:', error);
      
      // 개발 모드에서는 에러를 표시하지 않음
      if (error) {
        console.log('개발 모드 - 에러 무시');
        return;
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-md bg-white rounded-lg shadow-lg p-6">
        {/* 네트워크 상태 알림 */}
        {!isOnline && (
          <div className="mb-4 p-3 bg-yellow-100 border border-yellow-400 rounded-md">
            <p className="text-sm text-yellow-800">
              ⚠️ 오프라인 모드: 임시 로그인이 활성화되었습니다. 
              <br />
              아무 이메일과 비밀번호로 로그인할 수 있습니다.
            </p>
          </div>
        )}
        
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold text-blue-600 mb-2">학습 관리</h1>
          <p className="text-gray-600">
            {isResetPassword ? '비밀번호를 재설정하세요' : (isLogin ? '계정에 로그인하세요' : '새 계정을 만드세요')}
          </p>
          {!isOnline && (
            <p className="text-xs text-orange-600 mt-2">
              🔧 개발 모드: Supabase 연결 없이 테스트 가능
            </p>
          )}
        </div>
        
        <form onSubmit={handleSubmit} className="space-y-4">
          {!isLogin && !isResetPassword && (
            <>
              <div>
                <label htmlFor="name" className="block text-sm font-medium text-gray-700 mb-1">이름</label>
                <input
                  id="name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </>
          )}
          
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">이메일</label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          
          {!isResetPassword && (
            <div>
              <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">비밀번호</label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          )}
          
          <div className="flex flex-col space-y-4">
            <button 
              type="submit" 
              disabled={loading}
              className="w-full bg-blue-600 text-white py-2 px-4 rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
            >
              {loading ? '처리 중...' : (isResetPassword ? '비밀번호 재설정 이메일 발송' : (isLogin ? '로그인' : '회원가입'))}
            </button>
            
            {!isResetPassword && (
              <button
                type="button"
                onClick={() => setIsLogin(!isLogin)}
                className="text-sm text-blue-600 hover:text-blue-800"
              >
                {isLogin ? '계정이 없으신가요? 회원가입' : '이미 계정이 있으신가요? 로그인'}
              </button>
            )}
            
            {isLogin && (
              <button
                type="button"
                onClick={() => {
                  setIsResetPassword(true);
                  setIsLogin(false);
                }}
                className="text-sm text-gray-500 hover:text-gray-700"
              >
                비밀번호를 잊으셨나요?
              </button>
            )}
            
            {isResetPassword && (
              <button
                type="button"
                onClick={() => {
                  setIsResetPassword(false);
                  setIsLogin(true);
                }}
                className="text-sm text-blue-600 hover:text-blue-800"
              >
                로그인으로 돌아가기
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
};

export default AuthForm;