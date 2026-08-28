import { useEffect, useMemo, useRef, useState } from 'react';
import { ko } from 'date-fns/locale';
import type { DayContentProps } from 'react-day-picker';
import { Calendar } from '@shared/ui/calendar';
import { Button } from '@shared/ui/button';
import { CalendarDays, X } from 'lucide-react';
import { parseDate, toDateStr, formatWithWeekday } from '@shared/lib/reviewSchedule';

/**
 * 첫 오답일 선택 — 달력에서 고른다.
 *
 * 처음엔 날짜 목록 select 였는데, 수업이 쌓이면 항목이 계속 늘어 한눈에 안 들어온다.
 * 달력은 항목 수와 무관하게 크기가 일정하고, "몇 월 며칠 수업" 을 그대로 짚을 수 있다.
 *
 * ⚠️ Radix Popover 금지(dev-rules) — 순수 HTML 팝오버로 띄운다.
 * 오답이 **하나도 없는 날은 못 고른다**(`disabled`). 고를 수 있는 날엔 문제 수를 같이 찍어
 * 그 수업에서 몇 개가 틀렸는지 달력에서 바로 보이게 한다.
 */
interface Props {
  /** 'all' | 'YYYY-MM-DD' */
  value: string;
  onChange: (value: string) => void;
  /** [날짜, 문제 수] — 최신순 */
  days: [string, number][];
  /** 'YYYY-MM-DD' */
  today: string;
  /** 전체를 골랐을 때 보여줄 총 문제 수 */
  totalCount: number;
}

const startOfMonth = (dateStr: string) => {
  const d = parseDate(dateStr);
  return new Date(d.getFullYear(), d.getMonth(), 1);
};

const FirstWrongDayPicker = ({ value, onChange, days, today, totalCount }: Props) => {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const counts = useMemo(() => new Map(days), [days]);
  const selectedCount = value === 'all' ? null : counts.get(value) ?? 0;

  // 달력이 처음 보여줄 달: 고른 날 → 없으면 가장 최근 오답이 난 달
  const anchorMonth = useMemo(() => {
    if (value !== 'all') return startOfMonth(value);
    if (days.length) return startOfMonth(days[0][0]);
    return new Date();
  }, [value, days]);

  const [month, setMonth] = useState<Date>(anchorMonth);
  // 열 때마다 기준 달로 되돌린다 — 지난번에 넘겨 둔 달이 남아 있으면 헷갈린다
  useEffect(() => {
    if (open) setMonth(anchorMonth);
  }, [open, anchorMonth]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // 오답이 있는 달 밖으로는 넘기지 못하게 한다(빈 달을 헤매지 않게)
  const fromMonth = days.length ? startOfMonth(days[days.length - 1][0]) : undefined;
  const toMonth = days.length ? startOfMonth(days[0][0]) : undefined;

  const pick = (next: string) => { onChange(next); setOpen(false); };

  const DayCell = ({ date }: DayContentProps) => {
    const n = counts.get(toDateStr(date));
    return (
      <span className="flex flex-col items-center justify-center leading-none">
        <span className="text-[13px]">{date.getDate()}</span>
        {n ? <span className="mt-0.5 text-[9px] font-semibold opacity-70">{n}</span> : null}
      </span>
    );
  };

  const label = value === 'all'
    ? `전체 (${totalCount}문제)`
    : `${value === today ? '오늘 ' : ''}${formatWithWeekday(value)} · ${selectedCount}문제`;

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex h-9 items-center gap-2 rounded-md border border-input bg-background px-3 text-sm ${
          value !== 'all' ? 'border-primary text-primary font-medium' : ''
        }`}
      >
        <CalendarDays className="h-4 w-4 opacity-70" />
        {label}
      </button>

      {value !== 'all' && (
        <button
          type="button"
          onClick={() => onChange('all')}
          title="날짜 선택 해제"
          className="absolute -right-1 -top-1 rounded-full border bg-background p-0.5 text-muted-foreground hover:text-foreground"
        >
          <X className="h-3 w-3" />
        </button>
      )}

      {open && (
        <>
          {/* 바깥을 누르면 닫힌다. Portal 이 아니라 같은 트리의 형제다(dev-rules) */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-50 mt-1 rounded-md border bg-popover shadow-lg">
            {days.length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted-foreground">이 기간에 오답이 없습니다</p>
            ) : (
              <Calendar
                mode="single"
                locale={ko}
                // ko 로케일 기본값은 '8월 2026' 이라 어순이 어색하다
                formatters={{ formatCaption: (d) => `${d.getFullYear()}년 ${d.getMonth() + 1}월` }}
                showOutsideDays={false}
                month={month}
                onMonthChange={setMonth}
                fromMonth={fromMonth}
                toMonth={toMonth}
                selected={value === 'all' ? undefined : parseDate(value)}
                onSelect={(d) => { if (d) pick(toDateStr(d)); }}
                disabled={(d) => !counts.has(toDateStr(d))}
                components={{ DayContent: DayCell }}
              />
            )}
            <div className="flex items-center justify-between gap-2 border-t px-3 py-2">
              <span className="text-xs text-muted-foreground">
                오답이 있는 날 {days.length}일
              </span>
              <div className="flex gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  disabled={!counts.has(today)}
                  onClick={() => pick(today)}
                >
                  오늘
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => pick('all')}
                >
                  전체 보기
                </Button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default FirstWrongDayPicker;
