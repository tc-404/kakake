import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  QrCode, Bot, Activity, TrendingUp, RefreshCw, Power,
  Trash2, CircleCheck, CircleX, Plus, Radio, ShieldCheck,
  Users, Hash, Globe, KeyRound, ChevronDown,
} from 'lucide-react';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import type {
  OpenPlatformAccount, OpenPlatformState, OpenPlatformInsight, OpenPlatformChannel,
} from '@/lib/types';
import { cn } from '@/lib/utils';
import { BotInteractiveConfig } from '@/components/bot-interactive-config';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { errText, resText } from '@/lib/server-error';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';

const CHANNEL_TYPE_KEY: Record<number, string> = {
  0: 'open-platform.chanText',
  2: 'open-platform.chanVoice',
  4: 'open-platform.chanGroup',
  10005: 'open-platform.chanLive',
  10006: 'open-platform.chanApp',
  10007: 'open-platform.chanForum',
};

/** 数字徽标：日活四个口径 */
function StatPill({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col items-center rounded-xl bg-white/10 px-2 py-1.5">
      <span className={cn('text-base font-semibold tabular-nums leading-tight', accent ? 'text-teal-700' : 'text-slate-700')}>
        {value}
      </span>
      <span className="text-[10px] text-slate-500">{label}</span>
    </div>
  );
}

/** 近 7 天日活柱状图（纯 CSS，无图表库依赖） */
function DauChart({ daily }: { daily: Array<{ date: string; count: number }> }) {
  const max = Math.max(1, ...daily.map((d) => d.count));
  return (
    <div className="flex h-20 items-end gap-1.5">
      {daily.map((d) => (
        <div key={d.date} className="flex min-w-0 flex-1 flex-col items-center gap-1">
          <div
            className="w-full max-w-8 rounded-t-[3px] bg-gradient-to-t from-teal-500/80 to-teal-400/60 transition-[height]"
            style={{ height: `${Math.max(4, (d.count / max) * 100)}%` }}
            title={`${d.date}：${d.count}`}
          />
          <span className="truncate text-[9px] text-slate-400">{d.date.slice(5)}</span>
        </div>
      ))}
    </div>
  );
}

