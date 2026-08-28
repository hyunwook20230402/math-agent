import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@shared/supabase/client';
import { useAuth } from '@shared/hooks/useAuth';
import { Button } from '@shared/ui/button';
import { Input } from '@shared/ui/input';
import { Label } from '@shared/ui/label';
import { toast } from '@shared/hooks/use-toast';
import { Upload, FileText, Loader2, AlertTriangle } from 'lucide-react';
import type { Textbook, ProblemFolder } from '@shared/types/database';

const PIPELINE_URL =
  (import.meta.env.VITE_TUTOR_API_URL as string | undefined) || 'http://localhost:8001';

/** 교재 PDF 안의 '단계' 구간 (쎈 B단계 / C단계 …). thumb 은 그 구간 첫 쪽의 배너 그림. */
interface Section {
  page_start: number;
  page_end: number;
  banner_page: number | null;
  thumb: string;
}

interface PdfUploadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  textbook: Textbook;
  folder: ProblemFolder | null;
}

const PdfUploadDialog = ({ open, onOpenChange, textbook, folder }: PdfUploadDialogProps) => {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const [file, setFile] = useState<File | null>(null);
  const [category, setCategory] = useState('쎈');
  const [pdfType, setPdfType] = useState<'문제' | '해설'>('문제');
  const [pageStart, setPageStart] = useState('');
  const [pageEnd, setPageEnd] = useState('');
  const [uploading, setUploading] = useState(false);
  const [jobStatus, setJobStatus] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // 단계 구간 — 파일을 고르면 백엔드가 배너를 찾아 알려준다(로컬 계산이라 무료).
  const [sections, setSections] = useState<Section[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [pickedSection, setPickedSection] = useState<number | null>(null);
  // 지금 고른 폴더가 속한 단계(예: 'B'). 조상 폴더 이름에서 찾는다.
  const [stageLetter, setStageLetter] = useState<string | null>(null);

  const statusLabel: Record<string, string> = {
    queued: '대기 중',
    extracting: '텍스트 추출 중',
    converting: '이미지 변환 중',
    detecting: '문제 번호 감지 중',
    splitting: '문제 분리 중',
    uploading: '이미지 업로드 중',
    saving: '저장 중',
    done: '완료',
    error: '오류',
  };

  // 고른 폴더의 조상 중 'B단계' 같은 이름을 찾는다.
  // 사용자는 보통 `B단계 > 나머지정리와 인수분해` 처럼 **자식 폴더**를 고르므로,
  // 폴더 이름만 봐서는 단계를 알 수 없어 위로 거슬러 올라간다.
  useEffect(() => {
    if (!open || !folder) { setStageLetter(null); return; }
    let cancelled = false;
    (async () => {
      let cur: { name: string; parent_id: string | null } | null = folder;
      for (let i = 0; i < 6 && cur; i++) {
        const m = cur.name.match(/^([A-Za-z])\s*단계$/);
        if (m) { if (!cancelled) setStageLetter(m[1].toUpperCase()); return; }
        if (!cur.parent_id) break;
        const { data } = await supabase
          .from('problem_folders').select('name,parent_id').eq('id', cur.parent_id).maybeSingle();
        cur = data;
      }
      if (!cancelled) setStageLetter(null);
    })();
    return () => { cancelled = true; };
  }, [open, folder?.id]);

  const pickSection = (i: number, list: Section[] = sections) => {
    setPickedSection(i);
    setPageStart(String(list[i].page_start));
    setPageEnd(String(list[i].page_end));
  };

  const chooseFile = async (f: File | null) => {
    setFile(f);
    setSections([]);
    setPickedSection(null);
    setPageStart('');
    setPageEnd('');
    if (!f) return;

    setDetecting(true);
    try {
      const fd = new FormData();
      fd.append('file', f);
      const res = await fetch(`${PIPELINE_URL}/api/pdf/sections`, { method: 'POST', body: fd });
      if (!res.ok) return;                       // 구간 검출 실패는 조용히 넘어간다
      const found: Section[] = (await res.json()).sections ?? [];
      setSections(found);
      // 구간이 딱 둘이고 이 폴더가 B/C단계면 순서대로 미리 골라 둔다(그림이 같이 보이니
      // 틀렸으면 바로 바꿀 수 있다). 그 밖의 경우는 추측하지 않는다.
      if (found.length === 2 && (stageLetter === 'B' || stageLetter === 'C')) {
        pickSection(stageLetter === 'B' ? 0 : 1, found);
      }
    } catch {
      /* 검출은 편의 기능이라 실패해도 업로드를 막지 않는다 */
    } finally {
      setDetecting(false);
    }
  };

  const handleUpload = async () => {
    if (!file || !profile) return;

    setUploading(true);
    setErrorMessage(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('teacher_id', profile.id);
      formData.append('category', category);
      formData.append('pdf_type', pdfType);
      formData.append('textbook_id', textbook.id);
      // 폴더는 화면에서 고르지 않는다 — 사이드바에서 열어둔 폴더로, 아니면 교재 루트로.
      // 폴더가 한 컬럼(folder_id)으로 통합돼 깊이에 상관없이 이 값 하나면 된다.
      if (folder?.id) {
        formData.append('folder_id', folder.id);
      }
      if (pageStart) formData.append('page_start', pageStart);
      if (pageEnd) formData.append('page_end', pageEnd);

      const res = await fetch(`${PIPELINE_URL}/api/upload`, {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || '업로드 실패');
      }

      const data = await res.json();

      const extractRes = await fetch(`${PIPELINE_URL}/api/extract/${data.job_id}`, {
        method: 'POST',
      });

      if (!extractRes.ok) {
        const err = await extractRes.json();
        throw new Error(err.detail || '추출 시작 실패');
      }

      toast({ title: '추출 시작', description: pdfType === '해설' ? '해설 페이지 업로드 중입니다...' : '문제 추출 중입니다...' });
      startPolling(data.job_id);
    } catch (e: any) {
      setErrorMessage(e.message);
      toast({ title: '오류', description: e.message, variant: 'destructive' });
      setUploading(false);
    }
  };

  const startPolling = (id: string) => {
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`${PIPELINE_URL}/api/jobs/${id}`);
        const job = await res.json();
        setJobStatus(job.status);

        if (job.status === 'done') {
          clearInterval(interval);
          setUploading(false);
          toast({ title: '완료', description: `${job.total_problems}개 문제 추출 완료` });
          onOpenChange(false);
          navigate(`/cms/import/${id}`);
        } else if (job.status === 'error') {
          clearInterval(interval);
          setUploading(false);
          setErrorMessage(job.error || '추출 실패');
          toast({ title: '오류', description: job.error || '추출 실패', variant: 'destructive' });
        }
      } catch {
        clearInterval(interval);
        setUploading(false);
      }
    }, 2000);
  };

  const resetForm = () => {
    setFile(null);
    setPdfType('문제');
    setPageStart('');
    setPageEnd('');
    setSections([]);
    setPickedSection(null);
    setJobStatus(null);
    setErrorMessage(null);
    setUploading(false);
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center">
      <div
        className="fixed inset-0 bg-black/80"
        onClick={() => { if (!uploading) { onOpenChange(false); resetForm(); } }}
      />
      <div className="relative z-[10000] bg-background border rounded-lg shadow-lg w-full max-w-md max-h-[88vh] overflow-y-auto p-6 space-y-4">
        <div className="space-y-3">
          <h2 className="text-lg font-semibold">PDF에서 문제 가져오기</h2>
          <p className="text-sm text-muted-foreground">
            교재: <span className="font-medium text-foreground">{textbook.name}</span>
            {folder && <> · 폴더: <span className="font-medium text-foreground">{folder.name}</span></>}
          </p>
        </div>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>PDF 종류</Label>
              <select
                value={pdfType}
                onChange={(e) => setPdfType(e.target.value as '문제' | '해설')}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
              >
                <option value="문제">문제</option>
                <option value="해설">해설</option>
              </select>
            </div>
            <div>
              <Label>교재 종류</Label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
              >
                <option value="쎈">쎈</option>
                <option value="모의고사">모의고사</option>
                <option value="내신">내신</option>
                <option value="연산">연산</option>
                <option value="자작">자작</option>
              </select>
            </div>
          </div>

          <div>
            <Label>PDF 파일</Label>
            <div className="border-2 border-dashed rounded-lg p-4 text-center mt-1">
              <input
                type="file"
                accept=".pdf"
                onChange={(e) => chooseFile(e.target.files?.[0] || null)}
                className="hidden"
                id="pdf-upload-dialog"
              />
              <label htmlFor="pdf-upload-dialog" className="cursor-pointer">
                <FileText className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
                {file ? (
                  <p className="text-sm font-medium text-primary">{file.name}</p>
                ) : (
                  <p className="text-sm text-muted-foreground">클릭하여 파일 선택</p>
                )}
              </label>
            </div>
          </div>

          {/* ── 단계 구간 ────────────────────────────────────────────
              한 단원 PDF 에 B단계·C단계가 이어져 있으면 통째로 자를 때 한 폴더에 섞인다.
              배너가 있는 쪽을 찾아 구간을 보여주고, 고르면 아래 쪽 범위가 채워진다.
              배너 글자(B/C)는 입체 그림이라 기계가 못 읽으므로 **그림을 보고 고른다.** */}
          {detecting && (
            <p className="text-xs text-muted-foreground flex items-center gap-1.5">
              <Loader2 className="h-3 w-3 animate-spin" />단계 구간을 찾는 중…
            </p>
          )}

          {sections.length > 1 && (
            <div className="rounded-lg border p-3 space-y-2">
              <p className="text-sm font-medium">
                이 PDF 는 {sections.length}개 단계로 나뉩니다
                {stageLetter && <> — 이 폴더는 <b>{stageLetter}단계</b>입니다</>}
              </p>
              <p className="text-xs text-muted-foreground">
                넣을 구간을 고르세요. 고른 구간의 쪽만 잘립니다.
              </p>
              <div className="space-y-1.5">
                {sections.map((s, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => pickSection(i)}
                    disabled={uploading}
                    className={`w-full flex items-center gap-3 rounded-md border p-1.5 text-left transition-colors ${
                      pickedSection === i ? 'border-primary bg-primary/5' : 'hover:bg-muted'
                    }`}
                  >
                    <img src={s.thumb} alt="" className="h-10 w-32 object-cover object-left rounded border bg-white" />
                    <span className="text-sm">
                      {s.page_start}~{s.page_end}쪽
                      <span className="block text-xs text-muted-foreground">
                        {s.page_end - s.page_start + 1}쪽 분량
                      </span>
                    </span>
                    {pickedSection === i && <span className="ml-auto text-xs text-primary font-medium">선택됨</span>}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>시작 페이지 (선택)</Label>
              <Input
                type="number"
                min="1"
                placeholder="1"
                value={pageStart}
                onChange={(e) => { setPageStart(e.target.value); setPickedSection(null); }}
              />
            </div>
            <div>
              <Label>끝 페이지 (선택)</Label>
              <Input
                type="number"
                min="1"
                placeholder="전체"
                value={pageEnd}
                onChange={(e) => { setPageEnd(e.target.value); setPickedSection(null); }}
              />
            </div>
          </div>

          {uploading && jobStatus && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground bg-muted p-3 rounded-lg">
              <Loader2 className="h-4 w-4 animate-spin" />
              {statusLabel[jobStatus] || jobStatus}
            </div>
          )}

          {errorMessage && (
            <div className="flex items-start gap-3 p-3 rounded-lg border border-destructive/50 bg-destructive/10 text-destructive text-sm">
              <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5" />
              <div>
                <p className="font-medium">추출 실패</p>
                <p className="mt-1">{errorMessage}</p>
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => { onOpenChange(false); resetForm(); }} disabled={uploading}>
            취소
          </Button>
          <Button onClick={handleUpload} disabled={!file || uploading}>
            {uploading ? (
              <><Loader2 className="h-4 w-4 mr-2 animate-spin" />처리 중...</>
            ) : (
              <><Upload className="h-4 w-4 mr-2" />업로드 및 추출</>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default PdfUploadDialog;
