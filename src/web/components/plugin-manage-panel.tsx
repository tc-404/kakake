import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import type { ExtensionPage, PluginItem } from '@/lib/types';
import { STATUS_MAP } from '@/lib/types';
import { pluginHostConsolePath } from '@/lib/plugin-host-paths';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { PluginConfigDialog } from '@/components/plugin-config-dialog';

function mergePlugin(list: PluginItem[], item: PluginItem): PluginItem[] {
  return list.map((p) => (p.id === item.id ? item : p));
}

/** 连接面板：仅连接子开关（总开关在「插件」页） */
export function PluginManagePanel({ connectionId }: { connectionId: string }) {
  const [plugins, setPlugins] = useState<PluginItem[]>([]);
  const [pages, setPages] = useState<ExtensionPage[]>([]);
  const [loading, setLoading] = useState(false);
  const [actionPlugin, setActionPlugin] = useState<PluginItem | null>(null);
  const [configPlugin, setConfigPlugin] = useState<PluginItem | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.plugins.list(connectionId);
      setPlugins(res.data.plugins);
      setPages(res.data.extensionPages);
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const onToggle = async (plugin: PluginItem, enable: boolean) => {
    if (plugin.masterEnabled === false) {
      toast.error('请先在「插件」页打开该插件的总开关');
      return;
    }
    if (enable && plugin.accountReady === false) {
      toast.error('账号尚未上报，请等待连接成功后再启用');
      return;
    }
    try {
      const res = await api.plugins.setStatus(plugin.id, enable, connectionId);
      if (res.data?.plugin) {
        setPlugins((prev) => mergePlugin(prev, res.data!.plugin));
        const updated = res.data.plugin;
        if (enable) {
          if (updated.status === 'active') toast.success(`${plugin.name} 已在本连接启用`);
          else if (updated.status === 'error') toast.error(updated.errorMessage || '加载失败');
          else toast.success(`${plugin.name} 已复制到账号目录并开启`);
        } else {
          toast.success(`${plugin.name} 已对本连接关闭`);
        }
      } else {
        await load();
      }
    } catch (e) {
      toast.error(String(e));
      await load();
    }
  };

  const pagesOf = (id: string) => pages.filter((p) => p.pluginId === id);

  return (
    <div className="space-y-3">
      {loading && plugins.length === 0 ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          加载中…
        </div>
      ) : plugins.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">暂无插件</p>
      ) : (
        <div className="kk-glass divide-y divide-white/35 rounded-xl">
          {plugins.map((plugin) => {
            const st = STATUS_MAP[plugin.status] || STATUS_MAP.disabled;
            const masterOff = plugin.masterEnabled === false;
            const accountNotReady = plugin.accountReady === false;
            const checked = plugin.connectionEnabled === true;
            const switchDisabled = masterOff || (accountNotReady && !checked);
            const switchTitle = masterOff
              ? '请先在插件页打开总开关'
              : accountNotReady
                ? '等待连接上报账号后再启用'
                : '连接子开关';
            return (
              <div key={plugin.id} className="flex items-center gap-3 p-3">
                <button
                  type="button"
                  className="h-10 w-10 shrink-0 overflow-hidden rounded-md border bg-muted"
                  onClick={() => setActionPlugin(plugin)}
                  title="插件操作"
                >
                  {plugin.iconUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={plugin.iconUrl} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <span className="flex h-full items-center justify-center text-xs text-muted-foreground">
                      插
                    </span>
                  )}
                </button>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-medium">{plugin.name}</span>
                    <Badge variant={st.variant}>{st.text}</Badge>
                    {masterOff ? (
                      <Badge variant="outline" className="text-[10px] text-amber-700">
                        总开关已关
                      </Badge>
                    ) : null}
                    {accountNotReady ? (
                      <Badge variant="outline" className="text-[10px] text-slate-600">
                        等待账号
                      </Badge>
                    ) : plugin.accountKey ? (
                      <Badge variant="outline" className="text-[10px] text-slate-500">
                        {plugin.accountKey}
                      </Badge>
                    ) : null}
                    <span className="text-xs text-muted-foreground">v{plugin.version}</span>
                  </div>
                  <p className="truncate text-xs text-muted-foreground">{plugin.id}</p>
                </div>
                <Switch
                  checked={checked}
                  disabled={switchDisabled}
                  onCheckedChange={(v) => void onToggle(plugin, v)}
                  aria-label={`${plugin.name} 连接子开关`}
                  title={switchTitle}
                />
              </div>
            );
          })}
        </div>
      )}

      <Dialog open={!!actionPlugin} onOpenChange={(v) => !v && setActionPlugin(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{actionPlugin?.name}</DialogTitle>
            <DialogDescription>
              {actionPlugin?.author && `${actionPlugin.author} · `}v{actionPlugin?.version}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Button
              variant="outline"
              onClick={() => {
                if (actionPlugin) setConfigPlugin(actionPlugin);
                setActionPlugin(null);
              }}
            >
              插件配置
            </Button>
              {(actionPlugin?.hasPages || pagesOf(actionPlugin?.id || '').length > 0)
              && actionPlugin?.masterEnabled !== false
              && (actionPlugin?.status === 'active' || actionPlugin?.connectionEnabled) && (
              <Button
                variant="outline"
                onClick={() => {
                  if (!actionPlugin) return;
                  const list = pagesOf(actionPlugin.id);
                  const path = list[0]?.path || 'admin';
                  const acct = actionPlugin.accountKey;
                  const target = actionPlugin.webUrl
                    || list[0]?.hostPath
                    || pluginHostConsolePath(actionPlugin.id, path, acct || undefined);
                  setActionPlugin(null);
                  window.open(target, '_blank', 'noopener,noreferrer');
                }}
              >
                访问后台
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <PluginConfigDialog
        plugin={configPlugin}
        open={!!configPlugin}
        connectionId={connectionId}
        onClose={() => {
          setConfigPlugin(null);
          void load();
        }}
        onReload={load}
      />
    </div>
  );
}
