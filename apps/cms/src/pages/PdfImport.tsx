import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@shared/hooks/useAuth';
import { Button } from '@shared/ui/button';
import { Input } from '@shared/ui/input';
import { Label } from '@shared/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@shared/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@shared/ui/select';
import { toast } from '@shared/hooks/use-toast';
import { ArrowLeft, Upload, FileText, Loader2 } from 'lucide-react';

const PIPELINE_URL = 'http://localhost:8000';

const PdfImport = () => {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const [file, setFile] = useState<File | null>(null);
  const [category, setCategory] = useState('쎈');
  const [uploading, setUploading] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] || null;
    setFile(f);
  };

  const handleUpload = async () => {
    if (!file || !profile) return;

    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('teacher_id', profile.id);
      formData.append('category', category);

      const res = await fetch(`${PIPELINE_URL}/api/upload`, {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || '업로드 실패');
      }

      const data = await res.json();
      setJobId(data.job_id);

      // 추출 시작
      const extractRes = await fetch(`${PIPELINE_URL}/api/extract/${data.job_id}`, {
        method: 'POST',
      });

      if (!extractRes.ok) {
        const err = await extractRes.json();
        if (err.is_image_pdf) {
          toast({
            title: '이미지형 PDF',
            description: '현재는 텍스트형 PDF만 지원합니다. (OCR 기능은 추후 지원 예정)',
            variant: 'destructive',
          });
          return;
        }
        throw new Error(err.detail || '추출 시작 실패');
      }

      toast({ title: '추출 시작', description: '문제 추출 중입니다...' });
      startPolling(data.job_id);
    } catch (e: any) {
      toast({ title: '오류', description: e.message, variant: 'destructive' });
    } finally {
      setUploading(false);
    }
  };

  const startPolling = (id: string) => {
    setPolling(true);
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`${PIPELINE_URL}/api/jobs/${id}`);
        const job = await res.json();
        setJobStatus(job.status);

        if (job.status === 'done') {
          clearInterval(interval);
          setPolling(false);
          toast({ title: '완료', description: `${job.total_problems}개 문제 추출 완료` });
          navigate(`/cms/import/${id}`);
        } else if (job.status === 'error') {
          clearInterval(interval);
          setPolling(false);
          toast({ title: '오류', description: job.error || '추출 실패', variant: 'destructive' });
        }
      } catch {
        clearInterval(interval);
        setPolling(false);
      }
    }, 2000);
  };

  const statusLabel: Record<string, string> = {
    queued: '대기 중',
    extracting: '텍스트 추출 중',
    splitting: '문제 분리 중',
    structurizing: 'AI 구조화 중 (시간이 걸릴 수 있습니다)',
    saving: '저장 중',
    done: '완료',
    error: '오류',
  };

  return (
    <div className="container mx-auto px-4 py-6 max-w-2xl">
      <div className="flex items-center gap-4 mb-6">
        <Button variant="outline" size="sm" onClick={() => navigate('/cms')}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          돌아가기
        </Button>
        <div>
          <h1 className="text-2xl font-bold">파일에서 문제 가져오기</h1>
          <p className="text-muted-foreground">PDF 파일을 업로드하면 AI가 문제를 자동 추출합니다</p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>파일 업로드</CardTitle>
          <CardDescription>텍스트형 PDF (HWP는 추후 지원)</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>교재 종류</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
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
            <div className="border-2 border-dashed rounded-lg p-6 text-center mt-1">
              <input
                type="file"
                accept=".pdf,.hwp,.hwpx"
                onChange={handleFileChange}
                className="hidden"
                id="pdf-upload"
              />
              <label htmlFor="pdf-upload" className="cursor-pointer">
                <FileText className="h-10 w-10 mx-auto mb-2 text-muted-foreground" />
                {file ? (
                  <p className="text-sm font-medium text-primary">{file.name}</p>
                ) : (
                  <p className="text-sm text-muted-foreground">클릭하여 파일 선택</p>
                )}
              </label>
            </div>
          </div>

          {polling && jobStatus && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground bg-muted p-3 rounded-lg">
              <Loader2 className="h-4 w-4 animate-spin" />
              {statusLabel[jobStatus] || jobStatus}
            </div>
          )}

          <Button
            onClick={handleUpload}
            disabled={!file || uploading || polling}
            className="w-full"
          >
            {uploading || polling ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                처리 중...
              </>
            ) : (
              <>
                <Upload className="h-4 w-4 mr-2" />
                업로드 및 추출 시작
              </>
            )}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
};

export default PdfImport;
