import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@shared/ui/card';
import { Progress } from '@shared/ui/progress';
import { AlertTriangle, CheckCircle } from 'lucide-react';
import type { WeaknessRow } from '@shared/lib/api';

interface WeaknessPanelProps {
  rows: WeaknessRow[];
  threshold: number;
}

// 난이도 영문 라벨 → 한글 표기
const DIFFICULTY_KO: Record<string, string> = {
  very_easy: '쉬움',
  easy: '보통',
  medium: '보통',
  hard: '어려움',
  very_hard: '최고난도',
  unknown: '미분류',
};

const DIMENSION_META: { key: WeaknessRow['dimension']; title: string }[] = [
  { key: 'unit', title: '단원' },
  { key: 'difficulty', title: '난이도' },
  { key: 'concept', title: '개념' },
  { key: 'skill', title: '스킬' },
];

export function WeaknessPanel({ rows, threshold }: WeaknessPanelProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 text-amber-500" />
          취약 영역
        </CardTitle>
        <CardDescription>
          정답률 {threshold}% 이하인 영역입니다 (최신 시도 기준)
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {rows.length === 0 ? (
          <div className="text-center py-6 text-muted-foreground">
            <CheckCircle className="h-12 w-12 mx-auto mb-3 text-green-500" />
            <p>취약 영역이 없습니다.</p>
            <p className="text-sm">아직 푼 문제가 없거나, 모든 영역이 기준 이상입니다.</p>
          </div>
        ) : (
          DIMENSION_META.map(({ key, title }) => {
            const items = rows
              .filter((r) => r.dimension === key)
              .sort((a, b) => a.accuracy - b.accuracy);
            if (items.length === 0) return null;
            return (
              <div key={key} className="space-y-2">
                <h4 className="text-sm font-semibold text-muted-foreground">{title}</h4>
                <div className="space-y-2">
                  {items.map((r) => (
                    <div key={`${key}-${r.label}`} className="space-y-1">
                      <div className="flex justify-between text-sm gap-2">
                        <span className="truncate">
                          {key === 'difficulty' ? (DIFFICULTY_KO[r.label] ?? r.label) : r.label}
                        </span>
                        <span className="flex-shrink-0 font-medium text-red-600">
                          {r.accuracy}% <span className="text-muted-foreground font-normal">({r.correct}/{r.total})</span>
                        </span>
                      </div>
                      <Progress value={r.accuracy} className="h-1.5" />
                    </div>
                  ))}
                </div>
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}

export default WeaknessPanel;
