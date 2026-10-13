import { useEffect, useState } from 'react';
import { MarkdownContent } from '@/components/markdown-content';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { PluginItem } from '@/lib/types';
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export function PluginDocsDialog({
  plugin,
  open,
  onClose,
}: {
  plugin: PluginItem | null;
  open: boolean;
  onClose: () => void;
}) {
  const pluginId = plugin?.id ?? null;
  const [markdown, setMarkdown] = useState('');
  const [title, setTitle] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !pluginId) return;
    let cancelled = false;
    setLoading(true);
    setMarkdown('');
    setTitle(plugin?.name || pluginId);
    api.plugins
      .getDocs(pluginId)
      .then((res) => {
        if (cancelled) return;
        if (!res.ok || !res.markdown) {
          toast.error(res.message || '无法加载说明文档');
          onClose();
          return;
        }
        setMarkdown(res.markdown);
        if (res.name) setTitle(res.name);
      })
      .catch((e) => {
        if (cancelled) return;
        toast.error(String(e));
        onClose();
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only refetch when dialog opens for a plugin
  }, [open, pluginId]);

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          setMarkdown('');
          onClose();
        }
      }}
    >
      <DialogContent
        className={cn(
          'flex max-h-[min(88dvh,100dvh-2rem)] w-[min(100vw-1.5rem,48rem)] max-w-3xl flex-col gap-0 overflow-hidden p-0',
        )}
      >
        <DialogHeader className="shrink-0 space-y-0 border-b border-white/30 p-5 pb-3 pr-12 text-left">
          <DialogTitle>插件说明 · {title}</DialogTitle>
          <DialogDescription>
            {[plugin?.author, plugin?.version ? `v${plugin.version}` : null, plugin?.id]
              .filter(Boolean)
              .join(' · ')}
          </DialogDescription>
        </DialogHeader>

        <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">
          {loading ? (
            <div className="flex justify-center py-16">
              <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
            </div>
          ) : (
            <MarkdownContent markdown={markdown} className="text-slate-800" />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
