import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Copy, Download, Pause, RefreshCw, Search, Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { LogCategory, LogEntry, LogLevel } from '@/lib/types';
import { CATEGORY_LABEL, CATEGORY_ORDER } from '@/lib/types';
import { useEventSource } from '@/lib/sse';
import { copyToClipboard } from '@/lib/clipboard';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select-menu';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';

type UiLog = LogEntry & { uid: string; fresh?: boolean };

const LEVEL_PILL: Record<LogLevel, string> = {
  info: 'bg-teal-500/15 text-teal-700',
  warn: 'bg-amber-500/15 text-amber-700',
  error: 'bg-rose-500/15 text-rose-700',
  debug: 'bg-purple-500/15 text-purple-700',
};

/** 彩色描边保留，改为半透明，贴合液态玻璃 */
const LEVEL_FRAME: Record<LogLevel, string> = {
  info: 'border-2 border-teal-400/40',
  warn: 'border-2 border-amber-400/50',
  error: 'border-2 border-rose-400/50',
  debug: 'border-2 border-purple-400/50',
};

/** 模拟消息两类用专属描边色，与常规日志区分 */
const CATEGORY_FRAME: Partial<Record<LogCategory, string>> = {
  sim_event: 'border-2 border-sky-400/55',
  sim_action: 'border-2 border-fuchsia-400/55',
};

/** 模拟消息两类的分类徽标配色 */
const CATEGORY_PILL: Partial<Record<LogCategory, string>> = {
  sim_event: 'bg-sky-500/15 text-sky-700',
  sim_action: 'bg-fuchsia-500/15 text-fuchsia-700',
};

const LEVEL_LABEL: Record<LogLevel, string> = {
  info: 'INFO',
  warn: 'WARN',
  error: 'ERROR',
  debug: 'DEBUG',
};

function uid() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function toUi(entry: LogEntry, fresh = false): UiLog {
  return { ...entry, uid: uid(), fresh };
}

function asLevel(level: string): LogLevel {
  return level in LEVEL_PILL ? (level as LogLevel) : 'info';
}

function formatTime(time: string) {
  // 新格式：本地 `YYYY-MM-DD HH:mm:ss.SSS`；旧格式：UTC ISO `...Z`
  const s = String(time || '').trim();
  if (!s) return '';
  if (s.includes('T') && s.endsWith('Z')) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) {
      const pad = (n: number, w = 2) => String(n).padStart(w, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }
  }
  return s.replace('T', ' ').slice(0, 19);
}

function sourceTitle(entry: LogEntry) {
  const raw = (
    entry.prefix
    || CATEGORY_LABEL[entry.category as LogCategory]
    || entry.category
    || 'System'
  ).trim();
  if (!raw) return 'System';

  // 完整解析多段 [a] [b]，避免 /^\[|\]$/ 只砍掉首尾括号导致「咔咔珂] [连接] [测试」
  const parts: string[] = [];
  const re = /\[([^\]]*)\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const between = raw.slice(last, m.index).trim();
    if (between) parts.push(between.replace(/^\[+/, '').replace(/\]+$/, ''));
    const inner = m[1].trim();
    if (inner) parts.push(inner);
    last = m.index + m[0].length;
  }
  const rest = raw.slice(last).trim().replace(/^\[+/, '').replace(/\]+$/, '');
  if (rest) parts.push(rest);

  return parts.length > 0 ? parts.join(' · ') : raw;
}

function entryBody(entry: LogEntry) {
  const parts = [entry.message];
  if (entry.detail) parts.push(entry.detail);
  return parts.join('\n');
}

function entryPlainText(entry: LogEntry) {
  return `${formatTime(entry.time)} [${LEVEL_LABEL[asLevel(entry.level)]}] ${sourceTitle(entry)}\n${entryBody(entry)}`;
}

