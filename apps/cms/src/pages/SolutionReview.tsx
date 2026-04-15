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
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '@shared/hooks/useAuth';
import { Button } from '@shared/ui/button';
import { toast } from '@shared/hooks/use-toast';
import {
  ArrowLeft, Upload, Loader2, RotateCcw, Check, SkipForward, X,
} from 'lucide-react';
import BboxEditor, { type BboxItem } from '@/components/BboxEditor';

const PIPELINE_URL = 'http://localhost:8000';

interface SolutionItem {
  number: number | null;
  bbox: { x1: number; y1: number; x2: number; y2: number };
  cropped_path: string | null;
  is_fragment: boolean;
  box_type?: 'solution' | 'answer_table';
  group_id?: string | null;
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

function itemsToBboxItems(items: SolutionItem[], startNumber = 1): BboxItem[] {
  let counter = startNumber;
  return items.map((it) => {
    const boxType = it.box_type === 'answer_table' ? 'answer_table' : 'solution';
    // 정답표는 번호 매김 제외 — counter 증가 안 시키고 number 0 고정
    if (boxType === 'answer_table') {
      return {
        stagingId: null,
        bbox: { ...it.bbox },
        number: 0,
        groupId: it.group_id ?? null,
        boxType,
        numberExplicit: true, // 정답표는 저장 필요 (number=0 고정값)
      };
    }
    const hasNum = typeof it.number === 'number' && it.number > 0;
    const num = hasNum ? (it.number as number) : counter;
    if (!hasNum) counter += 1;
    else counter = Math.max(counter, num + 1); // 실제값 뒤에 이어지는 fallback도 중복 없이
    return {
      stagingId: null,
      bbox: { ...it.bbox },
      number: num,
      groupId: it.group_id ?? null,
      boxType,
      numberExplicit: hasNum, // DB/OCR 실제값만 explicit=true, fallback은 false
    };
  });
}

function genGroupId(): string {
  return 'g_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

export default function SolutionReview() {
  const { jobId } = useParams<{ jobId: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
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
  const [selectedBboxIdx, setSelectedBboxIdx] = useState<number | null>(null);
  const [mergeAnchorIdx, setMergeAnchorIdx] = useState<number | null>(null);
  /** 페이지별 사용자 지정 시작 번호 (입력 전엔 computeStartNumber fallback) */
  const [pageStartNumbers, setPageStartNumbers] = useState<Record<number, number>>({});

  // ── 박스 편집 핸들러 ─────────────────────────────────────────────

  /** 특정 페이지보다 앞선 페이지의 해설 박스 수 누적 → 이어지는 번호 fallback용 */
  const computeStartNumber = useCallback((targetPage: number): number => {
    const prior = pages.filter(p => p < targetPage);
    let count = 0;
    for (const p of prior) {
      const cached = bboxCache.get(p);
      if (cached) {
        count += cached.filter(it => it.boxType !== 'answer_table').length;
      } else {
        // 정답표 제외한 solution 박스만 카운트
        const items = pageData[p]?.items ?? [];
        count += items.filter(it => it.box_type !== 'answer_table').length;
      }
    }
    return count + 1;
  }, [pages, bboxCache, pageData]);

  /** 현재 activePage bbox를 교체하고 dirty 처리 */
  const updateCurrentPageBboxes = useCallback((updater: (prev: BboxItem[]) => BboxItem[]) => {
    const pg = activePageRef.current;
    setBboxCache(prev => {
      const startNum = pageStartNumbersRef.current[pg] ?? computeStartNumber(pg);
      const cur = prev.get(pg) ?? itemsToBboxItems(pageData[pg]?.items ?? [], startNum);
      const next = new Map(prev);
      next.set(pg, updater(cur));
      return next;
    });
    setDirtyPages(prev => new Set([...prev, pg]));
    setSavedPages(prev => { const n = new Set(prev); n.delete(pg); return n; });
  }, [pageData, computeStartNumber]);

  /** "묶기 시작" — 첫 번째 박스 선택 시 앵커 저장 */
  const handleStartMerge = useCallback(() => {
    if (selectedBboxIdx === null) return;
    setMergeAnchorIdx(selectedBboxIdx);
    toast({ title: '두 번째 박스를 클릭하면 같은 번호로 묶입니다.' });
  }, [selectedBboxIdx]);

  /** 묶기 취소 */
  const handleCancelMerge = useCallback(() => {
    setMergeAnchorIdx(null);
  }, []);

  /** 두 번째 박스 클릭 → 앵커와 같은 groupId 부여 */
  const handleMergeSelect = useCallback((idx: number) => {
    if (mergeAnchorIdx === null || idx === mergeAnchorIdx) {
      setMergeAnchorIdx(null);
      return;
    }
    updateCurrentPageBboxes(prev => {
      const items = [...prev];
      const anchor = items[mergeAnchorIdx];
      const target = items[idx];
      if (!anchor || !target) return prev;

      const gid = anchor.groupId || target.groupId || genGroupId();
      // 앵커 번호를 정답 번호로 통일 (explicit도 승계)
      const mergedNumber = anchor.number;
      const mergedExplicit = anchor.numberExplicit ?? false;
      items[mergeAnchorIdx] = { ...anchor, groupId: gid };
      items[idx] = { ...target, groupId: gid, number: mergedNumber, numberExplicit: mergedExplicit };
      return items;
    });
    setMergeAnchorIdx(null);
    toast({ title: '박스 묶기 완료', description: '같은 번호로 그룹화되었습니다.' });
  }, [mergeAnchorIdx, updateCurrentPageBboxes]);

  /** 그룹 해제 — 선택된 박스의 groupId 제거 */
  const handleUnmerge = useCallback(() => {
    if (selectedBboxIdx === null) return;
    updateCurrentPageBboxes(prev => {
      const items = [...prev];
      const item = items[selectedBboxIdx];
      if (!item) return prev;
      items[selectedBboxIdx] = { ...item, groupId: null };
      return items;
    });
  }, [selectedBboxIdx, updateCurrentPageBboxes]);

  /** 같은 번호 자동 묶기 — 현재 페이지에서 번호가 같은 박스를 한 번에 그룹화 */
  const handleAutoGroup = useCallback(() => {
    updateCurrentPageBboxes(prev => {
      const items = [...prev];
      // 번호별로 묶기 (answer_table 제외)
      const numToGid: Record<number, string> = {};
      return items.map(it => {
        if (it.boxType === 'answer_table' || !it.number) return it;
        // 이미 그룹이 있으면 그 번호의 대표 gid로 통일
        if (!numToGid[it.number]) {
          numToGid[it.number] = it.groupId || genGroupId();
        }
        return { ...it, groupId: numToGid[it.number] };
      });
    });
    toast({ title: '자동 묶기 완료', description: '같은 번호 박스를 모두 그룹화했습니다.' });
  }, [updateCurrentPageBboxes]);

  /** 전체 그룹 해제 — 현재 페이지 모든 groupId 제거 */
  const handleUnmergeAll = useCallback(() => {
    updateCurrentPageBboxes(prev => prev.map(it => ({ ...it, groupId: null })));
    toast({ title: '전체 그룹 해제 완료' });
  }, [updateCurrentPageBboxes]);

  /** 특정 idx 박스 삭제 */
  const handleDeleteBox = useCallback((idx: number) => {
    updateCurrentPageBboxes(prev => prev.filter((_, i) => i !== idx));
    setSelectedBboxIdx(prev => {
      if (prev === null) return null;
      if (prev === idx) return null;
      return prev > idx ? prev - 1 : prev;
    });
  }, [updateCurrentPageBboxes]);

  /** 선택된 박스의 번호 변경 */
  const handleChangeNumber = useCallback((newNum: number) => {
    if (selectedBboxIdx === null || isNaN(newNum)) return;
    updateCurrentPageBboxes(prev => {
      const items = [...prev];
      const item = items[selectedBboxIdx];
      if (!item) return prev;
      items[selectedBboxIdx] = { ...item, number: newNum, numberExplicit: true };
      return items;
    });
  }, [selectedBboxIdx, updateCurrentPageBboxes]);

  /** 선택된 박스의 유형(solution/answer_table) 토글 */
  const handleToggleBoxType = useCallback(() => {
    if (selectedBboxIdx === null) return;
    updateCurrentPageBboxes(prev => {
      const items = [...prev];
      const item = items[selectedBboxIdx];
      if (!item) return prev;
      const nextType = item.boxType === 'answer_table' ? 'solution' : 'answer_table';
      // 정답표로 전환 시 번호 0, 해설로 되돌릴 땐 기존 번호 유지
      const nextNumber = nextType === 'answer_table' ? 0 : (item.number || 0);
      items[selectedBboxIdx] = { ...item, boxType: nextType, number: nextNumber };
      return items;
    });
  }, [selectedBboxIdx, updateCurrentPageBboxes]);

  // 묶기 모드: 두 번째 박스 클릭 감지
  const handleSelectionChange = useCallback((idx: number | null) => {
    setSelectedBboxIdx(idx);
    if (mergeAnchorIdx !== null && idx !== null) {
      handleMergeSelect(idx);
    }
  }, [mergeAnchorIdx, handleMergeSelect]);

  // Escape 키로 묶기 모드 취소
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleCancelMerge();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleCancelMerge]);

  // ─────────────────────────────────────────────────────────────────

  const [answers, setAnswers] = useState<Record<number, { answer: string; answer_type: string }>>({});
  const [progress, setProgress] = useState<{ processed: number; total: number } | null>(null);
  const [applying, setApplying] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string>('');

  const activePageRef = useRef<number>(0);
  useEffect(() => { activePageRef.current = activePage; }, [activePage]);

  const pageStartNumbersRef = useRef<Record<number, number>>({});
  useEffect(() => { pageStartNumbersRef.current = pageStartNumbers; }, [pageStartNumbers]);

  // 새로고침 복구: URL에 ?sj=<id>가 있으면 백엔드에서 page_bboxes 복원
  useEffect(() => {
    const sj = searchParams.get('sj');
    if (!sj || solutionJobId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${PIPELINE_URL}/api/solution/status/${sj}`);
        if (!res.ok) {
          setSearchParams(prev => {
            const next = new URLSearchParams(prev);
            next.delete('sj');
            return next;
          }, { replace: true });
          return;
        }
        const job = await res.json();
        if (cancelled) return;
        const pb = job.page_bboxes ?? job.progress?.page_bboxes ?? {};
        const parsed: Record<number, PageData> = {};
        Object.entries(pb).forEach(([k, v]: any) => { parsed[Number(k)] = v as PageData; });
        const pageNums = Object.keys(parsed).map(Number).sort((a, b) => a - b);
        if (pageNums.length === 0) return;
        setSolutionJobId(sj);
        setPageData(parsed);
        setPages(pageNums);
        setActivePage(pageNums[0]);
        // 사용자가 실제로 저장(update-bboxes) 호출한 페이지만 ✓ 복원
        const modified: number[] = (job.modified_pages ?? job.progress?.modified_pages ?? []).map(Number);
        setSavedPages(new Set(modified));
        setAnswers(job.answers ?? {});
        setStage(job.status === 'done' ? 'done' : job.status === 'queued' || job.status === 'processing' ? 'tagging' : 'reviewing');
        toast({ title: '작업 복구됨', description: `${pageNums.length}페이지 불러옴` });
      } catch (e) {
        // 복구 실패 시 조용히 무시 (업로드 화면으로)
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 현재 페이지 bbox (캐시 우선)
  const bboxItems: BboxItem[] = useMemo(() => {
    if (bboxCache.has(activePage)) return bboxCache.get(activePage)!;
    const startNum = pageStartNumbers[activePage] ?? computeStartNumber(activePage);
    return itemsToBboxItems(pageData[activePage]?.items ?? [], startNum);
  }, [activePage, bboxCache, pageData, computeStartNumber, pageStartNumbers]);

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
      const startNum = pageStartNumbers[activePage] ?? computeStartNumber(activePage);
      next.set(activePage, itemsToBboxItems(pageData[activePage]?.items ?? [], startNum));
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
      setSearchParams(prev => {
        const next = new URLSearchParams(prev);
        next.set('sj', data.solution_job_id);
        return next;
      }, { replace: true });
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
      setSavedPages(new Set());
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
      const items = bboxCache.get(activePage) ?? itemsToBboxItems(pageData[activePage]?.items ?? [], computeStartNumber(activePage));
      const res = await fetch(`${PIPELINE_URL}/api/solution/${solutionJobId}/update-bboxes`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          page_number: activePage,
          items: items.map(it => ({
            // fallback 값은 DB 오염 방지 위해 null 전송
            number: it.numberExplicit ? it.number : null,
            bbox: it.bbox,
            group_id: it.groupId ?? null,
            box_type: it.boxType ?? 'solution',
          })),
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
      <div className="flex items-center justify-between px-5 py-4 border-b bg-white shrink-0">
        <div className="flex items-center gap-4">
          <Button variant="outline" onClick={() => navigate(`/cms/import/${jobId}`)}>
            <ArrowLeft className="h-4 w-4 mr-1" />
            문제 크롭으로
          </Button>
          <div>
            <h1 className="text-2xl font-bold">해설지 크롭 검수</h1>
            <p className="text-sm text-muted-foreground">
              단계: {STAGE_LABEL[stage]}
              {progress && stage === 'tagging' && (
                <> ({progress.processed}/{progress.total})</>
              )}
              {answersCount > 0 && <> · 정답 {answersCount}개 추출됨</>}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {stage === 'reviewing' && (
            <Button onClick={handleStartTagging}>
              <Check className="h-4 w-4 mr-1" />
              검수 완료 — AI 태깅 시작
            </Button>
          )}
          {stage === 'done' && (
            <Button onClick={handleApply} disabled={applying}>
              {applying ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Check className="h-4 w-4 mr-1" />}
              문제에 적용 → 상세 입력
            </Button>
          )}
          <Button
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
            <p className="text-sm text-muted-foreground whitespace-pre-wrap mb-4">{errorMsg}</p>
            <Button
              variant="outline"
              onClick={() => {
                setStage('idle');
                setErrorMsg('');
                setSolutionJobId(null);
                setPageData({});
                setPages([]);
                setActivePage(0);
                setBboxCache(new Map());
                setDirtyPages(new Set());
                setSavedPages(new Set());
                setSearchParams(prev => {
                  const next = new URLSearchParams(prev);
                  next.delete('sj');
                  return next;
                }, { replace: true });
              }}
            >
              <RotateCcw className="h-4 w-4 mr-2" />
              처음부터 다시 시도
            </Button>
          </div>
        </div>
      ) : (
        // reviewing — 크롭 검수 UI
        <div className="flex flex-1 overflow-hidden">
          {/* 좌측: 페이지 탭 + 에디터 */}
          <div className="flex flex-col flex-1 overflow-hidden border-r">
            <div className="flex gap-1.5 px-3 py-2 border-b bg-gray-50 overflow-x-auto shrink-0">
              {pages.map(pg => {
                const pgItems = pageData[pg]?.items ?? [];
                const isSaved = savedPages.has(pg);
                const isDirty = dirtyPages.has(pg);
                return (
                  <button
                    key={pg}
                    onClick={() => setActivePage(pg)}
                    className={`px-4 py-1.5 text-base font-medium rounded border transition-colors whitespace-nowrap ${
                      activePage === pg
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-white border-gray-200 hover:bg-gray-100'
                    }`}
                  >
                    {pg}페이지
                    <span className="ml-1 text-sm opacity-70">({pgItems.length})</span>
                    {isSaved && !isDirty && <span className="ml-1 text-sm text-green-500">✓</span>}
                    {isDirty && <span className="ml-1 text-sm text-orange-400">●</span>}
                  </button>
                );
              })}
            </div>

            <div className="flex-1 overflow-auto p-3">
              {pageImageUrl ? (
                <>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-base text-muted-foreground">
                      {activePage}페이지 — {bboxItems.length}개 해설 박스
                      {currentPageDirty && (
                        <span className="ml-2 text-orange-600 font-medium">(수정됨 — 미저장)</span>
                      )}
                    </p>
                    <div className="flex gap-2">
                      <Button variant="outline" onClick={handleAutoGroup} title="같은 번호 박스를 한 번에 그룹화">
                        같은 번호 자동 묶기
                      </Button>
                      <Button variant="outline" onClick={handleUnmergeAll} title="이 페이지 모든 그룹 해제">
                        전체 그룹 해제
                      </Button>
                      {currentPageDirty && (
                        <Button variant="outline" onClick={handleResetBbox}>
                          <RotateCcw className="h-4 w-4 mr-1" />
                          초기화
                        </Button>
                      )}
                      <Button
                        onClick={handleSaveBbox}
                        disabled={!currentPageDirty || savingBbox}
                      >
                        {savingBbox ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}
                        저장
                      </Button>
                    </div>
                  </div>

                  {/* 선택 박스 툴바 */}
                  {selectedBboxIdx !== null && bboxItems[selectedBboxIdx] && (() => {
                    const sel = bboxItems[selectedBboxIdx];
                    const isTable = sel.boxType === 'answer_table';
                    return (
                      <div className="flex items-center gap-2 mb-2 px-1 py-1.5 bg-yellow-50 border border-yellow-200 rounded text-sm flex-wrap">
                        <span className="text-xs text-muted-foreground shrink-0">
                          박스 선택됨
                        </span>

                        {/* 유형 토글 */}
                        <span className="text-xs shrink-0">유형:</span>
                        <Button
                          size="sm"
                          variant="outline"
                          className={`h-6 text-xs px-2 ${
                            isTable
                              ? 'bg-gray-100 text-gray-700 border-gray-400'
                              : 'bg-red-50 text-red-700 border-red-300'
                          }`}
                          onClick={handleToggleBoxType}
                          title="해설 / 정답표 전환"
                        >
                          {isTable ? '정답표' : '해설'} ⇄
                        </Button>

                        {/* 해설일 때만 번호/묶기 UI */}
                        {!isTable && (
                          <>
                            <span className="text-xs shrink-0">번호:</span>
                            <input
                              type="number"
                              min={1}
                              max={99}
                              value={sel.number}
                              onChange={e => handleChangeNumber(Number(e.target.value))}
                              className="w-14 text-xs border rounded px-1 py-0.5 text-center"
                            />
                            {mergeAnchorIdx === null ? (
                              <>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-6 text-xs px-2"
                                  onClick={handleStartMerge}
                                  title="이 박스를 앵커로 설정한 뒤 다른 박스를 클릭하면 같은 번호로 묶입니다"
                                >
                                  같은 번호로 묶기
                                </Button>
                                {sel.groupId && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-6 text-xs px-2 text-red-600 border-red-300"
                                    onClick={handleUnmerge}
                                  >
                                    그룹 해제
                                  </Button>
                                )}
                              </>
                            ) : (
                              <span className="flex items-center gap-2">
                                <span className="text-xs text-orange-600 font-medium animate-pulse">
                                  묶을 박스를 클릭하세요 (ESC: 취소)
                                </span>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-6 text-xs px-2"
                                  onClick={handleCancelMerge}
                                >
                                  취소
                                </Button>
                              </span>
                            )}
                          </>
                        )}
                      </div>
                    );
                  })()}
                  <BboxEditor
                    pageImageUrl={pageImageUrl}
                    pageWidth={pageWidth}
                    pageHeight={pageHeight}
                    items={bboxItems}
                    onChange={handleBboxChange}
                    resetKey={bboxResetKey}
                    preserveNumbers={true}
                    onSelectionChange={handleSelectionChange}
                    fallbackStartNumber={pageStartNumbers[activePage] ?? computeStartNumber(activePage)}
                  />
                </>
              ) : (
                <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                  페이지 이미지 로드 중...
                </div>
              )}
            </div>
          </div>

          {/* 우측: 현재 페이지 박스 리스트 + 정답 미리보기 */}
          <div className="w-80 flex flex-col overflow-hidden shrink-0">
            {/* 현재 페이지 박스 리스트 */}
            <div className="px-3 py-3 border-b bg-gray-50 shrink-0 space-y-2">
              <p className="text-base font-medium">
                {activePage}페이지 박스 ({bboxItems.length}개)
              </p>
              <div className="flex items-center gap-2">
                <label className="text-sm text-muted-foreground shrink-0">첫 해설 번호</label>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder={String(computeStartNumber(activePage))}
                  value={pageStartNumbers[activePage] ?? ''}
                  onChange={e => {
                    const val = e.target.value.replace(/[^0-9]/g, '');
                    if (val === '') {
                      setPageStartNumbers(prev => {
                        const next = { ...prev };
                        delete next[activePage];
                        return next;
                      });
                    } else {
                      const n = parseInt(val, 10);
                      if (!isNaN(n) && n >= 1) {
                        setPageStartNumbers(prev => ({ ...prev, [activePage]: n }));
                      }
                    }
                  }}
                  className="w-20 text-sm border rounded px-2 py-1 text-center"
                />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-1 text-sm min-h-0">
              {bboxItems.length === 0 ? (
                <p className="text-muted-foreground text-center py-4">박스 없음</p>
              ) : (
                bboxItems
                  .map((it, idx) => ({ it, idx }))
                  .sort((a, b) => {
                    const aTable = a.it.boxType === 'answer_table';
                    const bTable = b.it.boxType === 'answer_table';
                    if (aTable !== bTable) return aTable ? 1 : -1; // 정답표는 맨 뒤
                    return a.it.number - b.it.number;
                  })
                  .map(({ it, idx }) => {
                  const isTable = it.boxType === 'answer_table';
                  const isSelected = idx === selectedBboxIdx;
                  return (
                    <div
                      key={idx}
                      onClick={() => handleSelectionChange(idx)}
                      className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded border text-left transition-colors cursor-pointer ${
                        isSelected
                          ? 'bg-yellow-50 border-yellow-400'
                          : 'bg-white hover:bg-gray-50'
                      }`}
                    >
                      <span className="text-base font-medium flex-1 min-w-0 truncate">
                        {isTable ? (
                          <span className="text-gray-600">정답표</span>
                        ) : (
                          <>
                            <span className="text-red-600">{it.number}번</span>
                            {it.groupId && <span className="ml-1 text-sm text-purple-600">◆</span>}
                          </>
                        )}
                      </span>
                      <span className="text-muted-foreground text-sm shrink-0">
                        {Math.round(it.bbox.x2 - it.bbox.x1)}×{Math.round(it.bbox.y2 - it.bbox.y1)}
                      </span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteBox(idx);
                        }}
                        className="shrink-0 p-1 rounded hover:bg-red-100 text-gray-400 hover:text-red-600 transition-colors"
                        title="박스 삭제"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  );
                })
              )}
            </div>

          </div>
        </div>
      )}
    </div>
  );
}
