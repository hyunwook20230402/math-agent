import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { CheckCircle, XCircle, Loader2 } from 'lucide-react';

const EmailConfirm = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [message, setMessage] = useState('');

  useEffect(() => {
    const confirmEmail = async () => {
      try {
        const token_hash = searchParams.get('token_hash');
        const type = searchParams.get('type');

        if (!token_hash || !type) {
          setStatus('error');
          setMessage('잘못된 확인 링크입니다.');
          return;
        }

        const { error } = await supabase.auth.verifyOtp({
          type: type as any,
          token_hash,
        });

        if (error) {
          setStatus('error');
          setMessage(error.message);
        } else {
          setStatus('success');
          setMessage('이메일이 성공적으로 확인되었습니다!');
          
          // 3초 후 메인 페이지로 리다이렉트
          setTimeout(() => {
            navigate('/');
          }, 3000);
        }
      } catch (error: any) {
        setStatus('error');
        setMessage(error.message || '이메일 확인 중 오류가 발생했습니다.');
      }
    };

    confirmEmail();
  }, [searchParams, navigate]);

  const getIcon = () => {
    switch (status) {
      case 'loading':
        return <Loader2 className="h-12 w-12 animate-spin text-blue-500" />;
      case 'success':
        return <CheckCircle className="h-12 w-12 text-green-500" />;
      case 'error':
        return <XCircle className="h-12 w-12 text-red-500" />;
    }
  };

  const getTitle = () => {
    switch (status) {
      case 'loading':
        return '이메일 확인 중...';
      case 'success':
        return '이메일 확인 완료!';
      case 'error':
        return '이메일 확인 실패';
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="flex justify-center mb-4">
            {getIcon()}
          </div>
          <CardTitle className="text-2xl">{getTitle()}</CardTitle>
          <CardDescription>
            {message}
          </CardDescription>
        </CardHeader>
        
        <CardContent className="text-center">
          {status === 'success' && (
            <p className="text-sm text-muted-foreground mb-4">
              3초 후 메인 페이지로 이동합니다...
            </p>
          )}
          
          <Button 
            onClick={() => navigate('/')} 
            className="w-full"
            variant={status === 'error' ? 'destructive' : 'default'}
          >
            메인 페이지로 이동
          </Button>
        </CardContent>
      </Card>
    </div>
  );
};

export default EmailConfirm;
