import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Copy, Download, Pause, RefreshCw, Search, Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { LogCategory, LogEntry, LogFileInfo, LogLevel } from '@/lib/types';
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

/**
 * 每个日志分类一个独立文字色，作用在行首的「类型」段。
 * 与级别色并存：类型段用分类色，其余内容沿用级别色。
 */
const CATEGORY_TEXT: Record<LogCategory, string> = {
  system: 'text-slate-600',
  event: 'text-teal-700',
  action: 'text-sky-700',
  plugin: 'text-violet-700',
  gf_event: 'text-emerald-700',
  gf_action: 'text-amber-700',
  gf_plugin: 'text-fuchsia-700',
  sim_event: 'text-blue-700',
  sim_action: 'text-purple-700',
};

/** 级别色：非报错级时只作用在摘要上，与分类色混用 */
const LEVEL_TEXT: Record<LogLevel, string> = {
  info: 'text-teal-700',
  warn: 'text-amber-700',
  error: 'text-rose-700',
  debug: 'text-purple-700',
};

/** 报错级专用：整行统一玫红并加粗，压过分类色 */
const ERROR_ROW = 'text-rose-700 font-semibold';

/** 非报错级的级别强弱微调（配合分类色打底）：debug 淡、info 常规、warn 中粗 */
const LEVEL_EMPHASIS: Record<LogLevel, string> = {
  debug: 'opacity-70',
  info: '',
  warn: 'font-medium',
  error: 'font-semibold',
};

const LEVEL_LABEL: Record<LogLevel, string> = {
  info: 'INFO',
  warn: 'WARN',
  error: 'ERROR',
  debug: 'DEBUG',
};

/** 下拉里「实时日志」的哨兵值：Radix Select 的 Item value 不允许是空字符串 */
const LIVE_LOG = '__live__';

/**
 * 手机端下拉触发器：和搜索框挤在同一排所需的紧凑尺寸。
 * 76px 宽 − 内边距 12 − 箭头 14 − 间距 4 ≈ 46px 正文，11px 字号可放 4 个汉字
 * （选中「官方上报」这类四类目时也不至于截断）。
 * 桌面端还原成原来的 40px 高 / 14px 字号。
 */
const COMPACT_TRIGGER = [
  'h-9 w-[4.75rem] shrink min-w-0 gap-1 px-1.5 text-[11px]',
  'border-white/40 bg-white/20',
  '[&>svg]:h-3.5 [&>svg]:w-3.5',
  'sm:h-10 sm:w-[8.5rem] sm:gap-2 sm:px-3.5 sm:text-sm',
  'sm:[&>svg]:h-4 sm:[&>svg]:w-4',
].join(' ');

/**
 * 触发器上的分端文案：手机端只放两个字，桌面端放完整说法。
 * 只影响「收起状态下显示什么」，下拉列表里的选项文本不受影响——
 * 那里的「全部分类 / 全部级别 / 实时日志」仍要写全，否则分不清是「全部」还是某个具体值。
 */
function TriggerLabel({ short, full }: { short: string; full: string }) {
  // 外面再套一层是刻意的：SelectTrigger 上有 `[&>span]:line-clamp-1`，
  // 而 line-clamp 会强制 display:-webkit-box，可能盖掉直接子 span 上的 hidden。
  // 套一层后两个分端 span 至少是孙级，不受该选择器影响，hidden / inline 才切得动。
  return (
    <span className="min-w-0">
      <span className="sm:hidden">{short}</span>
      <span className="hidden sm:inline">{full}</span>
    </span>
  );
}

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

  // 来源同样摊平为单行，避免带换行的 prefix 把预览行撑开
  const title = parts.length > 0 ? parts.join(' · ') : raw;
  return title.replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
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


/**
 * 预览用媒体占位：图片 / 语音 / 视频等非文本内容在预览里只留 [图片] [语音] [视频]。
 * 覆盖全部协议与实现（OneBot11 CQ 码、NapCat/LLOneBot/go-cqhttp 等同源实现、
 * 官方机器人的媒体 URL、base64 负载），详情浮窗仍展示完整原文。
 */
