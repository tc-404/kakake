import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useLang, useT } from '@/lib/i18n';
import { api } from '@/lib/api';
import type { PluginItem } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Copy, CloudUpload, Loader2, Package, Database, AlertTriangle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { errText } from '@/lib/server-error';

type ProviderInfo = {
  id: string;
  name: string;
  host: string;
  maxBytesLabel: string;
  retention: { zh: string; en: string };
  maxBytes: number;
  note?: { zh: string; en: string };
  unavailable?: { zh: string; en: string };
};

type AccountInfo = { key: string; label: string };

type Step = 'provider' | 'mode' | 'accounts' | 'uploading' | 'done' | 'error';

/**
 * 「分享插件」悬浮窗：选上传源 → 选内容（仅插件 / 插件+数据）→（多账号时）选账号 → 上传 → 出链接。
 *
 * 流程与「添加连接」的类型选择弹窗同构：卡片点选即进入下一步；
 * 数据可选性由后端实际探测（data/<账号>/<插件Id> 是否存在）决定，前端只做展示与禁用。
 */
export function PluginShareDialog({
  plugin,
  open,
  onClose,
}: {
  plugin: PluginItem | null;
  open: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const lang = useLang();
  const [step, setStep] = useState<Step>('provider');
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [provider, setProvider] = useState<ProviderInfo | null>(null);
  const [accountChoice, setAccountChoice] = useState<string>('all');
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<{ url: string; retention?: string } | null>(null);
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    if (!open || !plugin) return;
    setStep('provider');
    setProvider(null);
    setResult(null);
    setErrorMsg('');
    setAccountChoice('all');
    setProviders([]);
    setAccounts([]);
    void (async () => {
      try {
        const [p, a] = await Promise.all([
          api.pluginShare.providers(),
          api.pluginShare.accounts(plugin.id),
        ]);
        setProviders(p.providers || []);
        setAccounts(a.accounts || []);
      } catch (e) {
        setErrorMsg(errText(e));
        setStep('error');
      }
    })();
  }, [open, plugin]);

  if (!plugin) return null;

  const hasAnyData = accounts.length > 0;
  const needsAccountPick = accounts.length > 1;

  const pickProvider = (p: ProviderInfo) => {
    setProvider(p);
    setStep('mode');
  };

  const pickMode = (mode: 'plugin' | 'plugin_data') => {
    if (mode === 'plugin_data' && !hasAnyData) return;
    if (mode === 'plugin' || !needsAccountPick) {
      void doUpload(mode, mode === 'plugin_data' ? accounts.map((a) => a.key) : []);
      return;
    }
    setAccountChoice('all');
    setStep('accounts');
  };

  const doUpload = async (mode: 'plugin' | 'plugin_data', keys: string[]) => {
    if (!provider) return;
    setStep('uploading');
    setUploading(true);
    try {
      const r = await api.pluginShare.upload(plugin.id, provider.id, mode, keys);
      setResult({ url: r.url || '', retention: lang === 'en' ? provider.retention.en : provider.retention.zh });
      setStep('done');
    } catch (e) {
      setErrorMsg(errText(e));
      setStep('error');
    } finally {
      setUploading(false);
    }
  };

  const copyLink = async () => {
    if (!result?.url) return;
    try {
      await navigator.clipboard.writeText(result.url);
      toast.success(t('plugins.shareCopied'));
    } catch {
      toast.error(t('plugins.shareCopyFailed'));
    }
  };

  const backToProvider = () => {
    setStep('provider');
    setProvider(null);
    setErrorMsg('');
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (uploading) return;
        if (!v) onClose();
      }}
    >
      <DialogContent
        className="max-w-lg"
        hideClose={uploading}
        onPointerDownOutside={(e: Event) => {
          if (uploading) e.preventDefault();
        }}
        onEscapeKeyDown={(e: KeyboardEvent) => {
          if (uploading) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {step === 'provider' ? t('plugins.shareSelectProvider')
              : step === 'mode' ? t('plugins.shareModeTitle')
                : step === 'accounts' ? t('plugins.shareAccountsTitle')
                  : step === 'uploading' ? t('plugins.shareUploading')
                    : step === 'done' ? t('plugins.shareDone')
                      : t('plugins.shareFailed')}
          </DialogTitle>
          <DialogDescription>
            {step === 'provider' ? t('plugins.shareTitleDesc', { name: plugin.name })
              : step === 'mode' ? t('plugins.shareModeDesc', { name: plugin.name })
                : step === 'accounts' ? t('plugins.shareAccountsDesc')
                  : step === 'done' ? t('plugins.shareDoneDesc')
                    : ''}
          </DialogDescription>
        </DialogHeader>

        {/* 第一步：选上传源（与添加连接的类型选择同构：卡片点选即下一步） */}
        {step === 'provider' ? (
          <div className="grid max-h-[60vh] gap-2 overflow-y-auto no-scrollbar">
            {providers.length === 0 ? (
              <div className="flex items-center justify-center gap-2 py-8 text-sm text-slate-400">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('plugins.shareLoading')}
              </div>
            ) : providers.map((p) => (
              <button
                key={p.id}
                type="button"
                disabled={!!p.unavailable}
                className={cn(
                  'kk-btn-press flex gap-3 rounded-xl bg-white/35 p-3.5 text-left transition-colors',
                  p.unavailable
                    ? 'cursor-not-allowed opacity-50'
                    : 'hover:bg-white/55',
                )}
                onClick={() => { if (!p.unavailable) pickProvider(p); }}
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <CloudUpload className="h-5 w-5" />
                </span>
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{p.name}</span>
                    <span className="rounded-md bg-white/40 px-1.5 py-px text-[10px] font-medium text-slate-500">
                      {t('plugins.shareMaxSize', { size: p.maxBytesLabel })}
                    </span>
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {t('plugins.shareRetention', { retention: lang === 'en' ? p.retention.en : p.retention.zh })}
                  </span>
                  {p.note ? (
                    <span className="mt-0.5 block text-[11px] leading-snug text-amber-700">
                      {lang === 'en' ? p.note.en : p.note.zh}
                    </span>
                  ) : null}
                  {p.unavailable ? (
                    <span className="mt-0.5 block text-[11px] leading-snug text-rose-600">
                      {lang === 'en' ? p.unavailable.en : p.unavailable.zh}
                    </span>
                  ) : null}
                </span>
              </button>
            ))}
          </div>
        ) : null}

        {/* 第二步：仅插件 / 插件+数据，两个等宽对称按钮 */}
        {step === 'mode' ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                className="kk-btn-press flex flex-col items-center gap-2 rounded-xl bg-white/35 p-4 text-center transition-colors hover:bg-white/55"
                onClick={() => pickMode('plugin')}
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-teal-500/15 text-teal-700">
                  <Package className="h-5 w-5" />
                </span>
                <span className="text-sm font-medium text-slate-800">{t('plugins.shareModePluginOnly')}</span>
                <span className="text-[11px] leading-snug text-slate-500">{t('plugins.shareModePluginOnlyDesc')}</span>
              </button>
              <button
                type="button"
                disabled={!hasAnyData}
                className={cn(
                  'kk-btn-press flex flex-col items-center gap-2 rounded-xl bg-white/35 p-4 text-center transition-colors',
                  hasAnyData ? 'hover:bg-white/55' : 'cursor-not-allowed opacity-45',
                )}
                onClick={() => pickMode('plugin_data')}
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-500/15 text-brand-700">
                  <Database className="h-5 w-5" />
                </span>
                <span className="text-sm font-medium text-slate-800">{t('plugins.shareModePluginData')}</span>
                <span className="text-[11px] leading-snug text-slate-500">
                  {hasAnyData ? t('plugins.shareModePluginDataDesc') : t('plugins.shareNoDataHint')}
                </span>
              </button>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={backToProvider}>
                {t('plugins.shareBack')}
              </Button>
            </DialogFooter>
          </div>
        ) : null}

        {/* 第三步：多账号都有数据时，选要携带谁的 */}
        {step === 'accounts' ? (
          <div className="space-y-3">
            <div className="grid max-h-[40vh] gap-2 overflow-y-auto no-scrollbar">
              {accounts.map((a) => (
                <label
                  key={a.key}
                  className={cn(
                    'flex cursor-pointer items-center gap-3 rounded-xl bg-white/35 p-3 transition-colors hover:bg-white/55',
                    accountChoice === a.key && 'ring-2 ring-teal-500/40',
                  )}
                >
                  <input
                    type="radio"
                    name="share-account"
                    className="h-4 w-4 accent-teal-600"
                    checked={accountChoice === a.key}
                    onChange={() => setAccountChoice(a.key)}
                  />
                  <span className="min-w-0 truncate text-sm text-slate-800">{a.label}</span>
                </label>
              ))}
              <label
                className={cn(
                  'flex cursor-pointer items-center gap-3 rounded-xl bg-white/35 p-3 transition-colors hover:bg-white/55',
                  accountChoice === 'all' && 'ring-2 ring-teal-500/40',
                )}
              >
                <input
                  type="radio"
                  name="share-account"
                  className="h-4 w-4 accent-teal-600"
                  checked={accountChoice === 'all'}
                  onChange={() => setAccountChoice('all')}
                />
                <span className="text-sm font-medium text-slate-800">{t('plugins.shareAccountsAll')}</span>
              </label>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={backToProvider}>
                {t('plugins.shareBack')}
              </Button>
              <Button
                type="button"
                onClick={() => {
                  const keys = accountChoice === 'all'
                    ? accounts.map((a) => a.key)
                    : accounts.filter((a) => a.key === accountChoice).map((a) => a.key);
                  void doUpload('plugin_data', keys);
                }}
              >
                {t('plugins.shareConfirm')}
              </Button>
            </DialogFooter>
          </div>
        ) : null}

        {step === 'uploading' ? (
          <div className="flex flex-col items-center gap-3 py-10">
            <Loader2 className="h-7 w-7 animate-spin text-teal-600" />
            <p className="text-sm text-slate-500">{t('plugins.shareUploadingHint', { name: provider?.name || '' })}</p>
          </div>
        ) : null}

        {step === 'done' && result ? (
          <div className="space-y-3">
            <div className="break-all rounded-xl border border-teal-300/50 bg-teal-400/10 p-3 font-mono text-xs text-teal-800">
              {result.url}
            </div>
            <p className="text-xs text-slate-500">{t('plugins.shareRetentionNote', { retention: result.retention || '' })}</p>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => void copyLink()}>
                <Copy className="h-4 w-4" />
                {t('plugins.shareCopy')}
              </Button>
              <Button type="button" onClick={onClose}>
                {t('plugins.finish')}
              </Button>
            </DialogFooter>
          </div>
        ) : null}

        {step === 'error' ? (
          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-xl border border-rose-300/50 bg-rose-400/10 p-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-500" />
              <p className="break-words text-sm text-rose-700">{errorMsg || t('plugins.shareFailed')}</p>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                {t('plugins.cancel')}
              </Button>
              <Button type="button" onClick={backToProvider}>
                {t('plugins.shareRetry')}
              </Button>
            </DialogFooter>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
