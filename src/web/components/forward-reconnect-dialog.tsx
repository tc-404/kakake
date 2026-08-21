import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { ConnectionStatus } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
      toast.success('重连设置已保存');
      onSaved?.();
      onClose();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSaving(false);
    }
  };

  const attempts = conn?.reconnectAttempts ?? 0;
  const attemptHint =
    (conn?.reconnectMaxAttempts ?? 15) > 0
      ? `已重试 ${attempts}/${conn?.reconnectMaxAttempts ?? 15} 次`
      : `已重试 ${attempts} 次（无限重试）`;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {conn?.mode === 'http_client' ? 'HTTP 客户端' : '正向 WS'} · {conn?.name ?? ''}
          </DialogTitle>
          <DialogDescription>
            意外断开时自动重连；关闭连接开关或手动停止后不再重连。
          </DialogDescription>
        </DialogHeader>

        {conn?.reconnectAbandoned && (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            已达最大重连次数，自动重连已停止。调整设置后保存可重新开始。
          </div>
        )}

        {conn && conn.enable && !conn.connected && (
          <div className="rounded-md border bg-muted/50 px-3 py-2 text-sm">
            {conn.reconnecting ? '正在重连…' : '未连接'} — {attemptHint}
          </div>
        )}

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="interval">重连间隔（毫秒）</Label>
            <Input
              id="interval"
              type="number"
              min={500}
              max={600000}
              value={intervalMs}
              onChange={(e) => setIntervalMs(Number(e.target.value) || 5000)}
            />
            <p className="text-xs text-muted-foreground">最小 500ms</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="max">最大重试次数</Label>
            <Input
              id="max"
              type="number"
              min={0}
              max={9999}
              value={maxAttempts}
              onChange={(e) => setMaxAttempts(Number(e.target.value) || 0)}
            />
            <p className="text-xs text-muted-foreground">0 表示无限重试</p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={onSave} disabled={saving}>
            保存并应用
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
