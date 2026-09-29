import * as React from 'react';
import { cn } from '@/lib/utils';

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<'input'>>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      className={cn(
        'flex h-10 w-full rounded-xl border border-white/30 bg-white/20 px-3.5 py-2 text-sm text-slate-800 outline-none transition-all duration-200',
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
