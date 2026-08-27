// 빠른정답 PDF 로 정답을 한 번에 채우는 화면.
//
// 두 곳에서 연다:
//   · 교재 관리 — 크롭 전에도 교재/폴더에 답지를 미리 넣어둔다 (jobId 없음)
//   · 상세 입력 — 저장된 답지로 이 작업의 문제들을 채운다 (jobId 있음)
//
// 왜 검수를 거치나: 정답이 틀리면 학생이 맞는 답을 쓰고도 오답이 된다. 그래서 바로 넣지 않고
// 읽은 결과를 표로 보여준 뒤 '적용' 을 누르게 한다. 사람이 봐야 하는 것(소문항·한글·여러 값·
// 두 번 읽어 다른 것)만 배지로 튄다.
//
// 왜 '시험 읽기' 가 먼저인가: 한 권 읽는 데 VL 을 수십 번 부른다(돈과 시간). 처음 보는 판형에
// 통째로 쓰기 전에 첫 쪽만 읽어 번호와 정답이 잡히는지 눈으로 확인한다.
//
// Radix Portal 은 이 프로젝트에서 안 보이는 버그가 있어(dev-rules) 순수 HTML/CSS 모달이다.
import { useEffect, useState } from 'react';
import { supabase } from '@shared/supabase/client';
import { Button } from '@shared/ui/button';
import { toast } from '@shared/hooks/use-toast';
import { MathInput } from '@shared/ui/MathInput';
import { Loader2, Upload, CheckCircle2, AlertTriangle, FlaskConical } from 'lucide-react';
import 'katex/dist/katex.min.css';

const PIPELINE_URL = import.meta.env.VITE_PIPELINE_URL || 'http://localhost:8001';

interface Row {
  staging_id: string;
  problem_number: number;
  source_label: string;
  image_url: string | null;
  current_answer: string;
  answer: string;
  answer_type: string;
  needs_review: boolean;
  note: string;
  matched: boolean;
}

interface Preview {
  total: number;
  matched: number;
  needs_review: number;
  answer_key_size: number;
  folder_id: string | null;
  rows: Row[];
}

/** 한 스코프(교재 전체 또는 폴더 하나)에 저장된 답지 현황. */
interface ScopeStat {
  folder_id: string | null;
  count: number;
  needs_review: number;
  label_min: string | null;
  label_max: string | null;
  source_pdf: string | null;
  updated_at: string | null;
}

interface ProbeResult {
  source_pdf: string;
  page: number;
  count: number;
  items: { label: string; answer: string; needs_review: boolean; note: string }[];
  plan: { pages: number; columns: number; calls_max: number };
}

interface Props {
  /** 상세 입력에서 열면 그 작업 id. 교재 관리에서 열면 없다(업로드·현황만 보인다). */
  jobId?: string | null;
  textbookId: string | null;
  textbookName?: string | null;
  /** 이 폴더(모의고사 회차·내신 학교)에 답지를 매려면. 없으면 교재 전체. */
  folderId?: string | null;
  folderName?: string | null;
  onClose: () => void;
  onApplied?: () => void;
}

