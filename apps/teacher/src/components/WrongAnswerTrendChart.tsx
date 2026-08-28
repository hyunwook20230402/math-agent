import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
} from 'recharts';
import type { WrongTrendRow } from '@shared/lib/api';

// recharts 를 직접 쓴다. @shared/ui/chart 래퍼는 저장소에서 실사용이 없고
// config API 가 장황해 이득이 없다. recharts Tooltip 은 Portal 이 아니라
// 인라인 렌더라 dev-rules 의 Portal 금지 규칙과 무관하다.

const fmtWeek = (iso: string) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
};

const WrongAnswerTrendChart = ({ data }: { data: WrongTrendRow[] }) => {
  if (!data || data.length === 0) {
    return (
      <div className="h-[220px] flex items-center justify-center text-sm text-muted-foreground">
        표시할 학습 기록이 없습니다
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={220}>
      <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: -16 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis dataKey="bucket_start" tickFormatter={fmtWeek} fontSize={12} />
        <YAxis yAxisId="l" allowDecimals={false} fontSize={12} />
        <YAxis yAxisId="r" orientation="right" domain={[0, 100]} unit="%" fontSize={12} />
        <Tooltip
          labelFormatter={(v) => `${fmtWeek(String(v))} 주`}
          formatter={(value: any, name: any) => [name === '정답률' ? `${value}%` : value, name]}
        />
        <Legend />
        <Bar yAxisId="l" dataKey="wrong" name="오답 수" fill="hsl(var(--destructive))" radius={[3, 3, 0, 0]} />
        <Line yAxisId="r" dataKey="accuracy" name="정답률" stroke="hsl(var(--primary))" strokeWidth={2} dot />
      </ComposedChart>
    </ResponsiveContainer>
  );
};

export default WrongAnswerTrendChart;
