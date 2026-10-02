import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { PluginManagePanel } from '@/components/plugin-manage-panel';
import type { ConnectionType } from '@/lib/types';

export function ConnectionPluginsDialog({
  open,
  connectionId,
  connectionName,
  connectionType,
  onClose,
}: {
  open: boolean;
  connectionId: string;
  connectionName: string;
  connectionType?: ConnectionType;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[min(85dvh,100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {connectionType === 'qq_official'
              ? 'GF 插件'
              : connectionType === 'weixin_bot'
                ? '微信插件'
                : connectionType === 'kook'
                  ? 'KOOK 插件'
                  : '插件'}
            {' '}· {connectionName}
          </DialogTitle>
        </DialogHeader>
        {connectionId ? <PluginManagePanel connectionId={connectionId} /> : null}
      </DialogContent>
    </Dialog>
  );
}
