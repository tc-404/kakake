import * as React from 'react';
import { cn } from '@/lib/utils';

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<'input'>>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      className={cn(
        /*
         * 只过渡真正会变的属性：outline 不能进过渡列表。
         * 元素带 outline-none（= 2px 透明描边），一旦用 transition-all，
         * 失焦时 outline-width 从 0 长回 2px 的瞬间会先把 currentColor（近黑）
         * 过渡出来，闪一道黑边。这里显式收窄，视觉过渡与原来完全一致。
         */
        'flex h-10 w-full rounded-xl border border-white/30 bg-white/20 px-3.5 py-2 text-sm text-slate-800 outline-none transition-[background-color,border-color,box-shadow,opacity] duration-200',
        'backdrop-blur-sm placeholder:text-slate-500',
        'hover:bg-white/25',
        'focus-visible:border-teal-400/50 focus-visible:bg-white/30 focus-visible:ring-2 focus-visible:ring-teal-500/50',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'file:border-0 file:bg-transparent file:text-sm file:font-medium',
        'aria-[invalid=true]:border-rose-400/70 aria-[invalid=true]:bg-rose-50/40 aria-[invalid=true]:focus-visible:ring-rose-200/60',
        className,
      )}
      ref={ref}
      {...props}
    />
  ),
);
Input.displayName = 'Input';

export { Input };
