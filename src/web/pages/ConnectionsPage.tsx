import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Plus, RefreshCw, CloudDownload, CloudUpload, Bot,
  Server, Radio, Globe, MessageCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { ConnectionMode, ConnectionStatus, ConnectionType } from '@/lib/types';
import { useEventSource } from '@/lib/sse';
import { sortConnectionsForList } from '@/lib/conn-status';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { ConnectionPluginsDialog } from '@/components/connection-plugins-dialog';
import { ForwardReconnectDialog } from '@/components/forward-reconnect-dialog';
import { ConnectionCard } from '@/components/connection-card';
import { ConnectionManageDialog } from '@/components/connection-manage-dialog';
import { WeixinBotLoginDialog } from '@/components/weixin-bot-login-dialog';
import { useMobileHeaderActions } from '@/components/mobile-header-actions';

function defaultPortForMode(mode?: ConnectionMode): number {
  if (mode === 'forward') return 3001;
  if (mode === 'http' || mode === 'http_sse') return 6701;
  if (mode === 'http_client') return 3000;
  return 6700;
}

function needsApiUrl(mode?: ConnectionMode): boolean {
  return mode === 'http' || mode === 'http_sse';
}

const MODE_OPTIONS: {
  type: ConnectionType;
  mode?: ConnectionMode;
  title: string;
  desc: string;
  icon: typeof CloudDownload;
}[] = [
  {
    type: 'onebot',
    mode: 'reverse',
    title: '反向 WS',
    desc: '本端开端口，等机器人连过来',
    icon: CloudDownload,
  },
  {
    type: 'onebot',
    mode: 'forward',
    title: '正向 WS',
    desc: '主动连到机器人那边的服务',
    icon: CloudUpload,
  },
  {
    type: 'onebot',
    mode: 'http',
    title: 'HTTP 服务器',
    desc: '本端收消息，再去调对方接口',
    icon: Server,
  },
  {
    type: 'onebot',
    mode: 'http_sse',
    title: 'HTTP SSE 服务器',
    desc: '本端收上报，再转推给订阅方',
    icon: Radio,
  },
  {
    type: 'onebot',
    mode: 'http_client',
    title: 'HTTP 客户端',
    desc: '主动连对方，也可接收事件上报',
    icon: Globe,
  },
  {
    type: 'qq_official',
    title: 'QQ 官方 · WS',
    desc: '直连腾讯网关，不用自己域名',
    icon: Bot,
  },
  {
    type: 'qq_official',
    mode: 'https',
    title: 'QQ 官方 · HTTPS',
    desc: '用你的域名接收官方回调',
    icon: Globe,
  },
  {
    type: 'weixin_bot',
    title: '微信 AI×BOT',
    desc: '扫码登录后，就能收发消息',
    icon: MessageCircle,
  },
];

function addFormMeta(type: ConnectionType, mode: ConnectionMode) {
  if (type === 'weixin_bot') {
    return {
      title: '添加微信 AI×BOT',
      desc: '先扫码登录，再启用即可收消息',
    };
  }
  if (type === 'qq_official') {
    if (mode === 'https') {
      return {
        title: '添加 QQ 官方 · HTTPS',
        desc: '填凭证与回调域名，启用后复制地址',
      };
    }
    return {
      title: '添加 QQ 官方 · WS',
      desc: '昵称头像自动拉取，默认先关闭',
    };
  }
  switch (mode) {
    case 'forward':
      return { title: '添加正向 WS', desc: '填对方服务地址，添加后默认关闭' };
    case 'http':
      return {
        title: '添加 HTTP 服务器',
        desc: '本端听上报，并填对方接口地址',
      };
    case 'http_sse':
      return {
        title: '添加 HTTP SSE 服务器',
        desc: '本端收上报并推送，同时填接口',
      };
    case 'http_client':
      return {
        title: '添加 HTTP 客户端',
        desc: '填对方地址连上，也可接收上报',
      };
    default:
      return {
        title: '添加反向 WS',
        desc: '本端开端口，让对方客户端连入',
      };
  }
}

