/**
 * 해설지 크롭 검수 페이지
 *
 * 1) 해설지 PDF 업로드
 * 2) 백엔드에서 자동 크롭 + 정답 추출
 * 3) 페이지별 bbox 편집기로 검수
 * 4) "AI 태깅 시작" 버튼 → 병합/업로드/Qwen 태깅 (백그라운드)
 * 5) 완료 시 매칭 결과를 문제 staging에 적용 → 상세 입력 페이지로 이동
 */
import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '@shared/hooks/useAuth';
import { Button } from '@shared/ui/button';
import { toast } from '@shared/hooks/use-toast';
import {
  ArrowLeft, Upload, Loader2, RotateCcw, Check, SkipForward,
} from 'lucide-react';
import BboxEditor, { type BboxItem } from '@/components/BboxEditor';

const PIPELINE_URL = 'http://localhost:8000';

interface SolutionItem {
  number: number;
  bbox: { x1: number; y1: number; x2: number; y2: number };
  cropped_path: string;
  is_fragment: boolean;
}

interface PageData {
  page_image_url: string;
  page_width: number;
  page_height: number;
  items: SolutionItem[];
}

type Stage =
  | 'idle'           // 업로드 전
  | 'uploading'      // 파일 업로드 중
  | 'extracting'     // 크롭 + 정답 추출 중
  | 'reviewing'      // 사용자 검수 중
  | 'tagging'        // 백그라운드 AI 태깅 진행 중
  | 'done'           // 태깅 완료, 적용 대기
  | 'error';

const STAGE_LABEL: Record<Stage, string> = {
  idle: '대기',
  uploading: '업로드 중',
  extracting: '크롭/정답 추출 중',
  reviewing: '크롭 검수',
  tagging: 'AI 태깅 중',
  done: '태깅 완료',
  error: '오류',
};

function itemsToBboxItems(items: SolutionItem[]): BboxItem[] {
  return items.map((it, i) => ({
    stagingId: null,
    bbox: { ...it.bbox },
    number: it.number || i + 1,
  }));
}

