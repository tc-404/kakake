import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { RefreshCw } from 'lucide-react';
import { getPortalRoot } from '@/lib/portal-root';
import { api } from '@/lib/api';
import { clearClientCaches } from '@/components/update-install-overlay';
import { useT } from '@/lib/i18n';

/**
 * 版本漂移检测：服务端经过「在线更新 + 重启」后，还开着的旧标签页仍跑着旧 SPA——
 * 旧页面再点懒加载页面会去拉已经被替换掉的旧 chunk，404 后表现为「覆盖显示不完善」。
 * 这里以页面加载时拉到的版本号为基线，定时（60s）与切回前台时拉轻量版本号比对，
 * 漂移了就弹横幅提示刷新。多标签场景每个标签各自检测、各自提示。
 */
export function VersionDriftBanner() {
  const t = useT();
  const [stale, setStale] = useState(false);
  const [staleVersion, setStaleVersion] = useState('');
  const [baseline, setBaseline] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const fetchVersion = async (): Promise<string | null> => {
      try {
        const r = await api.version.get();
        return r && r.ok ? r.version : null;
      } catch {
        return null;
      }
    };
    const check = async () => {
      const v = await fetchVersion();
      if (stopped || !v) return;
      // 基线在首次成功拉取时确立：语义是「相对本页面加载时的版本」
      setBaseline((cur) => cur ?? v);
      if (baseline !== null && v !== baseline) {
        setStaleVersion(v);
        setStale(true);
        stopped = true; // 已漂移就不再轮询，等用户刷新
        if (timer) clearInterval(timer);
      }
    };
    void check().then(() => {
      if (stopped) return;
      timer = setInterval(() => void check(), 60_000);
    });
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [baseline]);

  if (!stale) return null;

  return createPortal(
    <div className="fixed bottom-4 left-1/2 z-[90] -translate-x-1/2">
      <div className="kk-glass-2 kk-modal-in flex items-center gap-3 rounded-2xl px-4 py-3 shadow-[var(--glass2-shadow-modal)]">
        <span className="text-xs text-slate-600">
          {t('settings.versionDrift', { v: staleVersion })}
        </span>
        <button
          type="button"
          onClick={() => {
            void clearClientCaches().then(() => window.location.reload());
          }}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-gradient-to-r from-teal-500 to-emerald-500 px-3 text-xs font-semibold text-white shadow transition active:scale-95"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          {t('settings.versionDriftRefresh')}
        </button>
      </div>
    </div>,
    getPortalRoot(),
  );
}
