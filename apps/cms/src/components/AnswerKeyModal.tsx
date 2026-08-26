// 빠른정답 PDF 로 정답을 한 번에 채우는 검수 모달.
//
// 왜 검수를 거치나: 정답이 틀리면 학생이 맞는 답을 쓰고도 오답이 된다. 그래서 바로 넣지 않고
// 읽은 결과를 표로 보여준 뒤 '적용' 을 누르게 한다. 대부분은 그냥 훑고 넘기면 되고,
// 사람이 봐야 하는 것(소문항·한글·여러 값·두 번 읽어 다른 것)만 배지로 튄다.
//
// Radix Portal 은 이 프로젝트에서 안 보이는 버그가 있어(dev-rules) 순수 HTML/CSS 모달이다.
import { useEffect, useState } from 'react';
import { Button } from '@shared/ui/button';
import { toast } from '@shared/hooks/use-toast';
import { MathInput } from '@shared/ui/MathInput';
import { Loader2, Upload, CheckCircle2, AlertTriangle } from 'lucide-react';
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
  rows: Row[];
}

interface Props {
  jobId: string;
  textbookId: string | null;
  onClose: () => void;
  onApplied: () => void;
}

export function AnswerKeyModal({ jobId, textbookId, onClose, onApplied }: Props) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [onlyReview, setOnlyReview] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${PIPELINE_URL}/api/staging/${jobId}/answer-preview`);
      if (!res.ok) throw new Error((await res.json()).detail || '미리보기 실패');
      const data: Preview = await res.json();
      setPreview(data);
      setRows(data.rows);
    } catch (e: any) {
      toast({ title: '오류', description: e.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [jobId]);

  const upload = async (file: File) => {
    if (!textbookId) {
      toast({ title: '교재가 없습니다', description: '이 작업에 교재가 지정돼 있지 않습니다.', variant: 'destructive' });
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`${PIPELINE_URL}/api/answer-key/${textbookId}`, { method: 'POST', body: fd });
      if (!res.ok) throw new Error((await res.json()).detail || '읽기 실패');
      const j = await res.json();
      toast({ title: '정답표를 읽었습니다', description: `${j.count}개 (확인 필요 ${j.needs_review}개)` });
      await load();
    } catch (e: any) {
      toast({ title: '오류', description: e.message, variant: 'destructive' });
    } finally {
      setUploading(false);
    }
  };

  const apply = async () => {
    const items = rows
      .filter(r => r.answer.trim())
      .map(r => ({ staging_id: r.staging_id, answer: r.answer.trim(), answer_type: r.answer_type }));
    if (!items.length) return;
    setApplying(true);
    try {
      const res = await fetch(`${PIPELINE_URL}/api/staging/${jobId}/answer-apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      });
      if (!res.ok) throw new Error('적용 실패');
      const j = await res.json();
      toast({ title: '적용 완료', description: `${j.applied}개에 정답을 넣었습니다.` });
      onApplied();
      onClose();
    } catch (e: any) {
      toast({ title: '오류', description: e.message, variant: 'destructive' });
    } finally {
      setApplying(false);
    }
  };

  const patch = (id: string, next: Partial<Row>) =>
    setRows(prev => prev.map(r => (r.staging_id === id ? { ...r, ...next } : r)));

  const shown = onlyReview ? rows.filter(r => r.needs_review || !r.matched) : rows;
  const fillable = rows.filter(r => r.answer.trim()).length;
  const empty = preview && preview.answer_key_size === 0;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center">
      <div className="fixed inset-0 bg-black/80" onClick={onClose} />
      <div className="relative z-[10000] bg-background border rounded-lg shadow-lg w-full max-w-5xl max-h-[88vh] flex flex-col">
        <div className="px-5 py-3 border-b flex items-center justify-between shrink-0">
          <div>
            <h2 className="font-semibold">빠른정답으로 채우기</h2>
            {preview && (
              <p className="text-xs text-muted-foreground mt-0.5">
                문제 {preview.total}개 중 <b>{preview.matched}개</b> 매칭
                {preview.needs_review > 0 && <> · 확인 필요 <b className="text-orange-600">{preview.needs_review}개</b></>}
                {' · '}교재 정답표 {preview.answer_key_size}개
              </p>
            )}
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>닫기</Button>
        </div>

        <div className="px-5 py-2 border-b flex items-center gap-3 shrink-0 flex-wrap">
          <label className="inline-flex">
            <input
              type="file"
              accept="application/pdf"
              className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ''; }}
            />
            <span className="inline-flex items-center gap-1 h-8 px-3 rounded-md border text-sm cursor-pointer hover:bg-muted">
              {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
              {empty ? '빠른정답 PDF 넣기' : '빠른정답 PDF 다시 읽기'}
            </span>
          </label>
          {uploading && <span className="text-xs text-muted-foreground">읽는 중… 교재 한 권에 5~7분 걸립니다.</span>}
          {!empty && (
            <label className="text-sm inline-flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" checked={onlyReview} onChange={e => setOnlyReview(e.target.checked)} />
              확인이 필요한 것만 보기
            </label>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-3">
          {loading ? (
            <div className="py-16 text-center text-sm text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2" />불러오는 중…
            </div>
          ) : empty ? (
            <div className="py-16 text-center text-sm text-muted-foreground">
              이 교재에 저장된 정답표가 없습니다. 빠른정답 PDF 를 한 번 넣어 주세요.<br />
              한 번 읽어 두면 같은 교재의 다른 단원은 PDF 없이 바로 채워집니다.
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
            {onlyReview && `${shown.length}개만 보는 중 — `}적용하면 {fillable}개 문제에 정답이 들어갑니다.
          </p>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>취소</Button>
            <Button onClick={apply} disabled={applying || !fillable || !!empty}>
              {applying ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <CheckCircle2 className="h-4 w-4 mr-1" />}
              {fillable}개 적용
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
