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

export interface BboxItem {
  stagingId: string | null; // null = 신규
  bbox: Bbox;
  number: number; // 표시용 문제 번호 (1-based, 에디터 내부 순서)
}

interface Props {
  pageImageUrl: string;
  pageWidth: number;
  pageHeight: number;
  items: BboxItem[];
  onChange: (items: BboxItem[]) => void;
}

const HANDLE_SIZE = 10; // 모서리 핸들 크기 (px, canvas 좌표)
const MIN_BOX_SIZE = 20;
const BOX_COLOR = 'rgba(239,68,68,0.85)';   // 빨간색
const NEW_BOX_COLOR = 'rgba(59,130,246,0.7)'; // 파란색 (새 박스 드래그 중)
const SELECTED_COLOR = 'rgba(234,179,8,0.9)'; // 노란색 (선택됨)

type DragMode =
  | { type: 'none' }
  | { type: 'move'; idx: number; startMx: number; startMy: number; origBbox: Bbox }
  | { type: 'resize'; idx: number; handle: ResizeHandle; startMx: number; startMy: number; origBbox: Bbox }
  | { type: 'new'; startX: number; startY: number; curX: number; curY: number };

type ResizeHandle = 'tl' | 'tr' | 'bl' | 'br';

export default function BboxEditor({ pageImageUrl, pageWidth, pageHeight, items, onChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [scale, setScale] = useState(1);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const dragRef = useRef<DragMode>({ type: 'none' });
  const itemsRef = useRef<BboxItem[]>(items);
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

    // 기존 bbox 그리기
    itemsRef.current.forEach((item, idx) => {
      const { x1, y1, x2, y2 } = item.bbox;
      const sx1 = x1 * s, sy1 = y1 * s, sw = (x2 - x1) * s, sh = (y2 - y1) * s;
      const isSelected = idx === selectedIdx;
      ctx.strokeStyle = isSelected ? SELECTED_COLOR : BOX_COLOR;
      ctx.lineWidth = isSelected ? 3 : 2;
      ctx.strokeRect(sx1, sy1, sw, sh);

      // 반투명 배경
      ctx.fillStyle = isSelected ? 'rgba(234,179,8,0.08)' : 'rgba(239,68,68,0.06)';
      ctx.fillRect(sx1, sy1, sw, sh);

      // 문제 번호 라벨
      ctx.fillStyle = isSelected ? SELECTED_COLOR : BOX_COLOR;
      ctx.font = `bold ${Math.max(12, 14 * s)}px sans-serif`;
      ctx.fillText(`${item.number}번`, sx1 + 4, sy1 + Math.max(14, 16 * s));

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
    const midX = pageWidth / 2;
    const left = updated
      .filter(it => (it.bbox.x1 + it.bbox.x2) / 2 < midX)
      .sort((a, b) => a.bbox.y1 - b.bbox.y1);
    const right = updated
      .filter(it => (it.bbox.x1 + it.bbox.x2) / 2 >= midX)
      .sort((a, b) => a.bbox.y1 - b.bbox.y1);
    return [...left, ...right].map((it, i) => ({ ...it, number: i + 1 }));
  };

  const onMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;

    if (e.button === 2) {
      // 우클릭: 삭제
      const hit = hitTest(cx, cy);
      if (hit) {
        const next = reorder(itemsRef.current.filter((_, i) => i !== hit.idx));
        setSelectedIdx(null);
        onChange(next);
      }
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
        const newItem: BboxItem = {
          stagingId: null,
          bbox: { x1: Math.round(ix1), y1: Math.round(iy1), x2: Math.round(ix2), y2: Math.round(iy2) },
          number: itemsRef.current.length + 1,
        };
        const next = reorder([...itemsRef.current, newItem]);
        onChange(next);
        return;
      }
    }

    if (drag.type === 'move' || drag.type === 'resize') {
      const next = reorder([...itemsRef.current]);
      onChange(next);
    }
  };

  const onKeyDown = useCallback((e: KeyboardEvent) => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIdx !== null) {
      const next = reorder(itemsRef.current.filter((_, i) => i !== selectedIdx));
      setSelectedIdx(null);
      onChange(next);
    }
  }, [selectedIdx, onChange]);

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
        드래그: 이동 | 모서리 드래그: 리사이즈 | 빈 공간 드래그: 추가 | 우클릭/Delete: 삭제
      </p>
    </div>
  );
}
