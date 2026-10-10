import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Megaphone } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { MarkdownContent } from '@/components/markdown-content';
import { loadAnnouncementMarkdown } from '@/lib/load-announcement';
import { api } from '@/lib/api';

/**
 * 公告「版本更新」提示弹窗（与协议门禁独立，仅告知，不再走同意/拒绝）。
 *
 * 时机：进入后台（控制台挂载）时读一次 /api/announcement/update——该接口只读
 * 本地状态、不发起网络请求。远程探测由「登录后台任务」负责，探测到的新版本只在
 * 「下一次进入后台」才由此弹出。SPA 生命周期内只检查一次，避免路由切换反复弹。
 */

let checkedThisSession = false;

/** 退出登录时调用：下次登录进入后台应重新检查公告更新 */
export function resetAnnouncementUpdateCheck(): void {
  checkedThisSession = false;
}

export function AnnouncementUpdateDialog() {
  const [open, setOpen] = useState(false);
  const [markdown, setMarkdown] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const versionRef = useRef('');

  useEffect(() => {
    if (checkedThisSession) return;
    checkedThisSession = true;
    let cancelled = false;

    void (async () => {
      try {
        const state = await api.announcementUpdate();
        if (cancelled || !state.hasUpdate) return;
        versionRef.current = state.showVersion;
        setLoading(true);
        setOpen(true);
        // 正文沿用既有加载机制：远程优先，失败回退本地备份
        const payload = await loadAnnouncementMarkdown();
        if (cancelled) return;
        setMarkdown(payload.markdown);
      } catch {
        // 提示失败不打扰用户；下次进入再试
        if (!cancelled) setOpen(false);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const onConfirm = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.announcementUpdateAck(versionRef.current);
    } catch {
      // 确认失败也先关闭；服务端下次仍可再提示
    } finally {
      setBusy(false);
      setOpen(false);
      toast.success('已了解公告更新', { duration: 1600 });
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // 只允许通过「我知道了」关闭，避免误触后不再记录已读
        if (!next && !busy) void onConfirm();
      }}
    >
      <DialogContent hideClose className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Megaphone className="h-5 w-5 text-teal-600" />
            公告已更新
            {versionRef.current ? (
              <span className="rounded-md bg-teal-500/12 px-1.5 py-px text-[11px] font-semibold tabular-nums text-teal-700">
                v{versionRef.current}
              </span>
            ) : null}
          </DialogTitle>
          <DialogDescription>用户协议与公告有新版本，请阅读以下内容后关闭。</DialogDescription>
        </DialogHeader>

        <div className="no-scrollbar max-h-[52dvh] overflow-y-auto overscroll-contain rounded-xl border border-white/40 bg-white/25 p-4 text-slate-800">
          {loading && !markdown ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              正在加载公告…
            </div>
          ) : (
            <MarkdownContent markdown={markdown} />
          )}
        </div>

        <div className="flex justify-end">
          <button
            type="button"
            disabled={busy || loading}
            onClick={() => void onConfirm()}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-teal-500 to-teal-600 px-6 text-sm font-semibold text-white shadow-lg shadow-teal-500/30 transition-all hover:-translate-y-0.5 hover:shadow-xl active:scale-[0.96] disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            我知道了
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
