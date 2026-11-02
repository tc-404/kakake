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
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useT } from '@/lib/i18n';
import { errText, resText } from '@/lib/server-error';
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

function copyText(
  text: string,
  t: (key: string, params?: Record<string, string | number | undefined>) => string,
) {
  void copyToClipboard(text).then((ok) => {
    if (ok) toast.success(t('connections.copied'));
    else toast.error(t('connections.copyFailed'));
  });
}

function modeTitleKey(mode?: ConnectionMode): string {
  switch (mode) {
    case 'forward':
      return 'connections.modeForwardWs';
    case 'http':
      return 'connections.modeHttpServer';
    case 'http_sse':
      return 'connections.modeHttpSseServer';
    case 'http_client':
      return 'connections.modeHttpClient';
    case 'https':
      return 'connections.modeTitleHttps';
    default:
      return 'connections.modeReverseWs';
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
  const t = useT();
  const [name, setName] = useState('');
  const [host, setHost] = useState('127.0.0.1');
  const [port, setPort] = useState(6700);
  const [apiUrl, setApiUrl] = useState('');
  /** 接口代理：OneBot 协议端实现。auto = 连上后探测 get_version_info */
  const [onebotImpl, setOnebotImpl] = useState<'auto' | 'napcat' | 'snowluma'>('auto');
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
    setOnebotImpl(conn.onebotImpl || 'auto');
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
      toast.error(t('connections.enterName'));
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
          toast.error(resText(res) || t('connections.saveFailed'));
          return;
        }
        toast.success(wasEnabled ? t('connections.savedAndReconnected') : t('connections.saved'));
        await onSaved?.();
        return;
      }

      if (isWx) {
        const res = await api.connections.update(conn.id, { name: name.trim() });
        if (res.ok === false) {
          toast.error(resText(res) || t('connections.saveFailed'));
          return;
        }
        toast.success(t('connections.saved'));
        await onSaved?.();
        return;
      }

      if (isQq) {
        if (!appId.trim()) {
          toast.error(t('connections.enterAppId'));
          return;
        }
        const intentsValue = parseIntentsInput(intents);
        if (intentsValue === null) {
          toast.error(t('connections.intentsFormat'));
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
          toast.error(resText(res) || t('connections.saveFailed'));
          return;
        }
        toast.success(wasEnabled ? t('connections.savedAndReconnected') : t('connections.saved'));
        await onSaved?.();
        return;
      }

      if (!host.trim()) {
        toast.error(t('connections.enterHost'));
        return;
      }
      if (showApiUrl && !apiUrl.trim()) {
        toast.error(t('connections.fillNapcatApi'));
        return;
      }
      const body: {
        name: string;
        host: string;
        port: number;
        accessToken?: string;
        apiUrl?: string;
        onebotImpl?: 'auto' | 'napcat' | 'snowluma';
      } = {
        name: name.trim(),
        host: host.trim(),
        port,
      };
      if (showApiUrl) body.apiUrl = apiUrl.trim();
      if (tokenTouched) body.accessToken = accessToken;
      // 只有 OneBot 连接才有「协议端实现」这个概念；官方/微信/KOOK 不传
      if (!isQq && !isWx && !isKook) body.onebotImpl = onebotImpl;
      const res = await api.connections.update(conn.id, body);
      if (res.ok === false) {
        toast.error(resText(res) || t('connections.saveFailed'));
        return;
      }
      toast.success(wasEnabled ? t('connections.savedAndReconnected') : t('connections.saved'));
      await onSaved?.();
    } catch (e) {
      toast.error(errText(e));
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
        const msg = resText(r) || t('connections.operationFailed');
        /*
         * 判定要用后端原文：msg 已经被本地化成英文了，再拿中文关键词去匹配
         * 必然落空——英文模式下微信连接启用时会不弹扫码框，只报个错。
         * 同时兼容后端可能直接返回英文的情况。
         */
        const rawMsg = String(r?.message ?? '');
        if (!conn.enable && isWx && /扫码|登录|scan|log ?in/i.test(rawMsg || msg)) {
          onRequestWeixinLogin(conn, true);
          return;
        }
        toast.error(msg);
        return;
      }
      toast.success(conn.enable ? t('connections.connDisabled') : t('connections.connEnabled'));
      await onSaved?.();
    } catch (e) {
      toast.error(errText(e));
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
              ? t('connections.titleQq', { name: conn?.name ?? '' })
              : isWx
                ? t('connections.titleWeixin', { name: conn?.name ?? '' })
                : isKook
                  ? t('connections.titleKook', { name: conn?.name ?? '' })
                  : t('connections.titleEdit', { mode: t(modeTitleKey(mode)), name: conn?.name ?? '' })}
          </DialogTitle>
          {isWx && (
            <DialogDescription>
              {t('connections.descWeixinManage')}
            </DialogDescription>
          )}
          {isKook && (
            <DialogDescription>
              {t('connections.descKookManage')}
            </DialogDescription>
          )}
        </DialogHeader>

        {conn && (
          <div data-tour="conn-dialog-enable" className="flex items-center justify-between gap-3 rounded-xl border bg-muted/20 p-3">
            {/* 真实头像不给底色：透明 PNG/WebP 的透明区要透出来（同连接卡片），只有占位态才铺灰盘 */}
            <div className={`h-12 w-12 shrink-0 overflow-hidden rounded-full ${avatarDataUrl ? '' : 'bg-muted/40 ring-1 ring-border/40'}`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={avatarSrc} alt="" className="h-full w-full object-cover" />
            </div>
            <Switch
              checked={conn.enable}
              disabled={busy || saving}
              aria-label={conn.enable ? t('connections.ariaDisable') : t('connections.ariaEnable')}
              onCheckedChange={() => void onToggle()}
            />
          </div>
        )}

        <div className="space-y-3">
          {isWx ? (
            <>
              <div className="space-y-2">
                <Label>{t('label.name')}</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <p className="text-xs text-muted-foreground">
                {conn?.weixinSummary || conn?.listenUrl || t('connections.notLoggedIn')}
              </p>
            </>
          ) : isQq ? (
            <>
              {conn?.botProfile && (
                <div className="rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                  {conn.botProfile.desc || t('connections.noIntro')}
                </div>
              )}
              <div className="space-y-2 rounded-md border bg-muted/30 p-3">
                <div className="flex items-center justify-between gap-2">
                  <Label className="text-xs text-muted-foreground">{t('connections.shareLink')}</Label>
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
                            toast.error(resText(r) || t('connections.refreshFailed'));
                            return;
                          }
                          toast.success(r.profile?.shareUrl ? t('connections.refreshShareOk') : t('connections.refreshProfileNoUrl'));
                          await onSaved?.();
                        } catch (e) {
                          toast.error(errText(e));
                        } finally {
                          setRefreshingProfile(false);
                        }
                      }}
                    >
                      {refreshingProfile
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        : <RefreshCw className="h-3.5 w-3.5" />}
                      {t('connections.refresh')}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 gap-1"
                      disabled={!conn?.botProfile?.shareUrl}
                      onClick={() => {
                        const url = conn?.botProfile?.shareUrl;
                        if (url) copyText(url, t);
                      }}
                    >
                      <Copy className="h-3.5 w-3.5" />
                      {t('connections.copy')}
                    </Button>
                  </div>
                </div>
                <code className="block break-all font-mono text-[11px]">
                  {conn?.botProfile?.shareUrl || t('connections.noShareUrl')}
                </code>
              </div>
              <div className="space-y-2">
                <Label>{t('label.name')}</Label>
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
                  placeholder={t('connections.appSecretPlaceholder')}
                  autoComplete="new-password"
                />
              </div>
              <div className="flex items-center justify-between">
                <Label htmlFor="sandbox-manage">{t('connections.sandboxEnv')}</Label>
                <Switch
                  id="sandbox-manage"
                  checked={sandbox}
                  onCheckedChange={setSandbox}
                />
              </div>
              <div className="space-y-2">
                <Label>{t('connections.intentsLabel')}</Label>
                <Input
                  value={intents}
                  onChange={(e) => setIntents(e.target.value)}
                  placeholder={t('connections.intentsPlaceholder')}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              {isQqHttps && conn && (
                <>
                  <div className="space-y-2">
                    <Label>{t('connections.callbackBaseLabel')}</Label>
                    <Input
                      value={webhookBaseUrl}
                      onChange={(e) => setWebhookBaseUrl(e.target.value)}
                      placeholder="https://bot.example.com"
                      autoComplete="off"
                    />
                    <p className="text-xs text-muted-foreground">
                      {t('connections.callbackHintHttps')}
                    </p>
                  </div>
                  <div className="space-y-2 rounded-md border bg-muted/30 p-3">
                    {publicCallbackUrl ? (
                      <>
                        <div className="flex items-center justify-between gap-2">
                          <Label className="text-xs text-muted-foreground">{t('connections.callbackUrl')}</Label>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-7 gap-1"
                            onClick={() => copyText(publicCallbackUrl, t)}
                          >
                            <Copy className="h-3.5 w-3.5" />
                            {t('connections.copy')}
                          </Button>
                        </div>
                        <code className="block break-all font-mono text-[11px]">{publicCallbackUrl}</code>
                      </>
                    ) : (
                      <p className="text-xs text-amber-600">
                        {t('connections.noPublicBase', { url: conn.listenUrl })}
                      </p>
                    )}
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <Label className="text-xs text-muted-foreground">{t('connections.listenPath')}</Label>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 gap-1"
                        onClick={() => copyText(`/gfbot/${conn.id}`, t)}
                      >
                        <Copy className="h-3.5 w-3.5" />
                        {t('connections.copy')}
                      </Button>
                    </div>
                    <code className="block font-mono text-[11px]">/gfbot/{conn.id}</code>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {t('connections.reverseProxyHint')}
                    </p>
                  </div>
                </>
              )}
            </>
          ) : isKook ? (
            <>
              <div className="space-y-2">
                <Label>{t('label.name')}</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>{t('connections.botToken')}</Label>
                <Input
                  type="password"
                  value={kookToken}
                  placeholder={conn?.kookReady ? t('connections.tokenSetPlaceholder') : t('connections.tokenUnsetPlaceholder')}
                  autoComplete="new-password"
                  onChange={(e) => {
                    setKookTokenTouched(true);
                    setKookToken(e.target.value);
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  {conn?.kookSummary || t('connections.phKookBot')} · {t('connections.kookAutoIdentity')}
                </p>
              </div>
            </>
          ) : (
            <>
              <div className="space-y-2">
                <Label>{t('label.name')}</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>{isRemote ? t('connections.napcatAddress') : t('connections.listenAddress')}</Label>
                <Input value={host} onChange={(e) => setHost(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>{isRemote ? t('connections.napcatPort') : t('connections.listenPort')}</Label>
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
                  <Label>{t('connections.napcatHttpApi')}</Label>
                  <Input
                    value={apiUrl}
                    placeholder="http://127.0.0.1:3000"
                    onChange={(e) => setApiUrl(e.target.value)}
                  />
                </div>
              )}
              {mode === 'http_client' && (
                <p className="text-xs text-muted-foreground">
                  {t('connections.eventReportAddress')}
                  {conn?.listenUrl || `/onebot/http/${conn?.id}`}
                </p>
              )}
              {/* 接口代理的协议端实现识别：下拉显式指定 + 未指定时自动探测，双保险 */}
              {!isQq && !isWx && !isKook && (
                <div className="space-y-2">
                  <Label>{t('connections.onebotImpl')}</Label>
                  <Select
                    value={onebotImpl}
                    onValueChange={(v) => setOnebotImpl(v as 'auto' | 'napcat' | 'snowluma')}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">{t('connections.onebotImplAuto')}</SelectItem>
                      <SelectItem value="napcat">napcat</SelectItem>
                      <SelectItem value="snowluma">snowluma</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className="space-y-2">
                <Label>{t('connections.accessTokenOptional')}</Label>
                <Input
                  type="password"
                  value={accessToken}
                  placeholder={conn?.hasAccessToken ? t('connections.tokenSetPlaceholder') : t('connections.tokenUnsetPlaceholder')}
                  autoComplete="new-password"
                  onChange={(e) => {
                    setTokenTouched(true);
                    setAccessToken(e.target.value);
                  }}
                />
                {conn?.hasAccessToken && !tokenTouched && (
                  <p className="text-xs text-muted-foreground">{t('connections.tokenConfigured')}</p>
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
              title={t('connections.copyAddress')}
              aria-label={t('connections.copyAddress')}
              onClick={() => copyText(conn.listenUrl, t)}
            >
              <Copy className="h-3.5 w-3.5" />
              {t('connections.copy')}
            </Button>
          )}
          {isWx && conn && (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={ACTION_BTN_CLASS}
                title={conn.weixinLoggedIn ? t('connections.rescanLogin') : t('connections.scanLogin')}
                aria-label={conn.weixinLoggedIn ? t('connections.rescanLogin') : t('connections.scanLogin')}
                onClick={() => onRequestWeixinLogin(conn, false)}
              >
                <QrCode className="h-3.5 w-3.5" />
                {t('connections.scan')}
              </Button>
              {conn.weixinLoggedIn && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
              className={ACTION_BTN_CLASS}
              title={t('connections.weixinLogout')}
              aria-label={t('connections.weixinLogout')}
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const r = await api.connections.weixinLogout(conn.id);
                  if (!r.ok) {
                    toast.error(resText(r) || t('connections.logoutFailed'));
                    return;
                  }
                  toast.success(t('connections.weixinLogoutCleared'));
                  await onSaved?.();
                } catch (e) {
                  toast.error(errText(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              <LogOut className="h-3.5 w-3.5" />
              {t('connections.logout')}
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
              title={t('connections.managePlugins')}
              onClick={() => onOpenPlugins(conn)}
            >
              <AppWindow className="h-3.5 w-3.5" />
              {t('connections.plugins')}
            </Button>
          )}
          {conn && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={ACTION_BTN_CLASS}
              title={t('connections.reconnectNow')}
              disabled={!conn.enable || busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api.connections.reconnect(conn.id);
                  toast.success(t('connections.reconnected'));
                  await onSaved?.();
                } catch (e) {
                  toast.error(errText(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="h-3.5 w-3.5" />}
              {t('connections.reconnect')}
            </Button>
          )}
          {canReconnectSettings && conn && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={ACTION_BTN_CLASS}
              title={t('connections.reconnectStrategy')}
              aria-label={t('connections.reconnectStrategy')}
              onClick={() => onOpenReconnectStrategy(conn)}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              {t('connections.strategy')}
            </Button>
          )}
          {conn && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={cn(ACTION_BTN_CLASS, 'text-destructive hover:text-destructive')}
              title={t('connections.deleteThisConn')}
              onClick={() => onRequestDelete(conn)}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t('btn.delete')}
            </Button>
          )}
        </div>

        <DialogFooter className="!flex-row !justify-center gap-3 space-x-0 sm:!flex-row sm:!justify-center sm:space-x-0">
          <Button data-tour="conn-dialog-close" variant="outline" className="min-w-0 flex-1" onClick={onClose}>
            {t('btn.cancel')}
          </Button>
          <Button className="min-w-0 flex-1" onClick={() => void onSave()} disabled={saving || busy}>
            {saving ? t('connections.saving') : t('connections.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
