import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '@shared/hooks/useAuth';
import { Button } from '@shared/ui/button';
import { Input } from '@shared/ui/input';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@shared/ui/card';
import { toast } from '@shared/hooks/use-toast';
import { supabase } from '@shared/supabase/client';
import { attendanceApi, messageApi, smsBytes, type AttendanceRow, type AttendanceStatus } from '@shared/lib/api';
import { MessageSquare, Send, X, AlertTriangle } from 'lucide-react';

interface StudentRow {
  id: string;
  name: string;
  grade: string | null;
  parent_phone: string | null;
}

const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const STATUS_LABEL: Record<AttendanceStatus, string> = {
  present: '출석',
  late: '지각',
  absent: '결석',
};

const STATUS_STYLE: Record<AttendanceStatus, string> = {
  present: 'bg-emerald-600 text-white border-emerald-600',
  late: 'bg-amber-500 text-white border-amber-500',
  absent: 'bg-rose-600 text-white border-rose-600',
};

// 발송 전 화면에서 항상 수정할 수 있다
const DEFAULT_TEMPLATE: Record<AttendanceStatus, string> = {
  present: '[#{학원명}] #{학생이름} 학생이 #{날짜} #{시각} 등원했습니다.',
  late: '[#{학원명}] #{학생이름} 학생이 #{날짜} 수업에 지각했습니다.',
  absent: '[#{학원명}] #{학생이름} 학생이 #{날짜} 수업에 결석했습니다. 확인 부탁드립니다.',
};

