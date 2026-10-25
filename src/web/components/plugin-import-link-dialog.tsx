import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useT } from '@/lib/i18n';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Link, Loader2, Package, Database, AlertTriangle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { errText } from '@/lib/server-error';

type ImportResult = {
  ok: boolean;
  pluginId?: string;
  kind?: string;
  name?: string;
  hasData?: boolean;
  accounts?: string[];
  token?: string;
};

type Step = 'input' | 'working' | 'askData' | 'done' | 'error';

/**
 * 「从链接安装插件」悬浮窗：粘贴分享链接或任意插件包直链 → 后端下载并自动识别。
 *
 * 后端会先把插件本体装好；包内若带 data.zip（分享包特有），先暂存并返回 token，
 * 这里再问一次「是否连数据一起导入」——数据来自别人的账号目录，落不落盘由使用者决定。
 */
export function PluginImportLinkDialog({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  onImported: () => void;
}) {
  const t = useT();
  const [step, setStep] = useState<Step>('input');
  const [text, setText] = useState('');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    if (!open) return;
    setStep('input');
    setText('');
    setResult(null);
    setErrorMsg('');
  }, [open]);

  const startImport = async () => {
    if (!text.trim()) return;
    setStep('working');
    try {
      const r = await api.pluginShare.importFromText(text);
      setResult(r);
      if (r.hasData && r.token) {
        setStep('askData');
      } else {
        setStep('done');
        toast.success(t('plugins.importLinkDone', { name: r.name || r.pluginId || '' }));
        onImported();
      }
    } catch (e) {
      setErrorMsg(errText(e));
      setStep('error');
    }
  };

  const importData = async (withData: boolean) => {
    const token = result?.token;
    if (!withData || !token) {
      setStep('done');
      toast.success(t('plugins.importLinkDone', { name: result?.name || result?.pluginId || '' }));
      onImported();
      return;
    }
    setStep('working');
    try {
      const r = await api.pluginShare.importData(token);
      setStep('done');
      if (r.failed?.length) {
        toast.warning(t('plugins.importLinkDataPartial', { n: r.failed.length }));
      } else {
        toast.success(t('plugins.importLinkDoneWithData', { name: result?.name || result?.pluginId || '' }));
      }
      onImported();
    } catch (e) {
      // 插件本体已经装好了，数据失败只提示、不算失败
      toast.error(errText(e));
      setStep('done');
      onImported();
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {step === 'askData' ? t('plugins.importLinkDataTitle') : t('plugins.importLinkTitle')}
          </DialogTitle>
          <DialogDescription>
            {step === 'askData'
              ? t('plugins.importLinkDataDesc', {
                accounts: (result?.accounts || []).join('、') || '?',
              })
              : t('plugins.importLinkDesc')}
          </DialogDescription>
        </DialogHeader>

        {step === 'input' || step === 'working' ? (
          <div className="space-y-3">
            <div className="relative">
              <Link className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && step === 'input' && text.trim()) void startImport();
                }}
                disabled={step === 'working'}
                placeholder={t('plugins.importLinkPlaceholder')}
                autoFocus
                className="h-10 w-full rounded-xl pl-9 pr-3 text-sm text-slate-800 outline-none placeholder:text-slate-400 bg-white/35 focus:border-teal-400/50 focus:bg-white/30 focus:ring-2 focus:ring-teal-500/15"
              />
            </div>
            {step === 'working' ? (
              <div className="flex items-center gap-2 py-2 text-sm text-slate-500">
                <Loader2 className="h-4 w-4 animate-spin text-teal-600" />
                {t('plugins.importLinkWorking')}
              </div>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={step === 'working'} onClick={onClose}>
                {t('plugins.cancel')}
              </Button>
              <Button
                type="button"
                disabled={step === 'working' || !text.trim()}
                onClick={() => void startImport()}
              >
                {step === 'working' ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {t('plugins.importLinkGo')}
              </Button>
            </DialogFooter>
          </div>
        ) : null}

        {step === 'askData' ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                className="kk-btn-press flex flex-col items-center gap-2 rounded-xl bg-white/35 p-4 text-center transition-colors hover:bg-white/55"
                onClick={() => void importData(false)}
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-teal-500/15 text-teal-700">
                  <Package className="h-5 w-5" />
                </span>
                <span className="text-sm font-medium text-slate-800">{t('plugins.importLinkOnly')}</span>
              </button>
              <button
                type="button"
                className="kk-btn-press flex flex-col items-center gap-2 rounded-xl bg-white/35 p-4 text-center transition-colors hover:bg-white/55"
                onClick={() => void importData(true)}
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-sky-500/15 text-sky-700">
                  <Database className="h-5 w-5" />
                </span>
                <span className="text-sm font-medium text-slate-800">{t('plugins.importLinkWithData')}</span>
              </button>
            </div>
          </div>
        ) : null}

        {step === 'done' ? (
          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-xl border border-teal-300/50 bg-teal-400/10 p-3">
              <Package className="mt-0.5 h-4 w-4 shrink-0 text-teal-600" />
              <p className="break-words text-sm text-teal-800">
                {t('plugins.importLinkDoneDetail', {
                  name: result?.name || result?.pluginId || '',
                  id: result?.pluginId || '',
                })}
              </p>
            </div>
            <DialogFooter>
              <Button type="button" onClick={onClose}>
                {t('plugins.finish')}
              </Button>
            </DialogFooter>
          </div>
        ) : null}

        {step === 'error' ? (
          <div className="space-y-3">
            <div className={cn('flex items-start gap-2 rounded-xl border border-rose-300/50 bg-rose-400/10 p-3')}>
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-500" />
              <p className="break-words text-sm text-rose-700">{errorMsg || t('plugins.importLinkFailed')}</p>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                {t('plugins.cancel')}
              </Button>
              <Button type="button" onClick={() => setStep('input')}>
                {t('plugins.shareRetry')}
              </Button>
            </DialogFooter>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
