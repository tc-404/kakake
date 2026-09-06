import * as React from 'react';
import { cn } from '@/lib/utils';

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
        onChange={(e) => onValueChange(Number(e.target.value))}
        className={cn('kk-slider', className)}
        style={{ '--kk-slider-fill': `${pct}%` } as React.CSSProperties}
      />
    );
  },
);
Slider.displayName = 'Slider';