export default function SolutionReview() {
  const { jobId } = useParams<{ jobId: string }>();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [stage, setStage] = useState<Stage>('idle');
  const [solutionJobId, setSolutionJobId] = useState<string | null>(null);
  const [pages, setPages] = useState<number[]>([]);
  const [pageData, setPageData] = useState<Record<number, PageData>>({});
  const [activePage, setActivePage] = useState<number>(0);
  const [bboxCache, setBboxCache] = useState<Map<number, BboxItem[]>>(new Map());
  const [dirtyPages, setDirtyPages] = useState<Set<number>>(new Set());
  const [savedPages, setSavedPages] = useState<Set<number>>(new Set());
  const [savingBbox, setSavingBbox] = useState(false);
  const [bboxResetKey, setBboxResetKey] = useState(0);

  const [answers, setAnswers] = useState<Record<number, { answer: string; answer_type: string }>>({});
  const [progress, setProgress] = useState<{ processed: number; total: number } | null>(null);
  const [applying, setApplying] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string>('');

  const activePageRef = useRef<number>(0);
  useEffect(() => { activePageRef.current = activePage; }, [activePage]);

  // 현재 페이지 bbox (캐시 우선)
  const bboxItems: BboxItem[] = useMemo(() => {
    if (bboxCache.has(activePage)) return bboxCache.get(activePage)!;
    return itemsToBboxItems(pageData[activePage]?.items ?? []);
  }, [activePage, bboxCache, pageData]);

  // bbox 변경 → dirty
  const handleBboxChange = useCallback((items: BboxItem[]) => {
    const pg = activePageRef.current;
    setBboxCache(prev => {
      const next = new Map(prev);
      next.set(pg, items);
      return next;
    });
    setDirtyPages(prev => new Set([...prev, pg]));
    setSavedPages(prev => {
      const next = new Set(prev);
      next.delete(pg);
      return next;
    });
  }, []);

  const handleResetBbox = () => {
    setBboxCache(prev => {
      const next = new Map(prev);
      next.set(activePage, itemsToBboxItems(pageData[activePage]?.items ?? []));
      return next;
    });
    setDirtyPages(prev => {
      const next = new Set(prev);
      next.delete(activePage);
      return next;
    });
    setBboxResetKey(k => k + 1);
  };

  // 1. 해설지 PDF 업로드
  const handleUpload = async (file: File) => {
    if (!jobId || !profile) return;
    setStage('uploading');
    setErrorMsg('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('teacher_id', profile.id);
      fd.append('problem_job_id', jobId);

      const res = await fetch(`${PIPELINE_URL}/api/solution/upload`, {
        method: 'POST',
        body: fd,
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`업로드 실패: ${res.status} ${txt}`);
      }
      const data = await res.json();
      setSolutionJobId(data.solution_job_id);
      toast({ title: '업로드 완료', description: '해설 크롭 시작...' });
      await extractSolutions(data.solution_job_id);
    } catch (e: any) {
      setStage('error');
      setErrorMsg(e.message);
      toast({ title: '업로드 오류', description: e.message, variant: 'destructive' });
    }
  };

  // 2. 크롭 + 정답 추출 (동기 호출)
  const extractSolutions = async (sjId: string) => {
    setStage('extracting');
    try {
      const res = await fetch(`${PIPELINE_URL}/api/solution/extract/${sjId}`, {
        method: 'POST',
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`추출 실패: ${res.status} ${txt}`);
      }
      const data = await res.json();

      // page_bboxes 파싱
      const pb: Record<number, PageData> = {};
      Object.entries(data.page_bboxes).forEach(([k, v]: any) => {
        pb[Number(k)] = v as PageData;
      });
      setPageData(pb);
      const pageNums = Object.keys(pb).map(Number).sort((a, b) => a - b);
      setPages(pageNums);
      setActivePage(pageNums[0] || 0);
      setAnswers(data.answers || {});
      setStage('reviewing');
      toast({
        title: '크롭 완료',
        description: `${pageNums.length}페이지, ${data.total_numbers}개 해설 추출됨`,
      });
    } catch (e: any) {
      setStage('error');
      setErrorMsg(e.message);
      toast({ title: '추출 오류', description: e.message, variant: 'destructive' });
    }
  };

  // 3. 페이지 bbox 저장 (재크롭)
  const handleSaveBbox = async () => {
    if (!solutionJobId) return;
    setSavingBbox(true);
    try {
      const items = bboxCache.get(activePage) ?? itemsToBboxItems(pageData[activePage]?.items ?? []);
      const res = await fetch(`${PIPELINE_URL}/api/solution/${solutionJobId}/update-bboxes`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          page_number: activePage,
          items: items.map(it => ({ number: it.number, bbox: it.bbox })),
        }),
      });
      if (!res.ok) throw new Error('bbox 저장 실패');
      toast({ title: '저장 완료', description: '해당 페이지가 재크롭되었습니다.' });
      setDirtyPages(prev => {
        const next = new Set(prev);
        next.delete(activePage);
        return next;
      });
      setSavedPages(prev => new Set([...prev, activePage]));
      setBboxResetKey(k => k + 1);
    } catch (e: any) {
      toast({ title: '오류', description: e.message, variant: 'destructive' });
    } finally {
      setSavingBbox(false);
    }
  };

  // 4. AI 태깅 시작 (백그라운드)
  const handleStartTagging = async () => {
    if (!solutionJobId) return;
    if (dirtyPages.size > 0) {
      toast({
        title: '미저장 수정이 있습니다',
        description: `${[...dirtyPages].join(', ')}페이지를 먼저 저장하세요.`,
        variant: 'destructive',
      });
      return;
    }
    try {
      const res = await fetch(`${PIPELINE_URL}/api/solution/${solutionJobId}/upload-and-tag`, {
        method: 'POST',
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`태깅 시작 실패: ${txt}`);
      }
      setStage('tagging');
      toast({ title: 'AI 태깅 시작', description: '해설 이미지 병합 + Qwen 태깅 중...' });
    } catch (e: any) {
      toast({ title: '오류', description: e.message, variant: 'destructive' });
    }
  };

  // 5. 태깅 상태 폴링
  useEffect(() => {
    if (stage !== 'tagging' || !solutionJobId) return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`${PIPELINE_URL}/api/solution/status/${solutionJobId}`);
        if (!res.ok) return;
        const data = await res.json();
        if (data.progress) setProgress(data.progress);
        if (data.status === 'done') {
          setStage('done');
          clearInterval(timer);
        } else if (data.status === 'error') {
          setStage('error');
          setErrorMsg(data.error || '태깅 실패');
          clearInterval(timer);
        }
      } catch {}
    }, 2000);
    return () => clearInterval(timer);
  }, [stage, solutionJobId]);

  // 6. 문제 staging에 적용
  const handleApply = async () => {
    if (!solutionJobId || !jobId) return;
    setApplying(true);
    try {
      const res = await fetch(`${PIPELINE_URL}/api/solution/apply/${solutionJobId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ problem_job_id: jobId }),
      });
      if (!res.ok) throw new Error('적용 실패');
      const data = await res.json();
      toast({ title: '적용 완료', description: data.message });
      navigate(`/cms/pdf-review/${jobId}/details`);
    } catch (e: any) {
      toast({ title: '오류', description: e.message, variant: 'destructive' });
    } finally {
      setApplying(false);
    }
  };

  // 현재 페이지 원본 이미지
  const currentPage = pageData[activePage];
  const pageImageUrl = currentPage?.page_image_url;
  const pageWidth = currentPage?.page_width ?? 3509;
  const pageHeight = currentPage?.page_height ?? 4963;

  const currentPageDirty = dirtyPages.has(activePage);
  const answersCount = Object.keys(answers).length;

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      {/* 헤더 */}
      <div className="flex items-center justify-between px-4 py-3 border-b bg-white shrink-0">
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => navigate(`/cms/import/${jobId}`)}>
            <ArrowLeft className="h-4 w-4 mr-1" />
            문제 크롭으로
          </Button>
          <div>
            <h1 className="text-xl font-bold">해설지 크롭 검수</h1>
            <p className="text-xs text-muted-foreground">
              단계: {STAGE_LABEL[stage]}
              {progress && stage === 'tagging' && (
                <> ({progress.processed}/{progress.total})</>
              )}
              {answersCount > 0 && <> · 정답 {answersCount}개 추출됨</>}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {stage === 'reviewing' && (
            <Button size="sm" onClick={handleStartTagging}>
              <Check className="h-4 w-4 mr-1" />
              검수 완료 — AI 태깅 시작
            </Button>
          )}
          {stage === 'done' && (
            <Button size="sm" onClick={handleApply} disabled={applying}>
              {applying ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Check className="h-4 w-4 mr-1" />}
              문제에 적용 → 상세 입력
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => navigate(`/cms/pdf-review/${jobId}/details`)}
          >
            <SkipForward className="h-4 w-4 mr-1" />
            해설지 없이 건너뛰기
          </Button>
        </div>
      </div>

      {/* 본문 */}
      {stage === 'idle' || stage === 'uploading' || stage === 'extracting' ? (
        <div className="flex-1 flex items-center justify-center bg-gray-50">
          <div className="max-w-md w-full p-8 bg-white rounded-lg shadow-sm border text-center">
            <Upload className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
            <h2 className="text-lg font-semibold mb-2">해설지 PDF 업로드</h2>
            <p className="text-sm text-muted-foreground mb-4">
              해설지 PDF를 업로드하면 정답이 자동 추출되고
              <br />
              해설 영역이 페이지별로 크롭됩니다.
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf"
              className="hidden"
              onChange={e => {
                const f = e.target.files?.[0];
                if (f) handleUpload(f);
              }}
            />
            <Button
              disabled={stage !== 'idle'}
              onClick={() => fileInputRef.current?.click()}
            >
              {stage === 'idle' ? (
                <>
                  <Upload className="h-4 w-4 mr-2" />
                  PDF 선택
                </>
              ) : (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  {STAGE_LABEL[stage]}...
                </>
              )}
            </Button>
            {errorMsg && (
              <p className="mt-4 text-sm text-red-600 whitespace-pre-wrap">{errorMsg}</p>
            )}
          </div>
        </div>
      ) : stage === 'tagging' ? (
        <div className="flex-1 flex items-center justify-center bg-gray-50">
          <div className="text-center space-y-4">
            <Loader2 className="h-12 w-12 mx-auto animate-spin text-primary" />
            <p className="text-lg font-semibold">AI 태깅 진행 중</p>
            {progress && (
              <p className="text-sm text-muted-foreground">
                {progress.processed} / {progress.total}개 처리 중
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Qwen2.5-VL 7B가 해설 이미지를 분석하고 있습니다.
              <br />
              로컬 GPU 사용 — 속도는 하드웨어에 따라 다릅니다.
            </p>
          </div>
        </div>
      ) : stage === 'done' ? (
        <div className="flex-1 flex items-center justify-center bg-gray-50">
          <div className="max-w-md w-full p-8 bg-white rounded-lg shadow-sm border text-center">
            <Check className="h-12 w-12 mx-auto mb-4 text-green-500" />
            <h2 className="text-lg font-semibold mb-2">AI 태깅 완료</h2>
            <p className="text-sm text-muted-foreground mb-4">
              정답 + 해설 이미지 + 개념/스킬 태그 + 풀이 요약이 생성되었습니다.
              <br />
              "문제에 적용" 버튼을 누르면 문제 staging에 반영됩니다.
            </p>
            <Button onClick={handleApply} disabled={applying}>
              {applying ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Check className="h-4 w-4 mr-2" />}
              문제에 적용 → 상세 입력
            </Button>
          </div>
        </div>
      ) : stage === 'error' ? (
        <div className="flex-1 flex items-center justify-center bg-gray-50">
          <div className="max-w-md w-full p-8 bg-white rounded-lg border text-center">
            <p className="text-red-600 font-semibold mb-2">오류 발생</p>
            <p className="text-sm text-muted-foreground whitespace-pre-wrap">{errorMsg}</p>
          </div>
        </div>
      ) : (
        // reviewing — 크롭 검수 UI
        <div className="flex flex-1 overflow-hidden">
          {/* 좌측: 페이지 탭 + 에디터 */}
          <div className="flex flex-col flex-1 overflow-hidden border-r">
            <div className="flex gap-1 px-3 py-2 border-b bg-gray-50 overflow-x-auto shrink-0">
              {pages.map(pg => {
                const pgItems = pageData[pg]?.items ?? [];
                const isSaved = savedPages.has(pg);
                const isDirty = dirtyPages.has(pg);
                return (
                  <button
                    key={pg}
                    onClick={() => setActivePage(pg)}
                    className={`px-3 py-1 text-sm rounded border transition-colors whitespace-nowrap ${
                      activePage === pg
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-white border-gray-200 hover:bg-gray-100'
                    }`}
                  >
                    {pg}페이지
                    <span className="ml-1 text-xs opacity-70">({pgItems.length})</span>
                    {isSaved && !isDirty && <span className="ml-1 text-xs text-green-500">✓</span>}
                    {isDirty && <span className="ml-1 text-xs text-orange-400">●</span>}
                  </button>
                );
              })}
            </div>

            <div className="flex-1 overflow-auto p-3">
              {pageImageUrl ? (
                <>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-sm text-muted-foreground">
                      {activePage}페이지 — {bboxItems.length}개 해설 박스
                      {currentPageDirty && (
                        <span className="ml-2 text-orange-600 font-medium">(수정됨 — 미저장)</span>
                      )}
                    </p>
                    <div className="flex gap-2">
                      {currentPageDirty && (
                        <Button size="sm" variant="outline" onClick={handleResetBbox}>
                          <RotateCcw className="h-3 w-3 mr-1" />
                          초기화
                        </Button>
                      )}
                      <Button
                        size="sm"
                        onClick={handleSaveBbox}
                        disabled={!currentPageDirty || savingBbox}
                      >
                        {savingBbox ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : null}
                        저장
                      </Button>
                    </div>
                  </div>
                  <BboxEditor
                    pageImageUrl={pageImageUrl}
                    pageWidth={pageWidth}
                    pageHeight={pageHeight}
                    items={bboxItems}
                    onChange={handleBboxChange}
                    resetKey={bboxResetKey}
                  />
                </>
              ) : (
                <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                  페이지 이미지 로드 중...
                </div>
              )}
            </div>
          </div>

          {/* 우측: 정답 미리보기 + 해설 목록 */}
          <div className="w-64 flex flex-col overflow-hidden shrink-0">
            <div className="px-3 py-2 border-b bg-gray-50 shrink-0">
              <p className="text-sm font-medium">추출된 정답 ({answersCount}개)</p>
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-1 text-xs">
              {Object.entries(answers)
                .sort((a, b) => Number(a[0]) - Number(b[0]))
                .map(([num, a]) => (
                  <div key={num} className="flex items-center justify-between px-2 py-1 bg-white rounded border">
                    <span className="font-medium">{num}번</span>
                    <span className="text-primary">{a.answer}</span>
                    <span className="text-muted-foreground text-[10px]">
                      {a.answer_type === 'multiple_choice' ? '객관식' : '주관식'}
                    </span>
                  </div>
                ))}
              {answersCount === 0 && (
                <p className="text-muted-foreground text-center py-4">정답이 추출되지 않음</p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
