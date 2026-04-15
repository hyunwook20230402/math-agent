/**
 * BboxEditor — 원본 페이지 이미지 위에 bbox 오버레이 편집기
 *
 * - 드래그: bbox 이동
 * - 모서리 드래그: 크기 조정
 * - 새 영역 드래그: bbox 추가
 * - 우클릭 / Delete 키: bbox 삭제
 */
import { useRef, useEffect, useState, useCallback } from 'react';

export interface Bbox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export type BoxType = 'solution' | 'answer_table';

export interface BboxItem {
  stagingId: string | null; // null = 신규
  bbox: Bbox;
  number: number; // 표시용 문제 번호 (1-based, 에디터 내부 순서)
  groupId?: string | null; // 같은 번호로 묶인 박스들의 공통 id (L자/cross-page 해설)
  boxType?: BoxType; // 'solution'(기본) | 'answer_table' — YOLO 2-클래스 학습용
  // true = DB/OCR 실제값 또는 사용자 직접 입력값 (저장 대상)
  // false = fallback 자동 번호 (표시용, 저장 시 null로 변환)
  numberExplicit?: boolean;
}

interface Props {
  pageImageUrl: string;
  pageWidth: number;
  pageHeight: number;
  items: BboxItem[];
  onChange: (items: BboxItem[]) => void;
  resetKey?: number;
  /** true면 박스 번호를 위치 기반으로 자동 재정렬하지 않음 (해설지 L자 케이스 등) */
  preserveNumbers?: boolean;
  /** 현재 선택된 박스 idx를 부모에 알림 (툴바 렌더용) */
  onSelectionChange?: (idx: number | null) => void;
  /** 빈 페이지에서 첫 박스를 그릴 때 사용할 전역 이어짐 번호 (없으면 1) */
  fallbackStartNumber?: number;
}

const HANDLE_SIZE = 10; // 모서리 핸들 크기 (px, canvas 좌표)
const MIN_BOX_SIZE = 20;
const BOX_COLOR = 'rgba(239,68,68,0.85)';   // 빨간색 — solution (해설)
const ANSWER_TABLE_COLOR = 'rgba(107,114,128,0.85)'; // 회색 — answer_table (정답표)
const NEW_BOX_COLOR = 'rgba(59,130,246,0.7)'; // 파란색 (새 박스 드래그 중)
const SELECTED_COLOR = 'rgba(234,179,8,0.9)'; // 노란색 (선택됨)

// 그룹(같은 번호로 묶인 박스) 색상 팔레트. groupId 해시 → 색상 매핑.
const GROUP_COLORS = [
  'rgba(16,185,129,0.9)',   // emerald
  'rgba(139,92,246,0.9)',   // violet
  'rgba(236,72,153,0.9)',   // pink
  'rgba(14,165,233,0.9)',   // sky
  'rgba(249,115,22,0.9)',   // orange
  'rgba(20,184,166,0.9)',   // teal
];
function groupColor(groupId: string): string {
  let h = 0;
  for (let i = 0; i < groupId.length; i++) h = (h * 31 + groupId.charCodeAt(i)) >>> 0;
  return GROUP_COLORS[h % GROUP_COLORS.length];
}

type DragMode =
  | { type: 'none' }
  | { type: 'move'; idx: number; startMx: number; startMy: number; origBbox: Bbox }
  | { type: 'resize'; idx: number; handle: ResizeHandle; startMx: number; startMy: number; origBbox: Bbox }
  | { type: 'new'; startX: number; startY: number; curX: number; curY: number };

type ResizeHandle = 'tl' | 'tr' | 'bl' | 'br';

