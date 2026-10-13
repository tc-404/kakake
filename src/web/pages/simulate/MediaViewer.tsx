import { useEffect, useRef, useState } from 'react';
import { X, ZoomIn, ZoomOut, RotateCcw } from 'lucide-react';
import { Portal } from './Portal';

const MIN_SCALE = 1;
const MAX_SCALE = 6;

/**
 * 图片放大查看：渲染到 body、相对视口固定居中。
 * 支持滚轮 / 按钮 / 双击缩放，放大后可拖动平移，方便看清细节。
 */
export function ImageLightbox({ src, onClose }: { src: string; onClose: () => void }) {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  // 记录本次指针交互是否真的发生了拖动，用来在 onClick 里区分「点击」与「拖动」
  const moved = useRef(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

  const zoomBy = (delta: number) => {
    setScale((prev) => {
      const next = clampScale(Math.round((prev + delta) * 100) / 100);
      if (next === MIN_SCALE) setOffset({ x: 0, y: 0 });
      return next;
    });
  };

  const reset = () => { setScale(1); setOffset({ x: 0, y: 0 }); };

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 0.3 : -0.3);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (scale <= 1) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
    moved.current = false;
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const dx = e.clientX - drag.current.x;
    const dy = e.clientY - drag.current.y;
    // 超过阈值才算拖动，避免手抖被判成点击（点击会复位）
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved.current = true;
    setOffset({ x: drag.current.ox + dx, y: drag.current.oy + dy });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    drag.current = null;
    setDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  return (
    <Portal>
      <div
        className="fixed inset-0 z-[200] flex items-center justify-center overflow-hidden bg-black/75 backdrop-blur-sm"
        onClick={onClose}
        onWheel={onWheel}
      >
        {/* 工具栏 */}
        <div
          className="absolute right-3 z-[1] flex items-center gap-1.5"
          style={{ top: 'max(0.75rem, var(--safe-top))' }}
          onClick={(e) => e.stopPropagation()}
        >
          <LightboxBtn onClick={() => zoomBy(-0.5)} disabled={scale <= MIN_SCALE} title="缩小">
            <ZoomOut className="h-4 w-4" />
          </LightboxBtn>
          <span className="min-w-[3rem] rounded-full bg-white/15 px-2 py-1 text-center text-xs font-medium tabular-nums text-white">
            {Math.round(scale * 100)}%
          </span>
          <LightboxBtn onClick={() => zoomBy(0.5)} disabled={scale >= MAX_SCALE} title="放大">
            <ZoomIn className="h-4 w-4" />
          </LightboxBtn>
          <LightboxBtn onClick={reset} disabled={scale === 1 && offset.x === 0 && offset.y === 0} title="复位">
            <RotateCcw className="h-4 w-4" />
          </LightboxBtn>
          <LightboxBtn onClick={onClose} title="关闭">
            <X className="h-5 w-5" />
          </LightboxBtn>
        </div>

        <img
          src={src}
          alt="预览"
          draggable={false}
          className="max-h-[90dvh] max-w-[92vw] select-none rounded-lg object-contain"
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
            transition: dragging ? 'none' : 'transform 0.15s ease-out',
            cursor: scale > 1 ? (dragging ? 'grabbing' : 'grab') : 'zoom-in',
            touchAction: 'none',
          }}
          onClick={(e) => {
            e.stopPropagation();
            // 拖动后抬手会触发一次 click，此时不要复位
            if (moved.current) { moved.current = false; return; }
            if (scale > 1) reset();
            else setScale(2.5);
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
      </div>
    </Portal>
  );
}

function LightboxBtn({
  children, onClick, disabled, title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title: string;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="flex h-9 w-9 items-center justify-center rounded-full bg-white/15 text-white transition hover:bg-white/25 disabled:opacity-40"
    >
      {children}
    </button>
  );
}
