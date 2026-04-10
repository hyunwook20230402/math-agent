import { createContext, useContext, useEffect, useState } from 'react';
import { User, Session } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';
import { Profile } from '@/types/database';

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
    // Set up auth state listener
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        console.log('Auth state change:', event, session?.user?.email);
        setSession(session);
        setUser(session?.user ?? null);
        
        if (session?.user) {
          console.log('Fetching profile for user:', session.user.id);
          
          // 프로필 조회 (timeout 추가)
          console.log('Starting profile fetch for user_id:', session.user.id);
          
          const profilePromise = supabase
            .from('profiles')
            .select('*')
            .eq('user_id', session.user.id)
            .single();
          
          const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Profile fetch timeout after 5 seconds')), 5000)
          );
          
          const { data: profileData, error } = await Promise.race([profilePromise, timeoutPromise]) as any;
          console.log('Profile fetch completed:', { profileData, error });
          
          if (error) {
            console.error('Profile fetch error:', error);
            // 프로필이 없으면 임시 프로필로 로그인 허용
            const tempProfile: Profile = {
              id: session.user.id,
              user_id: session.user.id,
              name: session.user.user_metadata?.name || '사용자',
              role: session.user.user_metadata?.role || 'student',
              email: session.user.email || '',
              avatar_url: null,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            };
            setProfile(tempProfile);
          } else {
            console.log('Database profile found:', profileData);
            // 데이터베이스 프로필 사용
            const secureProfile: Profile = {
              id: profileData.id,
              user_id: profileData.user_id,
              name: profileData.name || session.user.user_metadata?.name || '사용자',
              role: profileData.role || session.user.user_metadata?.role || 'student',
              email: profileData.email || session.user.email || '',
              avatar_url: profileData.avatar_url || null,
              created_at: profileData.created_at || new Date().toISOString(),
              updated_at: profileData.updated_at || new Date().toISOString()
            };
            setProfile(secureProfile);
          }
          setLoading(false);
        } else {
          setProfile(null);
          setLoading(false);
        }
      }
    );

    // Check for existing session
    const initializeAuth = async () => {
      try {
        console.log('Initializing auth...');
        const { data: { session } } = await supabase.auth.getSession();
        console.log('Initial session:', session?.user?.email);
        setSession(session);
        setUser(session?.user ?? null);
        
        if (session?.user) {
          console.log('Initial session - Fetching profile for user:', session.user.id);
          
          // 프로필 조회 (timeout 추가)
          console.log('Initial - Starting profile fetch for user_id:', session.user.id);
          
          const profilePromise = supabase
            .from('profiles')
            .select('*')
            .eq('user_id', session.user.id)
            .single();
          
          const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Initial profile fetch timeout after 5 seconds')), 5000)
          );
          
          const { data: profileData, error } = await Promise.race([profilePromise, timeoutPromise]) as any;
          console.log('Initial - Profile fetch completed:', { profileData, error });
          
          if (error) {
            console.error('Initial profile fetch error:', error);
            // 프로필이 없으면 임시 프로필로 로그인 허용
            const tempProfile: Profile = {
              id: session.user.id,
              user_id: session.user.id,
              name: session.user.user_metadata?.name || '사용자',
              role: session.user.user_metadata?.role || 'student',
              email: session.user.email || '',
              avatar_url: null,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            };
            setProfile(tempProfile);
          } else {
            console.log('Initial - Database profile found:', profileData);
            // 데이터베이스 프로필 사용
            const secureProfile: Profile = {
              id: profileData.id,
              user_id: profileData.user_id,
              name: profileData.name || session.user.user_metadata?.name || '사용자',
              role: profileData.role || session.user.user_metadata?.role || 'student',
              email: profileData.email || session.user.email || '',
              avatar_url: profileData.avatar_url || null,
              created_at: profileData.created_at || new Date().toISOString(),
              updated_at: profileData.updated_at || new Date().toISOString()
            };
            setProfile(secureProfile);
          }
          setLoading(false);
        } else {
          console.log('No initial session found');
          setLoading(false);
        }
      } catch (error) {
        console.error('Auth initialization error:', error);
        setLoading(false);
      }
    };

    initializeAuth();

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