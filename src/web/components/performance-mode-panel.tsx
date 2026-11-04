import { useSyncExternalStore } from 'react';
import {
  getDeviceTier,
  getPerfMode,
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

/**
 * 性能模式设置：三态开关 + 当前判定结果展示。
 * auto = 按设备能力自动判定（核数/内存/iOS/实测帧率）；low / normal 为用户强制覆盖。
 * 设置只存浏览器本地（localStorage），不影响其他设备。
 */
export function PerformanceModePanel() {
  // 模式与档位变化都会触发 subscribeDeviceTier，这里把两者合成一个快照字符串
  const t = useT();
  const snapshot = useSyncExternalStore(
    subscribeDeviceTier,
    () => `${getPerfMode()}:${getDeviceTier()}`,
    () => 'auto:normal',
  );
  const [mode] = snapshot.split(':') as [PerfMode, 'low' | 'normal'];

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
              title={
                key === 'auto'
                  ? t('settings.perfAutoHint')
                  : key === 'low'
                    ? t('settings.perfLowHint')
                    : t('settings.perfNormalHint')
              }
              onClick={() => setPerfMode(key)}
              className={cn(
                'relative z-10 flex h-10 flex-1 items-center justify-center rounded-xl text-sm font-medium transition-colors duration-200',
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
    </div>
  );
}
