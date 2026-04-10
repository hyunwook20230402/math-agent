import { createContext, useContext, useEffect, useState } from 'react';
import { User, Session } from '@supabase/supabase-js';
import { supabase } from '@shared/supabase/client';
import { Profile } from '@shared/types/database';

interface AuthContextType {
  user: User | null;
  session: Session | null;
  profile: Profile | null;
  loading: boolean;
  signUp: (email: string, password: string, name: string, role: 'teacher' | 'student') => Promise<{ error?: any }>;
  signIn: (email: string, password: string) => Promise<{ error?: any }>;
  resetPassword: (email: string) => Promise<{ error?: any }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let initialized = false;

    // 초기 세션 먼저 확인 후 리스너 등록
    supabase.auth.getSession().then(({ data: { session } }) => {
      initialized = true;
      setSession(session);
      setUser(session?.user ?? null);

      if (!session?.user) {
        setLoading(false);
        return;
      }

      supabase
        .from('profiles')
        .select('*')
        .eq('user_id', session.user.id)
        .single()
        .then(({ data: profileData, error }) => {
          if (error || !profileData) {
            setProfile({
              id: session.user.id,
              user_id: session.user.id,
              name: session.user.user_metadata?.name || '사용자',
              role: session.user.user_metadata?.role || 'student',
              email: session.user.email || '',
              avatar_url: null,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            });
          } else {
            setProfile({
              id: profileData.id,
              user_id: profileData.user_id,
              name: profileData.name || session.user.user_metadata?.name || '사용자',
              role: profileData.role || session.user.user_metadata?.role || 'student',
              email: profileData.email || session.user.email || '',
              avatar_url: profileData.avatar_url || null,
              created_at: profileData.created_at || new Date().toISOString(),
              updated_at: profileData.updated_at || new Date().toISOString()
            });
          }
          setLoading(false);
        });
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, session) => {
        // 초기 세션 처리 전에는 무시 (중복 방지)
        if (!initialized) return;

        setSession(session);
        setUser(session?.user ?? null);

        if (!session?.user) {
          setProfile(null);
          setLoading(false);
          return;
        }

        supabase
          .from('profiles')
          .select('*')
          .eq('user_id', session.user.id)
          .single()
          .then(({ data: profileData, error }) => {
            if (error || !profileData) {
              setProfile({
                id: session.user.id,
                user_id: session.user.id,
                name: session.user.user_metadata?.name || '사용자',
                role: session.user.user_metadata?.role || 'student',
                email: session.user.email || '',
                avatar_url: null,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
              });
            } else {
              setProfile({
                id: profileData.id,
                user_id: profileData.user_id,
                name: profileData.name || session.user.user_metadata?.name || '사용자',
                role: profileData.role || session.user.user_metadata?.role || 'student',
                email: profileData.email || session.user.email || '',
                avatar_url: profileData.avatar_url || null,
                created_at: profileData.created_at || new Date().toISOString(),
                updated_at: profileData.updated_at || new Date().toISOString()
              });
            }
            setLoading(false);
          });
      }
    );

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  const signUp = async (email: string, password: string, name: string, role: 'teacher' | 'student') => {
    const redirectUrl = `${window.location.origin}/`;
    
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: redirectUrl,
        data: {
          name,
          role
        }
      }
    });
    return { error };
  };

  // 로그인 이후 profiles 레코드가 없다면 자동 생성
  useEffect(() => {
    const ensureProfile = async () => {
      if (!user) return;
      const { data: existing } = await supabase
        .from('profiles')
        .select('id')
        .eq('user_id', user.id)
        .single();
      if (!existing) {
        const inferredRole = (user.user_metadata?.role as 'teacher' | 'student') || 'student';
        await supabase.from('profiles').insert({
          user_id: user.id,
          name: user.user_metadata?.name || '사용자',
          role: inferredRole,
          email: user.email || ''
        });
      }
    };
    ensureProfile();
  }, [user]);

  const signIn = async (email: string, password: string) => {
    try {
      console.log('로그인 시도:', email);
      
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      
      if (error) {
        console.error('로그인 오류:', error);
        return { error };
      }
      
      console.log('로그인 성공:', data.user?.email);
      return { error: null };
      
    } catch (error: any) {
      console.error('로그인 예외:', error);
      return { error };
    }
  };

  const resetPassword = async (email: string) => {
    try {
      // 네트워크 에러 시 임시 처리
      if (navigator.onLine === false) {
        console.log('오프라인 모드 - 비밀번호 재설정 불가');
        return { error: { message: '오프라인 모드에서는 비밀번호 재설정을 사용할 수 없습니다.' } };
      }
      
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/reset-password`,
      });
      return { error };
    } catch (error: any) {
      // 네트워크 에러 시 임시 처리
      if (error.message?.includes('Failed to fetch') || error.message?.includes('ERR_NAME_NOT_RESOLVED')) {
        return { error: { message: '네트워크 연결을 확인해주세요. Supabase 서버에 연결할 수 없습니다.' } };
      }
      return { error };
    }
  };

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  return (
    <AuthContext.Provider value={{
      user,
      session,
      profile,
      loading,
      signUp,
      signIn,
      resetPassword,
      signOut
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};