import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { PluginManagePanel } from '@/components/plugin-manage-panel';
import type { ConnectionType } from '@/lib/types';
import { useT } from '@/lib/i18n';

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
  const t = useT();
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[min(85dvh,100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {connectionType === 'qq_official'
              ? t('components.connPluginsGf')
              : connectionType === 'weixin_bot'
                ? t('components.connPluginsWeixin')
                : connectionType === 'kook'
                  ? t('components.connPluginsKook')
                  : t('components.connPluginsDefault')}
            {' '}· {connectionName}
          </DialogTitle>
        </DialogHeader>
        {connectionId ? <PluginManagePanel connectionId={connectionId} /> : null}
      </DialogContent>
    </Dialog>
  );
}
