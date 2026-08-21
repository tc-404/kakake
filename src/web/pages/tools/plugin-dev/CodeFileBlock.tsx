import { useEffect, useRef, useState } from 'react';
import { Copy, Check, Download } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { copyToClipboard } from '@/lib/clipboard';

type Props = {
  title: string;
  downloadName: string;
  language?: string;
  content: string;
};

function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function resolvePageScrollEl(from: HTMLElement): HTMLElement {
  const marked = from.closest('[data-kk-page-scroll]');
  if (marked instanceof HTMLElement) return marked;
  const doc = document.scrollingElement;
  if (doc instanceof HTMLElement) return doc;
  return document.documentElement;
}

export function CodeFileBlock({ title, downloadName, language, content }: Props) {
  const [copied, setCopied] = useState(false);
  const scrollRef = useRef<HTMLPreElement>(null);

  async function onCopy() {
    const ok = await copyToClipboard(content);
    if (ok) {
      setCopied(true);
      toast.success('已复制全文');
      window.setTimeout(() => setCopied(false), 1600);
    } else {
      toast.error('复制失败');
    }
  }

  function onDownload() {
    downloadText(downloadName || title || 'file.txt', content);
    toast.success(`已下载 ${downloadName || title}`);
  }

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      const dy = e.deltaY;
      if (dy === 0) return;

      const atTop = el.scrollTop <= 1;
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;

      // 未到顶/底：交给代码窗自己滚
      if ((dy < 0 && !atTop) || (dy > 0 && !atBottom)) return;

      // 到顶继续上滚 / 到底继续下滚：带动页面
      const page = resolvePageScrollEl(el);
      page.scrollTop += dy;
      e.preventDefault();
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  return (
    <div className="kk-glass overflow-hidden rounded-2xl">
      <div className="flex flex-wrap items-center gap-2 border-b border-white/40 px-3 py-2.5 sm:px-4">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-slate-800">{title}</div>
          {language ? (
            <div className="truncate text-[11px] text-slate-500">{language}</div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => void onCopy()}
            className={cn(
              'inline-flex h-8 items-center gap-1 rounded-lg px-2.5 text-xs font-medium transition',
              'bg-white/45 text-slate-700 hover:bg-white/70',
            )}
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            复制
          </button>
          <button
            type="button"
            onClick={onDownload}
            className={cn(
              'inline-flex h-8 items-center gap-1 rounded-lg px-2.5 text-xs font-medium transition',
              'bg-white/45 text-slate-700 hover:bg-white/70',
            )}
          >
            <Download className="h-3.5 w-3.5" />
            下载
          </button>
        </div>
      </div>
      <pre
        ref={scrollRef}
        className="kk-glass-inset kk-code-scroll m-0 max-h-[min(70vh,520px)] rounded-none border-0 p-3 text-[12px] leading-5 text-slate-800 sm:p-4 sm:text-[13px] sm:leading-6"
      >
        <code className="whitespace-pre font-mono">{content}</code>
      </pre>
    </div>
  );
}
