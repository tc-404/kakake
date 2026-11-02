import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { ConnectionStatus } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useT } from '@/lib/i18n';
import { errText } from '@/lib/server-error';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export function ForwardReconnectDialog({
  open,
  conn,
  onClose,
  onSaved,
}: {
  open: boolean;
  conn: ConnectionStatus | null;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const t = useT();
  const [intervalMs, setIntervalMs] = useState(5000);
  const [maxAttempts, setMaxAttempts] = useState(0);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !conn) return;
    setIntervalMs(conn.reconnectIntervalMs ?? 5000);
    setMaxAttempts(conn.reconnectMaxAttempts ?? 15);
    // 只在打开或切换连接时灌表单；SSE 刷新不能覆盖正在编辑的值
    // eslint-disable-next-line react-hooks/exhaustive-deps -- conn 快照仅用于初始化
  }, [open, conn?.id]);

  const onSave = async () => {
    if (!conn) return;
    setSaving(true);
    try {
      await api.connections.updateForwardReconnect(conn.id, {
        reconnectIntervalMs: Math.max(500, intervalMs),
        reconnectMaxAttempts: Math.max(0, maxAttempts),
        resetReconnect: conn.enable,
      });
      toast.success(t('components.reconnectSaved'));
      onSaved?.();
      onClose();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setSaving(false);
    }
  };

  const attempts = conn?.reconnectAttempts ?? 0;
  const attemptHint =
    (conn?.reconnectMaxAttempts ?? 15) > 0
      ? t('connections.retryCount', { n: attempts, max: conn?.reconnectMaxAttempts ?? 15 })
      : t('connections.retryCountInfinite', { n: attempts });

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {conn?.mode === 'http_client' ? t('connections.modeHttpClient') : t('connections.modeForwardWs')} · {conn?.name ?? ''}
          </DialogTitle>
          <DialogDescription>
            {t('components.reconnectDesc')}
          </DialogDescription>
        </DialogHeader>

        {conn?.reconnectAbandoned && (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            {t('components.reconnectAbandoned')}
          </div>
        )}

        {conn && conn.enable && !conn.connected && (
          <div className="rounded-md border bg-muted/50 px-3 py-2 text-sm">
            {conn.reconnecting ? t('components.reconnecting') : t('components.notConnected')} — {attemptHint}
          </div>
        )}

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="interval">{t('components.reconnectIntervalLabel')}</Label>
            <Input
              id="interval"
              type="number"
              min={500}
              max={600000}
              value={intervalMs}
              onChange={(e) => setIntervalMs(Number(e.target.value) || 5000)}
            />
            <p className="text-xs text-muted-foreground">{t('components.reconnectMin')}</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="max">{t('components.reconnectMaxLabel')}</Label>
            <Input
              id="max"
              type="number"
              min={0}
              max={9999}
              value={maxAttempts}
              onChange={(e) => setMaxAttempts(Number(e.target.value) || 0)}
            />
            <p className="text-xs text-muted-foreground">{t('components.reconnectInfinite')}</p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('btn.cancel')}
          </Button>
          <Button onClick={onSave} disabled={saving}>
            {t('btn.saveAndApply')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