function tryParseJson(text: string): unknown | null {
  const t = text.trim();
  if (!t || (t[0] !== '{' && t[0] !== '[')) return null;
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return null;
  }
}

function highlightJson(value: unknown, indent = 0): ReactNode {
  const pad = '  '.repeat(indent);
  if (value === null) {
    return <span className="text-violet-600">null</span>;
  }
  if (typeof value === 'boolean') {
    return <span className="text-violet-600">{String(value)}</span>;
  }
  if (typeof value === 'number') {
    return <span className="text-emerald-600">{value}</span>;
  }
  if (typeof value === 'string') {
    return <span className="text-sky-600">&quot;{value}&quot;</span>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return (
      <>
        {'[\n'}
        {value.map((item, i) => (
          <span key={i}>
            {pad}  {highlightJson(item, indent + 1)}
            {i < value.length - 1 ? ',\n' : '\n'}
          </span>
        ))}
        {pad}]
      </>
    );
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return '{}';
    return (
      <>
        {'{\n'}
        {entries.map(([k, v], i) => (
          <span key={k}>
            {pad}  <span className="text-rose-600">&quot;{k}&quot;</span>
            {': '}
            {highlightJson(v, indent + 1)}
            {i < entries.length - 1 ? ',\n' : '\n'}
          </span>
        ))}
        {pad}{'}'}
      </>
    );
  }
  return String(value);
}

function useIsMobile(breakpoint = 768) {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const apply = () => setMobile(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [breakpoint]);
  return mobile;
}

/** 预览卡固定高度：元信息行 + 正文单行截断，全部卡片一致 */
const PREVIEW_CARD_PX = 58;

function previewText(entry: LogEntry) {
  const raw = entry.detail ? `${entry.message} ${entry.detail}` : entry.message;
  return raw.replace(/\s+/g, ' ').trim();
}

