import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, CircleAlert, Loader2, RotateCw, XCircle } from 'lucide-react';
import { getPortalRoot } from '@/lib/portal-root';
import { api, type MaintenanceReport } from '@/lib/api';
import { beginRestarting, watchRestartThenReload } from '@/components/update-install-overlay';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/** 清浏览器存储：localStorage / sessionStorage / Cache Storage / 自建 IndexedDB 全清。
 *  Cookie 不在清除范围（登录状态保留，重启后自动重连不掉线）；用户确认过才执行。 */
function purgeBrowserStorage(): void {
  try { localStorage.clear(); } catch { /* ignore */ }
  try { sessionStorage.clear(); } catch { /* ignore */ }
  try {
    if (typeof caches !== 'undefined') {
      void caches.keys().then((keys) => keys.forEach((k) => caches.delete(k)));
    }
  } catch { /* ignore */ }
  try {
    if (typeof indexedDB !== 'undefined' && typeof indexedDB.databases === 'function') {
      void indexedDB.databases().then((dbs) => {
        for (const db of dbs) {
          if (db?.name) indexedDB.deleteDatabase(db.name);
        }
      });
    }
  } catch { /* ignore */ }
}

/**
 * 顶栏「重启」按钮（设置页置顶栏专用）：点开确认弹窗（清理范围说明 + 浏览器存储勾选），
 * 确认后走维护流程——清理临时缓存 + 全方面自检 + 退出码 86 交启动器重启。
 * 重启等待复用更新遮罩的全局「重启中」层，服务恢复后整页硬刷新。
 */
export function MaintenanceRestartButton() {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  const [clearBrowserStorage, setClearBrowserStorage] = useState(false);
  const [busy, setBusy] = useState(false);

  const doRestart = async () => {
    setBusy(true);
    if (clearBrowserStorage) purgeBrowserStorage();
    try {
      const res = await api.maintenance.restart({ cleanTemp: true, clearBrowserStorage });
      if (!res.ok) {
        setBusy(false);
        return;
      }
      // 后端已开始收尾退出（800ms 延迟）；全局遮罩已亮，等服务恢复后整页硬刷新
      beginRestarting();
      void watchRestartThenReload();
    } catch {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        title={t('settings.maintenanceRun')}
        aria-label={t('settings.maintenanceRun')}
        data-tour="settings-maintenance"
        onClick={() => setConfirming(true)}
        disabled={busy}
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-slate-600 transition-colors hover:bg-white/35 disabled:opacity-50"
      >
        <RotateCw className="h-4 w-4" />
        <span className="hidden sm:inline">{t('settings.maintenanceShort')}</span>
      </button>

      {confirming
        ? createPortal(
            <div className="fixed inset-0 z-[75] grid place-items-center p-4">
              <div className="absolute inset-0 bg-black/25 backdrop-blur-md kk-overlay-in" />
              <div
                role="alertdialog"
                aria-modal="true"
                className="kk-glass-2 kk-modal-in relative z-[76] w-full max-w-md rounded-2xl p-6 shadow-[var(--glass2-shadow-modal)]"
              >
                <div className="mb-3 flex items-center gap-2">
                  <RotateCw className="h-5 w-5 shrink-0 text-teal-600" />
                  <h2 className="text-base font-bold text-slate-800">{t('settings.maintenanceConfirmTitle')}</h2>
                </div>
                <p className="flex items-start gap-1.5 text-xs leading-relaxed text-slate-600">
                  <CircleAlert className="mt-px h-3.5 w-3.5 shrink-0 text-amber-600" />
                  <span>{t('settings.maintenanceScope')}</span>
                </p>
                <label className="mt-3 flex cursor-pointer items-center gap-2 text-xs text-slate-700">
                  <input
                    type="checkbox"
                    checked={clearBrowserStorage}
                    onChange={(e) => setClearBrowserStorage(e.target.checked)}
                    className="h-3.5 w-3.5 accent-teal-600"
                  />
                  {t('settings.maintenanceClearBrowser')}
                </label>
                <div className="mt-4 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setConfirming(false)}
                    disabled={busy}
                    className="inline-flex h-10 flex-1 items-center justify-center rounded-xl border border-white/40 bg-white/25 text-sm font-medium text-slate-600 transition-colors hover:bg-white/40 disabled:opacity-60"
                  >
                    {t('btn.cancel')}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void doRestart()}
                    className={cn(
                      'inline-flex h-10 flex-1 items-center justify-center gap-1.5 rounded-xl text-sm font-semibold text-white transition-all active:scale-[0.98] disabled:cursor-not-allowed',
                      busy
                        ? 'cursor-not-allowed bg-slate-300/70'
                        : 'bg-gradient-to-r from-teal-500 to-emerald-500 shadow-lg kk-glow-emerald hover:-translate-y-0.5',
                    )}
                  >
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCw className="h-4 w-4" />}
                    {t('settings.maintenanceConfirm')}
                  </button>
                </div>
              </div>
            </div>,
            getPortalRoot(),
          )
        : null}
    </>
  );
}

/** 设置页卡片内容：最近一次维护自检报告（重启动作在页面顶栏） */
export function MaintenanceReportCard() {
  const t = useT();
  const [report, setReport] = useState<MaintenanceReport | null>(null);

  useEffect(() => {
    api.maintenance
      .lastReport()
      .then((r) => {
        if (r && r.ok && r.report) setReport(r.report);
      })
      .catch(() => { /* 拉不到就不展示历史 */ });
  }, []);

  return (
    <div className="space-y-3 sm:space-y-3.5">
      {/* 时间 + 总体状态（卡片标题「最近一次自检」由外层提供） */}
      <div className="text-xs text-slate-500">
        {report ? (
          <span>
            {new Date(report.at).toLocaleString()}
            <span className={cn('ml-2 font-semibold', report.ok ? 'text-emerald-600' : 'text-rose-600')}>
              {report.ok ? t('settings.maintenanceAllOk') : t('settings.maintenanceHasIssue')}
            </span>
          </span>
        ) : (
          <span>{t('settings.maintenanceNone')}</span>
        )}
      </div>

      {report ? (
        <ul className="space-y-1 rounded-xl border border-white/30 bg-white/20 p-3 text-xs text-slate-600">
          {report.checks.map((c) => (
            <li key={c.key} className="flex items-center gap-2 leading-relaxed">
              {c.ok ? (
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
              ) : (
                <XCircle className="h-3.5 w-3.5 shrink-0 text-rose-500" />
              )}
              <span className="shrink-0 font-medium text-slate-700">{c.label}</span>
              <span className="truncate text-slate-400">{c.detail}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-slate-400">{t('settings.maintenanceHeaderHint')}</p>
      )}
    </div>
  );
}
