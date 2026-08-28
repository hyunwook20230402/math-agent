import { useState, useEffect, useMemo, useCallback } from 'react';
import { useAuth } from '@shared/hooks/useAuth';
import { Button } from '@shared/ui/button';
import { Input } from '@shared/ui/input';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@shared/ui/card';
import { Badge } from '@shared/ui/badge';
import { Checkbox } from '@shared/ui/checkbox';
import { toast } from '@shared/hooks/use-toast';
import {
  wrongAnswerReviewApi,
  REVIEW_KIND_LABEL,
  REVIEW_TARGET_ROUNDS,
  type WrongAnswerRow,
  type TeacherWrongCountRow,
  type ScheduledReviewRow,
  type MissingReviewBatch,
  type ReviewKind,
} from '@shared/lib/api';
import {
  buildReviewStages,
  buildReviewTimeline,
  nextPendingCell,
  toDateStr,
  addDays,
  formatWithWeekday,
  AUTO_REVIEW_KINDS,
  STAGE_LABELS,
  type TimelineCell,
} from '@shared/lib/reviewSchedule';
import { CalendarClock, Printer, Search, X, Trash2, AlertCircle, PlusCircle } from 'lucide-react';
import ReviewScheduleModal from '@/components/ReviewScheduleModal';
import FirstWrongDayPicker from '@/components/FirstWrongDayPicker';

const PRINT_LIMIT = 40;

type PeriodKey = '1m' | '3m' | '6m' | 'all' | 'custom';
type SortKey = 'label' | 'due' | 'recent' | 'count';

const periodLabels: Record<PeriodKey, string> = {
  '1m': '최근 1개월',
  '3m': '최근 3개월',
  '6m': '최근 6개월',
  all: '전체 기간',
  custom: '직접 지정',
};

