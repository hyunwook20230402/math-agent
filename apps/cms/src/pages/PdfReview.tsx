import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '@shared/hooks/useAuth';
import { Button } from '@shared/ui/button';
import { Card, CardContent, CardHeader } from '@shared/ui/card';
import { toast } from '@shared/hooks/use-toast';
import {
  ArrowLeft, Check, X, CheckCheck, Loader2, BookOpen, RotateCcw, Download,
} from 'lucide-react';
import { useTextbook } from '@/context/TextbookContext';
import BboxEditor, { type BboxItem } from '@/components/BboxEditor';

const PIPELINE_URL = 'http://localhost:8000';

interface StagingProblem {
  id: string;
  job_id: string;
  problem_number: number;
  title: string;
  unit: string;
  difficulty: 'easy' | 'medium' | 'hard';
  answer_type: 'multiple_choice' | 'short_answer';
  correct_answer: string;
  explanation: string | null;
  problem_text: string;
  source_image_url: string | null;
  source_page_image_url: string | null;
  confidence: number;
  status: 'pending' | 'approved' | 'rejected' | 'modified';
  page_number: number | null;
  bbox: { x1: number; y1: number; x2: number; y2: number; page_width?: number; page_height?: number } | null;
}

const statusColor: Record<string, string> = {
  pending: 'bg-gray-100 text-gray-700',
  approved: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
  modified: 'bg-blue-100 text-blue-700',
};

function toBboxItems(problems: StagingProblem[]): BboxItem[] {
  return problems
    .filter(p => p.bbox)
    .map((p, i) => ({
      stagingId: p.id,
      bbox: { x1: p.bbox!.x1, y1: p.bbox!.y1, x2: p.bbox!.x2, y2: p.bbox!.y2 },
      number: i + 1,
    }));
}

function bboxChanged(a: BboxItem['bbox'], b: { x1: number; y1: number; x2: number; y2: number }): boolean {
  return (
    Math.abs(Math.round(a.x1) - Math.round(b.x1)) > 1 ||
    Math.abs(Math.round(a.y1) - Math.round(b.y1)) > 1 ||
    Math.abs(Math.round(a.x2) - Math.round(b.x2)) > 1 ||
    Math.abs(Math.round(a.y2) - Math.round(b.y2)) > 1
  );
}

