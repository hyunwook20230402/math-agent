/**
 * 해설지 크롭 검수 페이지
 *
 * 1) 해설지 PDF 업로드
 * 2) 백엔드에서 자동 크롭 + 정답 추출
 * 3) 페이지별 bbox 편집기로 검수
 * 4) "AI 태깅 시작" 버튼 → 병합/업로드/VL 태깅 (백그라운드)
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

const PIPELINE_URL = 'http://localhost:8001';

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
      };
    }
    const hasNum = typeof it.number === 'number' && it.number > 0;
    const num = hasNum ? (it.number as number) : counter;
    if (!hasNum) counter += 1;
    else counter = Math.max(counter, num + 1);
    return {
      stagingId: null,
      bbox: { ...it.bbox },
      number: num,
      groupId: it.group_id ?? null,
      boxType,
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
  const qaFileInputRef = useRef<HTMLInputElement>(null);
  const [qaFile, setQaFile] = useState<File | null>(null);
  const autoSaveTimerRef = useRef<Record<number, ReturnType<typeof setTimeout>>>({});
  const saveBboxForPageRef = useRef<((pg: number, items: BboxItem[], silent?: boolean) => Promise<void>) | null>(null);

  const [stage, setStage] = useState<Stage>('idle');
  const [solutionJobId, setSolutionJobId] = useState<string | null>(null);
  const solutionJobIdRef = useRef<string | null>(null);
  const setCleanSolutionJobId = (id: string | null) => {
    if (!id) {
      setSolutionJobId(null);
      solutionJobIdRef.current = null;
      return;
    }
    const match = id.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    const clean = match ? match[0] : null;
    setSolutionJobId(clean);
    solutionJobIdRef.current = clean;
  };
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

  // YOLO 학습 데이터 export / 재학습 상태
  const [exporting, setExporting] = useState(false);
  const [exportedAt, setExportedAt] = useState<string | null>(null);
  const [exportInfo, setExportInfo] = useState<{ train?: number; val?: number } | null>(null);
  const [retraining, setRetraining] = useState(false);
  const [uploadFolder, setUploadFolder] = useState<string | null>(null);

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

  /** 현재 activePage bbox를 교체하고 dirty 처리 + 2초 후 자동저장 */
  const updateCurrentPageBboxes = useCallback((updater: (prev: BboxItem[]) => BboxItem[]) => {
    const pg = activePageRef.current;
    let updatedItems: BboxItem[] = [];
    setBboxCache(prev => {
      const startNum = pageStartNumbersRef.current[pg] ?? computeStartNumber(pg);
      const cur = prev.get(pg) ?? itemsToBboxItems(pageData[pg]?.items ?? [], startNum);
      updatedItems = updater(cur);
      const next = new Map(prev);
      next.set(pg, updatedItems);
      return next;
    });
    setDirtyPages(prev => new Set([...prev, pg]));
    setSavedPages(prev => { const n = new Set(prev); n.delete(pg); return n; });

    // 2초 debounce 자동저장
    clearTimeout(autoSaveTimerRef.current[pg]);
    autoSaveTimerRef.current[pg] = setTimeout(() => {
      saveBboxForPageRef.current?.(pg, updatedItems, true).catch(() => {});
    }, 2000);
  }, [pageData, computeStartNumber]);

  /** "묶기 시작" — 첫 번째 박스 선택 시 앵커 저장 */
  const handleStartMerge = useCallback(() => {
    if (selectedBboxIdx === null) return;
    setMergeAnchorIdx(selectedBboxIdx);
    toast({ title: '두 번째 박스를 클릭하면 같은 번호로 묶입니다.' });
  }, [selectedBboxIdx]);

  /** 묶기 취소 — 앵커 그대로, 아무것도 안 하고 종료 */
  const handleCancelMerge = useCallback(() => {
    setMergeAnchorIdx(null);
  }, []);

  /** 그룹 확정 — 앵커 박스에 groupId 부여 후 묶기 모드 종료 (두 번째 박스 없이 끝낼 때) */
  const handleConfirmMerge = useCallback(() => {
    if (mergeAnchorIdx === null) return;
    updateCurrentPageBboxes(prev => {
      const items = [...prev];
      const anchor = items[mergeAnchorIdx];
      if (!anchor) return prev;
      const gid = anchor.groupId || genGroupId();
      items[mergeAnchorIdx] = { ...anchor, groupId: gid };
      return items;
    });
    setMergeAnchorIdx(null);
    setSelectedBboxIdx(null); // 확정 후 선택 툴바 닫기
    toast({ title: '그룹 확정', description: '박스에 그룹 ID가 부여되었습니다.' });
  }, [mergeAnchorIdx, updateCurrentPageBboxes]);

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
      // 앵커 번호를 정답 번호로 통일
      const mergedNumber = anchor.number;
      items[mergeAnchorIdx] = { ...anchor, groupId: gid };
      items[idx] = { ...target, groupId: gid, number: mergedNumber };
      return items;
    });
    setMergeAnchorIdx(null);
    setSelectedBboxIdx(null); // 묶기 완료 후 선택 툴바 닫기
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
      items[selectedBboxIdx] = { ...item, number: newNum };
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
    // 묶기 모드 중 박스를 클릭했을 때만 묶기 실행
    // idx === null 이면 새 박스가 추가된 것이므로 묶기 모드 취소
    if (mergeAnchorIdx !== null) {
      if (idx === null) {
        // 새 박스 추가(빈 공간 드래그 후) → 묶기 모드 자동 취소
        setMergeAnchorIdx(null);
      } else {
        handleMergeSelect(idx);
      }
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
  const [tagResults, setTagResults] = useState<Record<string, any>>({});
  const [expandedTagNumber, setExpandedTagNumber] = useState<number | null>(null);
  const [taggingMode, setTaggingMode] = useState<'sample' | 'continue' | 'full' | null>(null);
  const [retagStatus, setRetagStatus] = useState<Record<number, 'pending'|'tagging'|'done'|'warning'|'error'>>({});
  const retagPollerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const activePageRef = useRef<number>(0);
  useEffect(() => { activePageRef.current = activePage; }, [activePage]);

  const pageStartNumbersRef = useRef<Record<number, number>>({});
  useEffect(() => { pageStartNumbersRef.current = pageStartNumbers; }, [pageStartNumbers]);

  // 진입 시 ?sj가 없으면 problem_job_id(jobId)로 solution_jobs 역조회 → URL에 주입
  // (PdfReview에서 "다음: 해설지 크롭 검수"로 들어올 때 ?sj 가 안 붙기 때문)
  useEffect(() => {
    const sj = searchParams.get('sj');
    if (sj || !jobId || solutionJobId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${PIPELINE_URL}/api/solution/by-problem/${jobId}`);
        if (!res.ok) return;
        const job = await res.json();
        if (cancelled || !job?.id) return;
        if (job.status === 'error') return;
        setSearchParams(prev => {
          const next = new URLSearchParams(prev);
          next.set('sj', job.id);
          return next;
        }, { replace: true });
      } catch {
        // 조용히 무시 (업로드 화면으로 폴백)
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  // 새로고침 복구: URL에 ?sj=<id>가 있으면 백엔드에서 page_bboxes 복원
  useEffect(() => {
    const sj = searchParams.get('sj');
    if (!sj || solutionJobId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${PIPELINE_URL}/api/solution/status/${sj}`);
        if (!res.ok) {
          setSolutionJobId(null);
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
        setCleanSolutionJobId(sj);
        const newStage: Stage = job.status === 'done' ? 'done'
          : (job.status === 'queued' || job.status === 'processing') ? 'tagging'
          : 'reviewing';
        setStage(newStage);
        if (pageNums.length === 0) return;
        setPageData(parsed);
        setPages(pageNums);
        setActivePage(pageNums[0]);
        // 사용자가 실제로 저장(update-bboxes) 호출한 페이지만 ✓ 복원
        const modified: number[] = (job.modified_pages ?? job.progress?.modified_pages ?? []).map(Number);
        setSavedPages(new Set(modified));
        setAnswers(job.answers ?? {});
        const restoredTagResults = job.tag_results ?? job.progress?.tag_results ?? {};
        setTagResults(restoredTagResults);
        // _retagged 플래그 있는 번호만 done으로 복원
        const retaggedDone: Record<number, 'done'> = {};
        Object.entries(restoredTagResults).forEach(([k, v]: [string, any]) => {
          if (v?._retagged) retaggedDone[Number(k)] = 'done';
        });
        if (Object.keys(retaggedDone).length > 0) setRetagStatus(retaggedDone);
        toast({ title: '작업 복구됨', description: `${pageNums.length}페이지 불러옴` });
      } catch (e) {
        // 복구 실패 시 조용히 무시 (업로드 화면으로)
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

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
      if (qaFile) fd.append('quick_answer_file', qaFile);

      const res = await fetch(`${PIPELINE_URL}/api/solution/upload`, {
        method: 'POST',
        body: fd,
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`업로드 실패: ${res.status} ${txt}`);
      }
      const data = await res.json();
      setCleanSolutionJobId(data.solution_job_id);
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
      setCleanSolutionJobId(null);
      toast({ title: '추출 오류', description: e.message, variant: 'destructive' });
    }
  };

  // 3. 페이지 bbox 저장 (재크롭)
  const saveBboxForPage = useCallback(async (pg: number, items: BboxItem[], silent = false): Promise<void> => {
    const sjId = solutionJobIdRef.current;
    if (!sjId) return;
    const res = await fetch(`${PIPELINE_URL}/api/solution/${sjId}/update-bboxes`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        page_number: pg,
        items: items.map(it => ({
          number: it.boxType === 'answer_table' ? 0 : it.number,
          bbox: it.bbox,
          group_id: it.groupId ?? null,
          box_type: it.boxType ?? 'solution',
        })),
      }),
    });
    if (!res.ok) throw new Error('bbox 저장 실패');
    setDirtyPages(prev => { const next = new Set(prev); next.delete(pg); return next; });
    setSavedPages(prev => new Set([...prev, pg]));
    if (!silent) {
      setSelectedBboxIdx(null);
      toast({ title: '저장 완료', description: '해당 페이지가 재크롭되었습니다.' });
    }
  }, [solutionJobId]);

  // ref 동기화 (updateCurrentPageBboxes의 자동저장에서 참조)
  useEffect(() => { saveBboxForPageRef.current = saveBboxForPage; }, [saveBboxForPage]);

  const handleSaveBbox = async () => {
    if (!solutionJobIdRef.current) return;
    setSavingBbox(true);
    const pg = activePage;
    clearTimeout(autoSaveTimerRef.current[pg]);
    try {
      const items = bboxCache.get(pg) ?? itemsToBboxItems(pageData[pg]?.items ?? [], computeStartNumber(pg));
      await saveBboxForPage(pg, items, false);
    } catch (e: any) {
      toast({ title: '오류', description: e.message, variant: 'destructive' });
    } finally {
      setSavingBbox(false);
    }
  };

  // 4. AI 태깅 시작 (백그라운드)
  //    mode:
  //      - 'sample' : fresh + sample_count=4 (앞 4개 덮어쓰기)
  //      - 'full'   : fresh 전체 (기존 tag_results 있어도 덮어쓰기)
  //      - 'continue': 아직 tag_results 없는 번호만 이어서
  const handleStartTagging = async (
    mode: 'sample' | 'continue' | 'full' = 'full',
  ) => {
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
      const qs = new URLSearchParams();
      if (mode === 'sample') {
        qs.set('sample_count', '4');
        qs.set('mode', 'fresh');
      } else if (mode === 'continue') {
        qs.set('mode', 'continue');
      } else {
        qs.set('mode', 'fresh');
      }
      const res = await fetch(
        `${PIPELINE_URL}/api/solution/${solutionJobId}/upload-and-tag?${qs.toString()}`,
        { method: 'POST' },
      );
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`태깅 시작 실패: ${txt}`);
      }
      setStage('tagging');
      setTaggingMode(mode);
      const label = mode === 'sample' ? '샘플 4개'
        : mode === 'continue' ? '남은 문제 이어서'
        : '전체 태깅';
      toast({ title: `AI 태깅 시작 (${label})`, description: 'AI 태깅 진행 중. 중간 종료 말고 기다려 주세요.' });
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
        if (data.tag_results || data.progress?.tag_results) {
          setTagResults(data.tag_results ?? data.progress?.tag_results ?? {});
        }
        if (data.status === 'done') {
          setStage('done');
          setTaggingMode(null);
          clearInterval(timer);
        } else if (data.status === 'error') {
          setStage('error');
          setErrorMsg(data.error || '태깅 실패');
          setTaggingMode(null);
          clearInterval(timer);
        }
      } catch {}
    }, 2000);
    return () => clearInterval(timer);
  }, [stage, solutionJobId]);

  // YOLO export 상태 초기 조회
  useEffect(() => {
    if (!solutionJobId) return;
    (async () => {
      try {
        const res = await fetch(`${PIPELINE_URL}/api/solution/export-training-data/${solutionJobId}/status`);
        if (!res.ok) return;
        const data = await res.json();
        if (data.exported) {
          setExportedAt(data.exported_at ?? null);
          setExportInfo({ train: data.train, val: data.val });
        }
      } catch {}
    })();
  }, [solutionJobId]);

  // pdf_path에서 업로드 폴더 추출 (UI 표시용)
  useEffect(() => {
    if (!solutionJobId) return;
    (async () => {
      try {
        const res = await fetch(`${PIPELINE_URL}/api/solution/status/${solutionJobId}`);
        if (!res.ok) return;
        const data = await res.json();
        const pdfPath: string | undefined = data.file_path ?? data.pdf_path;
        if (!pdfPath) return;
        // uploads/solutions/<폴더명>/ 만 추출
        const m = pdfPath.match(/uploads[\\/]+solutions[\\/]+([^\\/]+)/);
        if (m) setUploadFolder(`uploads/solutions/${m[1]}/`);
      } catch {}
    })();
  }, [solutionJobId]);

  // YOLO 학습 데이터 export
  const handleExportTrainingData = async (force = false) => {
    if (!solutionJobId) return;
    setExporting(true);
    try {
      const res = await fetch(`${PIPELINE_URL}/api/solution/export-training-data`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ solution_job_id: solutionJobId, split_ratio: 0.8, force }),
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`Export 실패: ${res.status} ${txt}`);
      }
      const data = await res.json();
      if (data.already_exported && !force) {
        if (confirm(`이미 ${data.exported_at}에 export됨. 다시 export할까요?`)) {
          await handleExportTrainingData(true);
        }
        return;
      }
      setExportedAt(new Date().toISOString().slice(0, 19).replace('T', ' '));
      setExportInfo({ train: data.train, val: data.val });
      const warnings: string[] = Array.isArray(data.warnings) ? data.warnings : [];
      if (warnings.length > 0) {
        toast({
          title: `Export 완료 (경고 ${warnings.length}건)`,
          description: `train: ${data.train ?? 0}, val: ${data.val ?? 0}\n${warnings.join('\n')}`,
          variant: 'destructive',
        });
      } else {
        toast({
          title: 'Export 완료',
          description: `train: ${data.train ?? 0}, val: ${data.val ?? 0} 페이지`,
        });
      }
    } catch (e: any) {
      toast({ title: '오류', description: e.message, variant: 'destructive' });
    } finally {
      setExporting(false);
    }
  };

  // YOLO 재학습 시작
  const handleRetrainSolution = async () => {
    if (!confirm('YOLO 재학습을 시작합니다. 오래 걸리고 백그라운드로 실행됩니다. 계속할까요?')) return;
    setRetraining(true);
    try {
      const res = await fetch(`${PIPELINE_URL}/api/retrain-solution`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ epochs: 100 }),
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`재학습 시작 실패: ${txt}`);
      }
      const data = await res.json();
      toast({
        title: '재학습 시작됨',
        description: data.run_name ? `run: ${data.run_name}` : '백그라운드 실행 중',
      });
    } catch (e: any) {
      toast({ title: '오류', description: e.message, variant: 'destructive' });
    } finally {
      setRetraining(false);
    }
  };

  // 재태깅 폴러 정리
  const stopRetagPoller = useCallback(() => {
    if (retagPollerRef.current) {
      clearInterval(retagPollerRef.current);
      retagPollerRef.current = null;
    }
  }, []);

  const handleRetag = useCallback(async (numbers: number[]) => {
    const sjId = solutionJobIdRef.current;
    if (!sjId || numbers.length === 0) return;

    const initial: Record<number, 'pending'|'tagging'|'done'|'error'> = {};
    numbers.forEach(n => { initial[n] = 'pending'; });
    setRetagStatus(prev => ({ ...prev, ...initial }));

    await fetch(`${PIPELINE_URL}/api/solution/${sjId}/retag`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ numbers }),
    });

    stopRetagPoller();
    retagPollerRef.current = setInterval(async () => {
      try {
        const res = await fetch(`${PIPELINE_URL}/api/solution/${sjId}/retag-status`);
        const status: Record<string, string> = await res.json();
        // 빈 응답 = 서버 재시작 후 메모리 초기화 → 무시
        if (Object.keys(status).length === 0) return;

        const parsed: Record<number, 'pending'|'tagging'|'done'|'error'> = {};
        Object.entries(status).forEach(([k, v]) => { parsed[Number(k)] = v as any; });
        setRetagStatus(prev => ({ ...prev, ...parsed }));

        const allDone = Object.values(parsed).every(s => s === 'done' || s === 'warning' || s === 'error');
        if (allDone) {
          stopRetagPoller();
          const statusRes = await fetch(`${PIPELINE_URL}/api/solution/status/${sjId}`);
          const jobData = await statusRes.json();
          const newTagResults = jobData?.progress?.tag_results ?? jobData?.tag_results ?? {};
          if (Object.keys(newTagResults).length > 0) setTagResults(newTagResults);
          toast({ title: '재태깅 완료', description: `${numbers.length}개 문제 재태깅 완료` });
        }
      } catch { /* 폴링 오류 무시 */ }
    }, 2000);
  }, [stopRetagPoller]);

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
            <>
              <Button
                variant="outline"
                onClick={() => handleExportTrainingData(false)}
                disabled={exporting}
                title="검수한 bbox를 YOLO 학습 데이터셋으로 내보냅니다"
              >
                {exporting ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}
                {exportedAt ? 'YOLO 재Export' : 'YOLO 학습 데이터로 Export'}
              </Button>
              {exportedAt && (
                <Button
                  variant="outline"
                  onClick={handleRetrainSolution}
                  disabled={retraining}
                  title="오래 걸림. 백그라운드 실행."
                >
                  {retraining ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}
                  YOLO 재학습 시작
                </Button>
              )}
              <Button
                variant="outline"
                onClick={() => handleStartTagging('sample')}
                title="앞 4개만 태깅해 결과 확인. 프롬프트/taxonomy 조정 후 재호출 가능."
              >
                <Check className="h-4 w-4 mr-1" />
                샘플 태깅 (앞 4개)
              </Button>
              <Button
                variant="outline"
                onClick={() => handleStartTagging('continue')}
                disabled={Object.keys(tagResults).length === 0}
                title="tag_results에 아직 없는 번호만 이어서 태깅"
              >
                남은 문제 이어서 태깅
              </Button>
              <Button onClick={() => handleStartTagging('full')}>
                <Check className="h-4 w-4 mr-1" />
                검수 완료 — 전체 AI 태깅
              </Button>
            </>
          )}
          {stage === 'done' && (
            <>
              <Button
                variant="outline"
                onClick={() => handleStartTagging('sample')}
                title="샘플 재태깅"
              >
                샘플 재태깅 (앞 4개)
              </Button>
              <Button
                variant="outline"
                onClick={() => handleStartTagging('continue')}
                title="아직 안 된 번호만 이어서"
              >
                남은 문제 이어서 태깅
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  if (!confirm('전체 재태깅: 기존 태그 전부 덮어쓰기됩니다. 계속?')) return;
                  handleStartTagging('full');
                }}
                title="기존 tag_results 전체 덮어쓰기"
              >
                전체 재태깅
              </Button>
              <Button onClick={handleApply} disabled={applying}>
                {applying ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Check className="h-4 w-4 mr-1" />}
                문제에 적용 → 상세 입력
              </Button>
            </>
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

      {/* Export 상태 + 업로드 경로 표시 (검수 모드에서만) */}
      {stage === 'reviewing' && (uploadFolder || exportedAt) && (
        <div className="px-4 py-2 border-b bg-blue-50/30 text-xs text-muted-foreground flex items-center gap-4 flex-wrap">
          {uploadFolder && (
            <span>
              업로드 폴더: <code className="px-1 py-0.5 bg-white border rounded">{uploadFolder}</code>
            </span>
          )}
          {exportedAt && (
            <span>
              최근 Export: <strong>{exportedAt}</strong>
              {exportInfo && (
                <> (train: {exportInfo.train ?? 0}, val: {exportInfo.val ?? 0})</>
              )}
            </span>
          )}
        </div>
      )}

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
            <input
              ref={qaFileInputRef}
              type="file"
              accept=".pdf"
              className="hidden"
              onChange={e => setQaFile(e.target.files?.[0] ?? null)}
            />
            <div className="flex flex-col items-center gap-2">
              <button
                type="button"
                onClick={() => qaFileInputRef.current?.click()}
                className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
              >
                {qaFile ? `✓ 빠른정답: ${qaFile.name}` : '빠른정답 PDF 첨부 (선택)'}
              </button>
            </div>
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
            <p className="text-lg font-semibold">
              AI 태깅 진행 중
              {taggingMode === 'sample' && ' (샘플 4개)'}
              {taggingMode === 'continue' && ' (남은 문제 이어서)'}
            </p>
            {progress && (
              <p className="text-sm text-muted-foreground">
                {progress.processed} / {progress.total}개 처리 중
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              VL 모델이 문제+해설 이미지를 분석하고 있습니다.
              <br />
              시간대에 따라 Gemini / OpenAI / Ollama 자동 선택됩니다.
            </p>
          </div>
        </div>
      ) : stage === 'done' ? (
        <div className="flex-1 overflow-y-auto bg-gray-50 p-6">
          <div className="max-w-3xl mx-auto space-y-4">
            <div className="bg-white rounded-lg shadow-sm border p-6 flex items-start gap-4">
              <Check className="h-8 w-8 text-green-500 flex-shrink-0 mt-1" />
              <div className="flex-1">
                <h2 className="text-lg font-semibold mb-1">AI 태깅 결과 미리보기</h2>
                <p className="text-sm text-muted-foreground">
                  처리됨 <strong>{Object.keys(tagResults).length}</strong> 문제. 아래 카드를 클릭하면 상세 태그를 볼 수 있습니다.
                  <br />
                  결과가 맘에 안 들면 상단 버튼으로 <strong>샘플 재태깅 / 이어서</strong> 하세요.
                </p>
              </div>
            </div>

            {Object.entries(tagResults)
              .map(([k, v]) => [Number(k), v] as [number, any])
              .sort((a, b) => a[0] - b[0])
              .map(([num, r]) => {
                const expanded = expandedTagNumber === num;
                return (
                  <div key={num} className="bg-white rounded-lg border overflow-hidden">
                    <div className="flex items-center justify-between px-4 py-3 hover:bg-gray-50">
                      <button
                        type="button"
                        className="flex items-center gap-3 flex-1 text-left"
                        onClick={() => setExpandedTagNumber(expanded ? null : num)}
                      >
                        <span className="font-mono text-sm text-muted-foreground w-10">{num}번</span>
                        <span className="text-xs text-muted-foreground truncate max-w-md">
                          {r?.unit || '(단원 없음)'}
                        </span>
                        {r?.difficulty_score != null && (
                          <span className="text-xs px-2 py-0.5 rounded bg-blue-50 text-blue-700">
                            {r.difficulty_score}/10
                          </span>
                        )}
                        {retagStatus[num] === 'pending' && <span className="text-xs text-yellow-600">대기 중…</span>}
                        {retagStatus[num] === 'tagging' && <span className="text-xs text-blue-600 animate-pulse">재태깅 중…</span>}
                        {retagStatus[num] === 'done' && <span className="text-xs text-green-600">✓ 재태깅 완료</span>}
                        {retagStatus[num] === 'warning' && <span className="text-xs text-yellow-600">⚠ 검증 경고</span>}
                        {retagStatus[num] === 'error' && <span className="text-xs text-red-600">재태깅 오류</span>}
                      </button>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={retagStatus[num] === 'pending' || retagStatus[num] === 'tagging'}
                          onClick={e => { e.stopPropagation(); handleRetag([num]); }}
                          className="text-xs px-2 py-1 rounded border border-gray-300 hover:bg-gray-100 disabled:opacity-40"
                        >
                          재태깅
                        </button>
                        <button type="button" onClick={() => setExpandedTagNumber(expanded ? null : num)} className="text-xs text-muted-foreground px-1">{expanded ? '▲' : '▼'}</button>
                      </div>
                    </div>
                    {expanded && (
                      <div className="px-4 py-3 border-t bg-gray-50/50 text-sm space-y-2">
                        <div><strong className="text-xs text-muted-foreground">단원:</strong> {r?.unit || '-'}</div>
                        <div><strong className="text-xs text-muted-foreground">난이도:</strong> {r?.difficulty_score != null ? `${r.difficulty_score}/10` : '-'}</div>
                        <div>
                          <strong className="text-xs text-muted-foreground">개념:</strong>{' '}
                          {Array.isArray(r?.concept_tags) && r.concept_tags.length > 0
                            ? r.concept_tags.map((t: any) => typeof t === 'string' ? t : `${t.tag}`).join(', ')
                            : '-'}
                        </div>
                        <div>
                          <strong className="text-xs text-muted-foreground">스킬:</strong>{' '}
                          {Array.isArray(r?.skill_tags) && r.skill_tags.length > 0
                            ? r.skill_tags.map((t: any) => typeof t === 'string' ? t : `${t.tag}`).join(', ')
                            : '-'}
                        </div>
                        {r?._validation && (
                          <div className={`mt-1 text-xs rounded px-2 py-1 ${
                            r._validation.status === 'ok' ? 'bg-green-50 text-green-700'
                            : r._validation.status === 'warning' ? 'bg-yellow-50 text-yellow-700'
                            : 'bg-red-50 text-red-700'
                          }`}>
                            <strong>검증:</strong> {r._validation.status} (점수 {(r._validation.score * 100).toFixed(0)}점)
                            {r._validation.issues?.length > 0 && (
                              <ul className="mt-1 ml-3 list-disc">
                                {r._validation.issues.map((iss: any, i: number) => (
                                  <li key={i}>[{iss.severity}] {iss.field}: {iss.reason}{iss.applied ? ' ✓수정됨' : ''}</li>
                                ))}
                              </ul>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}

            {Object.keys(tagResults).length === 0 && (
              <div className="bg-white rounded-lg border p-6 text-center text-muted-foreground text-sm">
                태깅된 문제가 없습니다.
              </div>
            )}
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
                const pgItems = bboxCache.get(pg) ?? pageData[pg]?.items ?? [];
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

            {/* 상태바 + 툴바: 스크롤해도 고정 */}
            {pageImageUrl && (
              <div className="shrink-0 px-3 pt-3 pb-2 border-b bg-white">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-base text-muted-foreground">
                    {activePage}페이지 — {bboxItems.length}개 해설 박스
                    {currentPageDirty && (
                      <span className="ml-2 text-orange-600 font-medium">(수정됨 — 미저장)</span>
                    )}
                  </p>
                  <div className="flex gap-2">
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
                    <div className="flex items-center gap-2 px-1 py-1.5 bg-yellow-50 border border-yellow-200 rounded text-sm flex-wrap">
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
                                묶을 박스를 클릭하세요
                              </span>
                              <Button
                                size="sm"
                                variant="default"
                                className="h-6 text-xs px-2"
                                onClick={handleConfirmMerge}
                              >
                                그룹 확정
                              </Button>
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
              </div>
            )}

            {/* 에디터 스크롤 영역 */}
            <div className="flex-1 overflow-auto p-3">
              {pageImageUrl ? (
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
                      <span className="text-base font-medium flex-1 min-w-0 truncate flex items-center gap-1">
                        {isTable ? (
                          <span className="text-gray-600">정답표</span>
                        ) : (
                          <>
                            <input
                              type="number"
                              min={1}
                              value={it.number}
                              onClick={e => e.stopPropagation()}
                              onChange={e => {
                                const val = parseInt(e.target.value, 10);
                                if (!isNaN(val) && val > 0) {
                                  updateCurrentPageBboxes(prev => {
                                    const items = [...prev];
                                    items[idx] = { ...items[idx], number: val };
                                    return items;
                                  });
                                }
                              }}
                              className="w-14 text-red-600 font-medium border border-transparent hover:border-gray-300 focus:border-blue-400 rounded px-1 py-0 text-sm bg-transparent focus:bg-white focus:outline-none"
                            />
                            <span className="text-red-600 text-sm">번</span>
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
