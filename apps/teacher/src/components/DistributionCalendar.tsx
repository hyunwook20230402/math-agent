import { useRef, useState, useEffect } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@shared/ui/button';
import { styleOfDistribution, ORIGIN_STYLE, REVIEW_KIND_STYLE } from '@shared/lib/reviewSchedule';

// 달력 셀에 표시할 배포 정보 (경량)
export interface DistributionByDate {
  distribution_id: string;
  title: string;
  distribution_date: string; // ISO
  /** NULL=원본(처음 푸는 문제). 나머지는 복습 — 색이 갈린다(빨/주/노). */
  review_kind?: string | null;
}

/** 겹침 요약 점의 순서. 원본 → 다음 수업(빨) → 2주(주) → 4주(노) → 보충 */
const DOT_ORDER: (string | null)[] = [null, 'next_class', 'week2', 'week4', 'makeup'];
const dotClassOf = (kind: string | null) =>
  kind === null ? ORIGIN_STYLE.dot : REVIEW_KIND_STYLE[kind as keyof typeof REVIEW_KIND_STYLE]?.dot;

interface DistributionCalendarProps {
  selectedDate: string; // "YYYY-MM-DD"
  onSelectDate: (date: string) => void;
  distributions: DistributionByDate[]; // 현재 표시 중인 달의 배포 목록
  currentMonth: { year: number; month: number }; // month: 1~12
  onMonthChange: (year: number, month: number) => void;
  loading?: boolean;
  /** 배포를 다른 날짜로 옮긴다. 없으면 드래그 비활성. */
  onMoveDistribution?: (distributionId: string, newDate: string) => void;
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const DRAG_MIME = 'application/x-distribution-id';
/** 월 네비 버튼 위에 드래그한 채 머무르면 자동으로 달을 넘긴다. */
const HOVER_SWITCH_MS = 600;

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
  onMoveDistribution,
}: DistributionCalendarProps) => {
  const { year, month } = currentMonth; // month: 1~12
  const canDrag = !!onMoveDistribution;

  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 드래그가 끝나면 남아 있는 타이머를 정리한다(달이 혼자 넘어가는 것 방지)
  const clearHoverTimer = () => {
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  };
  useEffect(() => clearHoverTimer, []);

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

  // 6주 그리드. 앞뒤 빈 칸을 **이웃 달 날짜로 채운다** —
  // 8월 말 → 9월 초처럼 월 경계를 넘는 이동을 달을 넘기지 않고 바로 할 수 있다.
  const prevMonthDays = new Date(year, month - 1, 0).getDate();
  const prev = month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
  const next = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };

  type Cell = { day: number; key: string; outside: boolean };
  const cells: Cell[] = [];
  for (let i = firstWeekday - 1; i >= 0; i--) {
    const day = prevMonthDays - i;
    cells.push({ day, key: toDateKey(prev.year, prev.month, day), outside: true });
  }
  for (let day = 1; day <= daysInMonth; day++) {
    cells.push({ day, key: toDateKey(year, month, day), outside: false });
  }
  let nextDay = 1;
  while (cells.length % 7 !== 0) {
    cells.push({ day: nextDay, key: toDateKey(next.year, next.month, nextDay), outside: true });
    nextDay += 1;
  }

  const goPrev = () => onMonthChange(prev.year, prev.month);
  const goNext = () => onMonthChange(next.year, next.month);

  // 네비 버튼 위에 드래그한 채 머무르면 달을 넘긴다(먼 날짜로 옮길 때)
  const navDragOver = (e: React.DragEvent, go: () => void) => {
    if (!draggingId) return;
    e.preventDefault();
    if (hoverTimer.current) return;
    hoverTimer.current = setTimeout(() => {
      hoverTimer.current = null;
      go();
    }, HOVER_SWITCH_MS);
  };

  const handleDrop = (e: React.DragEvent, key: string) => {
    e.preventDefault();
    setDragOverKey(null);
    clearHoverTimer();
    const id = e.dataTransfer.getData(DRAG_MIME) || draggingId;
    setDraggingId(null);
    if (!id || !onMoveDistribution) return;
    // 같은 날짜면 아무것도 안 한다
    const current = distributions.find((d) => d.distribution_id === id);
    if (current && isoToDateKey(current.distribution_date) === key) return;
    onMoveDistribution(id, key);
  };

  return (
    <div className="select-none">
      {/* 헤더: 월 네비게이션 */}
      <div className="flex items-center justify-between mb-3">
        <Button
          variant="outline"
          size="icon"
          onClick={goPrev}
          aria-label="이전 달"
          onDragOver={(e) => navDragOver(e, goPrev)}
          onDragLeave={clearHoverTimer}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <div className="flex items-center gap-2">
          <span className="text-base font-semibold">{year}년 {month}월</span>
          {loading && (
            <span className="h-3 w-3 inline-block animate-spin rounded-full border-b-2 border-primary" />
          )}
        </div>
        <Button
          variant="outline"
          size="icon"
          onClick={goNext}
          aria-label="다음 달"
          onDragOver={(e) => navDragOver(e, goNext)}
          onDragLeave={clearHoverTimer}
        >
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
          const dists = byDate[cell.key] || [];
          const isSelected = cell.key === selectedDate;
          const isToday = cell.key === todayKey;
          const isDropTarget = dragOverKey === cell.key;
          const weekday = idx % 7;

          return (
            // button 이 아니라 div — 안에 draggable 칩이 들어가야 해서
            // (버튼 안에 인터랙티브 요소가 있으면 드래그와 클릭이 충돌한다)
            <div
              key={cell.key}
              role="button"
              tabIndex={0}
              onClick={() => onSelectDate(cell.key)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onSelectDate(cell.key); }}
              onDragOver={(e) => {
                if (!draggingId) return;
                e.preventDefault();
                setDragOverKey(cell.key);
              }}
              onDragLeave={() => setDragOverKey((k) => (k === cell.key ? null : k))}
              onDrop={(e) => handleDrop(e, cell.key)}
              className={`min-h-[132px] rounded-md border p-2 text-left flex flex-col transition-colors overflow-hidden cursor-pointer ${
                isDropTarget
                  ? 'border-primary ring-2 ring-primary bg-primary/10'
                  : isSelected
                    ? 'border-primary ring-1 ring-primary bg-primary/5'
                    : 'border-border hover:bg-muted/50'
              } ${cell.outside ? 'opacity-45' : ''}`}
            >
              {/* 날짜 숫자 + 겹침 요약 점.
                  점을 따로 찍는 이유: 칩이 넘쳐 '+N개' 가 되어도 **그날의 구성**
                  (원본+노랑+주황처럼)은 그대로 보여야 한다. 몇 달 지나면 한 날짜에
                  처음 푸는 문제와 2주·4주 전 오답이 겹친다. */}
              <div className="flex items-center gap-1 mb-1 shrink-0">
                <span
                  className={`text-xs font-medium flex items-center justify-center w-5 h-5 rounded-full shrink-0 ${
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
                <span className="flex items-center gap-0.5">
                  {DOT_ORDER.filter((k) => dists.some((d) => (d.review_kind ?? null) === k)).map((k) => (
                    <span key={k ?? 'origin'} className={`h-1.5 w-1.5 rounded-full ${dotClassOf(k)}`} />
                  ))}
                </span>
              </div>

              {/* 배포 메모: 최대 4개 + 초과분은 +N개. 드래그해서 다른 날로 옮긴다.
                  색은 종류별(원본 파랑 / 다음수업 빨 / 2주 주 / 4주 노) — 팔레트는
                  shared/lib/reviewSchedule.ts 한 곳에서만 정의한다. */}
              <div className="flex flex-col gap-0.5 min-w-0">
                {dists.slice(0, 4).map((d) => {
                  const style = styleOfDistribution(d.review_kind);
                  return (
                    <span
                      key={d.distribution_id}
                      title={canDrag ? `${style.label} — ${d.title} (끌어서 날짜 이동)` : `${style.label} — ${d.title}`}
                      draggable={canDrag}
                      onDragStart={(e) => {
                        if (!canDrag) return;
                        e.stopPropagation();
                        e.dataTransfer.setData(DRAG_MIME, d.distribution_id);
                        e.dataTransfer.effectAllowed = 'move';
                        setDraggingId(d.distribution_id);
                      }}
                      onDragEnd={() => { setDraggingId(null); setDragOverKey(null); clearHoverTimer(); }}
                      onClick={(e) => e.stopPropagation()}
                      className={`text-[11px] leading-tight truncate rounded px-1.5 py-0.5 ${style.chip} ${
                        canDrag ? 'cursor-grab active:cursor-grabbing' : ''
                      } ${draggingId === d.distribution_id ? 'opacity-40' : ''}`}
                    >
                      {d.title}
                    </span>
                  );
                })}
                {dists.length > 4 && (
                  <span className="text-[11px] leading-tight text-muted-foreground px-1">
                    +{dists.length - 4}개
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* 범례 — 빨/주/노가 무엇인지 화면에서 바로 읽히게 */}
      <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 mt-3 text-[11px] text-muted-foreground">
        {([[null, ORIGIN_STYLE.label], ...DOT_ORDER.slice(1).map((k) => [k, REVIEW_KIND_STYLE[k as keyof typeof REVIEW_KIND_STYLE].label])] as [string | null, string][])
          .map(([kind, label]) => (
            <span key={kind ?? 'origin'} className="flex items-center gap-1">
              <span className={`h-2 w-2 rounded-full ${dotClassOf(kind)}`} />
              {label}
            </span>
          ))}
      </div>

      {canDrag && (
        <p className="text-xs text-muted-foreground mt-2 text-center">
          과제를 끌어서 다른 날짜로 옮길 수 있습니다. 화살표 위에 잠시 머무르면 달이 넘어갑니다.
        </p>
      )}
    </div>
  );
};

export default DistributionCalendar;
