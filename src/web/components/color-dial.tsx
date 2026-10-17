import * as React from 'react';
import { hsvCss, type Hsv } from '@/lib/appearance';
import { cn } from '@/lib/utils';

/** 指针拖动（鼠标与触屏同一套）：把落点换算成 0–1 的相对坐标交给调用方 */
function useDragArea(onPick: (rx: number, ry: number) => void, disabled?: boolean) {
  const ref = React.useRef<HTMLDivElement>(null);
  const dragging = React.useRef(false);

  const emit = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const rx = (e.clientX - rect.left) / Math.max(1, rect.width);
    const ry = (e.clientY - rect.top) / Math.max(1, rect.height);
    onPick(Math.min(1, Math.max(0, rx)), Math.min(1, Math.max(0, ry)));
  };

  const end = (e: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  return {
    ref,
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
      if (disabled) return;
      dragging.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      emit(e);
    },
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging.current || disabled) return;
      emit(e);
    },
    onPointerUp: end,
    onPointerCancel: end,
  };
}

const to100 = (n: number) => Math.round(Math.min(100, Math.max(0, n)));

/**
 * 标准拾色器面板：正方形是「饱和度 × 明度」渐变区，中间小球标当前色；
 * 右侧竖条选色相。受控组件，三个值全靠拖动，没有输入框。供颜色悬浮窗复用。
 */
export function ColorArea({
  hsv, disabled, onChange, className,
}: {
  hsv: Hsv;
  disabled?: boolean;
  onChange: (next: Hsv) => void;
  className?: string;
}) {
  const push = (next: Partial<Hsv>) => onChange({ ...hsv, ...next });

  const area = useDragArea((rx, ry) => {
    push({ s: to100(rx * 100), v: to100((1 - ry) * 100) });
  }, disabled);

  const hueBar = useDragArea((_rx, ry) => {
    push({ h: Math.round(Math.min(360, Math.max(0, ry * 360))) });
  }, disabled);

  const onAreaKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const d = e.shiftKey ? 10 : 1;
    const moves: Record<string, Partial<Hsv>> = {
      ArrowLeft: { s: hsv.s - d },
      ArrowRight: { s: hsv.s + d },
      ArrowUp: { v: hsv.v + d },
      ArrowDown: { v: hsv.v - d },
    };
    const next = moves[e.key];
    if (!next) return;
    e.preventDefault();
    push({
      s: next.s === undefined ? hsv.s : to100(next.s),
      v: next.v === undefined ? hsv.v : to100(next.v),
    });
  };

  const onHueKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const d = e.shiftKey ? 15 : 2;
    const back = e.key === 'ArrowUp' || e.key === 'ArrowLeft';
    const fwd = e.key === 'ArrowDown' || e.key === 'ArrowRight';
    if (!back && !fwd) return;
    e.preventDefault();
    push({ h: ((Math.round(hsv.h + (back ? -d : d)) % 360) + 360) % 360 });
  };

  return (
    <div className={cn('flex gap-2.5', className)} data-disabled={disabled ? 'true' : undefined}>
      <div
        {...area}
        role="application"
        data-tour="color-area"
        tabIndex={disabled ? -1 : 0}
        aria-label={`颜色，饱和度 ${Math.round(hsv.s)}%，明度 ${Math.round(hsv.v)}%`}
        className="kk-color-dial__area kk-color-dial__area--lg"
        style={{
          backgroundColor: `hsl(${Math.round(hsv.h)} 100% 50%)`,
          backgroundImage:
            'linear-gradient(to top, #000, rgba(0, 0, 0, 0)), linear-gradient(to right, #fff, rgba(255, 255, 255, 0))',
        }}
        onKeyDown={onAreaKeyDown}
      >
        <span
          className="kk-color-dial__ball"
          style={{ left: `${hsv.s}%`, top: `${100 - hsv.v}%`, background: hsvCss(hsv) }}
        />
      </div>
      <div
        {...hueBar}
        role="slider"
        data-tour="color-hue"
        tabIndex={disabled ? -1 : 0}
        aria-label="色相"
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={360}
        aria-valuenow={Math.round(hsv.h)}
        aria-valuetext={`色相 ${Math.round(hsv.h)} 度`}
        className="kk-color-dial__hue kk-color-dial__hue--lg"
        onKeyDown={onHueKeyDown}
      >
        <span className="kk-color-dial__hue-knob" style={{ top: `${(hsv.h / 360) * 100}%` }} />
      </div>
    </div>
  );
}
