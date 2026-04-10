import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@shared/hooks/useAuth';
import { Button } from '@shared/ui/button';
import { Input } from '@shared/ui/input';
import { Label } from '@shared/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@shared/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@shared/ui/select';
import { toast } from '@shared/hooks/use-toast';
import { Upload, FileText, Loader2 } from 'lucide-react';
import type { Textbook, Chapter } from '@shared/types/database';

const PIPELINE_URL = 'http://localhost:8000';

interface PdfUploadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  textbook: Textbook;
  chapter: Chapter | null;
}

const PdfUploadDialog = ({ open, onOpenChange, textbook, chapter }: PdfUploadDialogProps) => {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const [file, setFile] = useState<File | null>(null);
  const [category, setCategory] = useState('쎈');
  const [pageStart, setPageStart] = useState('');
  const [pageEnd, setPageEnd] = useState('');
  const [uploading, setUploading] = useState(false);
  const [jobStatus, setJobStatus] = useState<string | null>(null);

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

  const handleUpload = async () => {
    if (!file || !profile) return;

    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('teacher_id', profile.id);
      formData.append('category', category);
      formData.append('textbook_id', textbook.id);
      if (chapter) {
        formData.append('chapter_id', chapter.id);
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

      // 추출 시작
      const extractRes = await fetch(`${PIPELINE_URL}/api/extract/${data.job_id}`, {
        method: 'POST',
      });

      if (!extractRes.ok) {
        const err = await extractRes.json();
        throw new Error(err.detail || '추출 시작 실패');
      }

      toast({ title: '추출 시작', description: '문제 추출 중입니다...' });
      startPolling(data.job_id);
    } catch (e: any) {
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
    setPageStart('');
    setPageEnd('');
    setJobStatus(null);
    setUploading(false);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!uploading) { onOpenChange(v); if (!v) resetForm(); } }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>PDF에서 문제 가져오기</DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground">{textbook.name}</span>
            {chapter && <span> &gt; {chapter.name}</span>}
            에 문제를 등록합니다
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label>교재 종류</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="쎈">쎈</SelectItem>
                <SelectItem value="모의고사">모의고사</SelectItem>
                <SelectItem value="연산">연산</SelectItem>
                <SelectItem value="자작">자작</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label>PDF 파일</Label>
            <div className="border-2 border-dashed rounded-lg p-4 text-center mt-1">
              <input
                type="file"
                accept=".pdf"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
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

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>시작 페이지 (선택)</Label>
              <Input
                type="number"
                min="1"
                placeholder="1"
                value={pageStart}
                onChange={(e) => setPageStart(e.target.value)}
              />
            </div>
            <div>
              <Label>끝 페이지 (선택)</Label>
              <Input
                type="number"
                min="1"
                placeholder="전체"
                value={pageEnd}
                onChange={(e) => setPageEnd(e.target.value)}
              />
            </div>
          </div>

          {uploading && jobStatus && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground bg-muted p-3 rounded-lg">
              <Loader2 className="h-4 w-4 animate-spin" />
              {statusLabel[jobStatus] || jobStatus}
            </div>
          )}
        </div>

        <DialogFooter>
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
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default PdfUploadDialog;
