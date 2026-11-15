import { useSyncExternalStore } from 'react';
import {
  getDeviceTier,
  getPerfMode,
  isSoftwareRenderer,
  setPerfMode,
  subscribeDeviceTier,
  type PerfMode,
} from '@/lib/device-tier';
import { cn } from '@/lib/utils';
import { useT } from '@/lib/i18n';

const MODES: PerfMode[] = ['auto', 'low', 'normal'];
const MODE_LABEL_KEY: Record<PerfMode, string> = {
  auto: 'settings.perfAuto',
  low: 'settings.perfLow',
  normal: 'settings.perfNormal',
};
const MODE_HINT_KEY: Record<PerfMode, string> = {
  auto: 'settings.perfAutoHint',
  low: 'settings.perfLowHint',
  normal: 'settings.perfNormalHint',
};

export function PerformanceModePanel() {
  const t = useT();
  const snapshot = useSyncExternalStore(
    subscribeDeviceTier,
    () => `${getPerfMode()}:${getDeviceTier()}`,
    () => 'auto:normal',
  );
  const [mode, tier] = snapshot.split(':') as [PerfMode, 'low' | 'normal'];
  const software = isSoftwareRenderer();

  return (
    <div>
      <div
        role="radiogroup"
        aria-label={t('settings.performanceMode')}
        data-tour="perf-mode-toggle"
        className="relative flex w-full items-center rounded-2xl border border-white/40 bg-white/20 p-1 backdrop-blur-sm"
      >
        {MODES.map((key) => {
          const active = mode === key;
          return (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={active}
              title={t(MODE_HINT_KEY[key])}
              onClick={() => setPerfMode(key)}
              className={cn(
                'relative z-10 flex h-10 flex-1 items-center justify-center whitespace-nowrap rounded-xl px-1 text-xs font-medium transition-colors duration-200 sm:text-sm',
                active
                  ? 'rounded-xl bg-teal-500/90 text-white shadow-md kk-glow'
                  : 'text-slate-600 hover:text-slate-800',
              )}
            >
              {t(MODE_LABEL_KEY[key])}
            </button>
          );
        })}
      </div>
      {software && tier !== 'low' && (
        <p className="mt-2 text-xs leading-relaxed text-amber-700">
          {t('settings.perfSoftwareHint')}
        </p>
      )}
    </div>
  );
}