export function AnswerKeyModal({
  jobId, textbookId, textbookName, folderId, folderName, onClose, onApplied,
}: Props) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [stats, setStats] = useState<ScopeStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'probe' | 'read' | 'apply' | null>(null);
  const [onlyReview, setOnlyReview] = useState(false);

  // 시험 읽기 결과와, 그때 고른 파일. 전체 읽기는 이 파일을 다시 올린다.
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  // 같은 PDF 를 이미 읽었을 때만 켜진다 — 되묻고 나서 다시 읽는 용도.
  const [confirmReread, setConfirmReread] = useState(false);

  // 답지를 어디에 맬 것인가. 폴더가 주어졌으면 그 폴더가 기본이다.
  const [scope, setScope] = useState<'textbook' | 'folder'>('textbook');
  // job 에서 열었을 때 스코프로 쓸 폴더(미리보기가 알려준다) + 이름.
  const [jobFolderId, setJobFolderId] = useState<string | null>(null);
  const [resolvedFolderName, setResolvedFolderName] = useState<string | null>(folderName ?? null);

  const activeFolderId = folderId ?? jobFolderId;

  const loadStats = async () => {
    if (!textbookId) return;
    try {
      const res = await fetch(`${PIPELINE_URL}/api/answer-key/${textbookId}`);
      if (res.ok) setStats(((await res.json()).scopes ?? []) as ScopeStat[]);
    } catch {
      /* 현황은 참고용이라 실패해도 화면을 막지 않는다 */
    }
  };

  const loadPreview = async () => {
    if (!jobId) return;
    const res = await fetch(`${PIPELINE_URL}/api/staging/${jobId}/answer-preview`);
    if (!res.ok) throw new Error((await res.json()).detail || '미리보기 실패');
    const data: Preview = await res.json();
    setPreview(data);
    setRows(data.rows);
    setJobFolderId(data.folder_id);
  };

  const load = async () => {
    setLoading(true);
    try {
      await Promise.all([loadStats(), loadPreview()]);
    } catch (e: any) {
      toast({ title: '오류', description: e.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [jobId, textbookId]);

  // 폴더가 정해지면 그 폴더를 기본 스코프로 삼고, 이름을 가져와 보여준다.
  useEffect(() => {
    if (!activeFolderId) return;
    setScope('folder');
    if (resolvedFolderName) return;
    supabase.from('problem_folders').select('name').eq('id', activeFolderId).maybeSingle()
      .then(({ data }) => { if (data?.name) setResolvedFolderName(data.name); });
  }, [activeFolderId]);

  const scopeFolderId = scope === 'folder' ? activeFolderId : null;
  const currentStat = stats.find(s => (s.folder_id ?? null) === scopeFolderId);
  const bookStat = stats.find(s => s.folder_id == null);

  /** 첫 쪽만 읽어 본다 — 저장하지 않는다. */
  const runProbe = async (file: File, page = 1) => {
    if (!textbookId) {
      toast({ title: '교재가 없습니다', description: '이 작업에 교재가 지정돼 있지 않습니다.', variant: 'destructive' });
      return;
    }
    setBusy('probe');
    setProbe(null);
    setConfirmReread(false);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('page', String(page));
      const res = await fetch(`${PIPELINE_URL}/api/answer-key/${textbookId}/probe`, { method: 'POST', body: fd });
      if (!res.ok) throw new Error((await res.json()).detail || '시험 읽기 실패');
      const j: ProbeResult = await res.json();
      setProbe(j);
      setPendingFile(file);
      if (!j.count) {
        toast({
          title: '이 쪽에서는 정답을 못 찾았습니다',
          description: '표지나 학습플래너 쪽일 수 있습니다. 다른 쪽으로 다시 시험해 보세요.',
        });
      }
    } catch (e: any) {
      toast({ title: '오류', description: e.message, variant: 'destructive' });
    } finally {
      setBusy(null);
    }
  };

  /** 확인했으면 나머지를 전부 읽어 저장한다. */
  const runFullRead = async (force = false) => {
    if (!textbookId || !pendingFile) return;
    setBusy('read');
    try {
      const fd = new FormData();
      fd.append('file', pendingFile);
      if (scopeFolderId) fd.append('folder_id', scopeFolderId);
      if (force) fd.append('force', 'true');
      const res = await fetch(`${PIPELINE_URL}/api/answer-key/${textbookId}`, { method: 'POST', body: fd });
      if (res.status === 409) {
        setConfirmReread(true);
        toast({ title: '이미 읽은 PDF 입니다', description: (await res.json()).detail });
        return;
      }
      if (!res.ok) throw new Error((await res.json()).detail || '읽기 실패');
      const j = await res.json();
      toast({ title: '정답표를 읽었습니다', description: `${j.count}개 (확인 필요 ${j.needs_review}개)` });
      setProbe(null);
      setPendingFile(null);
      await load();
    } catch (e: any) {
      toast({ title: '오류', description: e.message, variant: 'destructive' });
    } finally {
      setBusy(null);
    }
  };

  const apply = async () => {
    const items = rows
      .filter(r => r.answer.trim())
      .map(r => ({ staging_id: r.staging_id, answer: r.answer.trim(), answer_type: r.answer_type }));
    if (!items.length || !jobId) return;
    setBusy('apply');
    try {
      const res = await fetch(`${PIPELINE_URL}/api/staging/${jobId}/answer-apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      });
      if (!res.ok) throw new Error('적용 실패');
      const j = await res.json();
      toast({ title: '적용 완료', description: `${j.applied}개에 정답을 넣었습니다.` });
      onApplied?.();
      onClose();
    } catch (e: any) {
      toast({ title: '오류', description: e.message, variant: 'destructive' });
    } finally {
      setBusy(null);
    }
  };

  const patch = (id: string, next: Partial<Row>) =>
    setRows(prev => prev.map(r => (r.staging_id === id ? { ...r, ...next } : r)));

  const shown = onlyReview ? rows.filter(r => r.needs_review || !r.matched) : rows;
  const fillable = rows.filter(r => r.answer.trim()).length;
  const noKey = !currentStat && !bookStat;
  const minutes = probe ? Math.max(1, Math.round((probe.plan.calls_max * 16) / 60)) : 0;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center">
      <div className="fixed inset-0 bg-black/80" onClick={onClose} />
      <div className="relative z-[10000] bg-background border rounded-lg shadow-lg w-full max-w-5xl max-h-[88vh] flex flex-col">
        <div className="px-5 py-3 border-b flex items-center justify-between shrink-0">
          <div>
            <h2 className="font-semibold">
              빠른정답{textbookName ? ` — ${textbookName}` : ''}
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              {preview ? (
                <>
                  문제 {preview.total}개 중 <b>{preview.matched}개</b> 매칭
                  {preview.needs_review > 0 && <> · 확인 필요 <b className="text-orange-600">{preview.needs_review}개</b></>}
                  {' · '}쓸 수 있는 정답 {preview.answer_key_size}개
                </>
              ) : (
                '빠른정답 PDF 를 한 번 읽어 두면, 크롭한 문제의 지면번호로 정답이 자동으로 채워집니다.'
              )}
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>닫기</Button>
        </div>

        {/* ── 답지 범위 ─────────────────────────────────────────────
            모의고사·내신은 회차/학교마다 1~30번이 겹친다. 교재 전체로 담으면
            나중 답지가 앞 회차를 덮어쓰므로 어디에 맬지 분명히 고르게 한다. */}
        {activeFolderId && (
          <div className="px-5 py-2.5 border-b shrink-0 bg-muted/30">
            <p className="text-xs font-medium mb-1.5">이 답지의 범위</p>
            <div className="flex flex-col gap-1">
              <label className="text-sm inline-flex items-start gap-2 cursor-pointer">
                <input type="radio" className="mt-1" checked={scope === 'folder'}
                  onChange={() => setScope('folder')} />
                <span>
                  <b>{resolvedFolderName || '이 폴더'}</b> — 이 시험/회차에만
                  <span className="block text-xs text-muted-foreground">
                    모의고사·내신처럼 회차마다 1~30번이 겹칠 때 고르세요.
                  </span>
                </span>
              </label>
              <label className="text-sm inline-flex items-start gap-2 cursor-pointer">
                <input type="radio" className="mt-1" checked={scope === 'textbook'}
                  onChange={() => setScope('textbook')} />
                <span>
                  교재 전체
                  <span className="block text-xs text-muted-foreground">
                    쎈·기본서처럼 번호가 책 전체에서 유일한 교재. 한 번 읽어두면 다른 단원은 PDF 없이 채워집니다.
                  </span>
                </span>
              </label>
            </div>
          </div>
        )}

        <div className="px-5 py-2 border-b flex items-center gap-3 shrink-0 flex-wrap">
          <label className="inline-flex">
            <input
              type="file"
              accept="application/pdf"
              className="hidden"
              disabled={busy !== null}
              onChange={e => { const f = e.target.files?.[0]; if (f) runProbe(f); e.target.value = ''; }}
            />
            <span className="inline-flex items-center gap-1 h-8 px-3 rounded-md border text-sm cursor-pointer hover:bg-muted">
              {busy === 'probe' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
              빠른정답 PDF 넣기
            </span>
          </label>

          {/* 저장된 답지 현황 — 돈을 또 쓸지 판단하는 근거 */}
          {currentStat ? (
            <span className="text-xs text-muted-foreground">
              {scopeFolderId ? '이 회차' : '교재 전체'} 답지 <b>{currentStat.count}개</b>
              {currentStat.label_min && ` (${currentStat.label_min}~${currentStat.label_max})`}
              {currentStat.source_pdf && ` · ${currentStat.source_pdf}`}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">
              {scopeFolderId ? '이 회차에 저장된 답지가 없습니다.' : '이 교재에 저장된 답지가 없습니다.'}
              {scopeFolderId && bookStat && ` (교재 전체 답지 ${bookStat.count}개는 그대로 쓰입니다)`}
            </span>
          )}

          {rows.length > 0 && (
            <label className="text-sm inline-flex items-center gap-1.5 cursor-pointer ml-auto">
              <input type="checkbox" checked={onlyReview} onChange={e => setOnlyReview(e.target.checked)} />
              확인이 필요한 것만 보기
            </label>
          )}
        </div>

        {/* ── 시험 읽기 결과 ───────────────────────────────────────── */}
        {probe && (
          <div className="px-5 py-3 border-b shrink-0 bg-blue-50/50 dark:bg-blue-950/20">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-medium flex items-center gap-1.5">
                  <FlaskConical className="h-3.5 w-3.5" />
                  {probe.page}쪽 시험 읽기 — 정답 {probe.count}개
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  전체는 {probe.plan.pages}쪽 · 단 {probe.plan.columns}개 →
                  최대 {probe.plan.calls_max}회 읽기, 약 {minutes}분 걸립니다.
                  {probe.count === 0 && ' 이 쪽에는 정답이 없어 보입니다.'}
                </p>
                {probe.items.length > 0 && (
                  <p className="text-xs mt-1.5 font-mono truncate">
                    {probe.items.slice(0, 8).map(i => `${i.label} ${i.answer}`).join('   ')}
                    {probe.items.length > 8 && ' …'}
                  </p>
                )}
              </div>
              <div className="flex flex-col gap-1.5 shrink-0">
                <Button size="sm" onClick={() => runFullRead(confirmReread)} disabled={busy !== null}>
                  {busy === 'read' ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : null}
                  {confirmReread ? '그래도 전부 읽기' : '나머지 전부 읽기'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { setProbe(null); setPendingFile(null); }}
                  disabled={busy !== null}>
                  취소
                </Button>
              </div>
            </div>
            {busy === 'read' && (
              <p className="text-xs text-muted-foreground mt-2">
                읽는 중… 창을 닫지 마세요. 한 번 읽어두면 같은 범위는 다시 읽을 필요가 없습니다.
              </p>
            )}
          </div>
        )}

        {/* ── 검수 표 (상세 입력에서 연 경우만) ─────────────────────── */}
        <div className="flex-1 overflow-y-auto px-5 py-3">
          {loading ? (
            <div className="py-16 text-center text-sm text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2" />불러오는 중…
            </div>
          ) : !jobId ? (
            <div className="py-14 text-center text-sm text-muted-foreground">
              {noKey
                ? <>아직 저장된 답지가 없습니다. 위에서 빠른정답 PDF 를 넣어 주세요.<br />
                    첫 쪽만 먼저 읽어 확인한 뒤 전체를 읽습니다.</>
                : <>답지가 저장돼 있습니다. 문제에 채워 넣으려면<br />
                    <b>PDF 교재 문제 검수 → 상세 입력</b> 에서 “빠른정답으로 채우기” 를 누르세요.</>}
            </div>
          ) : rows.length === 0 ? (
            <div className="py-14 text-center text-sm text-muted-foreground">
              채울 문제가 없습니다.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr className="border-b">
                  <th className="text-left py-1.5 w-14">문제</th>
                  <th className="text-left w-16">지면</th>
                  <th className="text-left w-16">문제</th>
                  <th className="text-left w-24">유형</th>
                  <th className="text-left">정답</th>
                </tr>
              </thead>
              <tbody>
                {shown.map(r => (
                  <tr key={r.staging_id} className={`border-b align-top ${r.needs_review ? 'bg-orange-50/60' : ''}`}>
                    <td className="py-2 font-medium">{r.problem_number}번</td>
                    <td className="text-muted-foreground">{r.source_label || '—'}</td>
                    <td>
                      {r.image_url
                        ? <img src={r.image_url} alt="" className="h-10 w-12 object-cover object-left-top rounded border" />
                        : <span className="text-xs text-muted-foreground">—</span>}
                    </td>
                    <td>
                      <select
                        value={r.answer_type}
                        onChange={e => patch(r.staging_id, { answer_type: e.target.value })}
                        className="h-8 rounded-md border border-input bg-background px-2 text-sm"
                      >
                        <option value="multiple_choice">객관식</option>
                        <option value="short_answer">주관식</option>
                      </select>
                    </td>
                    <td className="pb-2">
                      <MathInput
                        value={r.answer}
                        onChange={next => patch(r.staging_id, { answer: next })}
                        placeholder={r.matched ? '' : '정답표에 없음 — 직접 입력'}
                      />
                      {(r.needs_review || !r.matched) && (
                        <p className="text-xs text-orange-600 mt-0.5 flex items-center gap-1">
                          <AlertTriangle className="h-3 w-3" />{r.note}
                        </p>
                      )}
                      {r.current_answer && r.current_answer !== r.answer && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          지금 값: {r.current_answer} → 덮어씁니다
                        </p>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="px-5 py-3 border-t flex items-center justify-between shrink-0">
          <p className="text-xs text-muted-foreground">
            {jobId
              ? <>{onlyReview && `${shown.length}개만 보는 중 — `}적용하면 {fillable}개 문제에 정답이 들어갑니다.</>
              : '정답표는 교재에 저장돼 다음 단원에서도 그대로 쓰입니다.'}
          </p>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>{jobId ? '취소' : '닫기'}</Button>
            {jobId && (
              <Button onClick={apply} disabled={busy !== null || !fillable}>
                {busy === 'apply' ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <CheckCircle2 className="h-4 w-4 mr-1" />}
                {fillable}개 적용
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
