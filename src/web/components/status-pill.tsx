import { cn } from '@/lib/utils';
import type { ConnVisualStatus } from '@/lib/conn-status';

const DOT: Record<ConnVisualStatus, string> = {
  disabled: 'bg-slate-400',
  connected: 'bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.2)]',
  connecting: 'bg-amber-500',
  failed: 'bg-red-500',
  waiting: 'bg-amber-500',
};

const PILL: Record<ConnVisualStatus, string> = {
  disabled: 'border-white/40 bg-white/40 text-slate-600 backdrop-blur-sm',
  connected: 'border-emerald-200/50 bg-emerald-50/70 text-emerald-700 backdrop-blur-sm',
  connecting: 'border-amber-200/50 bg-amber-50/70 text-amber-800 backdrop-blur-sm',
  failed: 'border-red-200/50 bg-red-50/70 text-red-700 backdrop-blur-sm',
  waiting: 'border-amber-200/50 bg-amber-50/70 text-amber-800 backdrop-blur-sm',
};

export function StatusPill({
  status,
  label,
  className,
}: {
  status: ConnVisualStatus;
  label: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-xl border px-2.5 py-1 text-xs font-medium',
        PILL[status],
        className,
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', DOT[status])} />
      {label}
    </span>
  );
}
