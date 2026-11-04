import { useSyncExternalStore } from 'react';
import { useT, type Lang } from '@/lib/i18n';
import {
  getLanguageState,
  saveLanguage,
  subscribeLanguage,
} from '@/lib/language';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

/**
 * 语言切换：横铺满一行的左右分段按钮（与「资源来源」等切换条同一套观感）。
 * 左 = 简体中文（默认），右 = English。
 *
 * 这是**实例级**设置：点了写进服务端的 data/language.json，同时经 /api/events
 * 广播给所有在线会话——改完不只有自己这边变，别人那边一起切。
 * 存盘失败会回滚并弹提示，不会出现「我这边英文、刷新又变回去」。
 */
export function LanguageSwitcher({ className }: { className?: string }) {
  // 快照含 saving：只订阅 lang 的话保存结束后不重渲染，按钮会卡在 disabled
  const { lang, saving } = useSyncExternalStore(subscribeLanguage, getLanguageState, getLanguageState);
  const t = useT();
  const options: Array<{ value: Lang; label: string }> = [
    { value: 'zh', label: '简体中文' },
    { value: 'en', label: 'English' },
  ];
  return (
    <div
      role="radiogroup"
      aria-label="语言 / Language"
      className={cn(
        // 与设置里「资源来源」的切换条保持一致：整行铺满、玻璃底、滑动高亮
        'relative flex w-full items-center rounded-2xl border border-white/40 bg-white/20 p-1 backdrop-blur-sm',
        className,
      )}
    >
      {/* 滑动高亮指示器：在两个选项之间平滑滑动，而非瞬间切换 */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-1 left-1 w-[calc(50%-0.25rem)] rounded-xl bg-teal-500/90 shadow-md kk-glow transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none"
        style={{ transform: lang === 'en' ? 'translateX(100%)' : 'translateX(0)' }}
      />
      {options.map((opt) => {
        const active = lang === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={saving}
            onClick={() => {
              if (opt.value === lang) return;
              void saveLanguage(opt.value).then((saved) => {
                if (saved === null) toast.error(t('settings.languageSaveFailed'));
              });
            }}
            className={cn(
              'relative z-10 flex h-10 flex-1 items-center justify-center rounded-xl text-sm font-medium transition-colors duration-200',
              active ? 'text-white' : 'text-slate-600 hover:text-slate-800',
              saving && 'opacity-70',
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
