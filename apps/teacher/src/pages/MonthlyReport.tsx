import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '@shared/hooks/useAuth';
import { Button } from '@shared/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@shared/ui/card';
import { Badge } from '@shared/ui/badge';
import { toast } from '@shared/hooks/use-toast';
import { supabase } from '@shared/supabase/client';
import {
  reportApi,
  messageApi,
  smsBytes,
  REVIEW_KIND_LABEL,
  type MonthlyReportSummary,
  type MonthlyDistributionRow,
  type WrongTrendRow,
  type MonthlyReportRecord,
} from '@shared/lib/api';
import { Save, Send, X, AlertTriangle } from 'lucide-react';
import WrongAnswerTrendChart from '@/components/WrongAnswerTrendChart';

interface StudentRow {
  id: string;
  name: string;
  grade: string | null;
  parent_phone: string | null;
}

const pad = (n: number) => String(n).padStart(2, '0');
const fmtDate = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
};

const MonthlyReport = () => {
  const { profile } = useAuth();
  const now = new Date();

  const [students, setStudents] = useState<StudentRow[]>([]);
  const [studentId, setStudentId] = useState('');
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);

  const [summary, setSummary] = useState<MonthlyReportSummary | null>(null);
  const [dists, setDists] = useState<MonthlyDistributionRow[]>([]);
  const [trend, setTrend] = useState<WrongTrendRow[]>([]);
  const [record, setRecord] = useState<MonthlyReportRecord | null>(null);
  const [feedback, setFeedback] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const [smsOpen, setSmsOpen] = useState(false);
  const [smsText, setSmsText] = useState('');
  const [sending, setSending] = useState(false);
  const [smsConfigured, setSmsConfigured] = useState<boolean | null>(null);
  const [academyName, setAcademyName] = useState('학원');

  const student = students.find((s) => s.id === studentId) || null;

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
        .select('id, name, grade, parent_phone')
        .eq('teacher_id', profile.id)
        .eq('role', 'student')
        .order('name');
      if (error) {
        toast({ title: '학생 조회 오류', description: error.message, variant: 'destructive' });
        return;
      }
      setStudents(data || []);
      setStudentId((prev) => prev || (data?.[0]?.id ?? ''));
    })();
  }, [profile?.id]);

  const load = useCallback(async () => {
    if (!studentId) return;
    setLoading(true);
    try {
      // 추이는 그 달 이전 8주부터 그 달 말까지
      const monthStart = new Date(year, month - 1, 1);
      const monthEnd = new Date(year, month, 0);
      const trendFrom = new Date(monthStart);
      trendFrom.setDate(trendFrom.getDate() - 56);
      const toStr = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

      const [s, d, t, r] = await Promise.all([
        reportApi.getSummary(studentId, year, month),
        reportApi.getDistributions(studentId, year, month),
        reportApi.getWrongTrend(studentId, toStr(trendFrom), toStr(monthEnd)),
        reportApi.get(studentId, year, month),
      ]);
      setSummary(s);
      setDists(d);
      setTrend(t);
      setRecord(r);
      setFeedback(r?.feedback || '');
    } catch (error: any) {
      toast({ title: '보고서 조회 오류', description: error.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [studentId, year, month]);

  useEffect(() => { load(); }, [load]);

  const handleSave = async () => {
    if (!profile?.id || !studentId || !summary) return;
    setSaving(true);
    try {
      const saved = await reportApi.save({
        student_id: studentId,
        teacher_id: profile.id,
        year,
        month,
        feedback,
        // 저장 시점 집계를 박제한다 — 나중에 학생이 재풀이해도 보낸 보고서가 흔들리지 않게
        snapshot: { summary, distributions: dists, saved_at: new Date().toISOString() },
      });
      setRecord(saved);
      toast({ title: '저장 완료', description: `${year}년 ${month}월 보고서가 저장되었습니다.` });
    } catch (error: any) {
      toast({ title: '저장 실패', description: error.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const buildSmsBody = () => {
    if (!summary) return '';
    return [
      `[${academyName}] #{학생이름} 학생 ${year}년 ${month}월 학습보고서`,
      `· 과제 ${summary.distributions_count}건 / 푼 문항 ${summary.attempted}개 / 정답률 ${summary.accuracy}%`,
      `· 새 오답 ${summary.new_wrong_problems}개, 복습 완료 ${summary.resolved_problems}개`,
      `· 출석률 ${summary.attendance_rate}% (출석 ${summary.attendance_present}·지각 ${summary.attendance_late}·결석 ${summary.attendance_absent})`,
      feedback.trim() ? `· 선생님 한마디: ${feedback.trim()}` : '',
    ].filter(Boolean).join('\n');
  };

  const openSms = async () => {
    if (!record) {
      toast({ title: '먼저 저장해주세요', description: '보고서를 저장한 뒤 발송할 수 있습니다.', variant: 'destructive' });
      return;
    }
    if (!student?.parent_phone) {
      toast({ title: '학부모 번호 없음', description: '학생 등록 화면에서 연락처를 먼저 입력해주세요.', variant: 'destructive' });
      return;
    }
    setSmsText(buildSmsBody());
    setSmsOpen(true);
  };

  const sendSms = async () => {
    if (!record) return;
    setSending(true);
    try {
      const res = await messageApi.send({
        student_ids: [studentId],
        template: smsText,
        recipient_kind: 'parent',
        message_type: 'report',
        report_id: record.id,
      });
      toast({
        title: res.mock ? '모의 발송 완료' : '발송 완료',
        description: res.mock
          ? '기록만 남았습니다(실제 문자는 나가지 않음).'
          : `성공 ${res.sent}건 · 실패 ${res.failed}건`,
      });
      setSmsOpen(false);
      const fresh = await reportApi.get(studentId, year, month);
      setRecord(fresh);
    } catch (error: any) {
      toast({ title: '발송 실패', description: error.message, variant: 'destructive' });
    } finally {
      setSending(false);
    }
  };

  const years = useMemo(() => {
    const y = now.getFullYear();
    return [y - 2, y - 1, y, y + 1];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cards = summary
    ? [
        { label: '배포 과제', value: `${summary.distributions_count}건`, sub: `받은 문항 ${summary.assigned_problems}개` },
        { label: '푼 문항', value: `${summary.attempted}개`, sub: `정답 ${summary.correct}개` },
        { label: '정답률', value: `${summary.accuracy}%`, sub: '그 달 최신 시도 기준' },
        { label: '새 오답', value: `${summary.new_wrong_problems}개`, sub: `복습 완료 ${summary.resolved_problems}개` },
        { label: '출석률', value: `${summary.attendance_rate}%`, sub: `출 ${summary.attendance_present}·지 ${summary.attendance_late}·결 ${summary.attendance_absent}` },
      ]
    : [];

  return (
    <div className="container mx-auto px-4 py-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">학습보고서</h1>
        <p className="text-muted-foreground">학생별 한 달 학습 내용을 정리해 학부모에게 문자로 보냅니다</p>
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

      {/* 상단 선택 바 — native select (Radix Select 금지) */}
      <Card className="mb-6">
        <CardContent className="py-4 flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">학생</label>
            <select
              value={studentId}
              onChange={(e) => setStudentId(e.target.value)}
              className="block h-9 px-3 rounded-md border border-input bg-background text-sm min-w-[160px]"
            >
              {students.length === 0 && <option value="">등록된 학생 없음</option>}
              {students.map((s) => (
                <option key={s.id} value={s.id}>{s.name}{s.grade ? ` (${s.grade})` : ''}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">연도</label>
            <select
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
              className="block h-9 px-3 rounded-md border border-input bg-background text-sm"
            >
              {years.map((y) => <option key={y} value={y}>{y}년</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">월</label>
            <select
              value={month}
              onChange={(e) => setMonth(Number(e.target.value))}
              className="block h-9 px-3 rounded-md border border-input bg-background text-sm"
            >
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                <option key={m} value={m}>{m}월</option>
              ))}
            </select>
          </div>

          <div className="ml-auto flex items-center gap-2">
            {record?.sent_at && (
              <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">
                발송됨 {fmtDate(record.sent_at)}
              </Badge>
            )}
            <Button variant="outline" onClick={handleSave} disabled={saving || !summary}>
              <Save className="h-4 w-4 mr-2" />
              {saving ? '저장 중...' : '저장'}
            </Button>
            <Button onClick={openSms} disabled={!record}>
              <Send className="h-4 w-4 mr-2" />
              학부모에게 문자 발송
            </Button>
          </div>
        </CardContent>
      </Card>

      {loading ? (
        <div className="py-20 text-center text-sm text-muted-foreground">불러오는 중...</div>
      ) : !studentId ? (
        <div className="py-20 text-center text-sm text-muted-foreground">학생을 먼저 등록해주세요</div>
      ) : (
        <div className="space-y-6">
          {/* 집계 카드 */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {cards.map((c) => (
              <Card key={c.label}>
                <CardContent className="py-4">
                  <p className="text-xs text-muted-foreground">{c.label}</p>
                  <p className="text-2xl font-bold mt-1">{c.value}</p>
                  <p className="text-xs text-muted-foreground mt-1">{c.sub}</p>
                </CardContent>
              </Card>
            ))}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* 배포 내역 */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">이 달 배포 내역</CardTitle>
                <CardDescription>{month}월에 나간 과제와 결과</CardDescription>
              </CardHeader>
              <CardContent>
                {dists.length === 0 ? (
                  <p className="py-10 text-center text-sm text-muted-foreground">이 달 배포가 없습니다</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left text-xs text-muted-foreground">
                          <th className="py-2 pr-3">날짜</th>
                          <th className="py-2 pr-3">과제</th>
                          <th className="py-2 pr-3 text-center">문항</th>
                          <th className="py-2 pr-3 text-center">푼 수</th>
                          <th className="py-2 pr-3 text-center">정답률</th>
                        </tr>
                      </thead>
                      <tbody>
                        {dists.map((d) => (
                          <tr key={d.distribution_id} className="border-b">
                            <td className="py-2 pr-3 text-xs text-muted-foreground whitespace-nowrap">
                              {fmtDate(d.distribution_date)}
                            </td>
                            <td className="py-2 pr-3">
                              <div className="flex items-center gap-1">
                                {d.review_kind && (
                                  <Badge variant="outline" className="text-[10px]">
                                    복습 {REVIEW_KIND_LABEL[d.review_kind]}
                                  </Badge>
                                )}
                                <span className="truncate max-w-[180px]">{d.distribution_title}</span>
                              </div>
                            </td>
                            <td className="py-2 pr-3 text-center">{d.total_problems}</td>
                            <td className="py-2 pr-3 text-center">{d.attempted}</td>
                            <td className="py-2 pr-3 text-center font-medium">{d.accuracy}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* 오답 추이 */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">오답 학습 추이</CardTitle>
                <CardDescription>최근 8주 — 주별 오답 수와 정답률</CardDescription>
              </CardHeader>
              <CardContent>
                <WrongAnswerTrendChart data={trend} />
              </CardContent>
            </Card>
          </div>

          {/* 피드백 */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">선생님 피드백</CardTitle>
              <CardDescription>학부모에게 보내는 문자에 그대로 들어갑니다</CardDescription>
            </CardHeader>
            <CardContent>
              <textarea
                className="w-full h-28 p-3 rounded-md border border-input bg-background text-sm"
                placeholder="예: 이번 달 지수법칙 단원을 집중적으로 다뤘고, 오답 복습도 성실히 마쳤습니다."
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
              />
            </CardContent>
          </Card>
        </div>
      )}

      {/* 문자 발송 모달 — 순수 HTML */}
      {smsOpen && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/80" onClick={() => setSmsOpen(false)} />
          <div className="relative z-[10000] bg-background border rounded-lg shadow-lg w-full max-w-lg p-6">
            <div className="flex items-start justify-between mb-3">
              <div>
                <h2 className="text-lg font-semibold">학습보고서 문자 발송</h2>
                <p className="text-sm text-muted-foreground">
                  {student?.name} 학부모 · {student?.parent_phone}
                </p>
              </div>
              <button onClick={() => setSmsOpen(false)} className="text-muted-foreground hover:text-foreground">
                <X className="h-5 w-5" />
              </button>
            </div>

            <textarea
              className="w-full h-56 p-3 rounded-md border border-input bg-background text-sm"
              value={smsText}
              onChange={(e) => setSmsText(e.target.value)}
            />
            <p className="text-xs text-muted-foreground mt-2">
              {smsBytes(smsText)} byte · {smsBytes(smsText) <= 90 ? 'SMS' : 'LMS'}
              {smsConfigured === false && ' · 모의 발송(실제 문자는 나가지 않음)'}
            </p>

            <div className="flex gap-2 pt-5">
              <Button className="flex-1" onClick={sendSms} disabled={sending || !smsText.trim()}>
                {sending ? '보내는 중...' : '발송'}
              </Button>
              <Button variant="outline" onClick={() => setSmsOpen(false)} disabled={sending}>취소</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default MonthlyReport;