const Attendance = () => {
  const { profile } = useAuth();
  const [date, setDate] = useState(todayStr());
  const [students, setStudents] = useState<StudentRow[]>([]);
  const [records, setRecords] = useState<Record<string, AttendanceRow>>({});
  const [loading, setLoading] = useState(true);
  const [smsConfigured, setSmsConfigured] = useState<boolean | null>(null);

  // 문자 모달
  const [msgOpen, setMsgOpen] = useState(false);
  const [msgTargets, setMsgTargets] = useState<StudentRow[]>([]);
  const [msgText, setMsgText] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    messageApi.getConfig()
      .then((c) => setSmsConfigured(c.configured))
      .catch(() => setSmsConfigured(null));   // 백엔드 미기동 — 배너만 생략
  }, []);

  const load = useCallback(async () => {
    if (!profile?.id) return;
    setLoading(true);
    try {
      // 학생 목록 1회 + 그날 출석 1회 → 메모리 조인 (학생마다 조회하면 N+1)
      const [{ data: studentRows, error }, attRows] = await Promise.all([
        supabase
          .from('profiles')
          .select('id, name, grade, parent_phone')
          .eq('teacher_id', profile.id)
          .eq('role', 'student')
          .order('name'),
        attendanceApi.getByDate(profile.id, date),
      ]);
      if (error) throw error;
      setStudents(studentRows || []);
      const map: Record<string, AttendanceRow> = {};
      attRows.forEach((r) => { map[r.student_id] = r; });
      setRecords(map);
    } catch (error: any) {
      toast({ title: '출석 조회 오류', description: error.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [profile?.id, date]);

  useEffect(() => { load(); }, [load]);

  const summary = useMemo(() => {
    let present = 0, late = 0, absent = 0;
    students.forEach((s) => {
      const st = records[s.id]?.status;
      if (st === 'present') present += 1;
      else if (st === 'late') late += 1;
      else if (st === 'absent') absent += 1;
    });
    return { present, late, absent, unchecked: students.length - present - late - absent };
  }, [students, records]);

  const setStatus = async (student: StudentRow, status: AttendanceStatus) => {
    if (!profile?.id) return;
    const prev = records[student.id];
    // 낙관적 업데이트 — 실패하면 되돌린다
    setRecords((r) => ({
      ...r,
      [student.id]: { ...(prev || ({} as AttendanceRow)), student_id: student.id, teacher_id: profile.id, attendance_date: date, status, note: prev?.note ?? null } as AttendanceRow,
    }));
    try {
      await attendanceApi.setStatus({
        student_id: student.id,
        teacher_id: profile.id,
        attendance_date: date,
        status,
        note: prev?.note ?? null,
      });
    } catch (error: any) {
      setRecords((r) => {
        const next = { ...r };
        if (prev) next[student.id] = prev; else delete next[student.id];
        return next;
      });
      toast({ title: '저장 실패', description: error.message, variant: 'destructive' });
    }
  };

  const saveNote = async (student: StudentRow, note: string) => {
    if (!profile?.id) return;
    const current = records[student.id];
    if (!current?.status) return;   // 상태를 먼저 찍어야 메모가 의미 있다
    try {
      await attendanceApi.setStatus({
        student_id: student.id,
        teacher_id: profile.id,
        attendance_date: date,
        status: current.status,
        note: note || null,
      });
    } catch (error: any) {
      toast({ title: '메모 저장 실패', description: error.message, variant: 'destructive' });
    }
  };

  const openMessage = (targets: StudentRow[], status: AttendanceStatus | 'mixed') => {
    const withPhone = targets.filter((t) => !!t.parent_phone);
    if (withPhone.length === 0) {
      toast({ title: '보낼 대상이 없습니다', description: '학부모 번호가 등록된 학생이 없습니다.', variant: 'destructive' });
      return;
    }
    setMsgTargets(withPhone);
    setMsgText(status === 'mixed' ? DEFAULT_TEMPLATE.absent : DEFAULT_TEMPLATE[status]);
    setMsgOpen(true);
  };

  const sendMessage = async () => {
    setSending(true);
    try {
      const now = new Date();
      const res = await messageApi.send({
        student_ids: msgTargets.map((t) => t.id),
        template: msgText,
        recipient_kind: 'parent',
        message_type: 'attendance',
        extra_vars: {
          '날짜': date,
          '시각': `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
        },
      });
      toast({
        title: res.mock ? '모의 발송 완료' : '발송 완료',
        description: res.mock
          ? `${res.results.length}건이 기록되었습니다(실제 문자는 나가지 않음).`
          : `성공 ${res.sent}건 · 실패 ${res.failed}건 · 번호없음 ${res.skipped}건`,
      });
      setMsgOpen(false);
    } catch (error: any) {
      toast({ title: '발송 실패', description: error.message, variant: 'destructive' });
    } finally {
      setSending(false);
    }
  };

  const lateOrAbsent = students.filter((s) => {
    const st = records[s.id]?.status;
    return st === 'late' || st === 'absent';
  });

  return (
    <div className="container mx-auto px-4 py-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">출석</h1>
        <p className="text-muted-foreground">날짜별로 출석·지각·결석을 기록하고 학부모에게 알립니다</p>
      </div>

      {smsConfigured === false && (
        <div className="mb-4 flex items-start gap-2 p-3 rounded-lg border border-amber-200 bg-amber-50 text-amber-800 text-sm">
          <AlertTriangle className="h-4 w-4 mt-0.5" />
          <div>
            <p className="font-medium">모의 발송 모드</p>
            <p>솔라피 키가 설정되지 않아 실제 문자는 나가지 않고 기록만 남습니다.</p>
          </div>
        </div>
      )}

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">날짜</label>
              <Input type="date" className="h-9 w-44" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <Button variant="outline" size="sm" className="h-9" onClick={() => setDate(todayStr())}>오늘</Button>

            <div className="flex gap-2 ml-auto text-sm">
              <span className="px-3 py-1.5 rounded-full bg-emerald-50 text-emerald-700">출석 {summary.present}</span>
              <span className="px-3 py-1.5 rounded-full bg-amber-50 text-amber-700">지각 {summary.late}</span>
              <span className="px-3 py-1.5 rounded-full bg-rose-50 text-rose-700">결석 {summary.absent}</span>
              <span className="px-3 py-1.5 rounded-full bg-muted text-muted-foreground">미체크 {summary.unchecked}</span>
            </div>
          </div>
          <CardDescription className="pt-2">
            버튼을 누르면 바로 저장됩니다 (한 학생 하루 한 번 기록)
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="py-16 text-center text-sm text-muted-foreground">불러오는 중...</div>
          ) : students.length === 0 ? (
            <div className="py-16 text-center text-sm text-muted-foreground">등록된 학생이 없습니다</div>
          ) : (
            <>
              <div className="flex justify-end mb-3">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={lateOrAbsent.length === 0}
                  onClick={() => openMessage(lateOrAbsent, 'mixed')}
                >
                  <Send className="h-4 w-4 mr-2" />
                  지각·결석 학생에게 일괄 알림 ({lateOrAbsent.length})
                </Button>
              </div>

              <div className="space-y-2">
                {students.map((s) => {
                  const rec = records[s.id];
                  return (
                    <div key={s.id} className="flex flex-wrap items-center gap-3 p-3 border rounded-lg">
                      <div className="w-40 min-w-0">
                        <p className="font-medium truncate">{s.name}</p>
                        <p className="text-xs text-muted-foreground truncate">{s.grade || '-'}</p>
                      </div>

                      <div className="flex">
                        {(['present', 'late', 'absent'] as AttendanceStatus[]).map((st, i) => {
                          const on = rec?.status === st;
                          return (
                            <button
                              key={st}
                              onClick={() => setStatus(s, st)}
                              className={`h-9 px-4 text-sm border ${i === 0 ? 'rounded-l-md' : i === 2 ? 'rounded-r-md border-l-0' : 'border-l-0'} ${
                                on ? STATUS_STYLE[st] : 'bg-background hover:bg-muted'
                              }`}
                            >
                              {STATUS_LABEL[st]}
                            </button>
                          );
                        })}
                      </div>

                      <Input
                        className="h-9 flex-1 min-w-[160px]"
                        placeholder="메모 (선택)"
                        defaultValue={rec?.note || ''}
                        onBlur={(e) => saveNote(s, e.target.value)}
                      />

                      <Button
                        variant="outline"
                        size="sm"
                        className="h-9"
                        disabled={!s.parent_phone}
                        title={s.parent_phone ? '학부모에게 문자 보내기' : '학부모 번호 미등록'}
                        onClick={() => openMessage([s], rec?.status || 'present')}
                      >
                        <MessageSquare className="h-4 w-4 mr-1" />
                        문자
                      </Button>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* 문자 미리보기 — 순수 HTML 모달 (Radix Dialog 금지) */}
      {msgOpen && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/80" onClick={() => setMsgOpen(false)} />
          <div className="relative z-[10000] bg-background border rounded-lg shadow-lg w-full max-w-lg p-6">
            <div className="flex items-start justify-between mb-4">
              <div>
                <h2 className="text-lg font-semibold">출석 문자 보내기</h2>
                <p className="text-sm text-muted-foreground">
                  학부모 {msgTargets.length}명 · {msgTargets.map((t) => t.name).join(', ')}
                </p>
              </div>
              <button onClick={() => setMsgOpen(false)} className="text-muted-foreground hover:text-foreground">
                <X className="h-5 w-5" />
              </button>
            </div>

            <textarea
              className="w-full h-32 p-3 rounded-md border border-input bg-background text-sm"
              value={msgText}
              onChange={(e) => setMsgText(e.target.value)}
            />
            <p className="text-xs text-muted-foreground mt-2">
              사용 가능: #{'{'}학생이름{'}'} #{'{'}학년{'}'} #{'{'}날짜{'}'} #{'{'}시각{'}'} #{'{'}학원명{'}'} #{'{'}선생님이름{'}'}
              {' · '}
              {smsBytes(msgText)} byte · {smsBytes(msgText) <= 90 ? 'SMS' : 'LMS'}
            </p>

            <div className="flex gap-2 pt-5">
              <Button className="flex-1" onClick={sendMessage} disabled={sending || !msgText.trim()}>
                {sending ? '보내는 중...' : `${msgTargets.length}명에게 보내기`}
              </Button>
              <Button variant="outline" onClick={() => setMsgOpen(false)} disabled={sending}>취소</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Attendance;
