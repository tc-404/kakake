import { useEffect, useState } from 'react';
import {
  AppWindow, Copy, Loader2, LogOut, QrCode, RefreshCcw, RefreshCw, Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { ConnectionMode, ConnectionStatus } from '@/lib/types';
import { copyToClipboard } from '@/lib/clipboard';
import { cn } from '@/lib/utils';
import { TRANSPARENT_AVATAR } from '@/components/connection-card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * 底部操作按钮的统一尺寸。
 *
 * 固定宽高 + shrink/grow 归零，保证换行后每个按钮大小完全一致；
 * 文案统一两个字，图标统一 16px，4.75rem（默认 76px）足够容纳且留有余量。
 * 用 rem 而非 px，浏览器放大字号时按钮同步变宽，不会挤掉文字。
 * 新增按钮请一律套用本常量，不要另写宽度。
 */
const ACTION_BTN_CLASS = 'h-8 w-[4.75rem] shrink-0 grow-0 gap-1 px-0 text-xs';

function copyText(text: string) {
  void copyToClipboard(text).then((ok) => {
    if (ok) toast.success('已复制');
    else toast.error('复制失败，请手动选中复制');
  });
}

function modeTitle(mode?: ConnectionMode): string {
  switch (mode) {
    case 'forward':
      return '正向 WS';
    case 'http':
      return 'HTTP 服务器';
    case 'http_sse':
      return 'HTTP SSE 服务器';
    case 'http_client':
      return 'HTTP 客户端';
    case 'https':
      return '官方 HTTPS';
    default:
      return '反向 WS';
  }
}

function isReconnectMode(mode?: ConnectionMode): boolean {
  return mode === 'forward' || mode === 'http_client';
}

/**
 * Intents 输入解析：支持 0x 十六进制与十进制。
 * 返回 null 表示格式不合法；0（或留空）表示回到内置默认组合。
 */
function parseIntentsInput(raw: string): number | null {
  const text = raw.trim().toLowerCase();
  if (!text) return 0;
  const value = /^0x[0-9a-f]+$/.test(text)
    ? Number.parseInt(text.slice(2), 16)
    : (/^\d+$/.test(text) ? Number.parseInt(text, 10) : Number.NaN);
  if (!Number.isFinite(value) || value < 0 || value > 0xffffffff) return null;
  return value >>> 0;
}

function formatIntentsValue(value?: number): string {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '';
  return `0x${(n >>> 0).toString(16)}`;
}

export function ConnectionManageDialog({
  open,
  conn,
  avatarDataUrl,
  onClose,
  onSaved,
  onOpenPlugins,
  onOpenReconnectStrategy,
  onRequestDelete,
  onRequestWeixinLogin,
}: {
  open: boolean;
  conn: ConnectionStatus | null;
  avatarDataUrl?: string | null;
  onClose: () => void;
  onSaved?: () => void | Promise<void>;
  onOpenPlugins: (conn: ConnectionStatus) => void;
  onOpenReconnectStrategy: (conn: ConnectionStatus) => void;
  onRequestDelete: (conn: ConnectionStatus) => void;
  onRequestWeixinLogin: (conn: ConnectionStatus, enableAfter?: boolean) => void;
}) {
  const [name, setName] = useState('');
  const [host, setHost] = useState('127.0.0.1');
  const [port, setPort] = useState(6700);
  const [apiUrl, setApiUrl] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [tokenTouched, setTokenTouched] = useState(false);
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [sandbox, setSandbox] = useState(true);
  const [intents, setIntents] = useState('');
  const [webhookBaseUrl, setWebhookBaseUrl] = useState('');
  const [kookToken, setKookToken] = useState('');
  const [kookTokenTouched, setKookTokenTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refreshingProfile, setRefreshingProfile] = useState(false);

  const isQq = conn?.type === 'qq_official';
  const isWx = conn?.type === 'weixin_bot';
  const isKook = conn?.type === 'kook';
  const isOnebot = !isQq && !isWx && !isKook;
  const mode = conn?.mode ?? 'reverse';
  const isRemote = mode === 'forward' || mode === 'http_client';
  const showApiUrl = mode === 'http' || mode === 'http_sse';
  const isQqHttps = isQq && mode === 'https';
  const canReconnectSettings = isOnebot && isReconnectMode(mode);
  const avatarSrc = avatarDataUrl || TRANSPARENT_AVATAR;
  // 只有填了公网域名才存在“可提交给开放平台”的回调 URL；本机地址不能当回调地址用
  const publicCallbackBase = webhookBaseUrl.trim().replace(/\/+$/, '');
  const publicCallbackUrl = conn && publicCallbackBase
    ? `${publicCallbackBase}/gfbot/${conn.id}`
    : '';

  useEffect(() => {
    if (!open || !conn) return;
    setName(conn.name);
    setHost(conn.host || '127.0.0.1');
    setPort(conn.port || 6700);
    setApiUrl(conn.apiUrl || '');
    setAccessToken('');
    setTokenTouched(false);
    setAppId(conn.appId || '');
    setAppSecret('');
    setSandbox(conn.sandbox !== false);
    setIntents(formatIntentsValue(conn.intents));
    setWebhookBaseUrl(conn.webhookBaseUrl || '');
    setKookToken('');
    setKookTokenTouched(false);
    // 只在打开或切换连接时灌表单；SSE 每 3s 换新对象不能回写输入
    // eslint-disable-next-line react-hooks/exhaustive-deps -- conn 快照仅用于初始化
  }, [open, conn?.id]);

  const onSave = async () => {
    if (!conn) return;
    if (!name.trim()) {
      toast.error('请输入名称');
      return;
    }
    setSaving(true);
    const wasEnabled = !!conn.enable;
    try {
      if (isKook) {
        const res = await api.connections.update(conn.id, {
          name: name.trim(),
          ...(kookTokenTouched && kookToken.trim() ? { kookToken: kookToken.trim() } : {}),
        }) as { ok?: boolean; message?: string };
        if (res && res.ok === false) {
          toast.error(res.message || '保存失败');
          return;
        }
        toast.success(wasEnabled ? '已保存并重连' : '已保存');
        await onSaved?.();
        return;
      }

      if (isWx) {
        const res = await api.connections.update(conn.id, { name: name.trim() });
        if (res.ok === false) {
          toast.error(res.message || '保存失败');
          return;
        }
        toast.success('已保存');
        await onSaved?.();
        return;
      }

      if (isQq) {
        if (!appId.trim()) {
          toast.error('请填写 AppID');
          return;
        }
        const intentsValue = parseIntentsInput(intents);
        if (intentsValue === null) {
          toast.error('Intents 只能是十进制数字或 0x 开头的十六进制');
          return;
        }
        const res = await api.connections.updateQqOfficial(conn.id, {
          name: name.trim() || undefined,
          appId: appId.trim(),
          appSecret: appSecret.trim() || undefined,
          sandbox,
          intents: intentsValue,
          webhookBaseUrl: isQqHttps ? webhookBaseUrl.trim() : undefined,
        }) as { ok?: boolean; message?: string };
        if (res && res.ok === false) {
          toast.error(res.message || '保存失败');
          return;
        }
        toast.success(wasEnabled ? '已保存并重连' : '已保存');
        await onSaved?.();
        return;
      }

      if (!host.trim()) {
        toast.error('请输入地址');
        return;
      }
      if (showApiUrl && !apiUrl.trim()) {
        toast.error('请填写 NapCat HTTP API 地址');
        return;
      }
      const body: {
        name: string;
        host: string;
        port: number;
        accessToken?: string;
        apiUrl?: string;
      } = {
        name: name.trim(),
        host: host.trim(),
        port,
      };
      if (showApiUrl) body.apiUrl = apiUrl.trim();
      if (tokenTouched) body.accessToken = accessToken;
      const res = await api.connections.update(conn.id, body);
      if (res.ok === false) {
        toast.error(res.message || '保存失败');
        return;
      }
      toast.success(wasEnabled ? '已保存并重连' : '已保存');
      await onSaved?.();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSaving(false);
    }
  };

  const onToggle = async () => {
    if (!conn) return;
    if (!conn.enable && isWx && !conn.weixinLoggedIn) {
      onRequestWeixinLogin(conn, true);
      return;
    }
    setBusy(true);
    try {
      const r = await api.connections.toggle(conn.id) as {
        ok?: boolean;
        message?: string;
      };
      if (r && r.ok === false) {
        const msg = r.message || '操作失败';
        if (!conn.enable && isWx && /扫码|登录/.test(msg)) {
          onRequestWeixinLogin(conn, true);
          return;
        }
        toast.error(msg);
        return;
      }
      toast.success(conn.enable ? '已关闭连接' : '已启用连接');
      await onSaved?.();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  const showCopyAddress = conn && ((!isQq || isQqHttps) && !isWx && !isKook);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isQq
              ? `QQ 官方 · ${conn?.name ?? ''}`
              : isWx
                ? `微信 AI×BOT · ${conn?.name ?? ''}`
                : isKook
                  ? `KOOK · ${conn?.name ?? ''}`
                  : `编辑${modeTitle(mode)} · ${conn?.name ?? ''}`}
          </DialogTitle>
          {isWx && (
            <DialogDescription>
              可随时修改名称；启用前需扫码登录。
            </DialogDescription>
          )}
          {isKook && (
            <DialogDescription>
              可修改名称与 Token；保存后自动重连生效。
            </DialogDescription>
          )}
        </DialogHeader>

        {conn && (
          <div data-tour="conn-dialog-enable" className="flex items-center justify-between gap-3 rounded-xl border bg-muted/20 p-3">
            <div className="h-12 w-12 shrink-0 overflow-hidden rounded-full bg-muted/40 ring-1 ring-border/40">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={avatarSrc} alt="" className="h-full w-full object-cover" />
            </div>
            <Switch
              checked={conn.enable}
              disabled={busy || saving}
              aria-label={conn.enable ? '禁用连接' : '启用连接'}
              onCheckedChange={() => void onToggle()}
            />
          </div>
        )}

        <div className="space-y-3">
          {isWx ? (
            <>
              <div className="space-y-2">
                <Label>名称</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <p className="text-xs text-muted-foreground">
                {conn?.weixinSummary || conn?.listenUrl || '未登录'}
              </p>
            </>
          ) : isQq ? (
            <>
              {conn?.botProfile && (
                <div className="rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                  {conn.botProfile.desc || '暂无简介'}
                </div>
              )}
              <div className="space-y-2 rounded-md border bg-muted/30 p-3">
                <div className="flex items-center justify-between gap-2">
                  <Label className="text-xs text-muted-foreground">分享链接</Label>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 gap-1"
                      disabled={refreshingProfile || busy || !conn}
                      onClick={async () => {
                        if (!conn) return;
                        setRefreshingProfile(true);
                        try {
                          const r = await api.connections.refreshBotProfile(conn.id);
                          if (!r.ok) {
                            toast.error(r.message || '刷新失败');
                            return;
                          }
                          toast.success(r.profile?.shareUrl ? '已刷新分享链接' : '已刷新资料（接口未返回分享链接）');
                          await onSaved?.();
                        } catch (e) {
                          toast.error(String(e));
                        } finally {
                          setRefreshingProfile(false);
                        }
                      }}
                    >
                      {refreshingProfile
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        : <RefreshCw className="h-3.5 w-3.5" />}
                      刷新
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 gap-1"
                      disabled={!conn?.botProfile?.shareUrl}
                      onClick={() => {
                        const url = conn?.botProfile?.shareUrl;
                        if (url) copyText(url);
                      }}
                    >
                      <Copy className="h-3.5 w-3.5" />
                      复制
                    </Button>
                  </div>
                </div>
                <code className="block break-all font-mono text-[11px]">
                  {conn?.botProfile?.shareUrl || '暂无，请点击刷新从开放平台拉取'}
                </code>
              </div>
              <div className="space-y-2">
                <Label>名称</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>AppID</Label>
                <Input value={appId} onChange={(e) => setAppId(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>AppSecret</Label>
                <Input
                  type="password"
                  value={appSecret}
                  onChange={(e) => setAppSecret(e.target.value)}
                  placeholder="留空保持不变"
                  autoComplete="new-password"
                />
              </div>
              <div className="flex items-center justify-between">
                <Label htmlFor="sandbox-manage">沙箱环境</Label>
                <Switch
                  id="sandbox-manage"
                  checked={sandbox}
                  onCheckedChange={setSandbox}
                />
              </div>
              <div className="space-y-2">
                <Label>Intents（可选）</Label>
                <Input
                  value={intents}
                  onChange={(e) => setIntents(e.target.value)}
                  placeholder="留空 = 群聊 + 私聊 + 群成员变更"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              {isQqHttps && conn && (
                <>
                  <div className="space-y-2">
                    <Label>公网回调基址</Label>
                    <Input
                      value={webhookBaseUrl}
                      onChange={(e) => setWebhookBaseUrl(e.target.value)}
                      placeholder="https://bot.example.com"
                      autoComplete="off"
                    />
                    <p className="text-xs text-muted-foreground">
                      开放平台要求公网 HTTPS（端口 80/443/8080/8443）地址；填了域名才会给出可直接提交的回调 URL。
                    </p>
                  </div>
                  <div className="space-y-2 rounded-md border bg-muted/30 p-3">
                    {publicCallbackUrl ? (
                      <>
                        <div className="flex items-center justify-between gap-2">
                          <Label className="text-xs text-muted-foreground">回调 URL</Label>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-7 gap-1"
                            onClick={() => copyText(publicCallbackUrl)}
                          >
                            <Copy className="h-3.5 w-3.5" />
                            复制
                          </Button>
                        </div>
                        <code className="block break-all font-mono text-[11px]">{publicCallbackUrl}</code>
                      </>
                    ) : (
                      <p className="text-xs text-amber-600">
                        未填写公网回调基址：当前监听地址
                        {' '}
                        <code className="break-all font-mono text-[11px]">{conn.listenUrl}</code>
                        {' '}
                        只能本机自测，开放平台无法用它校验或推送事件。
                      </p>
                    )}
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <Label className="text-xs text-muted-foreground">监听路径</Label>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 gap-1"
                        onClick={() => copyText(`/gfbot/${conn.id}`)}
                      >
                        <Copy className="h-3.5 w-3.5" />
                        复制
                      </Button>
                    </div>
                    <code className="block font-mono text-[11px]">/gfbot/{conn.id}</code>
                    <p className="mt-2 text-xs text-muted-foreground">
                      反代：域名 → http://127.0.0.1:8787，路径原样转发（与后台共用一条反代即可）。
                    </p>
                  </div>
                </>
              )}
            </>
          ) : isKook ? (
            <>
              <div className="space-y-2">
                <Label>名称</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>机器人 Token</Label>
                <Input
                  type="password"
                  value={kookToken}
                  placeholder={conn?.kookReady ? '已设置，留空表示不修改' : '未设置，可填写'}
                  autoComplete="new-password"
                  onChange={(e) => {
                    setKookTokenTouched(true);
                    setKookToken(e.target.value);
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  {conn?.kookSummary || 'KOOK 机器人'} · 首次启用连上网关后自动识别身份。
                </p>
              </div>
            </>
          ) : (
            <>
              <div className="space-y-2">
                <Label>名称</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>{isRemote ? 'NapCat 地址' : '监听地址'}</Label>
                <Input value={host} onChange={(e) => setHost(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>{isRemote ? 'NapCat 端口' : '监听端口'}</Label>
                <Input
                  type="number"
                  min={1}
                  max={65535}
                  value={port}
                  onChange={(e) => setPort(Number(e.target.value) || 6700)}
                />
              </div>
              {showApiUrl && (
                <div className="space-y-2">
                  <Label>NapCat HTTP API（apiUrl）</Label>
                  <Input
                    value={apiUrl}
                    placeholder="http://127.0.0.1:3000"
                    onChange={(e) => setApiUrl(e.target.value)}
                  />
                </div>
              )}
              {mode === 'http_client' && (
                <p className="text-xs text-muted-foreground">
                  事件上报地址：{conn?.listenUrl || `/onebot/http/${conn?.id}`}
                </p>
              )}
              <div className="space-y-2">
                <Label>Access Token（可选）</Label>
                <Input
                  type="password"
                  value={accessToken}
                  placeholder={conn?.hasAccessToken ? '已设置，留空表示不修改' : '未设置，可填写'}
                  autoComplete="new-password"
                  onChange={(e) => {
                    setTokenTouched(true);
                    setAccessToken(e.target.value);
                  }}
                />
                {conn?.hasAccessToken && !tokenTouched && (
                  <p className="text-xs text-muted-foreground">当前已配置 Token（界面不回显明文）</p>
                )}
              </div>
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-center gap-2 border-t pt-3">
          {showCopyAddress && conn && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={ACTION_BTN_CLASS}
              title="复制连接地址"
              aria-label="复制连接地址"
              onClick={() => copyText(conn.listenUrl)}
            >
              <Copy className="h-3.5 w-3.5" />
              复制
            </Button>
          )}
          {isWx && conn && (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={ACTION_BTN_CLASS}
                title={conn.weixinLoggedIn ? '重新扫码登录' : '扫码登录'}
                aria-label={conn.weixinLoggedIn ? '重新扫码登录' : '扫码登录'}
                onClick={() => onRequestWeixinLogin(conn, false)}
              >
                <QrCode className="h-3.5 w-3.5" />
                扫码
              </Button>
              {conn.weixinLoggedIn && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className={ACTION_BTN_CLASS}
                  title="退出微信登录"
                  aria-label="退出微信登录"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const r = await api.connections.weixinLogout(conn.id);
                      if (!r.ok) {
                        toast.error(r.message || '退出失败');
                        return;
                      }
                      toast.success('已清除微信登录凭证');
                      await onSaved?.();
                    } catch (e) {
                      toast.error(String(e));
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <LogOut className="h-3.5 w-3.5" />
                  退出
                </Button>
              )}
            </>
          )}
          {conn && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-tour="conn-dialog-plugins"
              className={ACTION_BTN_CLASS}
              title="管理该连接的插件"
              onClick={() => onOpenPlugins(conn)}
            >
              <AppWindow className="h-3.5 w-3.5" />
              插件
            </Button>
          )}
          {conn && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={ACTION_BTN_CLASS}
              title="立即重连"
              disabled={!conn.enable || busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api.connections.reconnect(conn.id);
                  toast.success('已重连');
                  await onSaved?.();
                } catch (e) {
                  toast.error(String(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="h-3.5 w-3.5" />}
              重连
            </Button>
          )}
          {canReconnectSettings && conn && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={ACTION_BTN_CLASS}
              title="重连策略设置"
              aria-label="重连策略设置"
              onClick={() => onOpenReconnectStrategy(conn)}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              策略
            </Button>
          )}
          {conn && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={cn(ACTION_BTN_CLASS, 'text-destructive hover:text-destructive')}
              title="删除该连接"
              onClick={() => onRequestDelete(conn)}
            >
              <Trash2 className="h-3.5 w-3.5" />
              删除
            </Button>
          )}
        </div>

        <DialogFooter className="!flex-row !justify-center gap-3 space-x-0 sm:!flex-row sm:!justify-center sm:space-x-0">
          <Button data-tour="conn-dialog-close" variant="outline" className="min-w-0 flex-1" onClick={onClose}>
            取消
          </Button>
          <Button className="min-w-0 flex-1" onClick={() => void onSave()} disabled={saving || busy}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
