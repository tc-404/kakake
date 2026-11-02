import * as React from 'react';
import { cn } from '@/lib/utils';

/** 判定手势方向前要跨过的位移（px）：小于它一律当作「手指还没动」 */
const GESTURE_SLOP = 6;

/** 拇指直径（px），与 .kk-slider::-webkit-slider-thumb 的 1.15rem 对齐 */
const THUMB_SIZE = 18;

/** 触摸按下点到拇指中心的容许偏差（px）：手指没有鼠标那么准，给足一点 */
const THUMB_GRAB = 26;

export interface SliderProps {
  id?: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onValueChange: (value: number) => void;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
  /** 读屏用的可读值，如 “1.0 倍” */
  valueText?: string;
}

/**
 * 触摸滑动条：原生 range 输入 + 玻璃质感样式（.kk-slider）。
 *
 * 用原生控件而非自绘 DOM，指针 / 触摸拖动、键盘方向键、读屏都直接可用；
 * 已填充比例通过 --kk-slider-fill 交给 CSS 画。
 */
export const Slider = React.forwardRef<HTMLInputElement, SliderProps>(
  ({ id, min, max, step, value, onValueChange, disabled, className, valueText, ...rest }, ref) => {
    const span = max - min;
    const pct = span > 0 ? Math.min(100, Math.max(0, ((value - min) / span) * 100)) : 0;

    /**
     * 触摸手势方向锁。
     *
     * 手机上滑动条是整行铺满的，手指上下滚页面时很容易扫到它，而原生 range
     * 会把这段位移按 x 分量算成改值；外加「轻点轨道一下就跳到那个位置」——
     * 两者合起来就是用户反馈的「明明没想调，值却自己变了」。
     * CSS 的 touch-action: pan-y 只挡得住纯竖向手势，斜着划和轻点都挡不住，
     * 所以这里再补一道：按下后先等手指跨过 GESTURE_SLOP，
     * 判成竖向 → 本次手势作废，并把按下瞬间那几像素已经改动的值退回去；
     * 一直没跨过 → 说明是轻点，直接忽略这次跳值。
     * 鼠标与键盘不受任何影响，照样可以点轨道跳值、按方向键微调。
     */
    const gesture = React.useRef<{
      x: number;
      y: number;
      start: number;
      decided: boolean;
      vertical: boolean;
      touch: boolean;
      outside: boolean;
    } | null>(null);

    /**
     * 触摸按下点是否落在拇指外。
     *
     * 手机上轨道是整行铺满的，而原生 range 按在哪儿拇指就跳到哪儿——
     * 手指扫过这一行的任何位置都会被它抓走。所以触摸端只认拇指附近那一段，
     * 按在轨道别处一律当作没碰到。桌面鼠标不受限，仍可点轨道任意处跳值。
     */
    const isOutsideThumb = (el: HTMLInputElement, clientX: number): boolean => {
      const rect = el.getBoundingClientRect();
      // 拇指可移动的区间要扣掉自身宽度，和浏览器排布 range 的方式一致
      const usable = Math.max(0, rect.width - THUMB_SIZE);
      const centerX = rect.left + THUMB_SIZE / 2 + usable * (pct / 100);
      return Math.abs(clientX - centerX) > THUMB_GRAB;
    };

    return (
      <input
        ref={ref}
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={rest['aria-label']}
        aria-valuetext={valueText}
        onPointerDown={(e) => {
          const touch = e.pointerType === 'touch';
          gesture.current = {
            x: e.clientX,
            y: e.clientY,
            start: value,
            decided: false,
            vertical: false,
            touch,
            outside: touch && isOutsideThumb(e.currentTarget, e.clientX),
          };
        }}
        onPointerMove={(e) => {
          const g = gesture.current;
          if (!g || g.decided || !g.touch || g.outside) return;
          const dx = Math.abs(e.clientX - g.x);
          const dy = Math.abs(e.clientY - g.y);
          if (dx < GESTURE_SLOP && dy < GESTURE_SLOP) return;
          g.decided = true;
          g.vertical = dy > dx;
          // 判成竖向：已经滚出去的几像素退回到按下前的值
          if (g.vertical && value !== g.start) onValueChange(g.start);
        }}
        onPointerUp={() => {
          gesture.current = null;
        }}
        onPointerCancel={() => {
          gesture.current = null;
        }}
        onChange={(e) => {
          const g = gesture.current;
          // 按在拇指外（手指扫过轨道）、竖向手势（在滚页面）、触摸轻点，都不改值
          if (g && g.touch && (g.outside || !g.decided || g.vertical)) return;
          onValueChange(Number(e.target.value));
        }}
        className={cn('kk-slider', className)}
        style={{ '--kk-slider-fill': `${pct}%` } as React.CSSProperties}
      />
    );
  },
);
Slider.displayName = 'Slider';
