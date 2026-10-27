import {
  BACKGROUND_PRESET_META,
  type BackgroundPreset,
} from '@/lib/appearance';
import { cn } from '@/lib/utils';
import { useT } from '@/lib/i18n';

/**
 * 背景预设切换：默认 / 波浪。
 *
 * 整体只在「完整特效」档显示（由 SettingsPage 决定是否渲染这张卡片）——
 * 性能模式下波浪压根不会画出来，摆个开关在那里只会让人以为坏了。
 *
 * 已设置自定义背景时开关照旧可点（选择被记住），只是下面多一行说明：
 * 自定义背景优先，预设暂时不生效；把自定义背景删掉后先前选的预设立刻回来。
 */
export function BackgroundPresetPanel({
  value,
  onChange,
  suppressed,
}: {
  value: BackgroundPreset;
  onChange: (preset: BackgroundPreset) => void;
  /** 已设置自定义背景：预设被压住不生效 */
  suppressed: boolean;
}) {
  const t = useT();
  // 背景预设：用本地 key 表按 item.value 取 i18n，原中文留在 lib/appearance.ts 作兜底。
  const PRESET_I18N: Record<string, string> = {
    default: 'settings.bgPresetDefault',
    waves: 'settings.bgPresetWaves',
  };
  const PRESET_HINT_I18N: Record<string, string> = {
    default: 'settings.bgPresetDefaultHint',
    waves: 'settings.bgPresetWavesHint',
  };
  return (
    <div className="space-y-3">
      <div
        role="radiogroup"
        aria-label={t('settings.backgroundPreset')}
        data-tour="bg-preset-toggle"
        className="relative flex w-full items-center rounded-2xl border border-white/40 bg-white/20 p-1 backdrop-blur-sm"
      >
        {BACKGROUND_PRESET_META.map((item) => {
          const active = value === item.value;
          return (
            <button
              key={item.value}
              type="button"
              role="radio"
              aria-checked={active}
              title={t(PRESET_HINT_I18N[item.value])}
              onClick={() => onChange(item.value)}
              className={cn(
                'relative z-10 flex h-10 flex-1 items-center justify-center rounded-xl text-sm font-medium transition-colors duration-200',
                active
                  ? 'rounded-xl bg-teal-500/90 text-white shadow-md kk-glow'
                  : 'text-slate-600 hover:text-slate-800',
              )}
            >
              {t(PRESET_I18N[item.value])}
            </button>
          );
        })}
      </div>
      {suppressed ? (
        <p className="text-xs leading-relaxed text-slate-400">
          {t('settings.bgPresetSuppressed')}
        </p>
      ) : null}
    </div>
  );
}
