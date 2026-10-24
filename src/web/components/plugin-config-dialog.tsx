import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import type { ConfigSchemaItem, PluginItem } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { errText } from '@/lib/server-error';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

const btnBase =
  'inline-flex h-9 min-w-[4.25rem] flex-1 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-medium transition-all duration-200 disabled:pointer-events-none disabled:opacity-50 sm:flex-none sm:min-w-[5rem] sm:px-4';

const btnGhost =
  'border border-white/30 bg-white/20 text-slate-700 backdrop-blur-sm hover:bg-white/40';

const btnSave =
  'border border-white/30 bg-teal-500/80 text-white shadow-md kk-glow backdrop-blur-sm hover:bg-teal-500/90';

const btnDanger =
  'border border-white/30 bg-red-500/80 text-white shadow-md kk-glow-red backdrop-blur-sm hover:bg-red-500/90';

export function PluginConfigDialog({
  plugin,
  open,
  onClose,
  onReload,
  /** 传入时：卸载仅删本连接 plugins_two 副本，不影响 plugins/ */
  connectionId,
}: {
  plugin: PluginItem | null;
  open: boolean;
  onClose: () => void;
  onReload: () => void;
  connectionId?: string;
}) {
  const pluginId = plugin?.id ?? null;
  const scopedToConnection = Boolean(connectionId);
  const [schema, setSchema] = useState<ConfigSchemaItem[]>([]);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [uninstallOpen, setUninstallOpen] = useState(false);
  const t = useT();

  useEffect(() => {
    if (!open || !pluginId) return;
    setLoading(true);
    api.plugins
      .getConfig(pluginId)
      .then((res) => {
        setSchema(res.data.schema.filter((i) => !i.key.startsWith('_') && !i.hidden));
        setValues(res.data.config || {});
      })
      .finally(() => setLoading(false));
  }, [open, pluginId]);

  const setField = (key: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  const onSave = async () => {
    if (!pluginId || schema.length === 0) return;
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {};
      for (const item of schema) {
        if (item.type === 'html' || item.type === 'text') continue;
        payload[item.key] = values[item.key];
      }
      await api.plugins.saveConfig(pluginId, payload);
      toast.success(t('plugins.cfg.saved'));
      onClose();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setSaving(false);
    }
  };

  const onReloadPlugin = async () => {
    if (!pluginId) return;
    setReloading(true);
    try {
      await api.plugins.reload(pluginId);
      toast.success(t('plugins.cfg.reloaded'));
      onReload();
    } finally {
      setReloading(false);
    }
  };

  const uninstall = async (cleanData: boolean) => {
    if (!pluginId) return;
    try {
      if (scopedToConnection && connectionId) {
        await api.plugins.removeConnectionRuntime(connectionId, pluginId, cleanData);
        toast.success(cleanData ? t('plugins.cfg.removedRuntimeClean') : t('plugins.cfg.removedRuntime'));
      } else {
        await api.plugins.uninstall(pluginId, cleanData);
        toast.success(t('plugins.cfg.uninstalled'));
      }
      setUninstallOpen(false);
      onClose();
      onReload();
    } catch (e) {
      toast.error(errText(e));
    }
  };

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(v) => {
          if (!v) {
            setSchema([]);
            setValues({});
            onClose();
          }
        }}
      >
        <DialogContent className="flex max-h-[min(85dvh,100dvh-2rem)] max-w-md flex-col gap-0 overflow-hidden p-0 landscape:max-w-2xl landscape:sm:max-w-3xl">
          <DialogHeader className="shrink-0 space-y-0 p-5 pb-3 pr-12 text-left">
            <DialogTitle>{t('plugins.cfg.title', { name: plugin?.name ?? '' })}</DialogTitle>
            <DialogDescription>
              {[plugin?.author, plugin?.version ? `v${plugin.version}` : null, plugin?.id]
                .filter(Boolean)
                .join(' · ')}
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-1 no-scrollbar">
            {loading ? (
              <div className="flex justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
              </div>
            ) : schema.length === 0 ? (
              <p className="py-10 text-center text-sm text-slate-500">{t('plugins.cfg.noConfig')}</p>
            ) : (
              <div className="flex flex-col gap-4 pb-3 pt-1 landscape:mx-auto landscape:max-w-xl landscape:sm:max-w-2xl">
                {schema.map((item) => {
                  if (item.type === 'html' || item.type === 'text') {
                    return (
                      <p key={item.key} className="text-sm text-slate-500">
                        {item.label}
                      </p>
                    );
                  }
                  if (item.type === 'boolean') {
                    return (
                      <div
                        key={item.key}
                        className="flex items-center justify-between gap-4 rounded-xl border border-white/25 bg-white/10 px-3.5 py-3 backdrop-blur-sm"
                      >
                        <Label className="mb-0">{item.label || item.key}</Label>
                        <Switch
                          checked={!!values[item.key]}
                          onCheckedChange={(v) => setField(item.key, v)}
                        />
                      </div>
                    );
                  }
                  if (item.type === 'number') {
                    return (
                      <div key={item.key} className="flex flex-col gap-1.5">
                        <Label>{item.label || item.key}</Label>
                        <Input
                          type="number"
                          value={values[item.key] === undefined || values[item.key] === null ? '' : String(values[item.key])}
                          placeholder={item.placeholder}
                          onChange={(e) => setField(item.key, e.target.value === '' ? undefined : Number(e.target.value))}
                        />
                      </div>
                    );
                  }
                  if (item.type === 'select' && item.options?.length) {
                    return (
                      <div key={item.key} className="flex flex-col gap-1.5">
                        <Label>{item.label || item.key}</Label>
                        <Select
                          value={String(values[item.key] ?? '')}
                          onValueChange={(v) => {
                            const opt = item.options?.find((o) => String(o.value) === v);
                            setField(item.key, opt ? opt.value : v);
                          }}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder={t('plugins.cfg.selectPlaceholder')} />
                          </SelectTrigger>
                          <SelectContent>
                            {item.options.map((o) => (
                              <SelectItem key={String(o.value)} value={String(o.value)}>
                                {o.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    );
                  }
                  return (
                    <div key={item.key} className="flex flex-col gap-1.5">
                      <Label>{item.label || item.key}</Label>
                      <Input
                        value={values[item.key] == null ? '' : String(values[item.key])}
                        placeholder={item.placeholder}
                        onChange={(e) => setField(item.key, e.target.value)}
                      />
                      {item.description ? (
                        <p className="text-xs text-slate-500">{item.description}</p>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="flex shrink-0 flex-wrap items-center justify-center gap-3 border-t border-white/30 bg-gradient-to-t from-white/15 to-transparent p-5 pt-4">
            <button
              type="button"
              className={cn(btnBase, btnGhost)}
              onClick={() => void onReloadPlugin()}
              disabled={reloading}
            >
              {reloading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {t('plugins.cfg.reload')}
            </button>
            <button
              type="button"
              className={cn(btnBase, btnDanger)}
              onClick={() => setUninstallOpen(true)}
            >
              {scopedToConnection ? t('plugins.cfg.deleteCopy') : t('plugins.cfg.uninstall')}
            </button>
            <button type="button" className={cn(btnBase, btnGhost)} onClick={onClose}>
              {t('plugins.cancel')}
            </button>
            <button
              type="button"
              className={cn(btnBase, btnSave)}
              onClick={() => void onSave()}
              disabled={saving || loading || schema.length === 0}
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {t('plugins.cfg.save')}
            </button>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={uninstallOpen} onOpenChange={setUninstallOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-slate-800">
              {scopedToConnection ? t('plugins.cfg.deleteCopyTitle') : t('plugins.cfg.uninstallTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-slate-500">
              {scopedToConnection
                ? t('plugins.cfg.deleteCopyDesc', { name: plugin?.name ?? '' })
                : t('plugins.cfg.uninstallDesc', { name: plugin?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-3 sm:gap-3">
            <AlertDialogCancel className={cn(btnBase, btnGhost, 'mt-0')}>{t('plugins.cancel')}</AlertDialogCancel>
            <button type="button" className={cn(btnBase, btnGhost)} onClick={() => void uninstall(false)}>
              {scopedToConnection ? t('plugins.cfg.onlyDeleteCopy') : t('plugins.cfg.onlyUninstall')}
            </button>
            <AlertDialogAction
              className={cn(btnBase, btnDanger)}
              onClick={() => void uninstall(true)}
            >
              {scopedToConnection ? t('plugins.cfg.deleteCopyClear') : t('plugins.cfg.uninstallClear')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
