import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowRight, Box, Copy, Loader2, Plug, RefreshCw, Cable, Package,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { ConnectionStatus } from '@/lib/types';
import { resolveConnVisual, sortConnectionsForList } from '@/lib/conn-status';
import { useEventSource } from '@/lib/sse';
import { copyToClipboard } from '@/lib/clipboard';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ForwardReconnectDialog } from '@/components/forward-reconnect-dialog';
import { StatCard, StatCardSkeleton } from '@/components/stat-card';
import { StatusPill } from '@/components/status-pill';
import { SystemMonitorPanel } from '@/components/system-monitor-panel';
import { QuietNav } from '@/components/quiet-link';

function copyText(text: string) {
  void copyToClipboard(text).then((ok) => {
    if (ok) toast.success('已复制');
    else toast.error('复制失败，请手动选中复制');
  });
}

function connAddress(conn: ConnectionStatus): string {
  if (conn.type === 'weixin_bot') {
    return conn.weixinSummary || conn.weixinAccountId || '未登录';
  }
  if (conn.type === 'qq_official') {
    if (conn.mode === 'https') return conn.listenUrl || '—';
    return conn.appId ? `AppID ${conn.appId}` : '—';
  }
  return conn.listenUrl || '—';
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const [connections, setConnections] = useState<ConnectionStatus[]>([]);
  const [stats, setStats] = useState({ plugins: 0, loaded: 0 });
  const [loading, setLoading] = useState(true);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [forwardConn, setForwardConn] = useState<ConnectionStatus | null>(null);

  const load = async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    try {
      const s = await api.status();
      setConnections(sortConnectionsForList(s.connections));
      setStats({
        plugins: s.plugins.length,
        loaded: s.plugins.filter((p) => p.loaded).length,
      });
    } catch (e) {
      toast.error(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const s = await api.status();
        if (cancelled) return;
        setConnections(sortConnectionsForList(s.connections));
        setStats({
          plugins: s.plugins.length,
          loaded: s.plugins.filter((p) => p.loaded).length,
        });
      } catch (e) {
        if (!cancelled) toast.error(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
      toast.success(conn.enable ? '已触发重连' : '已启用并连接');
      await load({ silent: true });
    } catch (e) {
      toast.error(String(e));
    } finally {
      setRetryingId(null);
    }
  };

  return (
    <div className="space-y-6 md:space-y-7">
      <div className="kk-stagger-item kk-stagger-1 hidden md:block">
        <h1 className="kk-page-title">概览</h1>
      </div>

      {loading && connections.length === 0 && stats.plugins === 0 ? (
        <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
          <StatCardSkeleton className="kk-stagger-item kk-stagger-2" />
          <StatCardSkeleton className="kk-stagger-item kk-stagger-3" />
          <StatCardSkeleton className="kk-stagger-item kk-stagger-4" />
          <StatCardSkeleton className="kk-stagger-item kk-stagger-5" />
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
          <StatCard
            className="kk-stagger-item kk-stagger-2"
            label="监听配置"
            value={connections.length}
            icon={Plug}
            tone="sky"
          />
          <StatCard
            className="kk-stagger-item kk-stagger-3"
            label="已连入"
            value={connected}
            icon={Cable}
            tone="emerald"
          />
          <StatCard
            className="kk-stagger-item kk-stagger-4"
            label="插件总数"
            value={stats.plugins}
            icon={Package}
            tone="violet"
          />
          <StatCard
            className="kk-stagger-item kk-stagger-5"
            label="已加载"
            value={stats.loaded}
            icon={Box}
            tone={stats.loaded > 0 ? 'amber' : 'slate'}
          />
        </div>
      )}

      <div className="kk-stagger-item kk-stagger-6 flex items-center justify-between">
        <h2 className="text-base font-semibold">连接状态</h2>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate('/connections')}
        >
          管理连接 <ArrowRight className="h-3.5 w-3.5" />
        </Button>
      </div>

      {loading && connections.length === 0 ? (
        <div className="grid gap-2.5 md:grid-cols-2">
          <div className="kk-card kk-stagger-item kk-stagger-7 h-[4.25rem] animate-pulse rounded-[1.15rem]" />
          <div className="kk-card kk-stagger-item kk-stagger-8 h-[4.25rem] animate-pulse rounded-[1.15rem]" />
        </div>
      ) : connections.length === 0 ? (
        <div className="kk-card kk-stagger-item kk-stagger-7 rounded-[1.15rem] px-5 py-8 text-center text-sm text-muted-foreground">
          暂无连接，
          <QuietNav
            to="/connections"
            className="inline text-primary underline-offset-4 hover:underline"
          >
            去添加
          </QuietNav>
        </div>
      ) : (
        <div className="grid gap-2.5 md:grid-cols-2">
          {connections.map((conn, index) => {
            const vis = resolveConnVisual(conn);
            const addr = connAddress(conn);
            const canCopy = !(
              (conn.type === 'qq_official' && conn.mode !== 'https')
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
                  vis.key === 'connected' && 'ring-1 ring-emerald-300/50',
                  vis.key === 'failed' && 'ring-1 ring-red-300/50',
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
                        {conn.modeLabel || conn.typeLabel}
                      </span>
                    </div>
                    <div className="mt-1 flex min-w-0 items-center gap-1">
                      <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
                        {addr}
                      </code>
                      {canCopy ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 shrink-0"
                          onClick={(e) => {
                            e.stopPropagation();
                            copyText(conn.listenUrl || addr);
                          }}
                        >
                          <Copy className="h-3.5 w-3.5" />
                        </Button>
                      ) : null}
                    </div>
                  </div>
                  <StatusPill status={vis.key} label={vis.label} className="shrink-0" />
                </div>

                {vis.failed ? (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-red-500/10 px-3 py-1.5 text-xs text-red-700">
                    <span>
                      {((conn.mode === 'forward' || conn.mode === 'http_client')
                        && (conn.reconnectAttempts ?? 0) > 0)
                        ? `已重试 ${conn.reconnectAttempts} 次 · 可点击重试`
                        : '连接异常 · 可点击重试'}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-red-700 hover:bg-red-50/60"
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
                      重试
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
