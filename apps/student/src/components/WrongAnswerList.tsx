import { Card, CardContent } from '@shared/ui/card';
import { Badge } from '@shared/ui/badge';
import { CheckCircle, XCircle } from 'lucide-react';
import type { WrongAnswerItem } from '@/hooks/useWrongAnswers';

export type WrongAnswerFilter = 'all' | 'still_wrong' | 'corrected';

interface WrongAnswerListProps {
  items: WrongAnswerItem[];
  filter: WrongAnswerFilter;
}

const EMPTY_MESSAGE: Record<WrongAnswerFilter, string> = {
  all: '첫 시도에서 틀린 문제가 없습니다!',
  still_wrong: '아직 못 푼 오답이 없습니다 — 결국 다 맞혔어요!',
  corrected: '정정한 오답이 아직 없습니다.',
};

export function WrongAnswerList({ items, filter }: WrongAnswerListProps) {
  const filtered = items.filter((item) => {
    if (filter === 'still_wrong') return item.isStillWrong;
    if (filter === 'corrected') return !item.isStillWrong;
    return true;
  });

  if (filtered.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        <CheckCircle className="h-12 w-12 mx-auto mb-4 text-green-500" />
        <p>{EMPTY_MESSAGE[filter]}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {filtered.map((item) => (
        <Card key={item.id}>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <h3 className="font-medium text-lg">{item.title}</h3>
              <Badge variant={item.isStillWrong ? 'destructive' : 'secondary'}>
                {item.attemptCount}회 시도
              </Badge>
              {item.isStillWrong ? (
                <Badge variant="outline" className="border-red-300 text-red-600">아직 틀림</Badge>
              ) : (
                <Badge variant="outline" className="border-green-300 text-green-600">✓ 정정됨</Badge>
              )}
            </div>

            <div className="space-y-2 text-sm">
              <div className="flex items-center gap-2">
                <XCircle className="h-4 w-4 text-red-500 flex-shrink-0" />
                <span className="text-muted-foreground">첫 시도 답안:</span>
                <span className="font-medium">{item.firstAnswer}</span>
              </div>

              {item.attemptCount > 1 && (
                <div className="flex items-center gap-2">
                  {item.isStillWrong ? (
                    <XCircle className="h-4 w-4 text-orange-500 flex-shrink-0" />
                  ) : (
                    <CheckCircle className="h-4 w-4 text-green-500 flex-shrink-0" />
                  )}
                  <span className="text-muted-foreground">마지막 시도 답안:</span>
                  <span className={`font-medium ${item.isStillWrong ? 'text-red-600' : 'text-green-600'}`}>
                    {item.lastAnswer}
                  </span>
                </div>
              )}

              <div className="flex items-center gap-2">
                <CheckCircle className="h-4 w-4 text-green-500 flex-shrink-0" />
                <span className="text-muted-foreground">정답:</span>
                <span className="font-medium">{item.correctAnswer}</span>
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export default WrongAnswerList;
