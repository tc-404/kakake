import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowRight, Box, Copy, Loader2, Plug, RefreshCw, Cable, Package,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { ConnectionStatus } from '@/lib/types';
import { resolveConnVisual, sortConnectionsForList, connLabelKey } from '@/lib/conn-status';
import { useEventSource } from '@/lib/sse';
import { copyToClipboard } from '@/lib/clipboard';
import { cn } from '@/lib/utils';
import { t, useT } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { ForwardReconnectDialog } from '@/components/forward-reconnect-dialog';
import { StatCard, StatCardSkeleton } from '@/components/stat-card';
import { StatusPill } from '@/components/status-pill';
import { SystemMonitorPanel } from '@/components/system-monitor-panel';
import { QuietNav } from '@/components/quiet-link';
import { errText } from '@/lib/server-error';

function copyText(text: string) {
  void copyToClipboard(text).then((ok) => {
    if (ok) toast.success(t('tip.copied'));
    else toast.error(t('dashboard.copyFailed'));
  });
}

function connAddress(conn: ConnectionStatus): string {
  if (conn.type === 'weixin_bot') {
    return conn.weixinSummary || conn.weixinAccountId || t('dashboard.notLoggedIn');
  }
  if (conn.type === 'qq_official') {
    if (conn.mode === 'https') {
      const base = (conn.webhookBaseUrl || '').trim().replace(/\/+$/, '');
      // 没填公网域名时不要拿本机地址冒充回调地址：开放平台只接受公网 HTTPS
      if (base) return `${base}/gfbot/${conn.id}`;
      return conn.qqSummary || (conn.appId ? `AppID ${conn.appId}` : '—');
    }
    return conn.appId ? `AppID ${conn.appId}` : '—';
  }
  return conn.listenUrl || '—';
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const t = useT();
  const [connections, setConnections] = useState<ConnectionStatus[]>([]);
  const [stats, setStats] = useState({ plugins: 0, loaded: 0 });
  const [loading, setLoading] = useState(true);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [forwardConn, setForwardConn] = useState<ConnectionStatus | null>(null);

  /** status 拉取的唯一落点：首挂载与手动刷新/重连共用，避免两份 setState 写散 */
  const fetchStatus = useCallback(async () => {
    const s = await api.status();
    setConnections(sortConnectionsForList(s.connections));
    setStats({
      plugins: s.plugins.length,
      loaded: s.plugins.filter((p) => p.loaded).length,
    });
  }, []);

  const load = async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    try {
      await fetchStatus();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    fetchStatus()
      .catch((e) => {
        if (!cancelled) toast.error(errText(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fetchStatus]);

  useEventSource((msg) => {
    if (msg.type === 'status' && (msg.data as { connections?: ConnectionStatus[] }).connections) {
      setConnections(sortConnectionsForList((msg.data as { connections: ConnectionStatus[] }).connections));
    }
  });

  const connected = connections.filter((c) => c.connected).length;

  const retry = async (conn: ConnectionStatus) => {
    setRetryingId(conn.id);
    try {
      if (!conn.enable) {
        await api.connections.toggle(conn.id);
      } else {
        await api.connections.reconnect(conn.id);
      }
      toast.success(t(conn.enable ? 'dashboard.reconnectTriggered' : 'dashboard.enabledAndConnected'));
      await load({ silent: true });
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setRetryingId(null);
    }
  };

  return (
    <div className="space-y-6 md:space-y-7">
      {/* 「概览」标题已由顶栏显示，这里直接从内容开始 */}
      {loading && connections.length === 0 && stats.plugins === 0 ? (
        <div data-tour="dashboard-stats" className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
          <StatCardSkeleton className="kk-stagger-item kk-stagger-2" />
          <StatCardSkeleton className="kk-stagger-item kk-stagger-3" />
          <StatCardSkeleton className="kk-stagger-item kk-stagger-4" />
          <StatCardSkeleton className="kk-stagger-item kk-stagger-5" />
        </div>
      ) : (
        <div data-tour="dashboard-stats" className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
          <StatCard
            className="kk-stagger-item kk-stagger-2"
            tourId="dash-stat-listen"
            label={t('dashboard.listenConfig')}
            value={connections.length}
            icon={Plug}
            tone="sky"
          />
          <StatCard
            className="kk-stagger-item kk-stagger-3"
            tourId="dash-stat-connected"
            label={t('dashboard.connectedIn')}
            value={connected}
            icon={Cable}
            tone="emerald"
          />
          <StatCard
            className="kk-stagger-item kk-stagger-4"
            tourId="dash-stat-plugins"
            label={t('dashboard.pluginTotal')}
            value={stats.plugins}
            icon={Package}
            tone="violet"
          />
          <StatCard
            className="kk-stagger-item kk-stagger-5"
            tourId="dash-stat-loaded"
            label={t('dashboard.loaded')}
            value={stats.loaded}
            icon={Box}
            tone={stats.loaded > 0 ? 'amber' : 'slate'}
          />
        </div>
      )}

      <div className="kk-stagger-item kk-stagger-6 flex items-center justify-between">
        <h2 className="text-base font-semibold">{t('dashboard.connectionStatus')}</h2>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate('/connections')}
        >
          {t('dashboard.manageConnections')} <ArrowRight className="h-3.5 w-3.5" />
        </Button>
      </div>

      {loading && connections.length === 0 ? (
        <div className="grid gap-2.5 md:grid-cols-2">
          <div className="kk-card kk-stagger-item kk-stagger-7 h-[4.25rem] animate-pulse rounded-[1.15rem]" />
          <div className="kk-card kk-stagger-item kk-stagger-8 h-[4.25rem] animate-pulse rounded-[1.15rem]" />
        </div>
      ) : connections.length === 0 ? (
        <div className="kk-card kk-stagger-item kk-stagger-7 rounded-[1.15rem] px-5 py-8 text-center text-sm text-muted-foreground">
          {t('dashboard.noConnections')}{t('dashboard.noConnectionsSep')}
          <QuietNav
            to="/connections"
            className="inline text-primary underline-offset-4 hover:underline"
          >
            {t('dashboard.goAdd')}
          </QuietNav>
        </div>
      ) : (
        <div className="grid gap-2.5 md:grid-cols-2">
          {connections.map((conn, index) => {
            const vis = resolveConnVisual(conn);
            // 后端给的 modeLabel / typeLabel 是中文常量，英文模式下要换成字典文案
            const kindKey = connLabelKey(conn.modeLabel) ?? connLabelKey(conn.typeLabel);
            const kindText = kindKey ? t(kindKey) : (conn.modeLabel || conn.typeLabel);
            const addr = connAddress(conn);
            const canCopy = !(
              (conn.type === 'qq_official' && conn.mode !== 'https')
              || (conn.type === 'qq_official' && !String(conn.webhookBaseUrl || '').trim())
              || conn.type === 'weixin_bot'
            );
            const clickable =
              conn.type !== 'qq_official'
              && conn.type !== 'weixin_bot'
              && (conn.mode === 'forward' || conn.mode === 'http_client');
            const stagger = Math.min(8, 7 + (index % 2)) as 7 | 8;

            return (
              <div
                key={conn.id}
                role={clickable ? 'button' : undefined}
                tabIndex={clickable ? 0 : undefined}
                className={cn(
                  'kk-card kk-card-interactive kk-stagger-item flex flex-col gap-2 rounded-[1.15rem] px-4 py-3',
                  stagger === 7 ? 'kk-stagger-7' : 'kk-stagger-8',
                  /*
                   * 状态描边走 outline，不能用 ring-1：
                   * Tailwind 的 ring-* 是靠 box-shadow 实现的，落在 utilities 层，
                   * 会把 .kk-glass / .kk-card 的 box-shadow: var(--glass-shadow)
                   * 整条盖掉（连 hover 的 --glass-shadow-hover 一起失效）——
                   * 表现为「只有不带 ring 的未启用卡片有阴影，已连接 / 失败都没阴影」。
                   * outline 不参与 box-shadow，阴影照常，描边也照常跟随圆角。
                   */
                  vis.key === 'connected' && 'outline outline-1 outline-emerald-300/50',
                  vis.key === 'failed' && 'outline outline-1 outline-red-300/50',
                  clickable && 'cursor-pointer',
                )}
                style={{ animationDelay: `${0.55 + index * 0.08}s` }}
                onClick={() => {
                  if (clickable) setForwardConn(conn);
                }}
                onKeyDown={(e) => {
                  if (!clickable) return;
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setForwardConn(conn);
                  }
                }}
              >
                <div className="flex min-w-0 items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <h3 className="truncate text-sm font-semibold text-foreground">{conn.name}</h3>
                      <span className="hidden truncate text-[11px] text-muted-foreground sm:inline">
                        {kindText}
                      </span>
                    </div>
                    <div className="mt-1 flex min-w-0 items-center gap-1">
                      {/* 用 span 而不是 code：全局字体渐变只染元素、code 标签被刻意排除
                          （代码块不吃墨色），这里只是等宽地址文本，应该跟着字体角色走 */}
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
                        {addr}
                      </span>
                      {canCopy ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 shrink-0"
                          onClick={(e) => {
                            e.stopPropagation();
                            copyText(addr);
                          }}
                        >
                          <Copy className="h-3.5 w-3.5" />
                        </Button>
                      ) : null}
                    </div>
                  </div>
                  <StatusPill status={vis.key} label={t(vis.msgKey)} className="shrink-0" />
                </div>

                {vis.failed ? (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-red-500/10 px-3 py-1.5 text-xs text-red-700">
                    <span>
                      {((conn.mode === 'forward' || conn.mode === 'http_client')
                        && (conn.reconnectAttempts ?? 0) > 0)
                        ? t('dashboard.retriedTimes', { n: conn.reconnectAttempts })
                        : t('dashboard.connErrorRetry')}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      /* kk-ink-plain：重试是失败态的语义红，不参与全局字体渐变 */
                      className="h-7 text-red-700 hover:bg-red-50/60 kk-ink-plain"
                      disabled={retryingId === conn.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        void retry(conn);
                      }}
                    >
                      {retryingId === conn.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="h-3.5 w-3.5" />
                      )}
                      {t('btn.retry')}
                    </Button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      <SystemMonitorPanel className="kk-stagger-item kk-stagger-8" />

      <ForwardReconnectDialog
        open={!!forwardConn}
        conn={forwardConn}
        onClose={() => setForwardConn(null)}
        onSaved={() => void load({ silent: true })}
      />
    </div>
  );
}
