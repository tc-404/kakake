import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export type StatTone = 'sky' | 'emerald' | 'violet' | 'amber' | 'slate';

const TONE: Record<
  StatTone,
  { icon: string; value: string }
> = {
  sky: {
    icon: 'bg-sky-500/15 text-sky-600',
    value: 'text-sky-700',
  },
  emerald: {
    icon: 'bg-emerald-500/15 text-emerald-600',
    value: 'text-emerald-700',
  },
  violet: {
    icon: 'bg-violet-500/15 text-violet-600',
    value: 'text-violet-700',
  },
  amber: {
    icon: 'bg-amber-500/15 text-amber-600',
    value: 'text-amber-700',
  },
  slate: {
    icon: 'bg-slate-500/12 text-slate-500',
    value: 'text-slate-600',
  },
};

export function StatCard({
  label,
  value,
  icon: Icon,
  tone = 'sky',
  className,
  tourId,
}: {
  label: string;
  value: number | string;
  icon: LucideIcon;
  tone?: StatTone;
  className?: string;
  tourId?: string;
}) {
  const t = TONE[tone];
  return (
    <div
      data-tour={tourId}
      className={cn(
        'kk-card flex flex-col items-center gap-1.5 p-2.5 text-center sm:items-start sm:gap-3 sm:p-5 sm:text-left',
        className,
      )}
    >
      <div className={cn('flex h-8 w-8 items-center justify-center rounded-xl sm:h-11 sm:w-11 sm:rounded-2xl', t.icon)}>
        <Icon className="h-3.5 w-3.5 sm:h-5 sm:w-5" />
      </div>
      <div className="min-w-0">
        <p className="truncate text-[11px] font-medium text-muted-foreground sm:text-[13px]">{label}</p>
        <p className={cn('mt-0.5 text-xl font-bold leading-none tracking-tight tabular-nums sm:mt-1 sm:text-[2rem]', t.value)}>
          {value}
        </p>
      </div>
    </div>
  );
}

export function StatCardSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn('kk-card flex flex-col items-center gap-1.5 p-2.5 sm:items-start sm:gap-3 sm:p-5', className)}>
      <div className="h-8 w-8 animate-pulse rounded-xl bg-white/40 sm:h-11 sm:w-11 sm:rounded-2xl" />
      <div className="w-full space-y-1.5 sm:space-y-2">
        <div className="mx-auto h-2.5 w-12 animate-pulse rounded bg-white/40 sm:mx-0 sm:h-3 sm:w-14" />
        <div className="mx-auto h-6 w-10 animate-pulse rounded-md bg-white/50 sm:mx-0 sm:h-8 sm:w-12" />
      </div>
    </div>
  );
}