export default function LogsPage() {
  const [logs, setLogs] = useState<UiLog[]>([]);
  const [level, setLevel] = useState<string>('all');
  const [category, setCategory] = useState<string>('all');
  const [query, setQuery] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [clearOpen, setClearOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [selected, setSelected] = useState<UiLog | null>(null);
  /** 仅初始加载 / 手动刷新时递增，用于列表批量入场；SSE 新日志不改此值 */
  const [listKey, setListKey] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(autoScroll);
  const levelRef = useRef(level);
  const categoryRef = useRef(category);

  autoScrollRef.current = autoScroll;
  levelRef.current = level;
  categoryRef.current = category;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.logs.list({
        limit: 200,
        level: level === 'all' ? undefined : level,
        category: category === 'all' ? undefined : category,
      });
      setLogs([...res.logs].reverse().map((e) => toUi(e, false)));
      setListKey((k) => k + 1);
      requestAnimationFrame(() => {
        boxRef.current?.scrollTo({ top: 0 });
      });
    } catch (e) {
      toast.error(String(e));
    } finally {
      setLoading(false);
    }
  }, [level, category]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!autoScroll) return;
    boxRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }, [logs, autoScroll]);

  useEventSource((msg) => {
    if (msg.type !== 'log') return;
    if (!autoScrollRef.current) return;
    const entry = msg.data as LogEntry;
    const lv = levelRef.current;
    const cat = categoryRef.current;
    if (lv !== 'all' && entry.level !== lv) return;
    if (cat !== 'all' && entry.category !== cat) return;
    setLogs((prev) => [toUi(entry, true), ...prev].slice(0, 800));
  });

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return logs;
    return logs.filter((e) => {
      const hay = `${e.time} ${e.level} ${e.category} ${e.prefix} ${e.message} ${e.detail || ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [logs, query]);

  const onDownload = async () => {
    setDownloading(true);
    try {
      await api.logs.download({
        level: level === 'all' ? undefined : level,
        category: category === 'all' ? undefined : category,
      });
      toast.success('已下载当前进程日志');
    } catch (e) {
      toast.error(String(e));
    } finally {
      setDownloading(false);
    }
  };

  const copyAllVisible = () => {
    const text = filtered.map(entryPlainText).join('\n\n');
    void copyToClipboard(text || '(empty)').then((ok) => {
      if (ok) toast.success(`已复制 ${filtered.length} 条日志`);
      else toast.error('复制失败，请手动选中复制');
    });
  };

  const confirmClear = async () => {
    setClearing(true);
    try {
      await api.logs.clear();
      setLogs([]);
      setClearOpen(false);
      toast.success('已清空日志');
    } catch (e) {
      toast.error(String(e));
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="kk-fixed-theme flex h-full min-h-0 flex-col gap-3">
      <div className="kk-stagger-item kk-stagger-1 shrink-0 hidden md:block">
        <h1 className="kk-page-title">运行日志</h1>
      </div>

      <div data-tour="logs-filters" className="kk-stagger-item kk-stagger-2 flex shrink-0 flex-col gap-2 sm:flex-row sm:items-center">
        <div data-tour="logs-search" className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 z-[1] h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            className="h-10 border-white/40 bg-white/20 pl-9 placeholder:text-slate-400 focus-visible:ring-1 focus-visible:ring-teal-500/50"
            placeholder="搜索关键词…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="flex shrink-0 gap-2">
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger data-tour="logs-cat" className="h-10 w-full min-w-[7.5rem] border-white/40 bg-white/20 sm:w-[8.5rem]">
              <SelectValue placeholder="分类" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部分类</SelectItem>
              {CATEGORY_ORDER.map((k) => (
                <SelectItem key={k} value={k}>
                  {CATEGORY_LABEL[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={level} onValueChange={setLevel}>
            <SelectTrigger data-tour="logs-level" className="h-10 w-full min-w-[6.5rem] border-white/40 bg-white/20 sm:w-[7.5rem]">
              <SelectValue placeholder="级别" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部级别</SelectItem>
              {(['debug', 'info', 'warn', 'error'] as const).map((v) => (
                <SelectItem key={v} value={v}>
                  {LEVEL_LABEL[v]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* 绝对铺满 + 隐藏滚动条，保证可滑 */}
      <div className="kk-stagger-item kk-stagger-3 relative min-h-0 flex-1">
        <div
          ref={boxRef}
          className="absolute inset-0 flex flex-col gap-2 overflow-y-auto overscroll-y-contain touch-pan-y no-scrollbar [-webkit-overflow-scrolling:touch]"
        >
          {!autoScroll && (
            <div className="kk-glass sticky top-0 z-10 flex shrink-0 items-center gap-2 rounded-xl px-3 py-2 text-xs text-slate-600">
              <Pause className="h-3.5 w-3.5 shrink-0" />
              <span className="flex-1">日志接收已暂停，点击刷新获取最新数据</span>
              <button
                type="button"
                className="font-medium text-primary underline-offset-2 hover:underline"
                onClick={() => void load()}
              >
                刷新
              </button>
            </div>
          )}

          {loading && logs.length === 0 ? (
            <>
              <SkeletonCard />
              <SkeletonCard />
              <SkeletonCard />
            </>
          ) : filtered.length === 0 ? (
            <div className="kk-glass flex min-h-[12rem] flex-1 items-center justify-center rounded-xl border-dashed text-sm text-muted-foreground">
              {query ? '无匹配日志' : '暂无日志'}
            </div>
          ) : (
            <div key={listKey} className="flex flex-col gap-2">
              {filtered.map((entry, index) => (
                <LogCard
                  key={entry.uid}
                  entry={entry}
                  batchIndex={entry.fresh ? undefined : Math.min(index, 20)}
                  onOpen={() => setSelected(entry)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <div data-tour="logs-toolbar" className="kk-glass kk-stagger-item kk-stagger-4 flex shrink-0 items-center gap-1 rounded-xl border border-white/40 bg-white/10 px-2 py-1.5 backdrop-blur-sm">
        <div className="flex items-center gap-0.5">
          <Button
            size="icon"
            variant="ghost"
            data-tour="logs-refresh"
            className="h-9 w-9 rounded-lg text-slate-600 hover:bg-white/20 hover:text-slate-800"
            disabled={loading}
            title="刷新"
            onClick={() => void load()}
          >
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            data-tour="logs-copy"
            className="h-9 w-9 rounded-lg text-slate-600 hover:bg-white/20 hover:text-slate-800"
            title="复制可见日志"
            onClick={copyAllVisible}
          >
            <Copy className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            data-tour="logs-download"
            className="h-9 w-9 rounded-lg text-slate-600 hover:bg-white/20 hover:text-slate-800"
            disabled={downloading}
            title="下载"
            onClick={() => void onDownload()}
          >
            <Download className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            data-tour="logs-clear"
            className="h-9 w-9 rounded-lg text-rose-500/80 hover:bg-rose-500/10 hover:text-rose-600"
            title="清空"
            onClick={() => setClearOpen(true)}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>

        <div data-tour="logs-autoscroll" className="ml-auto flex items-center gap-2 pr-1.5">
          <Label htmlFor="autoscroll" className="text-sm font-normal text-slate-600">
            自动滚动
          </Label>
          <Switch
            id="autoscroll"
            checked={autoScroll}
            onCheckedChange={(v) => {
              setAutoScroll(v);
              if (v) {
                boxRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
              }
            }}
          />
        </div>
      </div>

      <LogDetailPanel
        entry={selected}
        open={!!selected}
        onOpenChange={(v) => !v && setSelected(null)}
        onCopyAll={copyAllVisible}
      />

      <AlertDialog open={clearOpen} onOpenChange={setClearOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确定要清空所有日志吗？</AlertDialogTitle>
            <AlertDialogDescription>
              此操作不可恢复，但新日志会继续产生。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={clearing}>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={clearing}
              onClick={(e) => {
                e.preventDefault();
                void confirmClear();
              }}
            >
              {clearing ? '清空中…' : '清空'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function SkeletonCard() {
  return (
    <div
      className="shrink-0 animate-pulse rounded-xl border-2 border-white/25 bg-white/10 px-3.5 backdrop-blur-sm"
      style={{ height: PREVIEW_CARD_PX }}
    >
      <div className="flex h-full flex-col justify-center gap-1">
        <div className="flex items-center gap-2">
          <div className="h-2.5 w-28 shrink-0 rounded bg-slate-200/70" />
          <div className="h-2.5 w-16 shrink-0 rounded bg-slate-100/80" />
          <div className="ml-auto h-4 w-10 shrink-0 rounded-full bg-slate-200/60" />
        </div>
        <div className="h-2.5 w-full rounded bg-slate-100/80" />
      </div>
    </div>
  );
}

function LogCard({
  entry,
  batchIndex,
  onOpen,
}: {
  entry: UiLog;
  /** 批量入场序号；实时 fresh 日志不传，只用轻量单条动画 */
  batchIndex?: number;
  onOpen: () => void;
}) {
  const level = asLevel(entry.level);
  const source = sourceTitle(entry);
  const text = previewText(entry);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      style={{
        height: PREVIEW_CARD_PX,
        // 视口外的卡片跳过渲染，长列表滚动更顺；固定高度做占位避免抖动
        contentVisibility: 'auto',
        containIntrinsicSize: `${PREVIEW_CARD_PX}px`,
        ...(batchIndex != null ? { animationDelay: `${batchIndex * 0.04}s` } : undefined),
      }}
      className={cn(
        'group flex w-full shrink-0 cursor-pointer flex-col justify-center gap-1 overflow-hidden rounded-xl px-3.5 py-2 text-left touch-pan-y',
        // 去掉逐卡 backdrop-blur：上百张卡片各自 backdrop-filter 会在滚动时逐帧重采样，严重掉帧
        'bg-white/25 transition-colors duration-150 hover:bg-white/35 active:scale-[0.99]',
        entry.fresh && 'kk-log-fresh',
        !entry.fresh && batchIndex != null && 'kk-log-batch',
        CATEGORY_FRAME[entry.category as LogCategory] ?? LEVEL_FRAME[level],
      )}
    >
      <div className="flex min-w-0 items-center gap-2 text-xs text-slate-500">
        <time
          className="shrink-0 whitespace-nowrap text-[10px] tabular-nums text-slate-400"
          dateTime={entry.time}
        >
          {formatTime(entry.time)}
        </time>
        <span className="min-w-0 truncate text-slate-500">{source}</span>
        {CATEGORY_PILL[entry.category as LogCategory] && (
          <span
            className={cn(
              'inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 text-[10px] font-semibold tracking-wide',
              CATEGORY_PILL[entry.category as LogCategory],
            )}
          >
            {CATEGORY_LABEL[entry.category as LogCategory]}
          </span>
        )}
        <span
          className={cn(
            'ml-auto inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 text-[10px] font-semibold tracking-wide',
            LEVEL_PILL[level],
          )}
        >
          {LEVEL_LABEL[level]}
        </span>
      </div>
      <p
        className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs leading-none text-slate-800"
        title={text}
      >
        {text}
      </p>
    </div>
  );
}

function LogDetailPanel({
  entry,
  open,
  onOpenChange,
  onCopyAll,
}: {
  entry: UiLog | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCopyAll: () => void;
}) {
  const isMobile = useIsMobile();
  const level = entry ? asLevel(entry.level) : 'info';
  const body = entry ? entryBody(entry) : '';
  const parsed = entry
    ? tryParseJson(body) ?? tryParseJson(entry.message) ?? tryParseJson(entry.detail || '')
    : null;

  const copyThis = () => {
    if (!entry) return;
    void copyToClipboard(entryPlainText(entry)).then((ok) => {
      if (ok) toast.success('日志内容已复制');
      else toast.error('复制失败，请手动选中复制');
    });
  };

  return (
    <Dialog open={open && !!entry} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          'kk-fixed-theme flex flex-col gap-3 overflow-hidden',
          isMobile ? 'max-h-[min(80dvh,100dvh-2rem)]' : 'max-h-[80vh] max-w-xl',
        )}
      >
        <DialogHeader className="pr-6 text-left">
          <DialogTitle>日志详情</DialogTitle>
          <DialogDescription className="sr-only">查看完整日志内容</DialogDescription>
        </DialogHeader>

        {entry && (
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <time className="text-muted-foreground">{formatTime(entry.time)}</time>
              <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold', LEVEL_PILL[level])}>
                {LEVEL_LABEL[level]}
              </span>
              <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                {CATEGORY_LABEL[entry.category as LogCategory] || entry.category}
              </span>
              <span className="font-semibold text-slate-700">{sourceTitle(entry)}</span>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto no-scrollbar rounded-xl border border-white/30 bg-white/15 p-3 backdrop-blur-sm">
              {parsed !== null ? (
                <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-slate-800">
                  {highlightJson(parsed)}
                </pre>
              ) : (
                <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-slate-800">
                  {body}
                </pre>
              )}
            </div>

            <div className="flex w-full items-stretch justify-center gap-2">
              <Button
                className="h-10 min-w-0 flex-1 basis-0 justify-center"
                onClick={copyThis}
              >
                <Copy className="h-4 w-4 shrink-0" />
                <span className="truncate">一键复制完整内容</span>
              </Button>
              <Button
                variant="outline"
                className="h-10 min-w-0 flex-1 basis-0 justify-center"
                onClick={onCopyAll}
              >
                <Copy className="h-4 w-4 shrink-0" />
                <span className="truncate">复制全部日志</span>
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
