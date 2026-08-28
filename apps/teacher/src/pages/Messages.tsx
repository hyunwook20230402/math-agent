import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@shared/hooks/useAuth';
import { Button } from '@shared/ui/button';
import { Input } from '@shared/ui/input';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@shared/ui/card';
import { Badge } from '@shared/ui/badge';
import { Checkbox } from '@shared/ui/checkbox';
import { toast } from '@shared/hooks/use-toast';
import { supabase } from '@shared/supabase/client';
import { messageApi, smsBytes, type MessageLogRow } from '@shared/lib/api';
import { Send, Search, AlertTriangle, X } from 'lucide-react';
import { cn } from '@shared/lib/utils';

interface StudentRow {
  id: string;
  name: string;
  grade: string | null;
  school: string | null;
  parent_phone: string | null;
  student_phone: string | null;
}

const VARIABLES = ['학생이름', '학년', '학교', '날짜', '선생님이름', '학원명'];

const STATUS_BADGE: Record<string, string> = {
  sent: 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100',
  failed: 'bg-rose-100 text-rose-700 hover:bg-rose-100',
  mock: 'bg-slate-100 text-slate-700 hover:bg-slate-100',
  skipped: 'bg-amber-100 text-amber-700 hover:bg-amber-100',
};

const STATUS_KO: Record<string, string> = {
  sent: '발송', failed: '실패', mock: '모의', skipped: '번호없음',
};

const TYPE_KO: Record<string, string> = {
  notice: '공지', attendance: '출석', report: '보고서',
};