/** 单个机器人账号卡片 */
function AccountCard({
  account,
  onClick,
}: {
  account: OpenPlatformAccount;
  onClick: () => void;
}) {
  const t = useT();
  const dau = account.dau;
  const title = account.username || account.name || (account.pending ? t('open-platform.unnamedAccount') : t('open-platform.unnamedBot'));
  return (
    <button
      type="button"
      data-tour="op-card"
      onClick={onClick}
      className="kk-glass group flex w-full flex-col gap-3 rounded-2xl border border-white/40 p-4 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-teal-400/50 hover:bg-white/25"
    >
      <div className="flex items-center gap-4">
        {account.avatar ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={account.avatar} alt="" referrerPolicy="no-referrer" className="h-16 w-16 shrink-0 rounded-2xl bg-black/5 object-cover ring-1 ring-black/5" />
        ) : (
          <div className={cn(
            'flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl ring-1 ring-black/5',
            account.pending ? 'bg-slate-500/10 text-slate-400' : 'bg-teal-500/15 text-teal-700',
          )}>
            {account.pending ? <KeyRound className="h-8 w-8" /> : <Bot className="h-8 w-8" />}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="flex min-w-0 items-baseline gap-1 text-base font-semibold leading-tight text-slate-800">
              <span className="truncate">{title}</span>
              {account.appId ? (
                <span className="shrink-0 font-normal text-slate-400">（{account.appId}）</span>
              ) : null}
            </span>
            {!account.pending && (
              <span
                className={cn(
                  'inline-flex h-1.5 w-1.5 shrink-0 rounded-full',
                  account.connected ? 'bg-emerald-500' : 'bg-slate-300',
                )}
                title={account.connected ? t('open-platform.tipConnected') : t('open-platform.tipNotConnected')}
              />
            )}
          </div>
          <div className="mt-1 flex items-center gap-1 text-[11px] text-slate-500">
            <span>
              {account.pending ? t('open-platform.statusPending') : account.connected ? t('open-platform.statusConnected') : account.enable ? t('open-platform.statusConnecting') : t('open-platform.statusDisabled')}
            </span>
            <span className="opacity-0 transition-opacity group-hover:opacity-100">· {t('open-platform.details')}</span>
          </div>
        </div>
        <span
          className={cn(
            'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium',
            account.pending
              ? 'bg-slate-500/15 text-slate-600'
              : account.sandbox ? 'bg-amber-500/15 text-amber-700' : 'bg-teal-500/15 text-teal-700',
          )}
        >
          {account.pending ? t('open-platform.badgeNotConnected') : account.sandbox ? t('open-platform.badgeSandbox') : t('open-platform.badgeOfficial')}
        </span>
      </div>

      {account.pending ? (
        <p className="rounded-xl bg-white/10 px-3 py-2 text-[11px] text-slate-500">
          {t('open-platform.pendingNote')}
        </p>
      ) : (
        <div className="grid grid-cols-4 gap-1.5">
          <StatPill label={t('open-platform.dauToday')} value={dau?.today ?? 0} accent />
          <StatPill label={t('open-platform.dauYesterday')} value={dau?.yesterday ?? 0} />
          <StatPill label={t('open-platform.dau7d')} value={dau?.last7d ?? 0} />
          <StatPill label={t('open-platform.dauTotal')} value={dau?.total ?? 0} />
        </div>
      )}
    </button>
  );
}

export default function OpenPlatformPage() {
  const t = useT();
  const [state, setState] = useState<OpenPlatformState | null>(null);
  const [loading, setLoading] = useState(true);

  // 扫码接入
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrLoading, setQrLoading] = useState(false);
  /** 二维码悬浮窗：点「扫码接入」后额外呼出，关窗不取消扫码（可点「继续扫码」再呼出） */
  const [qrOpen, setQrOpen] = useState(false);
  const [qrTip, setQrTip] = useState('');
  const [scanNote, setScanNote] = useState('');
  const qrIdRef = useRef<string>('');
  const qrVersionRef = useRef<number>(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 详情弹窗
  const [selected, setSelected] = useState<OpenPlatformAccount | null>(null);
  const [busy, setBusy] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<OpenPlatformAccount | null>(null);

  // 账号详情里的官方数据
  const [insight, setInsight] = useState<OpenPlatformInsight | null>(null);
  const [insightLoading, setInsightLoading] = useState(false);
  const [openGuild, setOpenGuild] = useState<string>('');
  const [channels, setChannels] = useState<OpenPlatformChannel[]>([]);
  const [channelsLoading, setChannelsLoading] = useState(false);

  // 添加 / 接入账号
  const [addOpen, setAddOpen] = useState(false);
  const [addAppId, setAddAppId] = useState('');
  const [addName, setAddName] = useState('');
  const [addSecret, setAddSecret] = useState('');
  const [addSandbox, setAddSandbox] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await api.openPlatform.state();
      setState(res);
      return res;
    } catch (e) {
      toast.error(errText(e));
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  /** 刷新列表，并把详情弹窗里那份快照换成最新数据 */
  const loadAndSyncSelected = useCallback(async (id: string) => {
    const res = await load();
    const fresh = res?.accounts?.find((a) => a.id === id);
    if (fresh) setSelected(fresh);
    return res;
  }, [load]);

  useEffect(() => {
    void load();
  }, [load]);

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  useEffect(() => () => stopPolling(), []);

  async function loadQr() {
    setQrLoading(true);
    try {
      const res = await api.openPlatform.qr();
      if (!res.ok || !res.qrDataUrl || !res.id) {
        toast.error(resText(res) || t('open-platform.qrGenFailed'));
        return;
      }
      qrIdRef.current = res.id;
      qrVersionRef.current = res.version ?? 1;
      setQrDataUrl(res.qrDataUrl);
      setQrTip(t('open-platform.waitingScan'));
      setQrOpen(true);
      stopPolling();
      pollRef.current = setInterval(() => {
        void api.openPlatform.poll(qrIdRef.current).then((r) => {
          if (r.stage === 'pending') {
            setQrTip(resText(r) || t('open-platform.waitingScan'));
            // 二维码过期后官方会自动换新，把新图推给前端
            if (r.qrDataUrl && r.version && r.version !== qrVersionRef.current) {
              qrVersionRef.current = r.version;
              setQrDataUrl(r.qrDataUrl);
            }
            return;
          }
          stopPolling();
          setQrDataUrl(null);
          qrIdRef.current = '';
          if (!r.ok || r.stage !== 'done') {
            toast.error(resText(r) || t('open-platform.scanFailed'));
            return;
          }
          const n = r.appIds?.length ?? 0;
          if (n > 1) {
            toast.success(t('open-platform.connectedN', { n }));
            setScanNote(t('open-platform.scanNoteMultiN', { n }));
          } else {
            toast.success(t('open-platform.connectSuccess'));
            setScanNote(
              t('open-platform.scanNoteMulti'),
            );
          }
          void load();
        }).catch(() => { /* 忽略单次轮询错误 */ });
      }, 2000);
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setQrLoading(false);
    }
  }

  function cancelQr() {
    const id = qrIdRef.current;
    stopPolling();
    setQrDataUrl(null);
    qrIdRef.current = '';
    if (id) void api.openPlatform.cancelQr(id).catch(() => { /* 忽略 */ });
  }

  function openDetail(account: OpenPlatformAccount) {
    setSelected(account);
    setInsight(null);
    setOpenGuild('');
    setChannels([]);
    if (!account.pending) void loadInsight(account.id);
  }

  async function loadInsight(id: string) {
    setInsightLoading(true);
    try {
      const res = await api.openPlatform.insight(id);
      setInsight(res);
    } catch (e) {
      setInsight({ ok: false, message: errText(e) || t('open-platform.fetchFailed') });
    } finally {
      setInsightLoading(false);
    }
  }

  async function toggleGuild(guildId: string) {
    if (!selected) return;
    if (openGuild === guildId) {
      setOpenGuild('');
      setChannels([]);
      return;
    }
    setOpenGuild(guildId);
    setChannels([]);
    setChannelsLoading(true);
    try {
      const res = await api.openPlatform.channels(selected.id, guildId);
      setChannels(res.ok ? res.channels ?? [] : []);
      if (!res.ok) toast.error(resText(res) || t('open-platform.fetchChannelsFailed'));
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setChannelsLoading(false);
    }
  }

  function openAdd(account?: OpenPlatformAccount) {
    setAddAppId(account?.appId ?? '');
    setAddName(account?.name ?? '');
    setAddSecret('');
    setAddSandbox(true);
    setAddOpen(true);
  }

  async function submitAdd() {
    const appId = addAppId.trim();
    if (!appId) {
      toast.error(t('open-platform.fillAppId'));
      return;
    }
    setBusy(true);
    try {
      if (addSecret.trim()) {
        await api.connections.add({
          type: 'qq_official',
          appId,
          appSecret: addSecret.trim(),
          sandbox: addSandbox,
          name: addName.trim() || undefined,
          enable: true,
        });
        try {
          await api.openPlatform.removePending(appId);
        } catch { /* 本来就没登记过 */ }
        toast.success(t('open-platform.botConnected'));
      } else {
        await api.openPlatform.addPending(appId, addName.trim());
        toast.success(t('open-platform.registeredPending'));
      }
      setAddOpen(false);
      setSelected(null);
      await load();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function toggleAccount() {
    if (!selected) return;
    const id = selected.id;
    const pending = selected.pending;
    setBusy(true);
    try {
      const res = await api.connections.toggle(id);
      if (res && res.ok === false) throw new Error(res.message || t('open-platform.opFailed'));
      const on = res?.enable !== false;
      await loadAndSyncSelected(id);
      toast.success(on ? t('open-platform.enabledToast') : t('open-platform.disabledToast'));
      if (!pending) await loadInsight(id);
      // WebSocket 握手要一点时间，稍后补拉一次把「连接正常」刷出来
      if (on) window.setTimeout(() => void loadAndSyncSelected(id), 1500);
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function refreshProfile() {
    if (!selected) return;
    setBusy(true);
    try {
      await api.connections.refreshBotProfile(selected.id);
      await loadAndSyncSelected(selected.id);
      toast.success(t('open-platform.profileRefreshed'));
      await loadInsight(selected.id);
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function confirmRemove() {
    if (!removeTarget) return;
    setBusy(true);
    try {
      if (removeTarget.pending) {
        await api.openPlatform.removePending(removeTarget.appId);
        toast.success(t('open-platform.removedPending'));
      } else {
        await api.connections.remove(removeTarget.id);
        toast.success(t('open-platform.botDeleted'));
      }
      setRemoveTarget(null);
      setSelected(null);
      await load();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  }

  const accounts = state?.accounts ?? [];
  const login = state?.login;
  const connectedCount = accounts.filter((a) => !a.pending && a.connected).length;
  const totalDauToday = accounts.reduce((s, a) => s + (a.dau?.today ?? 0), 0);

  return (
    <div className="kk-fixed-theme flex h-full min-h-0 flex-col gap-4">
      {/* 登录区 */}
      <div data-tour="op-login" className="kk-glass kk-stagger-item kk-stagger-1 flex flex-col gap-4 rounded-2xl border border-white/40 p-4 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-4">
          {/* 登录卡永远显示状态，不再被二维码替换：二维码改由悬浮窗承载，
              点「扫码接入」后在原按钮位置之外额外弹出一个悬浮窗显示它。 */}
          <>
            <div className={cn(
              'flex h-12 w-12 shrink-0 items-center justify-center rounded-full',
              login?.bound ? 'bg-teal-500/15 text-teal-700' : 'bg-slate-500/10 text-slate-500',
            )}>
              {login?.bound ? <CircleCheck className="h-6 w-6" /> : <QrCode className="h-6 w-6" />}
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-slate-800">
                {login?.bound ? t('open-platform.loginBoundTitle') : t('open-platform.loginUnboundTitle')}
              </p>
              <p className="mt-0.5 text-xs text-slate-500">
                {login?.bound
                  ? t('open-platform.loginBoundDesc')
                  : t('open-platform.loginUnboundDesc')}
              </p>
              {scanNote ? (
                <p className="mt-1 text-[11px] leading-relaxed text-amber-700">{scanNote}</p>
              ) : null}
              {login?.bound ? (
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-500">
                  {login.appId ? <span className="font-mono">AppID {login.appId}</span> : null}
                  {login.bindIp ? (
                    <span className="inline-flex items-center gap-1">
                      <ShieldCheck className="h-3 w-3 text-emerald-600" />
                      {login.bindIp}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
          </>
        </div>

        {/* 手机：一行两个等宽铺满；电脑：竖向堆叠、贴卡片右缘并垂直居中 */}
        <div className="grid w-full shrink-0 grid-cols-2 gap-2 sm:w-auto sm:grid-cols-1">
          {qrDataUrl ? (
            /* 二维码已在悬浮窗里：这里只留「继续扫码」把它重新呼出来（关窗不取消扫码） */
            <Button
              size="sm"
              className="col-span-2 w-full sm:col-span-1"
              onClick={() => setQrOpen(true)}
            >
              <QrCode className="h-4 w-4" />
              {t('open-platform.continueScanBtn')}
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={qrLoading}
              className="col-span-2 w-full sm:col-span-1"
              onClick={() => void loadQr()}
            >
              {qrLoading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <QrCode className="h-4 w-4" />}
              {t('open-platform.scanConnectBtn')}
            </Button>
          )}
        </div>
      </div>

      {/* 统计概览：始终横向铺满，三等分居中 */}
      <div data-tour="op-stats" className="kk-glass kk-stagger-item kk-stagger-2 grid w-full grid-cols-3 divide-x divide-white/40 rounded-2xl border border-white/40 px-2 py-4">
        <div className="flex flex-col items-center justify-center gap-1 px-1 text-center">
          <span className="flex items-center gap-1 text-[11px] text-slate-500"><Bot className="h-3.5 w-3.5" />{t('open-platform.statBots')}</span>
          <span className="text-2xl font-semibold tabular-nums text-slate-800">{accounts.length}</span>
        </div>
        <div className="flex flex-col items-center justify-center gap-1 px-1 text-center">
          <span className="flex items-center gap-1 text-[11px] text-slate-500"><Radio className="h-3.5 w-3.5" />{t('open-platform.statConnected')}</span>
          <span className="text-2xl font-semibold tabular-nums text-emerald-600">{connectedCount}</span>
        </div>
        <div className="flex flex-col items-center justify-center gap-1 px-1 text-center">
          <span className="flex items-center gap-1 text-[11px] text-slate-500"><Activity className="h-3.5 w-3.5" />{t('open-platform.statDauToday')}</span>
          <span className="text-2xl font-semibold tabular-nums text-teal-700">{totalDauToday}</span>
        </div>
      </div>

      {/* 账号列表 */}
      <div className="flex shrink-0 items-center justify-between gap-2">
        <p className="text-xs text-slate-500">
          {t('open-platform.accountsSummary', { count: accounts.length })}{accounts.some((a) => a.pending) ? t('open-platform.includingPending') : ''}
        </p>
        <Button variant="outline" size="sm" data-tour="op-add" onClick={() => openAdd()}>
          <Plus className="h-4 w-4" /> {t('open-platform.addAccountBtn')}
        </Button>
      </div>

      {loading ? (
        <div className="kk-glass flex flex-1 items-center justify-center rounded-2xl border border-white/40 py-16 text-sm text-slate-500">
          {t('open-platform.loading')}
        </div>
      ) : accounts.length === 0 ? (
        <div className="kk-glass kk-stagger-item kk-stagger-3 flex flex-1 flex-col items-center justify-center gap-3 rounded-2xl border border-white/40 border-dashed py-16">
          <Bot className="h-10 w-10 text-slate-300" />
          <p className="text-sm text-slate-500">{t('open-platform.noAccounts')}</p>
          <p className="max-w-md text-center text-[11px] leading-relaxed text-slate-400">
            {t('open-platform.emptyHint')}
          </p>
          <Button size="sm" onClick={() => openAdd()}>
            <Plus className="h-4 w-4" /> {t('open-platform.registerOrConnectBtn')}
          </Button>
        </div>
      ) : (
        <div data-tour="op-list" className="grid grid-cols-1 items-start gap-3 md:grid-cols-2 xl:grid-cols-3">
          {accounts.map((account, i) => (
            <div key={account.id} className={cn('kk-stagger-item', `kk-stagger-${Math.min(i + 1, 4)}`)}>
              <AccountCard account={account} onClick={() => openDetail(account)} />
            </div>
          ))}
        </div>
      )}

      {/* 账号详情弹窗 */}
      <Dialog open={!!selected} onOpenChange={(v) => !v && setSelected(null)}>
        <DialogContent data-tour="op-detail" className="max-h-[85vh]">
          {selected && (
            <>
              <DialogHeader className="pr-6 text-left">
                <div className="flex items-center gap-4">
                  {selected.avatar ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={selected.avatar} alt="" referrerPolicy="no-referrer" className="h-16 w-16 shrink-0 rounded-2xl bg-black/5 object-cover ring-1 ring-black/5" />
                  ) : (
                    <div className={cn(
                      'flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl ring-1 ring-black/5',
                      selected.pending ? 'bg-slate-500/10 text-slate-400' : 'bg-teal-500/15 text-teal-700',
                    )}>
                      {selected.pending ? <KeyRound className="h-8 w-8" /> : <Bot className="h-8 w-8" />}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <DialogTitle className="flex min-w-0 items-baseline gap-1.5 text-lg leading-tight">
                      <span className="truncate">
                        {selected.username || selected.name || (selected.pending ? t('open-platform.unnamedAccount') : t('open-platform.unnamedBot'))}
                      </span>
                      {selected.appId ? (
                        <span className="shrink-0 text-sm font-normal text-slate-400">（{selected.appId}）</span>
                      ) : null}
                    </DialogTitle>
                    <DialogDescription className="mt-1 text-[11px]">
                      {selected.pending
                        ? t('open-platform.detailPendingDesc')
                        : `${selected.sandbox ? t('open-platform.sandboxEnv') : t('open-platform.officialEnv')} · ${selected.mode === 'https' ? 'HTTPS Webhook' : t('open-platform.websocketGateway')}`}
                    </DialogDescription>
                  </div>
                </div>
              </DialogHeader>

              <div className="flex min-h-0 flex-col gap-4 overflow-y-auto no-scrollbar">
                {/* 连接状态 */}
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className={cn('inline-flex items-center gap-1 rounded-full px-2.5 py-1 font-medium',
                    selected.pending
                      ? 'bg-slate-500/10 text-slate-600'
                      : selected.connected ? 'bg-emerald-500/15 text-emerald-700' : 'bg-slate-500/10 text-slate-500')}>
                    {selected.pending
                      ? <KeyRound className="h-3.5 w-3.5" />
                      : selected.connected ? <CircleCheck className="h-3.5 w-3.5" /> : <CircleX className="h-3.5 w-3.5" />}
                    {selected.pending ? t('open-platform.badgeNotConnected') : selected.connected ? t('open-platform.statusConnected') : selected.enable ? t('open-platform.statusDisconnected') : t('open-platform.statusDisabled')}
                  </span>
                </div>

                {selected.pending ? (
                  <div className="rounded-xl border border-white/30 bg-white/15 p-3 text-xs leading-relaxed text-slate-600">
                    {t('open-platform.pendingDetailNote')}
                  </div>
                ) : (
                  <>
                    {/* 日活 */}
                    {selected.dau ? (
                      <div data-tour="op-detail-dau" className="rounded-xl border border-white/30 bg-white/15 p-3">
                        <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-slate-600">
                          <TrendingUp className="h-3.5 w-3.5" /> {t('open-platform.dauTitle')}
                        </div>
                        <div className="mb-3 grid grid-cols-4 gap-2">
                          <StatPill label={t('open-platform.dauToday')} value={selected.dau.today} accent />
                          <StatPill label={t('open-platform.dauYesterday')} value={selected.dau.yesterday} />
                          <StatPill label={t('open-platform.dau7d')} value={selected.dau.last7d} />
                          <StatPill label={t('open-platform.dauTotal')} value={selected.dau.total} />
                        </div>
                        <DauChart daily={selected.dau.daily} />
                      </div>
                    ) : (
                      <p className="rounded-xl border border-white/30 bg-white/15 p-3 text-xs text-slate-500">
                        {t('open-platform.noDau')}
                      </p>
                    )}

                    {/* 官方接口数据 */}
                    <div data-tour="op-detail-insight" className="rounded-xl border border-white/30 bg-white/15 p-3">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 text-xs font-medium text-slate-600">
                          <Globe className="h-3.5 w-3.5" /> {t('open-platform.officialApiData')}
                        </div>
                        <button
                          type="button"
                          className="text-[11px] text-teal-700 hover:text-teal-800 disabled:opacity-50"
                          disabled={insightLoading || busy}
                          onClick={() => void loadInsight(selected.id)}
                        >
                          {insightLoading ? t('open-platform.fetching') : t('open-platform.refetch')}
                        </button>
                      </div>

                      {insightLoading && !insight ? (
                        <p className="text-xs text-slate-500">{t('open-platform.fetchingFrom')}</p>
                      ) : insight && !insight.ok ? (
                        <p className="text-xs text-rose-600">{insight.message}</p>
                      ) : insight?.profile ? (
                        <div className="flex flex-col gap-3">
                          <div className="flex items-center gap-3">
                            {insight.profile.avatar ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={insight.profile.avatar} alt="" referrerPolicy="no-referrer" className="h-10 w-10 rounded-lg bg-black/5 object-cover" />
                            ) : null}
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium text-slate-800">{insight.profile.username}</p>
                              <p className="truncate text-[11px] text-slate-500">
                                ID {insight.profile.id || '—'}
                                {insight.tokenExpiresIn ? ` · Token ${Math.round(insight.tokenExpiresIn / 60)} ${t('open-platform.minutes')}` : ''}
                              </p>
                            </div>
                          </div>
                          {insight.profile.desc ? (
                            <p className="text-[11px] leading-relaxed text-slate-500">{insight.profile.desc}</p>
                          ) : null}
                          {insight.gatewayUrl ? (
                            <div className="rounded-lg bg-white/10 p-2">
                              <div className="mb-0.5 text-[10px] text-slate-400">{t('open-platform.wssGateway')}</div>
                              <div className="break-all font-mono text-[11px] text-slate-700">{insight.gatewayUrl}</div>
                            </div>
                          ) : null}
                        </div>
                      ) : (
                        <p className="text-xs text-slate-500">{t('open-platform.noSecret')}</p>
                      )}

                      {insight?.guilds && insight.guilds.length > 0 ? (
                        <div className="mt-3 flex flex-col gap-1.5">
                          <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
                            <Users className="h-3.5 w-3.5" /> {t('open-platform.guildsIn', { count: insight.guilds.length })}
                          </div>
                          {insight.guilds.map((g) => (
                            <div key={g.id} className="overflow-hidden rounded-lg bg-white/10">
                              <button
                                type="button"
                                className="flex w-full items-center gap-2 px-2.5 py-2 text-left"
                                onClick={() => void toggleGuild(g.id)}
                              >
                                <span className="min-w-0 flex-1 truncate text-[11px] text-slate-700">{g.name || g.id}</span>
                                <span className="shrink-0 text-[10px] text-slate-400">{t('open-platform.memberCount', { count: g.memberCount })}</span>
                                <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform', openGuild === g.id && 'rotate-180')} />
                              </button>
                              {openGuild === g.id ? (
                                <div className="border-t border-white/20 px-2.5 py-2">
                                  {channelsLoading ? (
                                    <p className="text-[10px] text-slate-400">{t('open-platform.loadingChannels')}</p>
                                  ) : channels.length ? (
                                    <div className="flex flex-wrap gap-1.5">
                                      {channels.map((c) => (
                                        <span key={c.id} className="inline-flex items-center gap-1 rounded bg-white/20 px-1.5 py-0.5 text-[10px] text-slate-600">
                                          <Hash className="h-3 w-3" />
                                          {c.name || c.id}
                                          <span className="text-slate-400">{CHANNEL_TYPE_KEY[c.type] ? t(CHANNEL_TYPE_KEY[c.type]) : ''}</span>
                                        </span>
                                      ))}
                                    </div>
                                  ) : (
                                    <p className="text-[10px] text-slate-400">{t('open-platform.noChannels')}</p>
                                  )}
                                </div>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      ) : insight?.guilds ? (
                        <p className="mt-3 text-[11px] text-slate-400">
                          {t('open-platform.noGuilds')}
                        </p>
                      ) : null}
                    </div>

                    {/* 自定义菜单 / 指令面板：各自打开独立窗口配置 */}
                    <div data-tour="op-detail-interactive">
                      <p className="mb-1.5 text-[10px] text-slate-400">{t('open-platform.interactiveConfig')}</p>
                      <BotInteractiveConfig accountId={selected.id} />
                    </div>

                  </>
                )}
              </div>

              <div data-tour="op-detail-actions" className="flex flex-wrap items-center justify-between gap-2 pt-1">
                {selected.pending ? (
                  <Button size="sm" disabled={busy} onClick={() => openAdd(selected)}>
                    <KeyRound className="h-4 w-4" /> {t('open-platform.addSecretAndConnect')}
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => void refreshProfile()}
                  >
                    <RefreshCw className={cn('h-4 w-4', busy && 'animate-spin')} /> {t('open-platform.refreshProfile')}
                  </Button>
                )}
                <div className="flex items-center gap-2">
                  {!selected.pending && (
                    <Button
                      variant={selected.enable ? 'destructive' : 'default'}
                      size="sm"
                      disabled={busy}
                      onClick={() => void toggleAccount()}
                    >
                      <Power className="h-4 w-4" /> {selected.enable ? t('open-platform.disableBtn') : t('open-platform.enableBtn')}
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-rose-600 hover:bg-rose-500/10 hover:text-rose-700"
                    onClick={() => setRemoveTarget(selected)}
                  >
                    <Trash2 className="h-4 w-4" /> {selected.pending ? t('open-platform.removeBtn') : t('open-platform.deleteBtn')}
                  </Button>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* 添加 / 接入账号 */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{addAppId ? t('open-platform.addTitleConnected') : t('open-platform.addTitle')}</DialogTitle>
            <DialogDescription>
              {t('open-platform.addDesc')}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="op-add-appid">AppID</Label>
              <Input id="op-add-appid" value={addAppId} onChange={(e) => setAddAppId(e.target.value)} placeholder={t('open-platform.appIdPlaceholder')} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="op-add-name">{t('open-platform.nameLabel')}</Label>
              <Input id="op-add-name" value={addName} onChange={(e) => setAddName(e.target.value)} placeholder={t('open-platform.namePlaceholder')} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="op-add-secret">{t('open-platform.secretLabel')}</Label>
              <Input
                id="op-add-secret"
                type="password"
                value={addSecret}
                onChange={(e) => setAddSecret(e.target.value)}
                placeholder={t('open-platform.secretPlaceholder')}
              />
            </div>
            <label className="flex items-center gap-2 text-xs text-slate-600">
              <input type="checkbox" checked={addSandbox} onChange={(e) => setAddSandbox(e.target.checked)} />
              {t('open-platform.useSandbox')}
            </label>
            <Button disabled={busy} onClick={() => void submitAdd()}>
              {busy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              {addSecret.trim() ? t('open-platform.connectBtn') : t('open-platform.registerBtn')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <AlertDialog open={!!removeTarget} onOpenChange={(v) => !v && setRemoveTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{removeTarget?.pending ? t('open-platform.confirmRemovePending') : t('open-platform.confirmDeleteBot')}</AlertDialogTitle>
            <AlertDialogDescription>
              {removeTarget?.pending
                ? t('open-platform.removePendingDesc', { appId: removeTarget?.appId })
                : t('open-platform.deleteBotDesc', { name: removeTarget?.username || removeTarget?.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('open-platform.cancelBtn')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => { e.preventDefault(); void confirmRemove(); }}
            >
              {removeTarget?.pending ? t('open-platform.removeBtn') : t('open-platform.deleteBtn')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/*
        二维码悬浮窗：点「扫码接入」后额外呼出。
        登录卡本身不再被二维码替换（保持显示绑定状态），关窗也不取消扫码 ——
        想再看就点卡上的「继续扫码」。扫码成功 / 失败后 qrDataUrl 清空，这里自动收起。
      */}
      <Dialog open={qrOpen && !!qrDataUrl} onOpenChange={setQrOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-1.5">
              <QrCode className="h-4 w-4 text-teal-700" />
              {t('open-platform.scanTitle')}
            </DialogTitle>
            <DialogDescription>{qrTip || t('open-platform.scanDesc')}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col items-center gap-3">
            {qrDataUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={qrDataUrl}
                alt={t('open-platform.qrAlt')}
                className="h-56 w-56 rounded-xl border border-white/60 bg-white p-2"
              />
            ) : (
              <div className="flex h-56 w-56 items-center justify-center rounded-xl border border-white/60 bg-white/60">
                <RefreshCw className="h-6 w-6 animate-spin text-teal-600" />
              </div>
            )}
            <p className="text-center text-[11px] leading-relaxed text-slate-400">
              {t('open-platform.scanNote')}
            </p>
            <div className="flex w-full items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="flex-1"
                disabled={qrLoading}
                onClick={() => void loadQr()}
              >
                <RefreshCw className={cn('h-4 w-4', qrLoading && 'animate-spin')} />
                {t('open-platform.refreshBtn')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="flex-1"
                onClick={() => { cancelQr(); setQrOpen(false); }}
              >
                {t('open-platform.cancelBtn')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