export default function ConnectionsPage() {
  const [connections, setConnections] = useState<ConnectionStatus[]>([]);
  const [typeModalOpen, setTypeModalOpen] = useState(false);
  const [formModalOpen, setFormModalOpen] = useState(false);
  const [addType, setAddType] = useState<ConnectionType>('onebot');
  const [addMode, setAddMode] = useState<ConnectionMode>('reverse');
  const [submitting, setSubmitting] = useState(false);
  const [pluginsConn, setPluginsConn] = useState<ConnectionStatus | null>(null);
  const [forwardConn, setForwardConn] = useState<ConnectionStatus | null>(null);
  const [manageConnId, setManageConnId] = useState<string | null>(null);
  const [weixinLoginConn, setWeixinLoginConn] = useState<ConnectionStatus | null>(null);
  /** 扫码成功后是否自动启用该连接 */
  const [weixinEnableAfterLogin, setWeixinEnableAfterLogin] = useState(false);
  const [deleteConn, setDeleteConn] = useState<ConnectionStatus | null>(null);
  const [avatarMap, setAvatarMap] = useState<Record<string, { dataUrl: string; updatedAt?: string }>>({});
  const avatarMetaRef = useRef<Record<string, string | undefined>>({});

  const [name, setName] = useState('');
  const [host, setHost] = useState('127.0.0.1');
  const [port, setPort] = useState(6700);
  const [apiUrl, setApiUrl] = useState('http://127.0.0.1:3000');
  const [accessToken, setAccessToken] = useState('');
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [sandbox, setSandbox] = useState(true);
  const [webhookBaseUrl, setWebhookBaseUrl] = useState('');
  const [qqPreview, setQqPreview] = useState<ConnectionStatus['botProfile'] | null>(null);
  const [qqPreviewing, setQqPreviewing] = useState(false);
  const [loading, setLoading] = useState(true);

  const manageConn = manageConnId
    ? (connections.find((c) => c.id === manageConnId) ?? null)
    : null;

  const syncAvatars = useCallback(async (list: ConnectionStatus[]) => {
    const tasks: Promise<void>[] = [];
    for (const c of list) {
      if (c.type === 'weixin_bot' || !c.hasAvatar) {
        if (avatarMetaRef.current[c.id]) {
          delete avatarMetaRef.current[c.id];
          setAvatarMap((prev) => {
            if (!(c.id in prev)) return prev;
            const next = { ...prev };
            delete next[c.id];
            return next;
          });
        }
        continue;
      }
      const stamp = c.avatarUpdatedAt || '1';
      if (avatarMetaRef.current[c.id] === stamp) continue;
      tasks.push(
        (async () => {
          try {
            const r = await api.connections.avatar(c.id);
            if (!r.ok || !r.dataUrl) return;
            avatarMetaRef.current[c.id] = stamp;
            setAvatarMap((prev) => ({
              ...prev,
              [c.id]: { dataUrl: r.dataUrl!, updatedAt: r.updatedAt },
            }));
          } catch {
            /* ignore */
          }
        })(),
      );
    }
    if (tasks.length) await Promise.all(tasks);
  }, []);

  const load = useCallback(async (opts?: { silent?: boolean; notify?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    try {
      const r = await api.connections.list();
      setConnections(sortConnectionsForList(r.connections));
      void syncAvatars(r.connections);
      if (opts?.notify) {
        toast.success(`已刷新，共 ${r.connections.length} 个连接`);
      }
    } catch (e) {
      toast.error(String(e));
    } finally {
      setLoading(false);
    }
  }, [syncAvatars]);

  useMobileHeaderActions(
    () => (
      <>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-slate-600 hover:bg-white/35"
          disabled={loading}
          title="刷新"
          onClick={() => void load({ notify: true })}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-slate-600 hover:bg-white/35"
          title="添加连接"
          onClick={() => setTypeModalOpen(true)}
        >
          <Plus className="h-4 w-4" />
        </Button>
      </>
    ),
    [loading, load],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const r = await api.connections.list();
        if (cancelled) return;
        setConnections(sortConnectionsForList(r.connections));
        void syncAvatars(r.connections);
      } catch (e) {
        if (!cancelled) toast.error(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [syncAvatars]);

  useEventSource((msg) => {
    if (msg.type === 'status' && (msg.data as { connections?: ConnectionStatus[] }).connections) {
      const list = (msg.data as { connections: ConnectionStatus[] }).connections;
      setConnections(sortConnectionsForList(list));
      void syncAvatars(list);
    }
  });

  const pickMode = (type: ConnectionType, mode?: ConnectionMode) => {
    const m = mode ?? 'reverse';
    setAddType(type);
    setAddMode(m);
    setTypeModalOpen(false);
    setName('');
    setHost('127.0.0.1');
    setPort(defaultPortForMode(m));
    setApiUrl('http://127.0.0.1:3000');
    setAccessToken('');
    setAppId('');
    setAppSecret('');
    setSandbox(true);
    setWebhookBaseUrl('');
    setQqPreview(null);
    setFormModalOpen(true);
  };

  const previewQqBot = async () => {
    if (!appId.trim() || !appSecret.trim()) {
      toast.error('请填写 AppID 与 AppSecret');
      return;
    }
    setQqPreviewing(true);
    try {
      const res = await api.connections.previewQqOfficial({
        appId: appId.trim(),
        appSecret: appSecret.trim(),
        sandbox,
      });
      if (!res.ok || !res.profile) {
        toast.error(res.message || '获取资料失败');
        return;
      }
      setQqPreview(res.profile);
      toast.success(`已识别机器人：${res.profile.username}`);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setQqPreviewing(false);
    }
  };

  const onAdd = async () => {
    setSubmitting(true);
    try {
      if (addType === 'weixin_bot') {
        await api.connections.add({
          name: name.trim() || '微信 AI×BOT',
          type: 'weixin_bot',
        });
        toast.success('已添加微信 AI×BOT（请扫码登录后再启用）');
      } else if (addType === 'qq_official') {
        if (!appId.trim() || !appSecret.trim()) {
          toast.error('请填写 AppID 与 AppSecret');
          return;
        }
        await api.connections.add({
          type: 'qq_official',
          mode: addMode === 'https' ? 'https' : undefined,
          appId: appId.trim(),
          appSecret: appSecret.trim(),
          sandbox,
          webhookBaseUrl: addMode === 'https' ? webhookBaseUrl.trim() || undefined : undefined,
        });
        toast.success(
          addMode === 'https'
            ? '已添加 HTTPS 连接（默认关闭），启用后可复制回调地址'
            : '已添加 QQ 官方连接（默认关闭）',
        );
      } else {
        if (!name.trim()) {
          toast.error('请输入名称');
          return;
        }
        if (needsApiUrl(addMode) && !apiUrl.trim()) {
          toast.error('请填写 HTTP API 地址');
          return;
        }
        await api.connections.add({
          name: name.trim(),
          type: 'onebot',
          mode: addMode,
          host,
          port,
          accessToken,
          apiUrl: needsApiUrl(addMode) ? apiUrl.trim() : undefined,
        });
        toast.success('已添加连接（默认关闭）');
      }
      setFormModalOpen(false);
      void load();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const formMeta = addFormMeta(addType, addMode);

  return (
    <div className="space-y-4">
      <div className="kk-stagger-item kk-stagger-1 hidden flex-wrap items-center justify-between gap-2 md:flex">
        <h1 className="kk-page-title">连接管理</h1>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" disabled={loading} onClick={() => void load({ notify: true })}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            刷新
          </Button>
          <Button size="sm" onClick={() => setTypeModalOpen(true)}>
            <Plus className="h-3.5 w-3.5" />
            添加连接
          </Button>
        </div>
      </div>

      {connections.length === 0 ? (
        <div className="kk-card kk-stagger-item kk-stagger-2 border border-dashed border-border/80 py-16 text-center shadow-none">
          <p className="mb-4 text-sm text-muted-foreground">
            {loading ? '加载中…' : '暂无连接配置'}
          </p>
          {!loading && (
            <Button size="sm" onClick={() => setTypeModalOpen(true)}>
              <Plus className="h-3.5 w-3.5" />
              添加第一个连接
            </Button>
          )}
        </div>
      ) : (
        <div className="kk-conn-grid">
          {connections.map((conn, index) => (
            <ConnectionCard
              key={conn.id}
              conn={conn}
              index={index}
              avatarDataUrl={avatarMap[conn.id]?.dataUrl}
              onOpen={(c) => setManageConnId(c.id)}
            />
          ))}
        </div>
      )}

      <ConnectionManageDialog
        open={!!manageConn}
        conn={manageConn}
        avatarDataUrl={manageConn ? avatarMap[manageConn.id]?.dataUrl : undefined}
        onClose={() => setManageConnId(null)}
        onSaved={async () => {
          await load({ silent: true });
        }}
        onOpenPlugins={(c) => setPluginsConn(c)}
        onOpenReconnectStrategy={(c) => setForwardConn(c)}
        onRequestDelete={(c) => setDeleteConn(c)}
        onRequestWeixinLogin={(c, enableAfter) => {
          setWeixinEnableAfterLogin(!!enableAfter);
          setWeixinLoginConn(c);
        }}
      />

      <ConnectionPluginsDialog
        open={!!pluginsConn}
        connectionId={pluginsConn?.id ?? ''}
        connectionName={pluginsConn?.name ?? ''}
        connectionType={pluginsConn?.type}
        onClose={() => setPluginsConn(null)}
      />
      <WeixinBotLoginDialog
        open={!!weixinLoginConn}
        conn={weixinLoginConn}
        onClose={() => {
          setWeixinLoginConn(null);
          setWeixinEnableAfterLogin(false);
        }}
        onLoggedIn={async (list) => {
          const connId = weixinLoginConn?.id;
          const shouldEnable = weixinEnableAfterLogin;
          setWeixinEnableAfterLogin(false);
          if (list) {
            setConnections(sortConnectionsForList(list));
            void syncAvatars(list);
          } else {
            await load({ silent: true });
          }
          if (shouldEnable && connId) {
            try {
              const r = await api.connections.toggle(connId) as {
                ok?: boolean;
                message?: string;
                enable?: boolean;
              };
              if (r && r.ok === false) {
                toast.error(r.message || '登录成功，但启用失败');
                return;
              }
              toast.success('登录成功，已自动启用');
              await load({ silent: true });
            } catch (e) {
              toast.error(String(e));
            }
          }
        }}
      />
      <ForwardReconnectDialog open={!!forwardConn} conn={forwardConn} onClose={() => setForwardConn(null)} onSaved={load} />

      <Dialog open={typeModalOpen} onOpenChange={setTypeModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>选择连接类型</DialogTitle>
          </DialogHeader>
          <div className="grid max-h-[70vh] gap-2 overflow-y-auto no-scrollbar">
            {MODE_OPTIONS.map((opt) => {
              const Icon = opt.icon;
              return (
                <button
                  key={`${opt.type}-${opt.mode ?? 'ws'}`}
                  type="button"
                  className="kk-btn-press flex gap-3 rounded-xl bg-white/35 p-3.5 text-left transition-colors hover:bg-white/55"
                  onClick={() => pickMode(opt.type, opt.mode)}
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                    <Icon className="h-5 w-5" />
                  </span>
                  <span>
                    <span className="block font-medium">{opt.title}</span>
                    <span className="text-xs text-muted-foreground">{opt.desc}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={formModalOpen} onOpenChange={setFormModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{formMeta.title}</DialogTitle>
            <DialogDescription>{formMeta.desc}</DialogDescription>
          </DialogHeader>

          {addType === 'qq_official' ? (
            <div className="space-y-3">
              {qqPreview && (
                <div className="flex items-center gap-3 rounded-md border p-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={qqPreview.avatar} alt="" className="h-12 w-12 rounded-full object-cover" />
                  <div className="min-w-0">
                    <div className="font-medium">{qqPreview.username}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {qqPreview.desc || '暂无简介'}
                    </div>
                  </div>
                </div>
              )}
              <div className="space-y-2">
                <Label>AppID</Label>
                <Input value={appId} onChange={(e) => setAppId(e.target.value)} autoComplete="off" />
              </div>
              <div className="space-y-2">
                <Label>AppSecret</Label>
                <Input
                  type="password"
                  value={appSecret}
                  onChange={(e) => setAppSecret(e.target.value)}
                  autoComplete="new-password"
                />
              </div>
              <div className="flex items-center justify-between">
                <Label htmlFor="sandbox">沙箱环境</Label>
                <Switch id="sandbox" checked={sandbox} onCheckedChange={setSandbox} />
              </div>
              {addMode === 'https' && (
                <div className="space-y-2">
                  <Label>公网回调基址（可选）</Label>
                  <Input
                    value={webhookBaseUrl}
                    onChange={(e) => setWebhookBaseUrl(e.target.value)}
                    placeholder="https://bot.example.com"
                    autoComplete="off"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    填域名后可一键复制完整回调地址；反代到本服务端口即可。
                  </p>
                </div>
              )}
              <Button variant="outline" className="w-full" onClick={previewQqBot} disabled={qqPreviewing}>
                {qqPreviewing ? '获取中…' : '预览机器人资料'}
              </Button>
            </div>
          ) : addType === 'weixin_bot' ? (
            <div className="space-y-3">
              <div className="space-y-2">
                <Label>名称</Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="微信 AI×BOT"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                添加后先扫码登录，确认后再启用即可收消息。
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="space-y-2">
                <Label>名称</Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={
                    addMode === 'http'
                      ? 'HTTP 服务器'
                      : addMode === 'http_sse'
                        ? 'HTTP SSE'
                        : addMode === 'http_client'
                          ? 'HTTP 客户端'
                          : addMode === 'forward'
                            ? '正向 WS'
                            : '反向 WS'
                  }
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>
                    {addMode === 'forward' || addMode === 'http_client' ? '对方地址' : '监听地址'}
                  </Label>
                  <Input value={host} onChange={(e) => setHost(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label>
                    {addMode === 'forward' || addMode === 'http_client' ? '对方端口' : '监听端口'}
                  </Label>
                  <Input
                    type="number"
                    min={1}
                    max={65535}
                    value={port}
                    onChange={(e) => setPort(Number(e.target.value) || defaultPortForMode(addMode))}
                  />
                </div>
              </div>
              {needsApiUrl(addMode) && (
                <div className="space-y-2">
                  <Label>HTTP API 地址</Label>
                  <Input
                    value={apiUrl}
                    onChange={(e) => setApiUrl(e.target.value)}
                    placeholder="http://127.0.0.1:3000"
                  />
                </div>
              )}
              {addMode === 'http_client' && (
                <p className="text-xs text-muted-foreground">
                  启用后会连对方 SSE；也可把上报地址指到本连接的接收路径。
                </p>
              )}
              {addMode === 'http_sse' && (
                <p className="text-xs text-muted-foreground">
                  对方可把事件 POST 到监听地址；其他客户端也能订阅 SSE。
                </p>
              )}
              <div className="space-y-2">
                <Label>Access Token（可选）</Label>
                <Input
                  value={accessToken}
                  onChange={(e) => setAccessToken(e.target.value)}
                  autoComplete="off"
                />
              </div>
            </div>
          )}

          <DialogFooter className="!flex-row !justify-center gap-3 space-x-0 sm:!flex-row sm:!justify-center sm:space-x-0">
            <Button variant="outline" className="min-w-0 flex-1" onClick={() => setFormModalOpen(false)}>
              取消
            </Button>
            <Button className="min-w-0 flex-1" onClick={onAdd} disabled={submitting}>
              添加
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteConn} onOpenChange={(v) => !v && setDeleteConn(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除此连接？</AlertDialogTitle>
            <AlertDialogDescription>
              删除「{deleteConn?.name}」将同时移除 plugins_two 下对应账号的运行插件目录。
              「删除并清空数据」还会删除 data 下该账号的插件数据。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col gap-2 sm:flex-row sm:justify-end">
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                if (!deleteConn) return;
                const id = deleteConn.id;
                try {
                  await api.connections.remove(id);
                  toast.success(`已删除 ${deleteConn.name}`);
                  setDeleteConn(null);
                  setManageConnId((cur) => (cur === id ? null : cur));
                  setAvatarMap((prev) => {
                    if (!(id in prev)) return prev;
                    const next = { ...prev };
                    delete next[id];
                    return next;
                  });
                  delete avatarMetaRef.current[id];
                  await load();
                } catch (e) {
                  toast.error(String(e));
                }
              }}
            >
              删除
            </AlertDialogAction>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={async () => {
                if (!deleteConn) return;
                const id = deleteConn.id;
                try {
                  await api.connections.remove(id, { clearData: true });
                  toast.success(`已删除并清空数据：${deleteConn.name}`);
                  setDeleteConn(null);
                  setManageConnId((cur) => (cur === id ? null : cur));
                  setAvatarMap((prev) => {
                    if (!(id in prev)) return prev;
                    const next = { ...prev };
                    delete next[id];
                    return next;
                  });
                  delete avatarMetaRef.current[id];
                  await load();
                } catch (e) {
                  toast.error(String(e));
                }
              }}
            >
              删除并清空数据
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
