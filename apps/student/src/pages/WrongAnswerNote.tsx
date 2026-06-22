import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@shared/ui/card';
import { Button } from '@shared/ui/button';
import { AlertCircle, ArrowLeft } from 'lucide-react';
import { useAuth } from '@shared/hooks/useAuth';
import { useNavigate, useParams } from 'react-router-dom';
import { useWrongAnswers } from '@/hooks/useWrongAnswers';
import { WrongAnswerList, type WrongAnswerFilter } from '@/components/WrongAnswerList';

const WrongAnswerNote = () => {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const { distributionId } = useParams<{ distributionId: string }>();
  const [tab, setTab] = useState<WrongAnswerFilter>('still_wrong');

  const { items, distributionInfo, loading, error } = useWrongAnswers(distributionId, profile?.id);

  const stillWrongCount = items.filter((i) => i.isStillWrong).length;
  const correctedCount = items.length - stillWrongCount;

  const tabs: { key: WrongAnswerFilter; label: string; count: number }[] = [
    { key: 'still_wrong', label: '아직 틀림', count: stillWrongCount },
    { key: 'corrected', label: '정정됨', count: correctedCount },
    { key: 'all', label: '전체', count: items.length },
  ];

  if (loading) {
    return (
      <div className="container mx-auto px-4 py-6">
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-6 space-y-6">
      <div className="flex items-center gap-4">
        <Button
          variant="ghost"
          onClick={() => navigate('/student/dashboard')}
          className="flex items-center gap-2"
        >
          <ArrowLeft className="h-4 w-4" />
          대시보드로 돌아가기
        </Button>
      </div>

      <div>
        <h1 className="text-3xl font-bold text-foreground">오답 분석</h1>
        <p className="text-muted-foreground">
          {distributionInfo
            ? `${distributionInfo.problemSetName} - ${distributionInfo.title}`
            : '로딩 중...'}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertCircle className="h-5 w-5" />
            첫 시도에서 틀린 문제들
          </CardTitle>
          <CardDescription>
            아직 틀림 = 마지막 시도도 틀린 문제 / 정정됨 = 다시 풀어 결국 맞힌 문제
          </CardDescription>
        </CardHeader>
        <CardContent>
          {error ? (
            <div className="text-center py-8 text-muted-foreground">{error}</div>
          ) : (
            <>
              <div className="flex flex-wrap gap-2 mb-4">
                {tabs.map((t) => (
                  <Button
                    key={t.key}
                    variant={tab === t.key ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setTab(t.key)}
                  >
                    {t.label} ({t.count})
                  </Button>
                ))}
              </div>

              <WrongAnswerList items={items} filter={tab} />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default WrongAnswerNote;
