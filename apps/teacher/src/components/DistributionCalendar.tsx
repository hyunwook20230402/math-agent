import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@shared/ui/button';

// 달력 셀에 표시할 배포 정보 (경량)
export interface DistributionByDate {
  distribution_id: string;
  title: string;
  distribution_date: string; // ISO
}

interface DistributionCalendarProps {
  selectedDate: string; // "YYYY-MM-DD"
  onSelectDate: (date: string) => void;
  distributions: DistributionByDate[]; // 현재 표시 중인 달의 배포 목록
  currentMonth: { year: number; month: number }; // month: 1~12
  onMonthChange: (year: number, month: number) => void;
  loading?: boolean;
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

// Date → "YYYY-MM-DD" (로컬 기준, toISOString 의 UTC 오프셋 버그 회피)
const toDateKey = (year: number, month: number, day: number) => {
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
};

// ISO 문자열에서 로컬 날짜 키 추출
const isoToDateKey = (iso: string) => {
  const d = new Date(iso);
  return toDateKey(d.getFullYear(), d.getMonth() + 1, d.getDate());
};

const DistributionCalendar = ({
  selectedDate,
  onSelectDate,
  distributions,
  currentMonth,
  onMonthChange,
  loading = false,
}: DistributionCalendarProps) => {
  const { year, month } = currentMonth; // month: 1~12

  // 이번 달 1일의 요일(0=일)과 일수
  const firstWeekday = new Date(year, month - 1, 1).getDay();
  const daysInMonth = new Date(year, month, 0).getDate();

  const today = new Date();
  const todayKey = toDateKey(today.getFullYear(), today.getMonth() + 1, today.getDate());

  // 날짜키 → 그날 배포 목록 (셀 메모용)
  const byDate: Record<string, DistributionByDate[]> = {};
  for (const d of distributions) {
    const key = isoToDateKey(d.distribution_date);
    (byDate[key] ||= []).push(d);
  }

  // 6주(42칸) 그리드: 앞쪽 빈 칸 + 이번 달 날짜 + 뒤쪽 빈 칸
  const cells: Array<{ day: number | null; key: string | null }> = [];
  for (let i = 0; i < firstWeekday; i++) cells.push({ day: null, key: null });
  for (let day = 1; day <= daysInMonth; day++) {
    cells.push({ day, key: toDateKey(year, month, day) });
  }
  while (cells.length % 7 !== 0) cells.push({ day: null, key: null });

  const goPrev = () => {
    if (month === 1) onMonthChange(year - 1, 12);
    else onMonthChange(year, month - 1);
  };
  const goNext = () => {
    if (month === 12) onMonthChange(year + 1, 1);
    else onMonthChange(year, month + 1);
  };

  return (
    <div className="select-none">
      {/* 헤더: 월 네비게이션 */}
      <div className="flex items-center justify-between mb-3">
        <Button variant="outline" size="icon" onClick={goPrev} aria-label="이전 달">
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <div className="flex items-center gap-2">
          <span className="text-base font-semibold">{year}년 {month}월</span>
          {loading && (
            <span className="h-3 w-3 inline-block animate-spin rounded-full border-b-2 border-primary" />
          )}
        </div>
        <Button variant="outline" size="icon" onClick={goNext} aria-label="다음 달">
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>

      {/* 요일 헤더 */}
      <div className="grid grid-cols-7 mb-1">
        {WEEKDAYS.map((w, i) => (
          <div
            key={w}
            className={`text-center text-xs font-medium py-1 ${
              i === 0 ? 'text-red-500' : i === 6 ? 'text-blue-500' : 'text-muted-foreground'
            }`}
          >
            {w}
          </div>
        ))}
      </div>

      {/* 날짜 그리드 */}
      <div className="grid grid-cols-7 gap-1">
        {cells.map((cell, idx) => {
          if (cell.day === null || cell.key === null) {
            return <div key={`empty-${idx}`} className="min-h-[96px] rounded-md" />;
          }

          const dists = byDate[cell.key] || [];
          const isSelected = cell.key === selectedDate;
          const isToday = cell.key === todayKey;
          const weekday = idx % 7;

          return (
            <button
              type="button"
              key={cell.key}
              onClick={() => onSelectDate(cell.key as string)}
              className={`min-h-[96px] rounded-md border p-1.5 text-left flex flex-col transition-colors overflow-hidden ${
                isSelected
                  ? 'border-primary ring-1 ring-primary bg-primary/5'
                  : 'border-border hover:bg-muted/50'
              }`}
            >
              {/* 날짜 숫자 */}
              <span
                className={`text-xs font-medium mb-0.5 flex items-center justify-center w-5 h-5 rounded-full shrink-0 ${
                  isToday
                    ? 'bg-primary text-primary-foreground'
                    : weekday === 0
                      ? 'text-red-500'
                      : weekday === 6
                        ? 'text-blue-500'
                        : ''
                }`}
              >
                {cell.day}
              </span>

              {/* 배포 메모: 최대 2개 + 초과분은 +N개 */}
              <div className="flex flex-col gap-0.5 min-w-0">
                {dists.slice(0, 2).map((d) => (
                  <span
                    key={d.distribution_id}
                    title={d.title}
                    className="text-[10px] leading-tight truncate bg-primary/10 text-primary rounded px-1 py-0.5"
                  >
                    · {d.title}
                  </span>
                ))}
                {dists.length > 2 && (
                  <span className="text-[10px] leading-tight text-muted-foreground px-1">
                    +{dists.length - 2}개
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default DistributionCalendar;