/** 未知 CQ 段的兜底中文名：宁可显示 [xxx]，也不要把原始 CQ 串漏进预览 */
const CQ_MISC: Record<string, string> = {
  image: '[图片]',
  record: '[语音]',
  video: '[视频]',
  face: '[表情]',
  file: '[文件]',
  reply: '[回复]',
  forward: '[转发]',
  json: '[卡片]',
  xml: '[卡片]',
  node: '[转发]',
  at: '@',
  dice: '[骰子]',
  rps: '[猜拳]',
  shake: '[窗口抖动]',
  poke: '[戳一戳]',
  share: '[分享]',
  music: '[音乐]',
  redbag: '[红包]',
  contact: '[推荐]',
  location: '[位置]',
  markdown: '[卡片]',
  cardimage: '[卡片]',
  tts: '[文字转语音]',
  mface: '[表情]',
  miniapp: '[小程序]',
  gift: '[礼物]',
};

/**
 * OneBot11 消息段数组 → 可读文本。
 * 「输出」侧 send_* 的 message 是 `[{"type":"text","data":{"text":"…"}}, …]`，
 * 老日志文件里落盘的就是这串 JSON，后端修好了也救不了历史数据，只能前端兜。
 */
function segmentsToText(list: unknown[]): string {
  const out: string[] = [];
  for (const seg of list) {
    if (!seg || typeof seg !== 'object') continue;
    const o = seg as Record<string, unknown>;
    const type = String(o.type ?? '').toLowerCase();
    const data = (o.data && typeof o.data === 'object') ? o.data as Record<string, unknown> : {};
    const text = typeof data.text === 'string' ? data.text : '';
    if (type === 'text') {
      if (text) out.push(text);
      continue;
    }
    if (type === 'at') {
      const qq = String(data.qq ?? '');
      out.push(qq === 'all' ? '@全体成员' : (qq ? `@${qq}` : '@成员'));
      continue;
    }
    const tag = CQ_MISC[type];
    if (tag && tag !== '@') {
      out.push(tag);
      continue;
    }
    if (text) out.push(text);
    else if (type) out.push(`[${type}]`);
  }
  return out.join('');
}

/**
 * 摘要本身就带 JSON 时（历史日志里的 `send_msg: [{"type":"text",…}]`），把 JSON 尾巴
 * 换成可读正文，别把整串代码摆在预览里。解析不了（被 120 字符截断）就退而求其次抓文本段。
 */
function humanizeJsonInMessage(s: string): string {
  const at = s.search(/[[{]/);
  if (at < 0) return '';
  const head = s.slice(0, at).trimEnd();
  const tail = s.slice(at);

  let body = '';
  const parsed = tryParseJson(tail);
  if (Array.isArray(parsed)) {
    body = segmentsToText(parsed);
  } else if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>;
    if (Array.isArray(o.message)) body = segmentsToText(o.message);
    else {
      for (const k of ['content', 'text', 'prompt'] as const) {
        const v = o[k];
        if (typeof v === 'string' && v.trim()) {
          body = stripMarkup(v);
          break;
        }
      }
    }
  }

  // JSON 被 120 字符截断、解析不了时：直接抠 "text":"…"（闭合引号可能也被截掉，故设为可选），
  // 抠不到再退一级抠 "type":"…" 换成媒体标签
  if (!body && /"text"\s*:/.test(tail)) {
    const texts: string[] = [];
    const re = /"text"\s*:\s*"((?:[^"\\]|\\.)*)"?/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(tail))) texts.push(m[1].replace(/\\"/g, '"'));
    body = texts.join(' ');
  }
  if (!body && /"type"\s*:/.test(tail)) {
    const tags: string[] = [];
    const re = /"type"\s*:\s*"([a-z_]+)"/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(tail))) tags.push(CQ_MISC[m[1].toLowerCase()] ?? `[${m[1]}]`);
    body = tags.join('');
  }

  if (!body) return '';
  return head ? `${head} ${body}` : body;
}