export default function BboxEditor({
  pageImageUrl, pageWidth, pageHeight, items, onChange, resetKey,
  preserveNumbers = false, onSelectionChange, fallbackStartNumber = 1,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [scale, setScale] = useState(1);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const historyRef = useRef<BboxItem[][]>([]);

  useEffect(() => {
    setSelectedIdx(null);
  }, [resetKey]);

  // 콜백 참조가 매 렌더 바뀌어도 effect는 selectedIdx 변경 시에만 실행되도록 ref 패턴 사용.
  // (부모 handleSelectionChange가 mergeAnchorIdx 의존으로 재생성될 때, effect 재실행으로 인해
  //  묶기 앵커가 즉시 리셋되던 문제 방지)
  const onSelectionChangeRef = useRef(onSelectionChange);
  useEffect(() => { onSelectionChangeRef.current = onSelectionChange; }, [onSelectionChange]);
  useEffect(() => {
    onSelectionChangeRef.current?.(selectedIdx);
  }, [selectedIdx]);
  const dragRef = useRef<DragMode>({ type: 'none' });
  const itemsRef = useRef<BboxItem[]>(items);

  const pushHistory = useCallback(() => {
    historyRef.current = [...historyRef.current, itemsRef.current.map(it => ({ ...it, bbox: { ...it.bbox } }))];
    if (historyRef.current.length > 50) historyRef.current.shift();
  }, []);
  const imgRef = useRef<HTMLImageElement | null>(null);

  // items prop이 바뀌면 ref 동기화
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  // 이미지 로드 & 캔버스 크기 계산
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      imgRef.current = img;
      const container = canvas.parentElement;
      if (!container) return;
      const maxW = container.clientWidth || 700;
      const s = Math.min(maxW / pageWidth, 1);
      setScale(s);
      canvas.width = Math.round(pageWidth * s);
      canvas.height = Math.round(pageHeight * s);
      draw();
    };
    img.src = pageImageUrl;
  }, [pageImageUrl, pageWidth, pageHeight]);

  // 재렌더링 트리거 (items/selectedIdx 변경 시)
  useEffect(() => {
    draw();
  }, [items, selectedIdx, scale]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const s = scale;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    itemsRef.current.forEach((item, idx) => {
      const { x1, y1, x2, y2 } = item.bbox;
      const sx1 = x1 * s, sy1 = y1 * s, sw = (x2 - x1) * s, sh = (y2 - y1) * s;
      const isSelected = idx === selectedIdx;
      const isAnswerTable = item.boxType === 'answer_table';
      // 정답표 > 그룹 > 기본 순 우선순위
      const baseColor = isAnswerTable
        ? ANSWER_TABLE_COLOR
        : (item.groupId ? groupColor(item.groupId) : BOX_COLOR);
      ctx.strokeStyle = isSelected ? SELECTED_COLOR : baseColor;
      ctx.lineWidth = isSelected ? 3 : 2;
      if (isAnswerTable) {
        ctx.setLineDash([8, 4]); // 정답표는 점선
      }
      ctx.strokeRect(sx1, sy1, sw, sh);
      ctx.setLineDash([]);

      const fillBase = isAnswerTable
        ? 'rgba(107,114,128,0.06)'
        : (item.groupId ? baseColor.replace('0.9)', '0.08)') : 'rgba(239,68,68,0.06)');
      ctx.fillStyle = isSelected ? 'rgba(234,179,8,0.08)' : fillBase;
      ctx.fillRect(sx1, sy1, sw, sh);

      ctx.fillStyle = isSelected ? SELECTED_COLOR : baseColor;
      ctx.font = `bold ${Math.max(12, 14 * s)}px sans-serif`;
      let label: string;
      if (isAnswerTable) {
        label = '정답표';
      } else if (item.groupId) {
        label = `${item.number}번 \u25C6`;
      } else {
        label = `${item.number}번`;
      }
      ctx.fillText(label, sx1 + 4, sy1 + Math.max(14, 16 * s));

      // 모서리 핸들 (선택된 박스만)
      if (isSelected) {
        [
          [sx1, sy1], [sx1 + sw, sy1],
          [sx1, sy1 + sh], [sx1 + sw, sy1 + sh],
        ].forEach(([hx, hy]) => {
          ctx.fillStyle = SELECTED_COLOR;
          ctx.fillRect(hx - HANDLE_SIZE / 2, hy - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
        });
      }
    });

    // 새 박스 드래그 중
    const drag = dragRef.current;
    if (drag.type === 'new') {
      const sx1 = Math.min(drag.startX, drag.curX);
      const sy1 = Math.min(drag.startY, drag.curY);
      const sw = Math.abs(drag.curX - drag.startX);
      const sh = Math.abs(drag.curY - drag.startY);
      ctx.strokeStyle = NEW_BOX_COLOR;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 3]);
      ctx.strokeRect(sx1, sy1, sw, sh);
      ctx.setLineDash([]);
    }
  }, [scale, selectedIdx]);

  // 캔버스 좌표 → 원본 이미지 좌표
  const toImgCoord = (cx: number, cy: number) => ({
    x: cx / scale,
    y: cy / scale,
  });

  // 특정 캔버스 좌표에서 어떤 bbox/handle인지 판별
  const hitTest = (cx: number, cy: number): { idx: number; handle: ResizeHandle | null } | null => {
    const s = scale;
    // 역순으로 (위에 그려진 박스 먼저)
    for (let i = itemsRef.current.length - 1; i >= 0; i--) {
      const { x1, y1, x2, y2 } = itemsRef.current[i].bbox;
      const sx1 = x1 * s, sy1 = y1 * s, sx2 = x2 * s, sy2 = y2 * s;

      // 모서리 핸들 (선택된 박스만)
      if (i === selectedIdx) {
        const handles: [ResizeHandle, number, number][] = [
          ['tl', sx1, sy1], ['tr', sx2, sy1],
          ['bl', sx1, sy2], ['br', sx2, sy2],
        ];
        for (const [h, hx, hy] of handles) {
          if (Math.abs(cx - hx) <= HANDLE_SIZE && Math.abs(cy - hy) <= HANDLE_SIZE) {
            return { idx: i, handle: h };
          }
        }
      }

      // 박스 내부
      if (cx >= sx1 && cx <= sx2 && cy >= sy1 && cy <= sy2) {
        return { idx: i, handle: null };
      }
    }
    return null;
  };

  const reorder = (updated: BboxItem[]): BboxItem[] => {
    if (preserveNumbers) return updated;
    // 정답표는 번호 재부여 대상에서 제외
    const tables = updated.filter(it => it.boxType === 'answer_table');
    const solutions = updated.filter(it => it.boxType !== 'answer_table');
    const midX = pageWidth / 2;
    const left = solutions
      .filter(it => (it.bbox.x1 + it.bbox.x2) / 2 < midX)
      .sort((a, b) => a.bbox.y1 - b.bbox.y1);
    const right = solutions
      .filter(it => (it.bbox.x1 + it.bbox.x2) / 2 >= midX)
      .sort((a, b) => a.bbox.y1 - b.bbox.y1);
    const renumbered = [...left, ...right].map((it, i) => ({ ...it, number: i + 1 }));
    return [...renumbered, ...tables];
  };

  const onMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;

    if (e.button === 2) {
      // 우클릭: 박스 위에서만 삭제, 빈 곳 우클릭은 무시
      const hit = hitTest(cx, cy);
      if (hit) {
        pushHistory();
        const next = reorder(itemsRef.current.filter((_, i) => i !== hit.idx));
        setSelectedIdx(null);
        onChange(next);
      }
      // hit 없으면 아무것도 안 함 (선택 해제 방지)
      return;
    }

    const hit = hitTest(cx, cy);
    if (hit) {
      setSelectedIdx(hit.idx);
      const origBbox = { ...itemsRef.current[hit.idx].bbox };
      if (hit.handle) {
        dragRef.current = {
          type: 'resize',
          idx: hit.idx,
          handle: hit.handle,
          startMx: cx,
          startMy: cy,
          origBbox,
        };
      } else {
        dragRef.current = {
          type: 'move',
          idx: hit.idx,
          startMx: cx,
          startMy: cy,
          origBbox,
        };
      }
    } else {
      // 빈 공간 드래그 → 새 박스
      setSelectedIdx(null);
      dragRef.current = { type: 'new', startX: cx, startY: cy, curX: cx, curY: cy };
    }
  };

  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const drag = dragRef.current;

    if (drag.type === 'none') return;

    if (drag.type === 'new') {
      dragRef.current = { ...drag, curX: cx, curY: cy };
      draw();
      return;
    }

    const dx = (cx - drag.startMx) / scale;
    const dy = (cy - drag.startMy) / scale;
    const orig = drag.origBbox;
    let updated = [...itemsRef.current];

    if (drag.type === 'move') {
      const W = orig.x2 - orig.x1;
      const H = orig.y2 - orig.y1;
      let nx1 = Math.max(0, orig.x1 + dx);
      let ny1 = Math.max(0, orig.y1 + dy);
      nx1 = Math.min(nx1, pageWidth - W);
      ny1 = Math.min(ny1, pageHeight - H);
      updated[drag.idx] = {
        ...updated[drag.idx],
        bbox: { x1: nx1, y1: ny1, x2: nx1 + W, y2: ny1 + H },
      };
    } else if (drag.type === 'resize') {
      let { x1, y1, x2, y2 } = orig;
      const h = drag.handle;
      if (h === 'tl') { x1 = orig.x1 + dx; y1 = orig.y1 + dy; }
      else if (h === 'tr') { x2 = orig.x2 + dx; y1 = orig.y1 + dy; }
      else if (h === 'bl') { x1 = orig.x1 + dx; y2 = orig.y2 + dy; }
      else if (h === 'br') { x2 = orig.x2 + dx; y2 = orig.y2 + dy; }
      // 최소 크기 보장 & 범위 클램핑
      x1 = Math.max(0, Math.min(x1, x2 - MIN_BOX_SIZE));
      y1 = Math.max(0, Math.min(y1, y2 - MIN_BOX_SIZE));
      x2 = Math.min(pageWidth, Math.max(x2, x1 + MIN_BOX_SIZE));
      y2 = Math.min(pageHeight, Math.max(y2, y1 + MIN_BOX_SIZE));
      updated[drag.idx] = { ...updated[drag.idx], bbox: { x1, y1, x2, y2 } };
    }

    itemsRef.current = updated;
    draw();
  };

  const onMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button === 2) return; // 우클릭은 onMouseDown에서만 처리
    const canvas = canvasRef.current;
    const drag = dragRef.current;
    dragRef.current = { type: 'none' };

    if (drag.type === 'new' && canvas) {
      const rect = canvas.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const { x: ix1, y: iy1 } = toImgCoord(Math.min(drag.startX, cx), Math.min(drag.startY, cy));
      const { x: ix2, y: iy2 } = toImgCoord(Math.max(drag.startX, cx), Math.max(drag.startY, cy));
      if (ix2 - ix1 >= MIN_BOX_SIZE && iy2 - iy1 >= MIN_BOX_SIZE) {
        // 새 박스 추가 전에 선택 해제 → 부모에서 묶기 모드 자동 취소
        setSelectedIdx(null);
        pushHistory();
        const solutionNums = itemsRef.current
          .filter(it => it.boxType !== 'answer_table')
          .map(it => it.number);
        // 페이지에 박스 있으면 그 max+1, 없으면 부모가 준 전역 이어짐 번호(fallbackStartNumber)
        const nextNum = solutionNums.length > 0 ? Math.max(...solutionNums) + 1 : fallbackStartNumber;
        const newItem: BboxItem = {
          stagingId: null,
          bbox: { x1: Math.round(ix1), y1: Math.round(iy1), x2: Math.round(ix2), y2: Math.round(iy2) },
          number: nextNum,
          boxType: 'solution',
          // 새로 그린 박스도 "자동 번호"이므로 fallback 취급.
          // 사용자가 번호 입력창에서 직접 고쳐야 explicit=true 전환됨.
          numberExplicit: false,
        };
        const next = reorder([...itemsRef.current, newItem]);
        onChange(next);
        return;
      }
    }

    if (drag.type === 'move' || drag.type === 'resize') {
      pushHistory();
      const next = reorder([...itemsRef.current]);
      onChange(next);
    }
  };

  const onKeyDown = useCallback((e: KeyboardEvent) => {
    if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (historyRef.current.length > 0) {
        const prev = historyRef.current.pop()!;
        itemsRef.current = prev;
        setSelectedIdx(null);
        onChange(prev);
      }
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIdx !== null) {
      pushHistory();
      const next = reorder(itemsRef.current.filter((_, i) => i !== selectedIdx));
      setSelectedIdx(null);
      onChange(next);
    }
  }, [selectedIdx, onChange, pushHistory]);

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onKeyDown]);

  return (
    <div className="relative w-full overflow-auto border rounded bg-gray-50">
      <canvas
        ref={canvasRef}
        style={{ display: 'block', cursor: 'crosshair', userSelect: 'none' }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onContextMenu={e => e.preventDefault()}
      />
      <p className="text-xs text-gray-400 px-2 py-1">
        드래그: 이동 | 모서리 드래그: 리사이즈 | 빈 공간 드래그: 추가 | 우클릭/Delete: 삭제 | Ctrl+Z: 되돌리기
      </p>
    </div>
  );
}
