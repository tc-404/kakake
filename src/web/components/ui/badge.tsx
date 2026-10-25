import * as React from 'react';
import { cn } from '@/lib/utils';

function Badge({
  className,
  variant = 'default',
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  variant?: 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning';
}) {
  return (
    <div
      className={cn(
        'inline-flex items-center rounded-lg border px-2 py-0.5 text-xs font-semibold transition-colors backdrop-blur-sm',
        variant === 'default' && 'border-transparent bg-primary/90 text-primary-foreground',
        variant === 'secondary' && 'border-white/40 bg-white/45 text-secondary-foreground',
        variant === 'destructive' && 'border-transparent bg-destructive/90 text-destructive-foreground',
        variant === 'outline' && 'border-white/50 bg-white/30 text-foreground',
        variant === 'success' && 'border-emerald-200/60 bg-emerald-100/70 text-emerald-800',
        variant === 'warning' && 'border-amber-200/60 bg-amber-100/70 text-amber-800',
        className,
      )}
      {...props}
    />
  );
}

export { Badge };
