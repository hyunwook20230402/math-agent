import { useState } from 'react';
import { Button } from '@shared/ui/button';
import { Input } from '@shared/ui/input';
import { Label } from '@shared/ui/label';
import { CalendarClock, X } from 'lucide-react';
import type { ReviewKind } from '@shared/lib/api';
import { REVIEW_STAGES, addDays, formatWithWeekday } from '@shared/lib/reviewSchedule';

// Radix Dialog 금지(dev-rules) — 순수 HTML/CSS 모달
interface Props {
  open: boolean;
  studentName: string;
  problemCount: number;
  saving: boolean;
  onClose: () => void;
  onConfirm: (params: { kinds: ReviewKind[]; baseDate: string }) => void;
}

const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const ALL_KINDS = REVIEW_STAGES.map((s) => s.kind);

const ReviewScheduleModal = ({ open, studentName, problemCount, saving, onClose, onConfirm }: Props) => {
  const [kinds, setKinds] = useState<ReviewKind[]>(ALL_KINDS);
  const [baseDate, setBaseDate] = useState(todayStr());

  if (!open) return null;

  const toggleKind = (k: ReviewKind) => {
    setKinds((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));
  };

  const selected = REVIEW_STAGES.filter((s) => kinds.includes(s.kind));

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/80" onClick={onClose} />
      <div className="relative z-[10000] bg-background border rounded-lg shadow-lg w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <CalendarClock className="h-5 w-5 text-primary" />
              오답 복습 예약
            </h2>
            <p className="text-sm text-muted-foreground mt-1">
              {studentName} · 선택한 오답 {problemCount}문제
            </p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>복습 단계</Label>
            <div className="grid grid-cols-2 gap-2">
              {REVIEW_STAGES.map((s) => {
                const on = kinds.includes(s.kind);
                return (
                  <button
                    key={s.kind}
                    type="button"
                    onClick={() => toggleKind(s.kind)}
                    className={`px-3 py-2 rounded-md border text-sm text-left transition-colors ${
                      on ? 'bg-primary text-primary-foreground border-primary' : 'bg-background hover:bg-muted'
                    }`}
                  >
                    <div className="font-medium">{s.label}</div>
                    <div className={`text-xs ${on ? 'opacity-80' : 'text-muted-foreground'}`}>{s.hint}</div>
                  </button>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">
              당일 시험지는 선생님이 직접 배포하고, 그 뒤 4번을 여기서 예약합니다.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="baseDate">기준일 (오답이 생긴 수업날)</Label>
            <Input id="baseDate" type="date" value={baseDate} onChange={(e) => setBaseDate(e.target.value)} />
          </div>

          {selected.length > 0 && (
            <div className="rounded-md border bg-muted/40 p-3 text-sm space-y-1">
              <p className="font-medium">예약될 날짜</p>
              <p className="text-xs text-muted-foreground">
                기준일 {formatWithWeekday(baseDate)} — 당일 시험지는 직접 배포
              </p>
              {selected.map((s) => (
                <p key={s.kind} className="text-muted-foreground">
                  · {s.label} — {formatWithWeekday(addDays(baseDate, s.offsetOf(baseDate)))}
                </p>
              ))}
              <p className="text-xs text-muted-foreground pt-1">
                예약된 시험지는 그 날짜가 되어야 학생 화면에 나타납니다.
                결석·보강으로 밀리면 예약 현황에서 날짜를 바꾸면 됩니다.
              </p>
            </div>
          )}
        </div>

        <div className="flex gap-2 pt-6">
          <Button
            className="flex-1"
            disabled={saving || kinds.length === 0 || problemCount === 0}
            onClick={() => onConfirm({ kinds, baseDate })}
          >
            {saving ? '예약 중...' : `${kinds.length}개 예약하기`}
          </Button>
          <Button variant="outline" onClick={onClose} disabled={saving}>취소</Button>
        </div>
      </div>
    </div>
  );
};

export default ReviewScheduleModal;