const fmtDateTime = (iso: string | null) => {
  if (!iso) return '-';
  const d = new Date(iso);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const fmtDate = (iso: string | null) => {
  if (!iso) return '-';
  const d = new Date(iso);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
};

/** '8/28(금)' 표기는 shared 의 formatWithWeekday 하나로 쓴다(예전엔 여기 사본이 있었다) */
const fmtDayLabel = formatWithWeekday;

const monthsAgoIso = (months: number) => {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString();
};

// 회차 한 칸. 실제로 푼 날은 정답여부까지, 안 푼 회차는 예정일을 미리 보여준다.
const StageCell = ({ cell }: { cell: TimelineCell }) => {
  if (!cell.date) return <span className="text-muted-foreground">-</span>;
  const d = cell.date.slice(5).replace('-', '/');   // 'MM/DD'

  if (cell.state === 'done') {
    return (
      <span className={cell.isCorrect ? 'text-emerald-600' : 'text-rose-600'}>
        {d} {cell.isCorrect ? '✓' : '✗'}
      </span>
    );
  }
  if (cell.state === 'overdue') {
    // 예정일이 지났는데 아직 안 푼 것 — 결석·숙제 미이행으로 밀린 회차
    return <span className="text-rose-600 font-medium" title="예정일이 지났습니다">{d} !</span>;
  }
  if (cell.state === 'scheduled') {
    // 실제 예약된 배포가 있는 날 (선생님이 옮겼을 수도)
    return <span className="text-foreground" title="예약됨">{d}</span>;
  }
  return <span className="text-muted-foreground/60" title="예상">{d}</span>;
};

const WrongAnswerManagement = () => {
  const { profile } = useAuth();

  const [students, setStudents] = useState<TeacherWrongCountRow[]>([]);
  const [studentQuery, setStudentQuery] = useState('');
  const [selectedStudentId, setSelectedStudentId] = useState<string | null>(null);
  const [loadingStudents, setLoadingStudents] = useState(true);

  const [rows, setRows] = useState<WrongAnswerRow[]>([]);
  const [loadingRows, setLoadingRows] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const [period, setPeriod] = useState<PeriodKey>('3m');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  // 선생님이 실제로 찾는 건 "아직 5회를 못 채운 문제" 다 → 기본값
  const [statusFilter, setStatusFilter] = useState<'under' | 'all'>('under');
  // 다음 회차(아직 안 푼 첫 회차) 예정일 기준 — "오늘 뭘 내보내야 하나"를 바로 찾는다
  const [dueFilter, setDueFilter] = useState<'all' | 'today' | 'week' | 'overdue'>('all');
  // 첫 오답이 난 **날** 기준 — 오답이 쌓이면 목록이 길어져 하루치를 통째로 골라내야 한다
  const [firstWrongDay, setFirstWrongDay] = useState<string>('all');   // 'all' | 'YYYY-MM-DD'
  const [sortKey, setSortKey] = useState<SortKey>('label');   // 시험지를 만드니 번호순이 기본

  const [scheduled, setScheduled] = useState<ScheduledReviewRow[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [makeupOpen, setMakeupOpen] = useState(false);
  const [makeupDate, setMakeupDate] = useState(toDateStr(new Date()));
  const [saving, setSaving] = useState(false);
  const [detailRow, setDetailRow] = useState<WrongAnswerRow | null>(null);

  // 자동 생성이 못 돈 과제(학생 브라우저가 죽었거나 오프라인). 최근 2주만 본다 —
  // 기간을 안 자르면 이 기능 이전의 과거 배포가 통째로 잡혀 배너가 쓸모없어진다.
  const [missing, setMissing] = useState<MissingReviewBatch[]>([]);
  const [fixingMissing, setFixingMissing] = useState(false);

  const selectedStudent = students.find((s) => s.student_id === selectedStudentId) || null;

  // 좌측 학생 목록 (RPC 1회 — 학생마다 조회하면 N+1)
  useEffect(() => {
    if (!profile?.id) return;
    let alive = true;
    (async () => {
      setLoadingStudents(true);
      try {
        const data = await wrongAnswerReviewApi.getTeacherWrongCounts(profile.id);
        if (!alive) return;
        setStudents(data);
        setSelectedStudentId((prev) => prev ?? (data[0]?.student_id || null));
      } catch (error: any) {
        toast({ title: '학생 목록 오류', description: error.message, variant: 'destructive' });
      } finally {
        if (alive) setLoadingStudents(false);
      }
    })();
    return () => { alive = false; };
  }, [profile?.id]);

  const loadRows = useCallback(async () => {
    if (!selectedStudentId) {
      setRows([]);
      return;
    }
    setLoadingRows(true);
    try {
      let from: string | null = null;
      let to: string | null = null;
      if (period === '1m') from = monthsAgoIso(1);
      else if (period === '3m') from = monthsAgoIso(3);
      else if (period === '6m') from = monthsAgoIso(6);
      else if (period === 'custom') {
        from = customFrom ? new Date(`${customFrom}T00:00:00`).toISOString() : null;
        // to 는 그날 끝까지 포함 (RPC 는 < to 비교)
        to = customTo ? new Date(`${customTo}T23:59:59`).toISOString() : null;
      }

      const [data, sched] = await Promise.all([
        wrongAnswerReviewApi.getStudentWrongAnswers(selectedStudentId, { from, to }),
        wrongAnswerReviewApi.getScheduledReviews(selectedStudentId),
      ]);
      setRows(data);
      setScheduled(sched);
      setSelectedIds(new Set());
    } catch (error: any) {
      toast({ title: '오답 조회 오류', description: error.message, variant: 'destructive' });
      setRows([]);
    } finally {
      setLoadingRows(false);
    }
  }, [selectedStudentId, period, customFrom, customTo]);

  useEffect(() => { loadRows(); }, [loadRows]);

  const today = toDateStr(new Date());
  const weekEnd = addDays(today, 7);

  // 회차 타임라인은 한 번만 계산해 행에 붙여 둔다(정렬·필터·렌더가 같이 쓴다)
  const timelineRows = useMemo(
    () => rows.map((r) => {
      const cells = buildReviewTimeline(r.attempt_dates, r.attempt_results, r.scheduled, today);
      return { row: r, cells, next: nextPendingCell(cells) };
    }),
    [rows, today]
  );

  /**
   * 첫 오답이 난 날짜 목록(최신순) + 그날의 문제 수.
   * 자유 입력 date 대신 **실제로 오답이 있는 날만** 고르게 한다 — 수업일을 기억할
   * 필요가 없고, 빈 날을 골라 0건이 되는 일도 없다.
   */
  const firstWrongDays = useMemo(() => {
    const counts = new Map<string, number>();
    timelineRows.forEach((t) => {
      if (!t.row.first_wrong_at) return;
      const d = toDateStr(new Date(t.row.first_wrong_at));
      counts.set(d, (counts.get(d) ?? 0) + 1);
    });
    return [...counts.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [timelineRows]);

  // 기간을 바꾸거나 학생을 옮기면 고른 날짜가 목록에서 사라질 수 있다 → 되돌린다
  useEffect(() => {
    if (firstWrongDay !== 'all' && !firstWrongDays.some(([d]) => d === firstWrongDay)) {
      setFirstWrongDay('all');
    }
  }, [firstWrongDays, firstWrongDay]);

  const visibleRows = useMemo(() => {
    // 필터는 프론트에서 — 재조회 없이 즉시 전환
    let filtered = statusFilter === 'under'
      ? timelineRows.filter((t) => t.row.total_attempts < REVIEW_TARGET_ROUNDS)
      : timelineRows;

    if (firstWrongDay !== 'all') {
      filtered = filtered.filter(
        (t) => t.row.first_wrong_at && toDateStr(new Date(t.row.first_wrong_at)) === firstWrongDay,
      );
    }

    if (dueFilter !== 'all') {
      filtered = filtered.filter((t) => {
        const d = t.next?.date;
        if (!d) return false;                       // 5회 다 채운 문제
        // 누적 의미: 밀린 것도 "오늘 내보낼 것"에 포함된다(어제 못 나갔으면 오늘 나가야 한다).
        if (dueFilter === 'today') return d <= today;
        if (dueFilter === 'week') return d <= weekEnd;
        return d < today;                            // overdue = 예정일이 이미 지난 것
      });
    }

    const sorted = [...filtered];
    // 번호순: 쎈 "0320" 과 내신 "18" 이 섞여도 숫자로 비교되게 numeric 옵션 사용
    type T = typeof sorted[number];
    const byLabel = (a: T, b: T) =>
      (a.row.source_label || String(a.row.problem_number)).localeCompare(
        b.row.source_label || String(b.row.problem_number), undefined, { numeric: true });

    if (sortKey === 'recent') sorted.sort((a, b) => new Date(b.row.last_wrong_at).getTime() - new Date(a.row.last_wrong_at).getTime());
    else if (sortKey === 'count') sorted.sort((a, b) => b.row.wrong_count - a.row.wrong_count || byLabel(a, b));
    else if (sortKey === 'due') sorted.sort((a, b) => (a.next?.date ?? '9999').localeCompare(b.next?.date ?? '9999') || byLabel(a, b));
    else sorted.sort(byLabel);
    return sorted;
  }, [timelineRows, statusFilter, dueFilter, firstWrongDay, sortKey, today, weekEnd]);

  // 필터로 0건이 됐을 때 "그럼 언제 나가나"를 알려주기 위한 값
  const earliestDue = useMemo(() => {
    const dates = timelineRows
      .filter((t) => t.row.total_attempts < REVIEW_TARGET_ROUNDS)
      .map((t) => t.next?.date)
      .filter(Boolean) as string[];
    return dates.length ? dates.sort()[0] : null;
  }, [timelineRows]);

  const filteredStudents = useMemo(() => {
    const q = studentQuery.trim();
    if (!q) return students;
    return students.filter((s) => s.student_name?.includes(q));
  }, [students, studentQuery]);

  const allVisibleChecked = visibleRows.length > 0 && visibleRows.every((t) => selectedIds.has(t.row.problem_id));

  const toggleAll = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleChecked) visibleRows.forEach((t) => next.delete(t.row.problem_id));
      else visibleRows.forEach((t) => next.add(t.row.problem_id));
      return next;
    });
  };

  const toggleOne = (problemId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(problemId)) next.delete(problemId);
      else next.add(problemId);
      return next;
    });
  };

  const selectedRows = visibleRows.filter((t) => selectedIds.has(t.row.problem_id)).map((t) => t.row);

  const handleReserve = async ({ kinds, baseDate }: { kinds: ReviewKind[]; baseDate: string }) => {
    if (!profile?.id || !selectedStudent) return;
    setSaving(true);
    try {
      // 선택한 오답이 전부 한 배포에서 나온 경우에만 계보를 남긴다(거짓 계보 방지)
      const originIds = Array.from(new Set(selectedRows.map((r) => r.origin_distribution_id).filter(Boolean)));
      const parentId = originIds.length === 1 ? (originIds[0] as string) : null;

      const created = await wrongAnswerReviewApi.createReviewReservations({
        teacherId: profile.id,
        studentId: selectedStudent.student_id,
        studentName: selectedStudent.student_name,
        problemIds: selectedRows.map((r) => r.problem_id),
        stages: buildReviewStages(baseDate, kinds),
        parentDistributionId: parentId,
      });

      toast({
        title: '복습 예약 완료',
        description: `${created.length}개의 오답 시험지가 예약되었습니다.`,
      });
      setModalOpen(false);
      setSelectedIds(new Set());
      const sched = await wrongAnswerReviewApi.getScheduledReviews(selectedStudent.student_id);
      setScheduled(sched);
    } catch (error: any) {
      toast({ title: '예약 실패', description: error.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  // 보충 배포 — 결석·보강·숙제 미이행으로 빈 회차를 아무 날짜로나 메운다.
  // 예약 4건과 별개라 몇 번이든 낼 수 있다.
  const handleMakeup = async () => {
    if (!profile?.id || !selectedStudent) return;
    setSaving(true);
    try {
      // 예약과 같은 규칙 — 선택한 오답이 전부 한 배포 출신일 때만 계보를 남긴다.
      // 계보가 있어야 제목이 `[복습 보충] 쎈… > 나머지정리와 인수분해 (N문제)` 로 찍힌다(038).
      const originIds = Array.from(new Set(selectedRows.map((r) => r.origin_distribution_id).filter(Boolean)));
      const created = await wrongAnswerReviewApi.createReviewReservations({
        teacherId: profile.id,
        studentId: selectedStudent.student_id,
        studentName: selectedStudent.student_name,
        problemIds: selectedRows.map((r) => r.problem_id),
        stages: [{ stage: 5, kind: 'makeup', label: '보충', date: makeupDate }],
        parentDistributionId: originIds.length === 1 ? (originIds[0] as string) : null,
      });
      toast({
        title: '보충 배포 완료',
        description: `${makeupDate} 에 오답 ${selectedRows.length}문제가 배포됩니다.`,
      });
      setMakeupOpen(false);
      setSelectedIds(new Set());
      const sched = await wrongAnswerReviewApi.getScheduledReviews(selectedStudent.student_id);
      setScheduled(sched);
      void created;
    } catch (error: any) {
      toast({ title: '보충 배포 실패', description: error.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  // 예약 날짜 이동 — 보강일이 잡히면 밀린 복습을 그 날짜로 옮긴다
  const handleReschedule = async (distributionId: string, newDate: string) => {
    const before = scheduled;
    setScheduled((prev) =>
      prev.map((x) =>
        x.distribution_id === distributionId
          ? { ...x, distribution_date: `${newDate}T${new Date(x.distribution_date).toTimeString().slice(0, 8)}` }
          : x
      )
    );
    try {
      await wrongAnswerReviewApi.rescheduleReview(distributionId, newDate);
      toast({ title: '날짜 변경', description: `${newDate} 로 옮겼습니다.` });
    } catch (error: any) {
      setScheduled(before);
      toast({ title: '변경 실패', description: error.message, variant: 'destructive' });
    }
  };

  /** 안전망 목록 새로고침. 조회 실패는 조용히 넘긴다(배너가 없을 뿐 본업은 멀쩡하다). */
  const reloadMissing = useCallback(async () => {
    if (!profile?.id) return;
    try {
      setMissing(await wrongAnswerReviewApi.findMissingReviewBatches(profile.id, 14));
    } catch (error) {
      console.warn('복습 누락 조회 실패:', error);
    }
  }, [profile?.id]);

  useEffect(() => { reloadMissing(); }, [reloadMissing]);

  /**
   * 놓친 복습 배포를 만든다. 기준일은 **그 학생이 그 과제를 처음 푼 날** —
   * 오늘로 잡으면 며칠 지난 과제의 회차가 통째로 뒤로 밀린다.
   */
  const handleFixMissing = async () => {
    setFixingMissing(true);
    let made = 0;
    const failed: string[] = [];
    for (const m of missing) {
      try {
        const base = toDateStr(new Date(m.first_attempt_at));
        const created = await wrongAnswerReviewApi.autoCreateReviews({
          distributionId: m.distribution_id,
          studentId: m.student_id,
          stages: buildReviewStages(base, AUTO_REVIEW_KINDS),
        });
        made += created.length;
      } catch (error: any) {
        failed.push(`${m.student_name}: ${error.message}`);
      }
    }
    setFixingMissing(false);
    toast({
      title: failed.length ? '일부만 만들어졌습니다' : '복습 시험지 생성 완료',
      description: failed.length
        ? `${made}개 생성 · 실패 ${failed.length}건 — ${failed[0]}`
        : `${made}개의 복습 시험지가 만들어졌습니다.`,
      variant: failed.length ? 'destructive' : undefined,
    });
    await reloadMissing();
    if (selectedStudentId) {
      try {
        setScheduled(await wrongAnswerReviewApi.getScheduledReviews(selectedStudentId));
      } catch { /* 예약 현황 갱신 실패는 넘어간다 */ }
    }
  };

  const handleCancelReview = async (distributionId: string) => {
    try {
      await wrongAnswerReviewApi.cancelReview(distributionId);
      setScheduled((prev) => prev.filter((s) => s.distribution_id !== distributionId));
      toast({ title: '예약 취소', description: '복습 예약이 취소되었습니다.' });
    } catch (error: any) {
      toast({ title: '취소 실패', description: error.message, variant: 'destructive' });
    }
  };

  const handlePrint = () => {
    if (!selectedStudent || selectedRows.length === 0) return;
    if (selectedRows.length > PRINT_LIMIT) {
      toast({
        title: '문제가 너무 많습니다',
        description: `한 번에 ${PRINT_LIMIT}문제까지 인쇄할 수 있습니다.`,
        variant: 'destructive',
      });
      return;
    }
    const params = new URLSearchParams({
      student: selectedStudent.student_id,
      problems: selectedRows.map((r) => r.problem_id).join(','),
      title: `${selectedStudent.student_name} 오답 시험지`,
    });
    window.open(`/teacher/print/wrong-answers?${params.toString()}`, '_blank');
  };

  return (
    <div className="container mx-auto px-4 py-6 pb-28">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">오답 관리</h1>
        <p className="text-muted-foreground">
          학생이 과제를 다 풀면 복습 시험지 3개(다음 수업·2주·4주)가 자동으로 만들어집니다
        </p>
      </div>

      {/* 안전망 — 학생 브라우저가 죽거나 오프라인이면 자동 생성이 안 돈다.
          몰래 만들지 않고 여기 보여준 뒤 누르게 한다(모르는 사이 학생 화면에 과제가 뜨면 안 된다). */}
      {missing.length > 0 && (
        <Card className="mb-6 border-amber-300 bg-amber-50/60">
          <CardContent className="py-4">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <AlertCircle className="h-5 w-5 text-amber-600 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-amber-900">
                  복습 시험지가 안 만들어진 과제 {missing.length}건
                </p>
                <p className="text-xs text-amber-800 mt-0.5 truncate">
                  {missing.slice(0, 3).map((m) => `${m.student_name} · ${m.distribution_title} (오답 ${m.wrong_count})`).join(' / ')}
                  {missing.length > 3 ? ` 외 ${missing.length - 3}건` : ''}
                </p>
              </div>
              <Button size="sm" disabled={fixingMissing} onClick={handleFixMissing}>
                {fixingMissing ? '만드는 중...' : `${missing.length}건 만들기`}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex flex-col lg:flex-row gap-6">
        {/* 좌측: 학생 목록 */}
        <aside className="lg:w-80 shrink-0">
          <Card className="lg:sticky lg:top-4">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">학생</CardTitle>
              <CardDescription>{REVIEW_TARGET_ROUNDS}회를 못 채운 문제가 많은 순</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="relative">
                <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  className="pl-8"
                  placeholder="학생 검색"
                  value={studentQuery}
                  onChange={(e) => setStudentQuery(e.target.value)}
                />
              </div>

              {loadingStudents ? (
                <div className="py-8 text-center text-sm text-muted-foreground">불러오는 중...</div>
              ) : filteredStudents.length === 0 ? (
                <div className="py-8 text-center text-sm text-muted-foreground">등록된 학생이 없습니다</div>
              ) : (
                <div className="space-y-1 max-h-[60vh] overflow-y-auto">
                  {filteredStudents.map((s) => {
                    const active = s.student_id === selectedStudentId;
                    return (
                      <button
                        key={s.student_id}
                        onClick={() => setSelectedStudentId(s.student_id)}
                        className={`w-full text-left px-3 py-2 rounded-md border transition-colors ${
                          active ? 'border-primary bg-primary/5' : 'border-transparent hover:bg-muted'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-medium text-sm">{s.student_name}</span>
                          <span className="text-xs text-primary font-medium">
                            {REVIEW_TARGET_ROUNDS}회 미달 {s.under_target}
                          </span>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          누적 {s.wrong_problems}문제 · 미해결 {s.still_wrong} · 최근 {fmtDate(s.last_wrong_at)}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </aside>

        {/* 우측: 오답 표 */}
        <main className="flex-1 min-w-0 space-y-6">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">
                {selectedStudent ? `${selectedStudent.student_name} 오답 목록` : '오답 목록'}
              </CardTitle>
              <CardDescription>
                오답이 언제 처음 생겼는지, 몇 번 틀렸는지, 지금도 틀린 상태인지 확인합니다
              </CardDescription>
            </CardHeader>
            <CardContent>
              {/* 필터 바 — Radix Select 금지(dev-rules), native select 사용 */}
              <div className="flex flex-wrap items-end gap-3 mb-4 pb-4 border-b">
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">기간</label>
                  <select
                    value={period}
                    onChange={(e) => setPeriod(e.target.value as PeriodKey)}
                    className="block h-9 px-3 rounded-md border border-input bg-background text-sm"
                  >
                    {(Object.keys(periodLabels) as PeriodKey[]).map((k) => (
                      <option key={k} value={k}>{periodLabels[k]}</option>
                    ))}
                  </select>
                </div>

                {period === 'custom' && (
                  <>
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground">시작</label>
                      <Input type="date" className="h-9 w-40" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground">끝</label>
                      <Input type="date" className="h-9 w-40" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
                    </div>
                  </>
                )}

                {/* 첫 오답일 — "그날 수업에서 틀린 것만" 통째로 골라낸다.
                    수업이 쌓이면 날짜가 계속 늘어 목록으로는 못 보므로 달력에서 짚는다. */}
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">첫 오답일</label>
                  <FirstWrongDayPicker
                    value={firstWrongDay}
                    onChange={setFirstWrongDay}
                    days={firstWrongDays}
                    today={today}
                    totalCount={timelineRows.length}
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">상태</label>
                  <div className="flex">
                    {([
                      ['under', `${REVIEW_TARGET_ROUNDS}회 미달`],
                      ['all', '전체'],
                    ] as const).map(([key, label], i, arr) => (
                      <button
                        key={key}
                        onClick={() => setStatusFilter(key)}
                        className={`h-9 px-3 text-sm border ${i === 0 ? 'rounded-l-md' : i === arr.length - 1 ? 'rounded-r-md border-l-0' : 'border-l-0'} ${
                          statusFilter === key ? 'bg-primary text-primary-foreground border-primary' : 'bg-background'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">다음 회차 예정일</label>
                  <div className="flex">
                    {([
                      ['all', '전체'],
                      ['today', '오늘까지'],
                      ['week', '이번 주'],
                      ['overdue', '밀림'],
                    ] as const).map(([key, label], i, arr) => (
                      <button
                        key={key}
                        onClick={() => setDueFilter(key)}
                        className={`h-9 px-3 text-sm border ${i === 0 ? 'rounded-l-md' : i === arr.length - 1 ? 'rounded-r-md border-l-0' : 'border-l-0'} ${
                          dueFilter === key
                            ? key === 'overdue'
                              ? 'bg-rose-600 text-white border-rose-600'
                              : 'bg-primary text-primary-foreground border-primary'
                            : 'bg-background'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">정렬</label>
                  <select
                    value={sortKey}
                    onChange={(e) => setSortKey(e.target.value as SortKey)}
                    className="block h-9 px-3 rounded-md border border-input bg-background text-sm"
                  >
                    <option value="label">번호순</option>
                    <option value="due">다음 예정일순</option>
                    <option value="recent">최근 오답순</option>
                    <option value="count">오답 많은 순</option>
                  </select>
                </div>

                <div className="ml-auto text-sm text-muted-foreground">
                  {visibleRows.length}문제 · 선택 {selectedIds.size}
                </div>
              </div>

              {loadingRows ? (
                <div className="py-16 text-center text-sm text-muted-foreground">불러오는 중...</div>
              ) : visibleRows.length === 0 ? (
                <div className="py-16 text-center text-sm text-muted-foreground">
                  <AlertCircle className="h-10 w-10 mx-auto mb-3 opacity-40" />
                  {/* 필터 때문에 0건인 경우, 왜 0건인지 알려주지 않으면
                      "오늘 오답인데 왜 안 보이지?" 로 오해한다. 가장 이른 예정일을 함께 보여준다. */}
                  {timelineRows.length > 0 && (dueFilter !== 'all' || firstWrongDay !== 'all') ? (
                    <>
                      {firstWrongDay !== 'all' && (
                        <p>{fmtDayLabel(firstWrongDay)} 에 처음 틀린 문제 중 조건에 맞는 것이 없습니다</p>
                      )}
                      {dueFilter !== 'all' && (
                        <p className={firstWrongDay !== 'all' ? 'mt-1' : ''}>
                          다음 회차가 {dueFilter === 'overdue' ? '이미 지난' : dueFilter === 'today' ? '오늘까지인' : '이번 주인'} 문제가 없습니다
                        </p>
                      )}
                      {dueFilter !== 'all' && earliestDue && (
                        <p className="mt-1">
                          이 학생의 가장 이른 예정일은 <span className="font-medium text-foreground">{fmtDayLabel(earliestDue)}</span> 입니다
                        </p>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        className="mt-4"
                        onClick={() => { setDueFilter('all'); setFirstWrongDay('all'); }}
                      >
                        전체 보기 ({timelineRows.filter((t) => t.row.total_attempts < REVIEW_TARGET_ROUNDS).length}문제)
                      </Button>
                    </>
                  ) : (
                    <p>해당 기간에 오답이 없습니다</p>
                  )}
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-xs text-muted-foreground">
                        <th className="py-2 pr-2 w-10">
                          <Checkbox checked={allVisibleChecked} onCheckedChange={toggleAll} aria-label="전체 선택" />
                        </th>
                        <th className="py-2 pr-3">문제</th>
                        <th className="py-2 pr-3 text-center">진행 ({REVIEW_TARGET_ROUNDS}회)</th>
                        <th className="py-2 pr-3 text-center">오답</th>
                        {STAGE_LABELS.map((label, i) => (
                          <th key={label} className="py-2 pr-3 text-center whitespace-nowrap">
                            <div>{i === 0 ? '첫 오답' : `${i + 1}회차`}</div>
                            {i > 0 && <div className="font-normal opacity-70">{label}</div>}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {visibleRows.map(({ row: r, cells }) => (
                        <tr
                          key={r.problem_id}
                          className={`border-b hover:bg-muted/40 ${
                            r.total_attempts >= REVIEW_TARGET_ROUNDS ? 'text-muted-foreground' : ''
                          }`}
                        >
                          <td className="py-2 pr-2 align-middle">
                            <Checkbox
                              checked={selectedIds.has(r.problem_id)}
                              onCheckedChange={() => toggleOne(r.problem_id)}
                              aria-label="문제 선택"
                            />
                          </td>
                          <td className="py-2 pr-3">
                            <button className="flex items-center gap-2 text-left" onClick={() => setDetailRow(r)}>
                              {r.image_url ? (
                                <img src={r.image_url} alt="" loading="lazy" className="h-10 w-14 object-cover rounded border" />
                              ) : (
                                <div className="h-10 w-14 rounded border bg-muted" />
                              )}
                              <div className="min-w-0">
                                <div className="font-medium">{r.source_label || r.problem_number}번</div>
                                <div className="text-xs text-muted-foreground truncate max-w-[220px]">{r.problem_title}</div>
                              </div>
                            </button>
                          </td>
                          <td className="py-2 pr-3 text-center">
                            {(() => {
                              const done = Math.min(r.total_attempts, REVIEW_TARGET_ROUNDS);
                              const full = r.total_attempts >= REVIEW_TARGET_ROUNDS;
                              return (
                                <div className="flex flex-col items-center gap-1">
                                  <span className={`font-medium ${full ? 'text-muted-foreground' : 'text-primary'}`}>
                                    {r.total_attempts}/{REVIEW_TARGET_ROUNDS}
                                  </span>
                                  <span className="block w-14 h-1.5 rounded-full bg-muted overflow-hidden">
                                    <span
                                      className={`block h-full rounded-full ${full ? 'bg-muted-foreground/40' : 'bg-primary'}`}
                                      style={{ width: `${(done / REVIEW_TARGET_ROUNDS) * 100}%` }}
                                    />
                                  </span>
                                </div>
                              );
                            })()}
                          </td>
                          <td className="py-2 pr-3 text-center font-medium text-rose-600">{r.wrong_count}회</td>
                          {cells.map((cell) => (
                            <td key={cell.stage} className="py-2 pr-3 text-center whitespace-nowrap">
                              <StageCell cell={cell} />
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* 예약 현황 */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">복습 예약 현황</CardTitle>
              <CardDescription>
                아직 시작되지 않은 오답 시험지입니다. 예약일이 되면 학생 화면에 나타납니다 ·
                결석·보강으로 밀렸으면 날짜를 바꾸세요
              </CardDescription>
            </CardHeader>
            <CardContent>
              {scheduled.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">예약된 복습이 없습니다</p>
              ) : (
                <div className="space-y-2">
                  {scheduled.map((s) => (
                    <div key={s.distribution_id} className="flex items-center justify-between p-3 border rounded-lg">
                      <div>
                        <div className="flex items-center gap-2">
                          <Badge variant="outline">
                            {s.review_kind ? REVIEW_KIND_LABEL[s.review_kind] : `${s.review_stage}회차`}
                          </Badge>
                          <span className="font-medium text-sm">{s.title}</span>
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">
                          {fmtDateTime(s.distribution_date)} 시작 · {s.problem_count}문제
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {/* ⚠️ value 에 slice(0,10) 을 쓰면 안 된다 — 그건 **UTC 날짜**다.
                            예약은 KST 자정(=전날 15:00Z)으로 저장되므로 앞 10글자를 자르면
                            전 행이 항상 하루 전으로 보인다. 바로 위 fmtDateTime 은 로컬이라
                            같은 줄에서 두 날짜가 어긋났다. → 로컬 기준 toDateStr 을 쓴다.
                            (주석을 여는 태그 **속성 자리**에 넣으면 JSX 문법 오류다 —
                             거기엔 `{...spread}` 말고 표현식을 못 쓴다.) */}
                        <Input
                          type="date"
                          className="h-9 w-40"
                          value={toDateStr(new Date(s.distribution_date))}
                          onChange={(e) => e.target.value && handleReschedule(s.distribution_id, e.target.value)}
                          title="결석·보강으로 밀렸으면 다른 날짜로 옮기세요"
                        />
                        <Button variant="ghost" size="sm" onClick={() => handleCancelReview(s.distribution_id)}>
                          <Trash2 className="h-4 w-4 mr-1" />
                          취소
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </main>
      </div>

      {/* 고정 하단 바 */}
      <div className="fixed bottom-0 left-0 right-0 border-t bg-card/95 backdrop-blur z-40">
        <div className="container mx-auto px-4 py-3 flex items-center justify-between gap-4">
          <div className="text-sm">
            {selectedStudent ? (
              <>
                <span className="font-medium">{selectedStudent.student_name}</span>
                <span className="text-muted-foreground"> · {selectedIds.size}문제 선택</span>
              </>
            ) : (
              <span className="text-muted-foreground">학생을 선택하세요</span>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" disabled={selectedIds.size === 0} onClick={handlePrint}>
              <Printer className="h-4 w-4 mr-2" />
              오답 시험지 인쇄
            </Button>
            {/* [복습 예약] 버튼은 뺐다 — 학생이 과제를 다 풀면 다음수업·2주·4주 3개가
                **자동 생성**된다(auto_create_reviews_for_distribution). 손으로 예약할 일이
                없어졌다. 모달·API 는 남겨 뒀으니 되돌리려면 이 버튼만 되살리면 된다.
                [보충 배포]는 남긴다 — 결석·보강으로 빈 회차를 메우는 통로다. */}
            <Button variant="outline" disabled={selectedIds.size === 0} onClick={() => setMakeupOpen(true)}>
              <PlusCircle className="h-4 w-4 mr-2" />
              보충 배포
            </Button>
          </div>
        </div>
      </div>

      {/* 보충 배포 — 순수 HTML 모달 (Radix Dialog 금지) */}
      {makeupOpen && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/80" onClick={() => setMakeupOpen(false)} />
          <div className="relative z-[10000] bg-background border rounded-lg shadow-lg w-full max-w-md p-6">
            <div className="flex items-start justify-between mb-4">
              <div>
                <h2 className="text-lg font-semibold">보충 배포</h2>
                <p className="text-sm text-muted-foreground mt-1">
                  {selectedStudent?.student_name} · 오답 {selectedIds.size}문제
                </p>
              </div>
              <button onClick={() => setMakeupOpen(false)} className="text-muted-foreground hover:text-foreground">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">배포 날짜</label>
              <Input type="date" value={makeupDate} onChange={(e) => setMakeupDate(e.target.value)} />
              <p className="text-xs text-muted-foreground">
                결석·보강으로 회차가 비었을 때 씁니다. 예약 4건과 별개로 몇 번이든 낼 수 있습니다.
              </p>
            </div>

            <div className="flex gap-2 pt-6">
              <Button className="flex-1" onClick={handleMakeup} disabled={saving || !makeupDate || selectedIds.size === 0}>
                {saving ? '배포 중...' : `${selectedIds.size}문제 보충 배포`}
              </Button>
              <Button variant="outline" onClick={() => setMakeupOpen(false)} disabled={saving}>취소</Button>
            </div>
          </div>
        </div>
      )}

      {/* 자동 생성으로 대체돼 열 통로가 없다(위 버튼 제거). 되살릴 때를 위해 렌더는 남긴다 —
          modalOpen 이 항상 false 라 화면에는 안 나온다. */}
      <ReviewScheduleModal
        open={modalOpen}
        studentName={selectedStudent?.student_name || ''}
        problemCount={selectedIds.size}
        saving={saving}
        onClose={() => setModalOpen(false)}
        onConfirm={handleReserve}
      />

      {/* 문제 상세 — 순수 HTML 모달 */}
      {detailRow && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/80" onClick={() => setDetailRow(null)} />
          <div className="relative z-[10000] bg-background border rounded-lg shadow-lg w-full max-w-3xl max-h-[90vh] overflow-y-auto p-6">
            <div className="flex items-start justify-between mb-4">
              <div>
                <h2 className="text-lg font-semibold">{detailRow.source_label || detailRow.problem_number}번</h2>
                <p className="text-sm text-muted-foreground">{detailRow.problem_title}</p>
              </div>
              <button onClick={() => setDetailRow(null)} className="text-muted-foreground hover:text-foreground">
                <X className="h-5 w-5" />
              </button>
            </div>

            {detailRow.image_url && (
              <img src={detailRow.image_url} alt="문제" className="w-full rounded border mb-4" />
            )}

            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="p-3 rounded-md border">
                <p className="text-xs text-muted-foreground">정답</p>
                <p className="font-medium">{detailRow.correct_answer || '-'}</p>
              </div>
              <div className="p-3 rounded-md border">
                <p className="text-xs text-muted-foreground">학생의 마지막 답</p>
                <p className="font-medium">{detailRow.last_answer || '-'}</p>
              </div>
              <div className="p-3 rounded-md border">
                <p className="text-xs text-muted-foreground">오답 횟수</p>
                <p className="font-medium">{detailRow.wrong_count}회 / 시도 {detailRow.attempt_count}회</p>
              </div>
              <div className="p-3 rounded-md border">
                <p className="text-xs text-muted-foreground">최초 오답</p>
                <p className="font-medium">{fmtDateTime(detailRow.first_wrong_at)}</p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default WrongAnswerManagement;