const PdfReview = () => {
  const { jobId } = useParams<{ jobId: string }>();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const { breadcrumb } = useTextbook();

  const [problems, setProblems] = useState<StagingProblem[]>([]);
  const [loading, setLoading] = useState(true);
  const [approving, setApproving] = useState(false);

  const [pages, setPages] = useState<number[]>([]);
  const [activePage, setActivePage] = useState<number>(0);

  // 페이지별 bbox 캐시: 페이지 이동해도 수정 내용 유지
  const [bboxCache, setBboxCache] = useState<Map<number, BboxItem[]>>(new Map());

  // YOLO 재학습용: bbox가 수정+저장된 페이지 번호 추적
  const [modifiedPages, setModifiedPages] = useState<Set<number>>(new Set());
  const [exportingYolo, setExportingYolo] = useState(false);
  const [savingBbox, setSavingBbox] = useState(false);
  const [approvingId, setApprovingId] = useState<string | null>(null);

  const prevActivePageRef = useRef<number | null>(null);

  useEffect(() => {
    if (jobId) loadProblems();
  }, [jobId]);

  const loadProblems = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${PIPELINE_URL}/api/staging/${jobId}`);
      if (!res.ok) throw new Error('문제 목록 조회 실패');
      const data = await res.json();
      const list: StagingProblem[] = data.problems;
      setProblems(list);

      const pageNums = [...new Set(list.map(p => p.page_number).filter(Boolean) as number[])].sort((a, b) => a - b);
      setPages(pageNums);
      if (pageNums.length > 0 && prevActivePageRef.current === null) {
        setActivePage(pageNums[0]);
      }
    } catch (e: any) {
      toast({ title: '오류', description: e.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  // 페이지 전환 시 캐시 저장 및 복원
  useEffect(() => {
    if (activePage === 0) return;
    if (prevActivePageRef.current === activePage) return;
    prevActivePageRef.current = activePage;

    setBboxCache(prev => {
      // 캐시에 없으면 DB 원본으로 초기화
      if (!prev.has(activePage)) {
        const pageProblems = problems.filter(p => p.page_number === activePage);
        const next = new Map(prev);
        next.set(activePage, toBboxItems(pageProblems));
        return next;
      }
      return prev;
    });
  }, [activePage, problems]);

  // 현재 페이지 bbox (캐시 우선)
  const bboxItems: BboxItem[] = useMemo(() => {
    if (bboxCache.has(activePage)) return bboxCache.get(activePage)!;
    const pageProblems = problems.filter(p => p.page_number === activePage);
    return toBboxItems(pageProblems);
  }, [activePage, bboxCache, problems]);

  const activePageProblems = problems.filter(p => p.page_number === activePage);
  const pageImageUrl = activePageProblems[0]?.source_page_image_url || null;
  const pageWidth = activePageProblems[0]?.bbox?.page_width || 3509;
  const pageHeight = activePageProblems[0]?.bbox?.page_height || 4963;

  // 현재 페이지에서 bbox가 수정된 stagingId 집합 (캐시 기준)
  const modifiedStagingIds = useMemo(() => {
    const ids = new Set<string>();
    for (const item of bboxItems) {
      if (item.stagingId === null) continue;
      const original = problems.find(p => p.id === item.stagingId);
      if (!original?.bbox) continue;
      if (bboxChanged(item.bbox, original.bbox)) ids.add(item.stagingId);
    }
    return ids;
  }, [bboxItems, problems]);

  // 전체 페이지 중 수정된 stagingId (캐시 전체 기준, 배지용)
  const allModifiedStagingIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [, items] of bboxCache) {
      for (const item of items) {
        if (item.stagingId === null) continue;
        const original = problems.find(p => p.id === item.stagingId);
        if (!original?.bbox) continue;
        if (bboxChanged(item.bbox, original.bbox)) ids.add(item.stagingId);
      }
    }
    return ids;
  }, [bboxCache, problems]);

  const newBboxCount = bboxItems.filter(i => i.stagingId === null).length;

  const handleBboxChange = useCallback((items: BboxItem[]) => {
    setBboxCache(prev => {
      const next = new Map(prev);
      next.set(activePage, items);
      return next;
    });
  }, [activePage]);

  const handleResetBbox = () => {
    const pageProblems = problems.filter(p => p.page_number === activePage);
    setBboxCache(prev => {
      const next = new Map(prev);
      next.set(activePage, toBboxItems(pageProblems));
      return next;
    });
  };

  // bbox 저장 (재크롭 API 호출) - 현재 페이지만
  const saveBboxForPage = async (pageNum: number): Promise<boolean> => {
    const items = bboxCache.get(pageNum) ?? [];
    const pageProblem = problems.find(p => p.page_number === pageNum);
    const imgUrl = pageProblem?.source_page_image_url;
    const pw = pageProblem?.bbox?.page_width || 3509;
    const ph = pageProblem?.bbox?.page_height || 4963;

    if (!imgUrl) return false;

    const res = await fetch(`${PIPELINE_URL}/api/staging/${jobId}/update-bboxes`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        page_number: pageNum,
        source_page_image_url: imgUrl,
        page_width: pw,
        page_height: ph,
        problems: items.map(item => ({
          staging_id: item.stagingId,
          bbox: item.bbox,
        })),
      }),
    });
    return res.ok;
  };

  // 저장(재크롭) 버튼 - 현재 페이지
  const handleSaveBbox = async () => {
    setSavingBbox(true);
    try {
      const ok = await saveBboxForPage(activePage);
      if (!ok) throw new Error('bbox 저장 실패');
      toast({ title: '저장 완료', description: '박스가 재크롭되어 저장되었습니다.' });
      setModifiedPages(prev => new Set([...prev, activePage]));
      await loadProblems();
    } catch (e: any) {
      toast({ title: '오류', description: e.message, variant: 'destructive' });
    } finally {
      setSavingBbox(false);
    }
  };

  // ✓ 버튼: bbox 저장 + approved
  const handleApprove = async (id: string) => {
    setApprovingId(id);
    try {
      const problem = problems.find(p => p.id === id);
      const pageNum = problem?.page_number;

      // 현재 페이지에 수정된 bbox가 있으면 먼저 저장
      if (pageNum && (modifiedStagingIds.size > 0 || bboxItems.some(i => i.stagingId === null))) {
        const ok = await saveBboxForPage(pageNum);
        if (ok) {
          setModifiedPages(prev => new Set([...prev, pageNum]));
          await loadProblems();
        }
      }

      // status approved
      const res = await fetch(`${PIPELINE_URL}/api/staging/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'approved' }),
      });
      if (!res.ok) throw new Error('승인 실패');
      setProblems(prev => prev.map(p => p.id === id ? { ...p, status: 'approved' } : p));
    } catch (e: any) {
      toast({ title: '오류', description: e.message, variant: 'destructive' });
    } finally {
      setApprovingId(null);
    }
  };

  const handleReject = async (id: string) => {
    try {
      const res = await fetch(`${PIPELINE_URL}/api/staging/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'rejected' }),
      });
      if (!res.ok) throw new Error('거부 실패');
      setProblems(prev => prev.map(p => p.id === id ? { ...p, status: 'rejected' } : p));
    } catch (e: any) {
      toast({ title: '오류', description: e.message, variant: 'destructive' });
    }
  };

  const handleApproveAll = async () => {
    try {
      const pendingIds = problems.filter(p => p.status === 'pending').map(p => p.id);
      await Promise.all(pendingIds.map(id =>
        fetch(`${PIPELINE_URL}/api/staging/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'approved' }),
        })
      ));
      setProblems(prev => prev.map(p => p.status === 'pending' ? { ...p, status: 'approved' } : p));
      toast({ title: '전체 승인 완료', description: `${pendingIds.length}개 문제 승인됨` });
    } catch (e: any) {
      toast({ title: '오류', description: e.message, variant: 'destructive' });
    }
  };

  // YOLO 재학습 데이터 저장 (수정된 페이지만)
  const handleExportYolo = async () => {
    if (modifiedPages.size === 0) {
      toast({ title: '알림', description: '저장(재크롭)된 수정 페이지가 없습니다.', variant: 'destructive' });
      return;
    }
    setExportingYolo(true);
    try {
      const res = await fetch(`${PIPELINE_URL}/api/export-training-data`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          job_id: jobId,
          modified_page_numbers: [...modifiedPages],
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || '내보내기 실패');
      }
      const data = await res.json();
      toast({
        title: 'YOLO 재학습 저장 완료',
        description: `${data.exported_count}페이지 저장됨 (train: ${data.train}, val: ${data.val})`,
      });
    } catch (e: any) {
      toast({ title: '오류', description: e.message, variant: 'destructive' });
    } finally {
      setExportingYolo(false);
    }
  };

  const handleFinalApprove = async () => {
    if (!profile) return;
    setApproving(true);
    try {
      const res = await fetch(`${PIPELINE_URL}/api/staging/${jobId}/approve-all`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teacher_id: profile.id }),
      });
      if (!res.ok) throw new Error('등록 실패');
      const data = await res.json();
      toast({ title: '등록 완료', description: data.message });
      navigate(`/cms/pdf-review/${jobId}/details`);
    } catch (e: any) {
      toast({ title: '오류', description: e.message, variant: 'destructive' });
    } finally {
      setApproving(false);
    }
  };

  const approvedCount = problems.filter(p => p.status === 'approved').length;
  const totalCount = problems.filter(p => p.status !== 'rejected').length;

  // 현재 페이지에 수정 있는지 (저장 버튼 활성화 기준)
  const currentPageDirty = modifiedStagingIds.size > 0 || newBboxCount > 0;

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  const hasBboxData = problems.some(p => p.bbox && p.source_page_image_url);

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      {/* 상단 헤더 */}
      <div className="flex items-center justify-between px-4 py-3 border-b bg-white shrink-0">
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => navigate('/cms/textbooks')}>
            <ArrowLeft className="h-4 w-4 mr-1" />
            돌아가기
          </Button>
          <div>
            <h1 className="text-xl font-bold">크롭 검수</h1>
            {breadcrumb && (
              <p className="text-xs text-primary flex items-center gap-1">
                <BookOpen className="h-3 w-3" />
                {breadcrumb}
              </p>
            )}
            <p className="text-xs text-muted-foreground">승인됨: {approvedCount} / {totalCount}개</p>
          </div>
        </div>
        <div className="flex gap-2">
          {modifiedPages.size > 0 && (
            <Button variant="outline" size="sm" onClick={handleExportYolo} disabled={exportingYolo}>
              {exportingYolo ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Download className="h-4 w-4 mr-1" />}
              YOLO 재학습 저장 ({modifiedPages.size}페이지)
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={handleApproveAll}>
            <CheckCheck className="h-4 w-4 mr-1" />
            전체 승인
          </Button>
          <Button size="sm" onClick={handleFinalApprove} disabled={approving || approvedCount === 0}>
            {approving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Check className="h-4 w-4 mr-1" />}
            상세 입력 ({approvedCount}개)
          </Button>
        </div>
      </div>

      {hasBboxData ? (
        <div className="flex flex-1 overflow-hidden">
          {/* 좌측: 페이지 탭 + Canvas 에디터 */}
          <div className="flex flex-col flex-1 overflow-hidden border-r">
            {/* 페이지 탭 */}
            <div className="flex gap-1 px-3 py-2 border-b bg-gray-50 overflow-x-auto shrink-0">
              {pages.map(pg => {
                const pgProblems = problems.filter(p => p.page_number === pg);
                const pgItems = bboxCache.get(pg) ?? toBboxItems(pgProblems);
                const pgModified = pgItems.some(item => {
                  if (item.stagingId === null) return true;
                  const orig = problems.find(p => p.id === item.stagingId);
                  return orig?.bbox ? bboxChanged(item.bbox, orig.bbox) : false;
                });
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
                    <span className="ml-1 text-xs opacity-70">
                      ({pgProblems.length}문제)
                    </span>
                    {modifiedPages.has(pg) && (
                      <span className="ml-1 text-xs text-orange-500">✏</span>
                    )}
                    {pgModified && !modifiedPages.has(pg) && (
                      <span className="ml-1 text-xs text-yellow-500">●</span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* 캔버스 에디터 */}
            <div className="flex-1 overflow-auto p-3">
              {pageImageUrl ? (
                <>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-sm text-muted-foreground">
                      {activePage}페이지 — {bboxItems.length}개 박스
                      {currentPageDirty && (
                        <span className="ml-2 text-orange-600 font-medium">
                          (수정 {modifiedStagingIds.size + newBboxCount}건 — 미저장)
                        </span>
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
                        저장 (재크롭)
                      </Button>
                    </div>
                  </div>
                  <BboxEditor
                    pageImageUrl={pageImageUrl}
                    pageWidth={pageWidth}
                    pageHeight={pageHeight}
                    items={bboxItems}
                    onChange={handleBboxChange}
                  />
                </>
              ) : (
                <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                  이 페이지에 원본 이미지가 없습니다.
                </div>
              )}
            </div>
          </div>

          {/* 우측: 현재 페이지 문제 목록 */}
          <div className="w-72 flex flex-col overflow-hidden shrink-0">
            <div className="px-3 py-2 border-b bg-gray-50 shrink-0">
              <p className="text-sm font-medium">{activePage}페이지 문제 목록</p>
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-2">
              {activePageProblems.map(p => {
                const isBboxModified = allModifiedStagingIds.has(p.id);
                const isApprovingThis = approvingId === p.id;
                return (
                  <Card
                    key={p.id}
                    className={`text-sm ${p.status === 'rejected' ? 'opacity-40' : ''}`}
                  >
                    <CardHeader className="py-2 px-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1 flex-wrap">
                          <span className="font-semibold">{p.problem_number}번</span>
                          <span className={`text-xs px-1.5 py-0.5 rounded-full ${statusColor[p.status]}`}>
                            {p.status}
                          </span>
                          {isBboxModified && (
                            <span className="text-xs px-1.5 py-0.5 rounded-full bg-orange-100 text-orange-700">
                              ✏ bbox수정
                            </span>
                          )}
                        </div>
                        <div className="flex gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 px-2 text-green-600"
                            onClick={() => handleApprove(p.id)}
                            disabled={p.status === 'approved' || isApprovingThis}
                          >
                            {isApprovingThis ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 px-2 text-red-600"
                            onClick={() => handleReject(p.id)}
                            disabled={p.status === 'rejected'}
                          >
                            <X className="h-3 w-3" />
                          </Button>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className="py-1 px-3">
                      <div className="text-xs text-muted-foreground">
                        {p.confidence < 0.7 && (
                          <span className="text-red-500">신뢰도: {(p.confidence * 100).toFixed(0)}%</span>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
              {/* 새로 추가된 bbox */}
              {bboxItems.filter(i => i.stagingId === null).map((item, idx) => (
                <Card key={`new-${idx}`} className="text-sm border-blue-200">
                  <CardHeader className="py-2 px-3">
                    <div className="flex items-center gap-1">
                      <span className="font-semibold">{item.number}번</span>
                      <span className="text-xs px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700">
                        + 신규
                      </span>
                    </div>
                  </CardHeader>
                </Card>
              ))}
            </div>
          </div>
        </div>
      ) : (
        /* bbox 없을 때: 기존 카드 목록 뷰 */
        <div className="flex-1 overflow-y-auto p-4">
          <div className="max-w-3xl mx-auto space-y-3">
            {problems.map(p => (
              <Card key={p.id} className={p.status === 'rejected' ? 'opacity-40' : ''}>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{p.problem_number}번</span>
                      {p.confidence < 0.7 && (
                        <span className="text-xs text-red-500">
                          (신뢰도 낮음: {(p.confidence * 100).toFixed(0)}%)
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`text-xs px-2 py-1 rounded-full ${statusColor[p.status]}`}>{p.status}</span>
                      <Button size="sm" variant="ghost" className="text-green-600" onClick={() => handleApprove(p.id)} disabled={p.status === 'approved'}>
                        <Check className="h-4 w-4" />
                      </Button>
                      <Button size="sm" variant="ghost" className="text-red-600" onClick={() => handleReject(p.id)} disabled={p.status === 'rejected'}>
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  {p.source_image_url ? (
                    <img src={p.source_image_url} alt={`문제 ${p.problem_number}`} className="mt-2 max-w-full rounded border" style={{ maxHeight: 400 }} />
                  ) : (
                    <p className="mt-2 text-sm bg-muted p-2 rounded text-ellipsis overflow-hidden max-h-20">{p.problem_text}</p>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default PdfReview;