const fmtDateTime = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const Messages = () => {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const [tab, setTab] = useState<'compose' | 'logs'>('compose');

  const [students, setStudents] = useState<StudentRow[]>([]);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [recipientKind, setRecipientKind] = useState<'parent' | 'student'>('parent');
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [smsConfigured, setSmsConfigured] = useState<boolean | null>(null);
  const [academyName, setAcademyName] = useState('학원');
  const textRef = useRef<HTMLTextAreaElement>(null);

  const [logs, setLogs] = useState<MessageLogRow[]>([]);
  const [logLoading, setLogLoading] = useState(false);
  const [logType, setLogType] = useState('');
  const [logStatus, setLogStatus] = useState('');

  useEffect(() => {
    messageApi.getConfig()
      .then((c) => { setSmsConfigured(c.configured); setAcademyName(c.academy_name); })
      .catch(() => setSmsConfigured(null));
  }, []);

  useEffect(() => {
    if (!profile?.id) return;
    (async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, name, grade, school, parent_phone, student_phone')
        .eq('teacher_id', profile.id)
        .eq('role', 'student')
        .order('name');
      if (error) {
        toast({ title: '학생 조회 오류', description: error.message, variant: 'destructive' });
        return;
      }
      setStudents(data || []);
    })();
  }, [profile?.id]);

  const loadLogs = useCallback(async () => {
    if (!profile?.id) return;
    setLogLoading(true);
    try {
      const rows = await messageApi.getLogs(profile.id, {
        messageType: logType || undefined,
        status: logStatus || undefined,
      });
      setLogs(rows);
    } catch (error: any) {
      toast({ title: '로그 조회 오류', description: error.message, variant: 'destructive' });
    } finally {
      setLogLoading(false);
    }
  }, [profile?.id, logType, logStatus]);

  useEffect(() => { if (tab === 'logs') loadLogs(); }, [tab, loadLogs]);

  const phoneOf = (s: StudentRow) => (recipientKind === 'parent' ? s.parent_phone : s.student_phone);

  const filtered = useMemo(() => {
    const q = query.trim();
    if (!q) return students;
    return students.filter((s) => s.name?.includes(q) || (phoneOf(s) || '').includes(q));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [students, query, recipientKind]);

  const selectable = filtered.filter((s) => !!phoneOf(s));
  const allChecked = selectable.length > 0 && selectable.every((s) => selected.has(s.id));

  const toggleAll = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allChecked) selectable.forEach((s) => next.delete(s.id));
      else selectable.forEach((s) => next.add(s.id));
      return next;
    });
  };

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const insertVariable = (name: string) => {
    const el = textRef.current;
    const token = `#{${name}}`;
    if (!el) { setText((t) => t + token); return; }
    const start = el.selectionStart ?? text.length;
    const end = el.selectionEnd ?? text.length;
    const next = text.slice(0, start) + token + text.slice(end);
    setText(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };

  // 미리보기는 선택된 첫 수신자 기준
  const previewStudent = students.find((s) => selected.has(s.id));
  const preview = useMemo(() => {
    const today = new Date();
    const vars: Record<string, string> = {
      '학생이름': previewStudent?.name || '홍길동',
      '학년': previewStudent?.grade || '',
      '학교': previewStudent?.school || '',
      '날짜': `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`,
      '선생님이름': profile?.name || '',
      '학원명': academyName,
    };
    let out = text;
    Object.entries(vars).forEach(([k, v]) => { out = out.split(`#{${k}}`).join(v); });
    return out;
  }, [text, previewStudent, profile?.name, academyName]);

  const doSend = async () => {
    setSending(true);
    try {
      const res = await messageApi.send({
        student_ids: Array.from(selected),
        template: text,
        recipient_kind: recipientKind,
        message_type: 'notice',
      });
      toast({
        title: res.mock ? '모의 발송 완료' : '발송 완료',
        description: res.mock
          ? `${res.results.length}건이 기록되었습니다(실제 문자는 나가지 않음).`
          : `성공 ${res.sent}건 · 실패 ${res.failed}건 · 번호없음 ${res.skipped}건`,
      });
      setConfirmOpen(false);
      setSelected(new Set());
      setText('');
    } catch (error: any) {
      toast({ title: '발송 실패', description: error.message, variant: 'destructive' });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="container mx-auto px-4 py-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">메시지</h1>
        <p className="text-muted-foreground">학부모에게 공지나 알림을 보냅니다</p>
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

      {/* 내부 탭 */}
      <div className="flex gap-1 border-b mb-4">
        {([['compose', '새 메시지'], ['logs', '전송 로그']] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={cn(
              'px-4 py-2 text-sm font-medium border-b-2 transition-colors',
              tab === key ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'compose' ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* 수신자 */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">수신자 선택</CardTitle>
              <CardDescription>번호가 등록되지 않은 학생은 선택할 수 없습니다</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input className="pl-8" placeholder="이름/번호 검색" value={query} onChange={(e) => setQuery(e.target.value)} />
                </div>
                <select
                  value={recipientKind}
                  onChange={(e) => { setRecipientKind(e.target.value as 'parent' | 'student'); setSelected(new Set()); }}
                  className="h-10 px-3 rounded-md border border-input bg-background text-sm"
                >
                  <option value="parent">학부모 번호</option>
                  <option value="student">학생 번호</option>
                </select>
              </div>

              <div className="flex items-center justify-between text-sm">
                <button className="text-primary hover:underline" onClick={toggleAll}>
                  {allChecked ? '전체 해제' : '전체 선택'}
                </button>
                <span className="text-muted-foreground">선택 {selected.size}명</span>
              </div>

              <div className="max-h-[420px] overflow-y-auto space-y-1 border rounded-md p-2">
                {filtered.length === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">학생이 없습니다</p>
                ) : (
                  filtered.map((s) => {
                    const phone = phoneOf(s);
                    return (
                      <div
                        key={s.id}
                        className={cn('flex items-center gap-3 px-2 py-2 rounded-md', !phone && 'opacity-60')}
                      >
                        <Checkbox
                          checked={selected.has(s.id)}
                          disabled={!phone}
                          onCheckedChange={() => toggleOne(s.id)}
                          aria-label={`${s.name} 선택`}
                        />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium truncate">{s.name}</p>
                          <p className="text-xs text-muted-foreground truncate">
                            {s.grade || '-'} · {phone || '번호 없음'}
                          </p>
                        </div>
                        {!phone && (
                          <Button variant="ghost" size="sm" onClick={() => navigate('/teacher/students')}>
                            등록하기
                          </Button>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </CardContent>
          </Card>

          {/* 내용 */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">메시지 내용</CardTitle>
              <CardDescription>변수를 넣으면 학생마다 자동으로 채워집니다</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-1">
                {VARIABLES.map((v) => (
                  <button
                    key={v}
                    onClick={() => insertVariable(v)}
                    className="px-2 py-1 text-xs rounded border hover:bg-muted"
                  >
                    #{'{'}{v}{'}'}
                  </button>
                ))}
              </div>

              <textarea
                ref={textRef}
                className="w-full h-40 p-3 rounded-md border border-input bg-background text-sm"
                placeholder="예: [#{학원명}] #{학생이름} 학생 학부모님께 안내드립니다."
                value={text}
                onChange={(e) => setText(e.target.value)}
              />

              <div className="rounded-md border bg-muted/40 p-3">
                <p className="text-xs text-muted-foreground mb-1">
                  미리보기 {previewStudent ? `(${previewStudent.name} 기준)` : '(예시)'}
                </p>
                <p className="text-sm whitespace-pre-wrap">{preview || '내용을 입력하세요'}</p>
                <p className="text-xs text-muted-foreground mt-2">
                  {smsBytes(preview)} byte · {smsBytes(preview) <= 90 ? 'SMS' : 'LMS'} · 수신 {selected.size}명
                </p>
              </div>

              <Button
                className="w-full"
                disabled={selected.size === 0 || !text.trim()}
                onClick={() => setConfirmOpen(true)}
              >
                <Send className="h-4 w-4 mr-2" />
                {selected.size}명에게 발송
              </Button>
            </CardContent>
          </Card>
        </div>
      ) : (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">전송 로그</CardTitle>
            <CardDescription>최근 200건</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex gap-3 mb-4">
              <select
                value={logType}
                onChange={(e) => setLogType(e.target.value)}
                className="h-9 px-3 rounded-md border border-input bg-background text-sm"
              >
                <option value="">전체 유형</option>
                <option value="notice">공지</option>
                <option value="attendance">출석</option>
                <option value="report">보고서</option>
              </select>
              <select
                value={logStatus}
                onChange={(e) => setLogStatus(e.target.value)}
                className="h-9 px-3 rounded-md border border-input bg-background text-sm"
              >
                <option value="">전체 상태</option>
                <option value="sent">발송</option>
                <option value="failed">실패</option>
                <option value="mock">모의</option>
                <option value="skipped">번호없음</option>
              </select>
            </div>

            {logLoading ? (
              <div className="py-16 text-center text-sm text-muted-foreground">불러오는 중...</div>
            ) : logs.length === 0 ? (
              <div className="py-16 text-center text-sm text-muted-foreground">전송 기록이 없습니다</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th className="py-2 pr-3">보낸 시각</th>
                      <th className="py-2 pr-3">유형</th>
                      <th className="py-2 pr-3">수신</th>
                      <th className="py-2 pr-3">내용</th>
                      <th className="py-2 pr-3">상태</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logs.map((l) => (
                      <tr key={l.id} className="border-b">
                        <td className="py-2 pr-3 text-xs text-muted-foreground whitespace-nowrap">{fmtDateTime(l.sent_at)}</td>
                        <td className="py-2 pr-3 text-xs">{TYPE_KO[l.message_type] || l.message_type}</td>
                        <td className="py-2 pr-3 text-xs">{l.recipient_phone || '-'}</td>
                        <td className="py-2 pr-3 text-xs max-w-[360px] truncate">{l.body || l.error || '-'}</td>
                        <td className="py-2 pr-3">
                          <Badge className={STATUS_BADGE[l.status] || ''}>{STATUS_KO[l.status] || l.status}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* 발송 확인 — 순수 HTML 모달 */}
      {confirmOpen && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/80" onClick={() => setConfirmOpen(false)} />
          <div className="relative z-[10000] bg-background border rounded-lg shadow-lg w-full max-w-md p-6">
            <div className="flex items-start justify-between mb-3">
              <h2 className="text-lg font-semibold">발송 확인</h2>
              <button onClick={() => setConfirmOpen(false)} className="text-muted-foreground hover:text-foreground">
                <X className="h-5 w-5" />
              </button>
            </div>
            <p className="text-sm">
              {recipientKind === 'parent' ? '학부모' : '학생'} <span className="font-medium">{selected.size}명</span>에게 발송합니다.
              {smsConfigured === false ? ' (모의 발송 — 실제 문자는 나가지 않습니다)' : ' 되돌릴 수 없습니다.'}
            </p>
            <div className="mt-3 p-3 rounded-md border bg-muted/40 text-sm whitespace-pre-wrap max-h-40 overflow-y-auto">
              {preview}
            </div>
            <div className="flex gap-2 pt-5">
              <Button className="flex-1" onClick={doSend} disabled={sending}>
                {sending ? '보내는 중...' : '발송'}
              </Button>
              <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={sending}>취소</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Messages;
