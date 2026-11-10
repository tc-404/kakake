import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { useT } from '@/lib/i18n';
import { api } from '@/lib/api';
import type { PluginItem } from '@/lib/types';
import { errText } from '@/lib/server-error';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

const ERROR_KEYS: Record<string, string> = {
  NAME_EMPTY: 'plugins.meta.errNameEmpty',
  NAME_INVALID: 'plugins.meta.errNameInvalid',
  NAME_RESERVED: 'plugins.meta.errNameReserved',
  NAME_TOO_LONG: 'plugins.meta.errNameTooLong',
  NAME_CONFLICT: 'plugins.meta.errNameConflict',
  KIND_MISMATCH: 'plugins.meta.errKindMismatch',
  META_INVALID: 'plugins.meta.errNameInvalid',
  PLUGIN_META_MASTER_ON: 'plugins.meta.errBusy',
  PLUGIN_META_RUNNING: 'plugins.meta.errBusy',
  PLUGIN_META_MANIFEST_INVALID: 'plugins.meta.errManifestInvalid',
  PLUGIN_META_IO_DENIED: 'plugins.meta.errWrite',
  PLUGIN_META_WRITE_FAILED: 'plugins.meta.errWrite',
  PLUGIN_META_RESCAN_FAILED: 'plugins.meta.errWrite',
  PLUGIN_META_ROLLBACK_INCOMPLETE: 'plugins.meta.errWrite',
  PLUGIN_META_NOT_FOUND: 'plugins.meta.errNotFound',
  PLUGIN_META_DIR_MISSING: 'plugins.meta.errNotFound',
};

export function PluginMetaDialog({
  plugin,
  open,
  onClose,
  onSaved,
}: {
  plugin: PluginItem | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [version, setVersion] = useState('');
  const [author, setAuthor] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !plugin) return;
    setName(plugin.id);
    setDisplayName(plugin.name || '');
    setVersion(plugin.version || '');
    setAuthor(typeof plugin.author === 'string' ? plugin.author : '');
    setSaving(false);
    setLoading(true);
    let cancelled = false;
    void (async () => {
      let meta: { name: string; displayName: string; version: string; author: string } | null = null;
      try {
        const res = await api.plugins.getMeta(plugin.id);
        if (res.ok && res.meta) meta = res.meta;
      } catch {
        meta = null;
      }
      if (cancelled) return;
      if (meta) {
        setName(meta.name);
        setDisplayName(meta.displayName);
        setVersion(meta.version);
        setAuthor(meta.author);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, plugin?.id]);

  const onSave = async () => {
    if (!plugin || saving || loading) return;
    const nextName = name.trim();
    if (!nextName) {
      toast.error(t('plugins.meta.errNameEmpty'));
      return;
    }
    setSaving(true);
    try {
      const res = await api.plugins.updateMeta(plugin.id, {
        name: nextName,
        displayName: displayName.trim(),
        version: version.trim(),
        author: author.trim(),
      });
      if (!res.ok) {
        const key = ERROR_KEYS[String(res.code || '')];
        toast.error(key ? t(key) : res.message || t('plugins.meta.failed'));
        return;
      }
      toast.success(t('plugins.meta.saved', { name: res.pluginId || nextName }));
      onClose();
      onSaved();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setSaving(false);
    }
  };

  const submitOnEnter = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void onSave();
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !saving) onClose();
      }}
    >
      <DialogContent
        className="max-w-sm"
        hideClose={saving}
        onEscapeKeyDown={(event) => {
          if (saving) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (saving) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('plugins.meta.title')}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="plugin-meta-name">{t('plugins.meta.name')}</Label>
            <Input
              id="plugin-meta-name"
              autoFocus
              value={name}
              disabled={loading || saving}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={submitOnEnter}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="plugin-meta-display-name">{t('plugins.meta.displayName')}</Label>
            <Input
              id="plugin-meta-display-name"
              value={displayName}
              disabled={loading || saving}
              onChange={(e) => setDisplayName(e.target.value)}
              onKeyDown={submitOnEnter}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="plugin-meta-version">{t('plugins.meta.version')}</Label>
            <Input
              id="plugin-meta-version"
              value={version}
              disabled={loading || saving}
              onChange={(e) => setVersion(e.target.value)}
              onKeyDown={submitOnEnter}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="plugin-meta-author">{t('plugins.meta.author')}</Label>
            <Input
              id="plugin-meta-author"
              value={author}
              disabled={loading || saving}
              onChange={(e) => setAuthor(e.target.value)}
              onKeyDown={submitOnEnter}
            />
          </div>
        </div>
        <DialogFooter className="flex-row justify-end gap-2 pt-1">
          <Button variant="outline" size="sm" disabled={saving} onClick={onClose}>
            {t('btn.cancel')}
          </Button>
          <Button size="sm" disabled={saving || loading} onClick={() => void onSave()}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : t('btn.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