function previewMedia(text: string): string {
  let s = text;
  // 上游若在 CQ 码中间截断（160 字符上限），闭合的 ] 会丢失，后面所有正则都匹配不到。
  // 先把结尾这半截 CQ 补上 ]，避免原始参数串漏进预览。
  s = s.replace(/(\[CQ:[a-z_]+[^\]]*)$/gi, '$1]');
  // CQ 码：图片 / 语音 / 视频
  s = s.replace(/\[CQ:image[^\]]*\]/gi, '[图片]');
  s = s.replace(/\[CQ:record[^\]]*\]/gi, '[语音]');
  s = s.replace(/\[CQ:video[^\]]*\]/gi, '[视频]');
  // CQ 码：其余非文本段，避免预览被参数串淹没
  s = s.replace(/\[CQ:face[^\]]*\]/gi, '[表情]');
  s = s.replace(/\[CQ:file[^\]]*\]/gi, '[文件]');
  s = s.replace(/\[CQ:(?:json|xml)[^\]]*\]/gi, '[卡片]');
  s = s.replace(/\[CQ:forward[^\]]*\]/gi, '[转发]');
  s = s.replace(/\[CQ:reply[^\]]*\]/gi, '[回复]');
  // @：全体单独标出，其余带出 QQ 号，比一串 CQ 参数有用
  s = s.replace(/\[CQ:at[^\]]*\]/gi, (m) => {
    const q = /qq=([^,\]]+)/i.exec(m);
    if (!q) return '@成员';
    return q[1] === 'all' ? '@全体成员' : `@${q[1]}`;
  });
  // 兜底：任何还没被认领的 CQ 段都换成中文标签，不留原始参数串
  s = s.replace(/\[CQ:([a-z_]+)[^\]]*\]/gi, (_m, type: string) => CQ_MISC[type.toLowerCase()] ?? `[${type}]`);
  // QQ 官方表情：<faceType=6,faceId="0",ext="...">
  s = s.replace(/<faceType=[^>]*>/gi, '[表情]');
  // 官方 @ 标记：<@openid> / <qqbot-at-user id=""/>
  s = s.replace(/<@[^>]*>/g, '@');
  s = s.replace(/<qqbot-at-(?:user|everyone)[^>]*>/gi, '@');
  // 裸媒体地址（官方机器人 / 微信 / KOOK 等直接带 URL 的情况）
  s = s.replace(/https?:\/\/[^\s"'）)]+\.(?:png|jpe?g|gif|webp|bmp)/gi, '[图片]');
  s = s.replace(/https?:\/\/[^\s"'）)]+\.(?:mp4|mov|mkv|webm)/gi, '[视频]');
  s = s.replace(/https?:\/\/[^\s"'）)]+\.(?:amr|silk|mp3|wav|ogg|m4a)/gi, '[语音]');
  // base64 媒体负载，整段替换避免刷屏
  s = s.replace(/base64:\/\/[A-Za-z0-9+/=]{16,}/g, '[媒体]');
  return s;
}

/** 去掉 markdown / 标签语法，压成一段可读纯文本 */
function stripMarkup(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[#*`_~>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/**
 * message 是纯 API 路径时（官方机器人输出就是这样），从 detail 里摘一段正文，
 * 否则预览只剩 `/v2/groups/.../messages` 这种没有信息量的串。
 */
function briefFromDetail(detail: string | undefined): string {
  if (!detail) return '';
  const parsed = tryParseJson(detail);
  if (!parsed || typeof parsed !== 'object') return '';
  const o = parsed as Record<string, unknown>;
  const md = o.markdown;
  if (md && typeof md === 'object') {
    const c = (md as Record<string, unknown>).content;
    if (typeof c === 'string' && c.trim()) return stripMarkup(c);
  }
  for (const k of ['content', 'text', 'message', 'prompt'] as const) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return stripMarkup(v);
  }
  return '';
}

const API_PATH_RE = /^(?:\/v\d+\/|v\d+\/|https?:\/\/)/;

/**
 * 官方机器人的图片 / 视频 / 语音挂在 attachments 上，正文 content 是空的，
 * 此时后端给的 message 只会是「(非文本)」——要从 attachments 里认出媒体类型。
 */
function mediaFromDetail(detail: string | undefined): string {
  // 先做廉价子串判断，避免每条日志都去 JSON.parse
  if (!detail || !detail.includes('attachments')) return '';
  const parsed = tryParseJson(detail);
  if (!parsed || typeof parsed !== 'object') return '';
  const list = (parsed as Record<string, unknown>).attachments;
  if (!Array.isArray(list)) return '';
  const tags: string[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const ct = String((item as Record<string, unknown>).content_type || '').toLowerCase();
    if (ct.startsWith('image/')) tags.push('[图片]');
    else if (ct.startsWith('video/')) tags.push('[视频]');
    else if (ct.startsWith('audio/') || ct.includes('voice') || ct.includes('silk')) tags.push('[语音]');
    else if (ct) tags.push('[附件]');
  }
  return tags.join('');
}

/**
 * 部分 OneBot11 实现会把消息正文里的 & < > [ ] , 转成 HTML 实体
 * （例如 NapCat 的 `&#91;动画表情&#93;`），预览里还原回可读字符。
 * 必须在 previewMedia 之后执行，否则还原出的 [ ] 会干扰 CQ 码匹配。
 */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#44;/g, ',')
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']');
}

/**
 * 预览文本：以 message（后端写好的可读摘要）为主体。
 * detail 是完整上报 JSON（最多 2048 字符），拼进来会让预览变成一大串代码——
 * 它只在详情浮窗里出现。message 缺失时才拿 detail 兜底并截短。
 */
function previewText(entry: LogEntry): string {
  const main = (entry.message || '').trim();
  let text = main;
  if (main && API_PATH_RE.test(main)) {
    const brief = briefFromDetail(entry.detail);
    if (brief) text = `${main} · ${brief}`;
  }
  // 摘要自带 JSON（历史日志里 send_* 的消息段数组）时摘出正文，别把代码摆进预览
  const humanized = humanizeJsonInMessage(text);
  if (humanized) text = humanized;
  // 官方图片/语音/视频：正文为空时 message 只是「(非文本)」，用 attachments 换成媒体标签
  const media = mediaFromDetail(entry.detail);
  if (media) {
    text = text.includes('(非文本)')
      ? text.replace('(非文本)', media)
      : `${text}${text ? ' ' : ''}${media}`;
  } else if (!text) {
    text = (entry.detail || '').trim().slice(0, 300);
  }
  return decodeEntities(previewMedia(text))
    .replace(/[\r\n\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
  /** 日志目录下的 .log 文件（点开「选择」时才拉取） */
  const [logFiles, setLogFiles] = useState<LogFileInfo[]>([]);
  /**
   * 临时查看的日志文件名。
   * undefined = 实时机制（默认）；LIVE_LOG = 用户主动切回实时；其它 = 查看该文件。
   * 这个状态不做持久化，刷新页面一定回到实时机制。
   */
  const [viewingFile, setViewingFile] = useState<string | undefined>(undefined);
  const boxRef = useRef<HTMLDivElement>(null);
  /** true = 本次滚动直接定位（首次/刷新/换筛选），false = 平滑跟随新日志 */
  const instantScrollRef = useRef(true);
  const autoScrollRef = useRef(autoScroll);
  const levelRef = useRef(level);
  const categoryRef = useRef(category);
  const viewingFileRef = useRef(viewingFile);

  /** 是否正在临时查看某个 .log 文件 */
  const isFileView = !!viewingFile && viewingFile !== LIVE_LOG;

  /** 终端语义：最新一条在列表最底部，跟随即滚到底。
   * 先强制 layout 一次，避免 content-visibility 的估算高度让 scrollHeight 失真。 */
  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const el = boxRef.current;
    if (!el) return;
    // 强制浏览器计算一次真实高度，修正 content-visibility 初始估算带来的偏差
    el.getBoundingClientRect();
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  autoScrollRef.current = autoScroll;
  levelRef.current = level;
  categoryRef.current = category;
  viewingFileRef.current = viewingFile;

  const load = useCallback(async () => {
    setLoading(true);
    // 重新拉取（首次进入 / 刷新 / 切换筛选）后直接定位到底部，不做长距离滚动动画
    instantScrollRef.current = true;
    try {
      const res = await api.logs.list({
        limit: 200,
        level: level === 'all' ? undefined : level,
        category: category === 'all' ? undefined : category,
      });
      // 后端 slice(-limit) 已是「旧 → 新」，直接采用：最新一条落在列表最底部
      setLogs(res.logs.map((e) => toUi(e, false)));
      setListKey((k) => k + 1);
      requestAnimationFrame(() => {
        scrollToBottom('auto');
      });
    } catch (e) {
      toast.error(String(e));
    } finally {
      setLoading(false);
    }
  }, [level, category, scrollToBottom]);

  /** 点开「选择」时才拉取，避免进页面就多一次请求 */
  const loadFileList = useCallback(async () => {
    try {
      const res = await api.logs.files();
      setLogFiles(res.files);
    } catch (e) {
      toast.error(String(e));
    }
  }, []);

  /**
   * 选择查看某个 .log 文件（一次性临时查看）。
   * 后端只做读取，不写入内存环形缓冲、不参与计数，刷新页面即回到实时机制。
   */
  const pickLogFile = useCallback(async (value: string) => {
    setViewingFile(value);
    if (value === LIVE_LOG) {
      void load();
      return;
    }
    setLoading(true);
    instantScrollRef.current = true;
    try {
      const res = await api.logs.file(value);
      // 文件里也是按时间「旧 → 新」写入，与实时列表方向一致
      setLogs(res.logs.map((e) => toUi(e, false)));
      setListKey((k) => k + 1);
      requestAnimationFrame(() => {
        scrollToBottom('auto');
      });
      toast.success(`已载入 ${value}`);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setLoading(false);
    }
  }, [load, scrollToBottom]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!autoScroll) return;
    scrollToBottom(instantScrollRef.current ? 'auto' : 'smooth');
    instantScrollRef.current = false;
  }, [logs, autoScroll, scrollToBottom]);

  useEventSource((msg) => {
    if (msg.type !== 'log') return;
    if (!autoScrollRef.current) return;
    // 正在临时查看文件时，不把实时日志混进文件列表
    if (viewingFileRef.current && viewingFileRef.current !== LIVE_LOG) return;
    const entry = msg.data as LogEntry;
    const lv = levelRef.current;
    const cat = categoryRef.current;
    if (lv !== 'all' && entry.level !== lv) return;
    if (cat !== 'all' && entry.category !== cat) return;
    // 终端语义：新日志追加到末尾（最底部）
    setLogs((prev) => [...prev, toUi(entry, true)].slice(-800));
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
      {/* 「运行日志」标题已由顶栏显示，这里直接从筛选区开始 */}
      {/* 手机端也是单行：搜索框弹性吃掉剩余宽度，三个下拉固定紧凑宽度。
          触发器上的文案分两套（见 TriggerLabel）：手机端只显示两字「分类 / 级别 / 选择」，
          桌面端才是「全部分类 / 全部级别 / 实时日志」。
          极窄屏（<360px）下三个下拉可再压缩并省略号截断，搜索框保住最低可输入宽度。 */}
      <div data-tour="logs-filters" className="kk-stagger-item kk-stagger-2 flex shrink-0 flex-row items-center gap-1.5 sm:gap-2">
        <div data-tour="logs-search" className="relative min-w-[5.5rem] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 z-[1] h-4 w-4 -translate-y-1/2 text-slate-400 sm:left-3" />
          <Input
            className="h-9 border-white/40 bg-white/20 pl-8 pr-2 text-xs placeholder:text-slate-400 focus-visible:ring-1 focus-visible:ring-teal-500/50 sm:h-10 sm:pl-9 sm:pr-3.5 sm:text-sm"
            placeholder="搜索关键词…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="flex min-w-0 items-center gap-1.5 sm:gap-2">
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger data-tour="logs-cat" className={COMPACT_TRIGGER}>
              <SelectValue placeholder="分类">
                {category === 'all'
                  ? <TriggerLabel short="分类" full="全部分类" />
                  : CATEGORY_LABEL[category as LogCategory] ?? category}
              </SelectValue>
            </SelectTrigger>
            {/* 手机端触发器被压到 76px，弹层不能跟着变窄，否则文件名/分类名挤成一团 */}
            <SelectContent className="min-w-[12rem]">
              <SelectItem value="all">全部分类</SelectItem>
              {CATEGORY_ORDER.map((k) => (
                <SelectItem key={k} value={k}>
                  {CATEGORY_LABEL[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={level} onValueChange={setLevel}>
            <SelectTrigger data-tour="logs-level" className={cn(COMPACT_TRIGGER, 'sm:w-[7.5rem]')}>
              <SelectValue placeholder="级别">
                {level === 'all'
                  ? <TriggerLabel short="级别" full="全部级别" />
                  : LEVEL_LABEL[level as LogLevel] ?? level}
              </SelectValue>
            </SelectTrigger>
            <SelectContent className="min-w-[12rem]">
              <SelectItem value="all">全部级别</SelectItem>
              {(['debug', 'info', 'warn', 'error'] as const).map((v) => (
                <SelectItem key={v} value={v}>
                  {LEVEL_LABEL[v]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {/* 选择：挑一个 .log 文件临时查看（一次性，刷新即回到实时机制） */}
          <Select
            value={viewingFile}
            onValueChange={(v) => void pickLogFile(v)}
            onOpenChange={(open) => {
              if (open) void loadFileList();
            }}
          >
            <SelectTrigger data-tour="logs-file" className={cn(COMPACT_TRIGGER, 'sm:w-[9.5rem]')}>
              <SelectValue placeholder="选择">
                {viewingFile === LIVE_LOG
                  ? <TriggerLabel short="实时" full="实时日志" />
                  : viewingFile}
              </SelectValue>
            </SelectTrigger>
            <SelectContent className="min-w-[12rem]">
              <SelectItem value={LIVE_LOG}>实时日志</SelectItem>
              {logFiles.length === 0 ? (
                <SelectItem value="__none__" disabled>
                  暂无日志文件
                </SelectItem>
              ) : (
                logFiles.map((f) => (
                  <SelectItem key={f.name} value={f.name}>
                    {f.name}
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* 绝对铺满 + 隐藏滚动条，保证可滑 */}
      {/* 手机端抵消外壳 main 的 px-4，把左右留白还给日志行；桌面端保持原边距 */}
      <div
        data-tour="logs-stream"
        className="kk-stagger-item kk-stagger-3 relative -mx-4 min-h-0 flex-1 md:mx-0"
      >
        {/* 终端流：只允许上下滚动，横条与滚动条 UI 均不出现，超出部分按行截断 */}
        <div
          ref={boxRef}
          className="absolute inset-0 flex flex-col overflow-y-auto overflow-x-hidden overscroll-y-contain touch-pan-y no-scrollbar [-webkit-overflow-scrolling:touch]"
        >
          {loading && logs.length === 0 ? (
            <>
              <SkeletonRow />
              <SkeletonRow />
              <SkeletonRow />
              <SkeletonRow />
              <SkeletonRow />
            </>
          ) : filtered.length === 0 ? (
            <div className="kk-glass flex min-h-[12rem] flex-1 items-center justify-center rounded-xl border-dashed text-sm text-muted-foreground">
              {query ? '无匹配日志' : '暂无日志'}
            </div>
          ) : (
            <div key={listKey} className="flex flex-col">
              {filtered.map((entry, index) => (
                <LogRow
                  key={entry.uid}
                  entry={entry}
                  // 入场动画自顶部第一条向下推进（阅读顺序），最多铺 16 行
                  batchIndex={entry.fresh ? undefined : Math.min(index, 16)}
                  onOpen={() => setSelected(entry)}
                />
              ))}
            </div>
          )}

          {/* 暂停提示吸底：终端视口默认停在最新一条，提示需跟着在底部可见 */}
          {!autoScroll && (
            <div className="kk-glass sticky bottom-0 z-10 mt-auto flex shrink-0 items-center gap-2 rounded-xl px-3 py-2 text-xs text-slate-600">
              <Pause className="h-3.5 w-3.5 shrink-0" />
              <span className="flex-1">日志接收已暂停，点击刷新获取最新数据</span>
              <button
                type="button"
                className="font-medium text-primary underline-offset-2 hover:underline"
                onClick={() => (isFileView ? void pickLogFile(viewingFile as string) : void load())}
              >
                刷新
              </button>
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
            title={isFileView ? `重新读取 ${viewingFile}` : '刷新'}
            onClick={() => (isFileView ? void pickLogFile(viewingFile as string) : void load())}
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
            className="h-9 w-9 rounded-lg text-rose-500/80 hover:bg-rose-500/10 hover:text-rose-600 disabled:opacity-40"
            // 清空只作用于内存实时日志，查看文件时禁用，避免误解成删文件
            disabled={isFileView}
            title={isFileView ? '查看文件时不可清空' : '清空'}
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

function SkeletonRow() {
  return (
    <div className="flex min-h-[22px] shrink-0 animate-pulse items-center gap-1 px-3 py-[3px] sm:min-h-[26px] sm:gap-1.5 sm:py-[4px]">
      <div className="h-2 w-10 shrink-0 rounded bg-slate-200/70" />
      <div className="h-2 w-16 shrink-0 rounded bg-slate-100/80" />
      <div className="h-2 w-24 shrink-0 rounded bg-slate-100/80" />
      <div className="h-2 min-w-0 flex-1 rounded bg-slate-100/80" />
    </div>
  );
}

function LogRow({
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
  // 手机端时间只留「时:分:秒」，年月日部分到 sm 以上才显示
  const timeText = formatTime(entry.time);
  const spaceAt = timeText.indexOf(' ');
  const datePart = spaceAt > 0 ? timeText.slice(0, spaceAt) : '';
  const clockPart = spaceAt > 0 ? timeText.slice(spaceAt + 1) : timeText;
  // 预览文本只算一次：entry 不变时避免重复解析 detail
  const text = useMemo(() => previewText(entry), [entry]);

  return (
    <div
      role="button"
      tabIndex={0}
      // 任何端、任何长度都能点开看完整内容（内容本身就这点时，弹窗里也就是这点）
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      style={{
        // 不用 content-visibility：它会让离屏行跳过内容渲染（只留 contain-intrinsic-size 的空盒子），
        // 这正是折行后「行是空白、内容消失」的来源。行结构简单，800 条以内全量渲染更稳。
        ...(batchIndex != null ? { animationDelay: `${batchIndex * 0.025}s` } : undefined),
      }}
      className={cn(
        // 整行是「单一文本流」：类型/账号/时间/摘要 连续排列，
        // 折行由整段统一决定——整段一起换行，每行都从行首开始，不存在只在摘要区里换行的情况
        // 兜底：万一还有超长不可断的串（未识别的协议原始数据），允许它在行内折断，
        // 而不是把整行撑宽/溢出。正常文本不受影响——只在单词本身放不下时才断。
        'line-clamp-2 w-full shrink-0 cursor-pointer break-words text-left',
        // 内容只占 1 行就是 1 行高，占满 2 行才撑高——不会凭空空出一行
        'min-h-[22px] py-[3px] sm:min-h-[26px] sm:py-[4px]',
        // 左右留白提到 1rem 并用 safe-area 兜底，圆角屏 / 刘海机不会吃掉首尾字符
        'pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))]',
        'text-[11px] leading-[1.4] sm:text-xs sm:leading-[1.5]',
        'touch-pan-y transition-colors duration-100 hover:bg-white/35 active:bg-white/45',
        // 报错级优先：整行统一玫红加粗，压过分类色
        level === 'error'
          ? ERROR_ROW
          : CATEGORY_TEXT[entry.category as LogCategory] ?? 'text-slate-600',
        // 其余级别：整行分类色打底，摘要再叠级别色——允许一行多色混用
        level !== 'error' && LEVEL_EMPHASIS[level],
        entry.fresh && 'kk-log-append',
        !entry.fresh && batchIndex != null && 'kk-log-batch',
      )}
      title={text}
    >
      {/* 以下全部是同一段文本流里的 inline 片段，没有任何独立宽高/块级容器，
          因此整段一起折行、从行首续排，不会只让摘要单独换行 */}
      {/* 类型段：色相随整行的分类色，仅用字重做区隔 */}
      <span className="font-medium">
        {CATEGORY_LABEL[entry.category as LogCategory] || entry.category}
      </span>
      <span className="opacity-60"> · </span>
      <span className="opacity-80">{source}</span>
      <span className="opacity-60"> · </span>
      <time className="whitespace-nowrap tabular-nums opacity-80" dateTime={entry.time}>
        {datePart ? <span className="hidden sm:inline">{`${datePart} `}</span> : null}
        {clockPart}
      </time>
      <span className="opacity-60"> · </span>
      {/* 摘要：报错级跟随整行玫红，其余级别叠用级别色 */}
      <span className={cn('font-mono', level !== 'error' && LEVEL_TEXT[level])}>{text}</span>
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
