import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft, Bot, Check, ChevronDown, ChevronRight, Copy, FileText, Loader2, Pencil, Plus,
  RotateCcw, Send, Settings2, CheckCircle2, XCircle, Trash2, X, RefreshCw,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Combobox } from '@/components/ui/combobox';
import { MarkdownContent } from '@/components/markdown-content';
import { usePageHeader } from '@/components/header-actions';
import {
  aiApi, streamRun, streamRetry,
  type AiMessage, type AiProfile, type AiSessionFull, type AiSessionMeta, type AiStreamEvent, type FileChange, type TurnUsage,
} from '@/lib/ai';
import { resolveCurrentProfileId } from '@/lib/ai-profile';

/** 会话内渲染块：来自持久化消息或实时流 */
interface StepBlock {
  tool: string;
  args?: Record<string, unknown>;
  ok?: boolean;
  output?: string;
  change?: FileChange;
  running?: boolean;
}

/**
 * 过程时间线节点：把「访问 / 思考 / 重试」当作正式节点排进消息流，
 * 按发生顺序出现、到点就定格成过去式——不再是一条钉在底部一直闪的状态条。
 */
interface PhaseNode {
  kind: 'phase';
  key: 'access' | 'think' | 'retry' | 'note';
  tone: 'info' | 'warn';
  active: boolean;
  attempt?: number;
  max?: number;
  /** note 节点的自定义文案（如「未调用工具但疑似未完成，已自动续跑」） */
  text?: string;
  /** 本节点的模型思考正文（reasoning_content / Anthropic thinking），可点击展开查看 */
  thinking?: string;
}
interface TextNode { kind: 'text'; text: string; }
interface StepNode { kind: 'step'; step: StepBlock; }
type TimelineItem = PhaseNode | TextNode | StepNode;

/** 定格所有进行中的过程节点（显示文案由 active 在渲染时派生，这里只翻状态） */
function freezePhases(items: TimelineItem[]): TimelineItem[] {
  let changed = false;
  const next = items.map((it) => {
    if (it.kind === 'phase' && it.active) { changed = true; return { ...it, active: false }; }
    return it;
  });
  return changed ? next : items;
}

/** 排队中的待发送指令 */
interface QueueItem {
  id: number;
  text: string;
}

/** 毫秒 → 「x分xx秒 / x秒」 */
function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}分${String(s % 60).padStart(2, '0')}秒` : `${s}秒`;
}

/** token 数 → 紧凑显示（最大 4 位有效数字级别，避免长数字撑破小字行） */
function fmtTokens(n: number): string {
  const v = Math.max(0, Math.round(Number(n) || 0));
  if (v < 1000) return String(v);
  if (v < 100000) return `${(v / 1000).toFixed(1)}K`;
  if (v < 1000000) return `${Math.round(v / 1000)}K`;
  return `${(v / 1000000).toFixed(2)}M`;
}

const ZERO_USAGE: TurnUsage = { input: 0, output: 0, cached: 0, cacheWrite: 0 };

/** 会话累计用量 = 各条消息的 usage 之和（每条保存的是「本轮增量」） */
function sumUsage(msgs: readonly AiMessage[]): TurnUsage {
  const acc = { ...ZERO_USAGE };
  for (const m of msgs) {
    const u = m.usage;
    if (!u) continue;
    acc.input += u.input || 0;
    acc.output += u.output || 0;
    acc.cached += u.cached || 0;
    acc.cacheWrite += u.cacheWrite || 0;
  }
  return acc;
}

/** 把增量并入累计（就地修改，供顺序遍历时边累加边渲染） */
function addUsage(acc: TurnUsage, u?: TurnUsage): void {
  if (!u) return;
  acc.input += u.input || 0;
  acc.output += u.output || 0;
  acc.cached += u.cached || 0;
  acc.cacheWrite += u.cacheWrite || 0;
}

/**
 * 会话 token 用量：输入 / 输出 / 缓存 / 缓存命中率。
 * 显示在「耗时」记录的左侧——一行放不下时自动折行，数字用等宽字体避免跳动。
 */
function UsageChips({ usage }: { usage: TurnUsage }) {
  if (!usage.input && !usage.output && !usage.cached) return null;
  const pct = usage.input > 0 ? Math.round((usage.cached / usage.input) * 100) : 0;
  const title = `本会话累计 —— 输入 ${usage.input} / 输出 ${usage.output} / 缓存命中 ${usage.cached}`
    + (usage.cacheWrite ? ` / 缓存写入 ${usage.cacheWrite}` : '')
    + `（缓存命中率 = 命中缓存 ÷ 输入）`;
  return (
    <span
      className="inline-flex flex-wrap items-baseline gap-x-2.5 gap-y-0 font-mono text-[10px] text-slate-400"
      title={title}
    >
      <span>输入 <b className="font-medium text-slate-500">{fmtTokens(usage.input)}</b></span>
      <span>输出 <b className="font-medium text-slate-500">{fmtTokens(usage.output)}</b></span>
      <span>缓存 <b className="font-medium text-teal-600">{fmtTokens(usage.cached)}</b></span>
      <span>命中 <b className="font-medium text-teal-600">{pct}%</b></span>
    </span>
  );
}

/** 最终答复下方的文件变更网格：一行两个，文件名 + 增删行数 */
function FileGrid({ changes }: { changes: FileChange[] }) {
  if (!changes.length) return null;
  return (
    <div className="mt-2 grid grid-cols-2 gap-1.5">
      {changes.map((c) => {
        const added = c.diff.filter((l) => l.t === '+').length;
        const removed = c.diff.filter((l) => l.t === '-').length;
        const name = c.path.split('/').pop() || c.path;
        return (
          <div
            key={c.path}
            title={`${c.kind === 'create' ? '新建' : '修改'}：${c.path}`}
            className="flex min-w-0 items-center gap-1.5 kk-inset-slot rounded-lg px-2 py-1.5"
          >
            <FileText className="h-3.5 w-3.5 shrink-0 text-slate-400" />
            <span className="min-w-0 flex-1 truncate text-[11px] text-slate-700">{name}</span>
            {c.kind === 'create' && (
              <span className="shrink-0 rounded bg-emerald-50 px-1 text-[10px] leading-4 text-emerald-600">新</span>
            )}
            <span className="shrink-0 font-mono text-[10px] text-emerald-600">+{added}</span>
            <span className="shrink-0 font-mono text-[10px] text-rose-600">-{removed}</span>
          </div>
        );
      })}
    </div>
  );
}

// ---------- diff 展示 ----------

function DiffView({ change }: { change: FileChange }) {
  const [open, setOpen] = useState(false);
  const added = change.diff.filter((l) => l.t === '+').length;
  const removed = change.diff.filter((l) => l.t === '-').length;
  return (
    <div className="mt-1.5 overflow-hidden kk-inset-slot rounded-lg">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-xs text-slate-600 hover:bg-slate-50"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        {change.kind === 'create' ? '新建' : '修改'}文件
        <code className="truncate font-mono text-[11px] text-slate-700">{change.path}</code>
        <span className="ml-auto shrink-0 font-mono text-[11px]">
          <span className="text-emerald-600">+{added}</span>{' '}
          <span className="text-rose-600">-{removed}</span>
        </span>
      </button>
      {open && (
        <div className="max-h-72 overflow-auto border-t border-slate-200/60 bg-slate-50 p-0 font-mono text-[11px] leading-5">
          {change.diff.map((l, i) => (
            <div
              key={i}
              className={cn(
                'whitespace-pre-wrap break-all px-2.5',
                l.t === '+' && 'bg-emerald-50 text-emerald-800',
                l.t === '-' && 'bg-rose-50 text-rose-800',
                l.t === '=' && 'text-slate-500',
              )}
            >
              <span className="mr-1.5 inline-block w-2 select-none opacity-60">{l.t === '=' ? ' ' : l.t}</span>
              {l.s}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- 工具步骤 ----------

const TOOL_LABEL: Record<string, string> = {
  list_dir: '列出目录',
  read_file: '读取文件',
  write_file: '写入文件',
  edit_file: '修改文件',
  search_text: '搜索文本',
};

function StepCard({ step }: { step: StepBlock }) {
  const [open, setOpen] = useState(false);
  const path = typeof step.args?.path === 'string' ? step.args.path : '';
  return (
    <div className="mt-1.5 overflow-hidden kk-inset-slot rounded-lg text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-slate-600 hover:bg-slate-50"
      >
        {step.running ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-teal-500" />
        ) : step.ok ? (
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
        ) : (
          <XCircle className="h-3.5 w-3.5 shrink-0 text-rose-500" />
        )}
        <span className="shrink-0 font-medium text-slate-700">{TOOL_LABEL[step.tool] || step.tool}</span>
        {path && <code className="truncate font-mono text-[11px] text-slate-500">{path}</code>}
        <ChevronRight className={cn('ml-auto h-3.5 w-3.5 shrink-0 transition-transform', open && 'rotate-90')} />
      </button>
      {open && step.output && (
        <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all border-t border-slate-200/60 bg-slate-50 px-2.5 py-1.5 font-mono text-[11px] leading-5 text-slate-600">
          {step.output}
        </pre>
      )}
      {step.change && <DiffView change={step.change} />}
    </div>
  );
}

// ---------- 过程节点（思考 / 上游瞬断重试）----------

/**
 * 单个过程节点：进行中闪烁、过了就定格成过去式，位置不漂移。
 * 若该节点带有模型思考正文（thinking），可点击展开 / 收起查看思考内容。
 */
function PhaseChip({ node }: { node: PhaseNode }) {
  const [open, setOpen] = useState(false);
  const active = node.active;
  const thinking = String(node.thinking || '');
  const hasThinking = thinking.length > 0;
  let text: string;
  if (node.text) {
    // 落库的过程节点自带完整文案（如「上游瞬断 · 已自动重试 2 次 · 已恢复」）
    text = node.text;
  } else if (node.key === 'note') {
    text = '已自动续跑';
  } else if (node.key === 'retry') {
    text = active
      ? `上游瞬断，自动重试中（${node.attempt ?? '?'}/${node.max ?? '?'}）…`
      : `上游瞬断 · 已自动重试 ${node.attempt ?? 0} 次 · 已恢复`;
  } else if (node.key === 'access') {
    text = active ? '正在访问上游…' : '已连接上游';
  } else {
    text = active ? '正在思考…' : '思考完成';
  }
  // 有思考正文时补上字数，让用户一眼知道「展开是有东西可看的」
  if (hasThinking) text = `${text} · ${thinking.length} 字`;

  const Icon = active ? (node.key === 'retry' ? RefreshCw : Loader2) : node.key === 'note' ? RotateCcw : Check;
  const chipClass = cn(
    'inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-left text-[11px]',
    active
      ? (node.tone === 'warn'
        ? 'border-amber-200 bg-amber-50 text-amber-600'
        : 'border-teal-200 bg-teal-50 text-teal-600')
      : 'border-slate-200/70 bg-slate-50 text-slate-400',
    hasThinking && 'cursor-pointer hover:border-slate-300 hover:text-slate-500',
  );
  const inner = (
    <>
      <Icon className={cn('h-3 w-3 shrink-0', active && 'animate-spin')} />
      <span className={cn('truncate', active && 'kk-blink')} title={text}>{text}</span>
      {hasThinking && (
        <ChevronDown className={cn('h-3 w-3 shrink-0 transition-transform', open && 'rotate-180')} />
      )}
    </>
  );

  return (
    <div className="mt-1.5">
      {hasThinking ? (
        <button
          type="button"
          className={chipClass}
          onClick={() => setOpen((v) => !v)}
          title={open ? '收起思考过程' : '展开查看思考过程'}
        >
          {inner}
        </button>
      ) : (
        <div className={chipClass} title={text}>{inner}</div>
      )}
      {hasThinking && open && (
        <div className="kk-inset-slot mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-[11px] leading-relaxed text-slate-500">
          {thinking}
        </div>
      )}
    </div>
  );
}

// ---------- 上游配置中心 ----------

const EMPTY_PROFILE: AiProfile = {
  id: '', name: '', protocol: 'openai', baseUrl: '', apiPath: '', apiKey: '',
  model: '', reasoning: '', maxTokens: 4096, timeoutMs: 120000, retryCount: 5,
};

/** 常用预设：一键填协议 + 地址 */
const PRESETS: { label: string; protocol: 'openai' | 'anthropic'; baseUrl: string }[] = [
  { label: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com' },
  { label: 'Anthropic', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com' },
  { label: '智谱 GLM', protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { label: 'Kimi (Moonshot)', protocol: 'openai', baseUrl: 'https://api.moonshot.cn/v1' },
  { label: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com' },
  { label: '火山引擎方舟', protocol: 'openai', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
  { label: 'MiniMax', protocol: 'openai', baseUrl: 'https://api.minimax.chat/v1' },
];

type TestStatus = { state: 'idle' | 'testing' | 'ok' | 'fail'; detail?: string };

function ProfileDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [profiles, setProfiles] = useState<AiProfile[]>([]);
  const [activeId, setActiveId] = useState('');
  const [view, setView] = useState<'list' | 'edit'>('list');
  const [draft, setDraft] = useState<AiProfile>({ ...EMPTY_PROFILE });
  const [busy, setBusy] = useState('');
  /** 模型列表拉取的在途标记：用 ref 而非 busy，因为「失焦自动拉取」会先于按钮点击执行，此时 state 还没更新 */
  const loadingModels = useRef(false);
  /** 提交中标记：同理，「保存」与「保存并测试」的 disabled 依赖 busy，快速双击仍可能两次都读到旧值 */
  const savingRef = useRef(false);
  const [tip, setTip] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [modelsOpenSignal, setModelsOpenSignal] = useState(0);
  const [testStatus, setTestStatus] = useState<Record<string, TestStatus>>({});

  const reload = useCallback(async () => {
    try {
      const r = await aiApi.listProviders();
      setProfiles(r.profiles);
      setActiveId(r.activeId);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (open) { reload(); setView('list'); setDraft({ ...EMPTY_PROFILE }); setTip(''); setModels([]); }
  }, [open, reload]);

  const patch = (p: Partial<AiProfile>) => setDraft((d) => ({ ...d, ...p }));

  const openEdit = (p: AiProfile | null) => {
    setDraft(p ? { ...p, apiKey: '' } : { ...EMPTY_PROFILE });
    setModels([]);
    setTip('');
    setView('edit');
  };

  /**
   * 保存草稿。新建返回新档案 id，更新返回原 id；失败返回 null。
   *
   * `andTest` 为真时顺带跑一次连接测试，结果记在列表卡片的测试状态里。
   */
  const save = async (andTest: boolean): Promise<string | null> => {
    if (savingRef.current) return null;
    if (!draft.name.trim()) { setTip('请填写显示名称'); return null; }
    savingRef.current = true;
    setBusy('save');
    try {
      const saved = draft.id
        ? (await aiApi.updateProvider(draft.id, draft)).profile
        : (await aiApi.saveProvider(draft)).profile;
      /*
       * 新建成功后必须把 id 回写进草稿。
       *
       * 不回写的话 draft.id 一直是空串：之后再点一次「保存」或「保存并测试」，
       * `draft.id ? update : create` 会再次走「新建」分支，于是同一个地址、同一把密钥、
       * 同一个模型被反复插成多份完全一样的档案。
       * 顺带清掉明文密钥——它已经存到服务端了，且后端约定「空密钥 = 未修改，保留已存密钥」。
       */
      setDraft((d) => ({ ...d, id: saved.id, hasKey: saved.hasKey ?? d.hasKey, apiKey: '' }));
      await reload();
      if (andTest) {
        setTestStatus((s) => ({ ...s, [saved.id]: { state: 'testing' } }));
        const t0 = Date.now();
        try {
          const r = await aiApi.testProvider({ ...draft, id: saved.id });
          const ms = Date.now() - t0;
          setTestStatus((s) => ({ ...s, [saved.id]: r.ok
            ? { state: 'ok', detail: `${ms}ms` }
            : { state: 'fail', detail: (r.message || '失败').slice(0, 80) } }));
        } catch (err) {
          setTestStatus((s) => ({ ...s, [saved.id]: { state: 'fail', detail: (err instanceof Error ? err.message : '失败').slice(0, 80) } }));
        }
      }
      return saved.id;
    } catch (err) {
      setTip(err instanceof Error ? err.message : '保存失败');
      return null;
    } finally {
      savingRef.current = false;
      setBusy('');
    }
  };

  const testProfile = async (p: AiProfile) => {
    setTestStatus((s) => ({ ...s, [p.id]: { state: 'testing' } }));
    const t0 = Date.now();
    try {
      const r = await aiApi.testProvider({ ...p, id: p.id });
      const ms = Date.now() - t0;
      setTestStatus((s) => ({ ...s, [p.id]: r.ok
        ? { state: 'ok', detail: `${ms}ms` }
        : { state: 'fail', detail: (r.message || '失败').slice(0, 80) } }));
    } catch (err) {
      setTestStatus((s) => ({ ...s, [p.id]: { state: 'fail', detail: (err instanceof Error ? err.message : '失败').slice(0, 80) } }));
    }
  };

  /**
   * 拉取上游模型列表。override 用于把「刚输入、draft 还没跟上」的值喂进来（密钥失焦自动拉取时用）。
   * 地址与密钥先在前端拦一道并给出可操作提示，不然得把草稿发到后端才被告知缺什么。
   */
  const loadModels = async (override?: Partial<AiProfile>) => {
    if (loadingModels.current) return; // 失焦自动拉取与手动点击可能撞在一起，挡住第二次
    const d = { ...draft, ...override };
    if (!d.baseUrl.trim()) { setTip('请先填写服务器地址（或点上方厂商预设一键填入）'); return; }
    if (!(d.apiKey?.trim() || d.hasKey)) { setTip('请先填写 API Key，再拉取模型列表'); return; }
    loadingModels.current = true;
    setBusy('models');
    setTip('正在拉取模型列表…');
    try {
      const r = await aiApi.fetchModels(d);
      if (r.ok && r.models?.length) {
        setModels(r.models);
        setTip(`已拉取 ${r.models.length} 个模型，可在「模型名称」里选择`);
        setModelsOpenSignal((n) => n + 1);
      } else {
        setTip(r.message?.slice(0, 100) || '未拉取到模型列表，可手动输入模型名');
      }
    } catch (err) {
      setTip((err instanceof Error ? err.message : '拉取失败').slice(0, 100));
    } finally {
      loadingModels.current = false;
      setBusy('');
    }
  };

  /**
   * 填完密钥离开输入框时自动拉一次模型列表，省掉「不知道模型该叫什么」这一步。
   * 仅当四件事同时成立才触发：地址已填、密钥刚填、模型还空着、此前没拉到过——避免反复打上游接口。
   */
  const autoLoadModels = (key: string) => {
    if (busy || !key.trim()) return;
    if (!draft.baseUrl.trim() || draft.model.trim() || models.length) return;
    void loadModels({ apiKey: key });
  };

  /**
   * 套用厂商预设：写显示名称 + 协议 + 地址，并清掉上一家残留的自定义路径与模型列表。
   * 名称只在用户还没填时补上，不覆盖用户自己起的名字。
   * 这些地址已经自带版本段（Kimi 的 /v1、智谱的 /api/paas/v4、方舟的 /api/v3……），
   * 请求路径留空即可——后端会按地址里的版本段推导，不会再重复补一层 /v1。
   */
  const applyPreset = (pre: (typeof PRESETS)[number]) => {
    patch({
      protocol: pre.protocol,
      baseUrl: pre.baseUrl,
      apiPath: '',
      ...(draft.name.trim() ? {} : { name: pre.label }),
    });
    setModels([]);
    setTip(`已套用 ${pre.label}：填好 API Key 后会自动拉取可用模型，选中即可保存`);
  };

  const copyProfile = async (p: AiProfile) => {
    try {
      await aiApi.copyProvider(p.id);
      await reload();
    } catch { /* ignore */ }
  };

  const removeProfile = async (p: AiProfile) => {
    if (!window.confirm(`删除「${p.name}」？`)) return;
    try {
      await aiApi.deleteProvider(p.id);
      await reload();
    } catch { /* ignore */ }
  };

  const activate = async (id: string) => {
    if (!id || id === activeId) return;
    await aiApi.activateProvider(id);
    await reload();
  };

  const statusLine = (p: AiProfile) => {
    const st = testStatus[p.id] || { state: 'idle' as const };
    if (st.state === 'testing') return { icon: <Loader2 className="h-3 w-3 animate-spin text-teal-500" />, text: '测试中', cls: 'text-slate-500' };
    if (st.state === 'ok') return { icon: <CheckCircle2 className="h-3 w-3 text-emerald-500" />, text: st.detail || '正常', cls: 'text-emerald-600' };
    if (st.state === 'fail') return { icon: <XCircle className="h-3 w-3 text-rose-500" />, text: st.detail || '失败', cls: 'text-rose-600' };
    return { icon: null, text: '未测试', cls: 'text-slate-400' };
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88dvh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{view === 'edit' ? (draft.id ? '编辑模型' : '添加模型') : '模型服务'}</DialogTitle>
        </DialogHeader>

        {view === 'list' ? (
          <div className="space-y-3">
            <div className="flex justify-end">
              <Button size="sm" onClick={() => openEdit(null)}><Plus className="h-3.5 w-3.5" /> 添加模型</Button>
            </div>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              {profiles.map((p) => {
                const st = statusLine(p);
                return (
                  <div
                    key={p.id}
                    className={cn(
                      'rounded-xl border bg-white/70 p-3',
                      p.id === activeId ? 'border-teal-400 ring-1 ring-teal-200' : 'border-slate-200',
                    )}
                  >
                    <div className="flex items-center gap-1.5">
                      <button type="button" className="min-w-0 flex-1 truncate text-left text-sm font-medium text-slate-800" title="点击设为当前" onClick={() => activate(p.id)}>
                        {p.name}
                      </button>
                      <span className="flex shrink-0 items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] text-slate-500">
                        <span className={cn('h-1.5 w-1.5 rounded-full', p.protocol === 'openai' ? 'bg-teal-500' : 'bg-amber-500')} />
                        {p.protocol === 'openai' ? 'OpenAI' : 'Anthropic'}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate text-xs text-slate-400">{p.model || '未设模型'}</div>
                    <div className={cn('mt-2 flex items-center gap-1 rounded-md bg-slate-100/80 px-2 py-1 text-[11px]', st.cls)}>
                      {st.icon}
                      <span className="truncate">{p.id === activeId ? '当前使用 · ' : ''}{st.text}</span>
                    </div>
                    <div className="mt-2 flex justify-center gap-1">
                      <Button variant="ghost" size="sm" className="h-7 px-2.5 text-xs" disabled={testStatus[p.id]?.state === 'testing'} onClick={() => testProfile(p)}>测试</Button>
                      <Button variant="ghost" size="sm" className="h-7 px-2.5 text-xs" onClick={() => openEdit(p)}>编辑</Button>
                      <Button variant="ghost" size="sm" className="h-7 px-2.5 text-xs" onClick={() => copyProfile(p)}>复制</Button>
                      <Button variant="ghost" size="sm" className="h-7 px-2.5 text-xs text-rose-500 hover:text-rose-600" onClick={() => removeProfile(p)}>删除</Button>
                    </div>
                  </div>
                );
              })}
              {!profiles.length && (
                <div className="col-span-full py-8 text-center text-sm text-slate-400">还没有模型服务，点右上「添加模型」</div>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((pre) => (
                <button
                  key={pre.label}
                  type="button"
                  title={`${pre.protocol === 'openai' ? 'OpenAI 兼容' : 'Anthropic'} 协议 · ${pre.baseUrl}`}
                  onClick={() => applyPreset(pre)}
                  className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs text-slate-600 hover:border-teal-300 hover:text-teal-700"
                >
                  {pre.label}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <label className="space-y-1 text-xs text-slate-500">
                <span>显示名称</span>
                <Input value={draft.name} onChange={(e) => patch({ name: e.target.value })} placeholder="例如：主力模型" />
              </label>
              <label className="space-y-1 text-xs text-slate-500">
                <span>请求协议</span>
                <Select value={draft.protocol} onValueChange={(v) => patch({ protocol: v as AiProfile['protocol'] })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="openai">OpenAI 兼容</SelectItem>
                    <SelectItem value="anthropic">Anthropic</SelectItem>
                  </SelectContent>
                </Select>
              </label>
              <label className="space-y-1 text-xs text-slate-500 sm:col-span-2">
                <span>服务器地址</span>
                <Input value={draft.baseUrl} onChange={(e) => patch({ baseUrl: e.target.value })} placeholder="https://api.openai.com" />
              </label>
              <label className="space-y-1 text-xs text-slate-500">
                <span>API Key</span>
                <Input
                  type="password"
                  value={draft.apiKey || ''}
                  onChange={(e) => patch({ apiKey: e.target.value })}
                  onBlur={(e) => autoLoadModels(e.target.value)}
                  placeholder={draft.hasKey ? '已保存' : 'sk-…'}
                />
              </label>
              <label className="space-y-1 text-xs text-slate-500">
                <span>请求路径（可选，留空按默认）</span>
                <Input value={draft.apiPath} onChange={(e) => patch({ apiPath: e.target.value })} placeholder="/v1/chat/completions" />
              </label>
              <label className="space-y-1 text-xs text-slate-500">
                <span>模型名称</span>
                <div className="flex gap-1.5">
                  <Combobox
                    className="min-w-0 flex-1"
                    value={draft.model}
                    onChange={(v) => patch({ model: v })}
                    options={models}
                    openSignal={modelsOpenSignal}
                    placeholder="gpt-4o"
                    emptyHint="先点「获取模型」，或直接手动输入"
                  />
                  <Button type="button" variant="outline" size="sm" className="h-9 shrink-0" disabled={busy !== ''} onClick={() => { void loadModels(); }}>
                    获取模型
                  </Button>
                </div>
              </label>
              <label className="space-y-1 text-xs text-slate-500">
                <span>思考强度</span>
                <Select value={draft.reasoning || 'off'} onValueChange={(v) => patch({ reasoning: v === 'off' ? '' : v as AiProfile['reasoning'] })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="off">不设置</SelectItem>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                  </SelectContent>
                </Select>
              </label>
              <label className="space-y-1 text-xs text-slate-500">
                <span>最大输出 Token</span>
                <Input type="number" value={draft.maxTokens} onChange={(e) => patch({ maxTokens: Number(e.target.value) })} placeholder="留空使用默认值" />
                {draft.reasoning ? (
                  <span className="block pt-0.5 text-[10px] leading-relaxed text-amber-600">
                    思考内容也计入这个上限。当前思考强度为 {draft.reasoning}，若额度太紧，模型会把预算耗在思考上、
                    不产出正文就中断（表现为「只有思考、没有回复」）。建议不低于 8192。
                  </span>
                ) : null}
              </label>
              <label className="space-y-1 text-xs text-slate-500">
                <span>超时（毫秒）</span>
                <Input type="number" value={draft.timeoutMs} onChange={(e) => patch({ timeoutMs: Number(e.target.value) })} />
              </label>
              <label className="space-y-1 text-xs text-slate-500">
                <span>失败重试（次）</span>
                <Input type="number" value={draft.retryCount} onChange={(e) => patch({ retryCount: Number(e.target.value) })} />
              </label>
              {draft.protocol === 'anthropic' && (
                <label className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50/60 px-2.5 py-2 text-xs text-slate-600 sm:col-span-2">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-teal-500"
                    checked={draft.promptCache !== false}
                    onChange={(e) => patch({ promptCache: e.target.checked })}
                  />
                  <span>提示词缓存（官方直连/稳定中转建议开，可省约 90% 输入费用；会改写请求的中转请关）</span>
                </label>
              )}
            </div>
            {tip && <div className="rounded-md bg-slate-100 px-2.5 py-1.5 text-xs text-slate-600">{tip}</div>}
            <div className="flex justify-end gap-2">
              {/* 两个保存按钮成功后都回到列表：一是避免停在编辑页被反复点，二是测试结果本就展示在列表卡片上 */}
              <Button variant="outline" size="sm" onClick={() => setView('list')}>取消</Button>
              <Button variant="outline" size="sm" disabled={busy !== ''} onClick={() => { void save(true).then((id) => { if (id) setView('list'); }); }}>保存并测试</Button>
              <Button size="sm" disabled={busy !== ''} onClick={() => { void save(false).then((id) => { if (id) setView('list'); }); }}>保存</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------- 主页面 ----------

export default function AIPage() {
  const [view, setView] = useState<'list' | 'chat'>('list');
  const [sessions, setSessions] = useState<AiSessionMeta[]>([]);
  const [activeId, setActiveId] = useState('');
  const [session, setSession] = useState<AiSessionFull | null>(null);
  const [running, setRunning] = useState(false);
  const [input, setInput] = useState('');
  const [configOpen, setConfigOpen] = useState(false);
  // 过程时间线：文本 / 工具卡 / 思考 / 重试 按发生顺序排列，到点定格
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [errorText, setErrorText] = useState('');
  /** 过程定格：本轮结束后状态条留在原位（已完成含恢复次数与耗时 / 执行中断） */
  const [turnOutcome, setTurnOutcome] = useState<{ kind: 'done' | 'error'; retries: number; durationMs?: number } | null>(null);
  /** 本会话累计 token 用量：base 来自落库消息（刷新后恢复），stream 来自本轮实时事件 */
  const [baseUsage, setBaseUsage] = useState<TurnUsage>({ ...ZERO_USAGE });
  const [streamUsage, setStreamUsage] = useState<TurnUsage | null>(null);
  const [profiles, setProfiles] = useState<AiProfile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState('');
  const [serverRunningIds, setServerRunningIds] = useState<string[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // —— 指令排队：running 期间发送的指令先进队列，本轮干净结束后自动派发队首 ——
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const queueRef = useRef<QueueItem[]>([]);
  const activeIdRef = useRef('');
  const seqRef = useRef(0);
  // —— 本轮实时耗时（秒），随 running 起止 ——
  const [elapsed, setElapsed] = useState(0);

  /**
   * 服务端是否仍在跑本轮。
   *
   * 关键：刷新网页 / 切走再回来时，本地 `running` 一定是 false（SSE 流挂在原来那次请求上，早就断了），
   * 但服务端可能还在正常执行。此时只能靠服务端**内存里的运行标记**判断，也就是 `runningIds`
   * （由 `GET /sessions` 与 `GET /sessions/:id` 的 `running` 同步而来）。少了这一层，就会出现
   * 「明明还在跑，界面却当成空闲、还允许下新指令」的假空闲。
   *
   * 为什么不直接用落库的 `session.status === 'running'`：进程异常退出时文件里会残留 running，
   * 而内存运行标记不会。以内存标记为准，才不会被残留状态卡住（列表接口的自愈逻辑同理）。
   */
  const serverRunning = !!activeId && serverRunningIds.includes(activeId);
  /** 「本轮正在进行」的唯一判定：本地有流 or 服务端在跑。UI 一律用它，不要再用裸 running */
  const busy = running || serverRunning;
  /** 当前要显示的会话累计用量：本轮有实时数据就用实时的，否则用落库累计 */
  const liveUsage = streamUsage ?? baseUsage;

  // 两种视图都注入全局置顶栏：会话视图多一个返回键，配置按钮始终在全局顶栏右上角
  usePageHeader(() => (
    view === 'chat'
      ? {
          title: session?.title || '对话',
          leading: (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0 text-slate-600 hover:bg-white/35"
              title="返回对话列表"
              aria-label="返回对话列表"
              onClick={backToList}
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
          ),
          actions: (
            <>
              {busy && <Loader2 className="mr-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-teal-500" />}
              <Button variant="ghost" size="icon" className="h-8 w-8" title="AI 上游配置" aria-label="AI 上游配置" onClick={() => setConfigOpen(true)}>
                <Settings2 className="h-4 w-4" />
              </Button>
            </>
          ),
        }
      : {
          title: 'AI',
          actions: (
            <Button variant="ghost" size="icon" className="h-8 w-8" title="AI 上游配置" aria-label="AI 上游配置" onClick={() => setConfigOpen(true)}>
              <Settings2 className="h-4 w-4" />
            </Button>
          ),
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [view, session?.title, busy]);

  const refreshSessions = useCallback(async () => {
    try {
      const r = await aiApi.listSessions();
      setSessions(r.sessions);
      setServerRunningIds(r.runningIds || []);
      return r;
    } catch { return null; }
  }, []);

  const loadProfiles = useCallback(async () => {
    try {
      const r = await aiApi.listProviders();
      setProfiles(r.profiles);
      setActiveProfileId(r.activeId);
    } catch { /* ignore */ }
  }, []);

  const currentProfileId = resolveCurrentProfileId(session?.profileId, activeProfileId, profiles.map((p) => p.id));
  const currentProfile = profiles.find((p) => p.id === currentProfileId) || null;

  /**
   * 切换本会话使用的模型服务。
   *
   * 两处都要写：`activateProvider` 更新全局「当前使用」（新建会话时取它），
   * `updateSession` 把档案记到本会话上（会话级优先，一个会话可以有自己的模型）。
   * 本地先乐观更新，菜单与按钮立刻反映选择；写库失败则回滚并明确报出来——
   * 此前这里是 `catch {}` 静默吞错，写入一旦失败，界面看着像已切换、刷新后却回到旧值，
   * 表现出来就是「选了不记忆」。
   */
  const switchProfile = async (id: string) => {
    if (!id || id === currentProfileId) return;
    const prevSession = session;
    setSession((prev) => (prev ? { ...prev, profileId: id } : prev));
    try {
      await aiApi.activateProvider(id);
      if (prevSession) await aiApi.updateSession(prevSession.id, { profileId: id });
      await loadProfiles();
    } catch (err) {
      setSession(prevSession);
      setErrorText(`切换模型失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /**
   * 模型配置弹窗的开合处理。
   *
   * 关闭时必须刷新主界面的档案列表与当前选中：弹窗里可能刚新增 / 删除 / 换过档案，
   * 不同步的话左下角的模型菜单仍是旧数据——刚添加的模型要刷新整个页面才看得见，
   * 用户只能再打开配置界面去选，这正是「左下角选不了自己的模型」的来源。
   */
  const onConfigOpenChange = (open: boolean) => {
    setConfigOpen(open);
    if (!open) {
      void loadProfiles();
      void refreshSessions();
    }
  };

  const loadSession = useCallback(async (id: string): Promise<AiSessionFull | null> => {
    try {
      const r = await aiApi.getSession(id);
      setSession(r.session);
      // 会话累计用量以落库消息为准（刷新 / 切回都靠它恢复）
      setBaseUsage(sumUsage(r.session.messages));
      // 顺带把服务端权威的运行标记同步进运行列表：刷新后靠它把界面恢复成「执行中」
      setServerRunningIds((prev) => {
        const has = prev.includes(id);
        if (r.running && !has) return [...prev, id];
        if (!r.running && has) return prev.filter((x) => x !== id);
        return prev;
      });
      return r.session;
    } catch { return null; }
  }, []);

  const clearLive = () => {
    setTimeline([]);
    setErrorText('');
    setTurnOutcome(null);
    // 实时用量归零：此后统一显示落库的会话累计，避免两套数字打架
    setStreamUsage(null);
  };

  useEffect(() => {
    refreshSessions();
    loadProfiles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // activeIdRef：供 driveStream 收尾时判断「是否仍停留在本会话」
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);

  // 本轮实时计时：running 开始时归零并逐秒递增
  useEffect(() => {
    if (!running) { setElapsed(0); return; }
    const t0 = Date.now();
    setElapsed(0);
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(t);
  }, [running]);

  // —— 排队指令管理 ——
  const enqueueCmd = (text: string) => {
    seqRef.current += 1;
    queueRef.current = [...queueRef.current, { id: seqRef.current, text }];
    setQueue(queueRef.current);
  };
  /** 撤回：把这条排队消息从队列移除 */
  const withdrawQueued = (id: number) => {
    queueRef.current = queueRef.current.filter((q) => q.id !== id);
    setQueue(queueRef.current);
  };
  /** 修改：从队列移除并把内容填回输入框 */
  const editQueued = (item: QueueItem) => {
    queueRef.current = queueRef.current.filter((q) => q.id !== item.id);
    setQueue(queueRef.current);
    setInput(item.text);
    taRef.current?.focus();
  };

  // 兜底派发：空闲 + 队列非空 + 会话无错误时自动派出队首
  // （覆盖：返回列表再回来、轮次收尾未接上、服务端跑完而本地早已脱离等场景）
  useEffect(() => {
    if (view !== 'chat' || busy || !activeId) return;
    if (session?.status === 'error') return; // 出错态不自动派发，等用户决定重发
    const next = queueRef.current[0];
    if (!next) return;
    queueRef.current = queueRef.current.slice(1);
    setQueue(queueRef.current);
    setSession((prev) => (prev ? { ...prev, messages: [...prev.messages, { role: 'user', content: next.text, time: Date.now() } as AiMessage] } : prev));
    void driveStream(activeId, 'run', next.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, activeId, busy, session?.status, queue]);

  // 对话内自动滚到底
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [session, timeline, view]);

  // 输入框自增高 + 跟随滚底
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
    el.scrollTop = el.scrollHeight;
  }, [input]);

  // 执行中定时刷新（服务器端进度回填；离开又回来的会话也靠这个收尾）
  // 注意：判断条件必须用「服务端在跑」而不是本地 running —— 刷新后本地 running=false，
  // 若只看本地就会完全不轮询，界面永远停在刷新那一刻的旧消息上。
  const needProgressPoll = view === 'chat' && !!activeId && !running && serverRunning;
  useEffect(() => {
    if (!needProgressPoll || !activeId) return;
    const t = setInterval(async () => {
      await loadSession(activeId);
      await refreshSessions();
    }, 2000);
    return () => clearInterval(t);
  }, [needProgressPoll, activeId, loadSession, refreshSessions]);

  // 列表视图：只要有会话在跑就轮询，任务结束/中断后状态点自动收掉（否则圈会一直转）
  const anySessionRunning = serverRunningIds.length > 0 || sessions.some((s) => s.status === 'running');
  useEffect(() => {
    if (view !== 'list' || !anySessionRunning) return;
    const t = setInterval(() => { void refreshSessions(); }, 3000);
    return () => clearInterval(t);
  }, [view, anySessionRunning, refreshSessions]);

  const openSession = async (id: string) => {
    setActiveId(id);
    clearLive();
    await loadSession(id);
    await refreshSessions();
    setView('chat');
  };

  const backToList = () => {
    if (running) {
      // 本地流脱离：服务端继续执行，回列表后由状态点展示
      abortRef.current?.abort();
      abortRef.current = null;
      setRunning(false);
    }
    clearLive();
    setView('list');
    refreshSessions();
  };

  const newSession = async () => {
    try {
      const r = await aiApi.createSession();
      await refreshSessions();
      setActiveId(r.session.id);
      setSession({ ...r.session, messages: [] });
      clearLive();
      setView('chat');
    } catch { /* ignore */ }
  };

  const removeSession = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm('删除该会话？历史消息不可恢复。')) return;
    try {
      await aiApi.deleteSession(id);
      await refreshSessions();
      if (id === activeId) { setSession(null); setActiveId(''); }
    } catch (err) {
      window.alert(err instanceof Error ? err.message : '删除失败');
    }
  };

  const renameSession = async (s: AiSessionMeta, e: React.MouseEvent) => {
    e.stopPropagation();
    const title = window.prompt('重命名会话', s.title);
    if (title === null || !title.trim()) return;
    try {
      await aiApi.renameSession(s.id, title.trim());
      await refreshSessions();
      if (s.id === activeId) setSession((prev) => (prev ? { ...prev, title: title.trim() } : prev));
    } catch { /* ignore */ }
  };

  // —— 过程时间线的写入原语：先定格旧节点，再把新节点按顺序追加/原地更新 ——
  /** 设置「当前进行中」的过程节点：队尾若已是进行中的节点则原地改写（省略中间态），否则定格旧的再追加 */
  const setPhase = (patch: { key: PhaseNode['key']; tone: PhaseNode['tone']; attempt?: number; max?: number }) => {
    setTimeline((t) => {
      const last = t[t.length - 1];
      if (last && last.kind === 'phase' && last.active) {
        return [...t.slice(0, -1), { kind: 'phase', active: true, ...patch }];
      }
      return [...freezePhases(t), { kind: 'phase', active: true, ...patch }];
    });
  };
  /** 写入思考增量：队尾进行中的节点就地转成「思考中」并累积正文；没有则新起一个思考节点 */
  const pushThinking = (delta: string) => {
    setTimeline((t) => {
      const arr = [...t];
      const last = arr[arr.length - 1];
      if (last && last.kind === 'phase' && last.active) {
        if (last.key === 'access' || last.key === 'retry') {
          // 「访问中 / 重试中」直接接替为「思考中」（重试重来的那次思考从零累计）
          arr[arr.length - 1] = { kind: 'phase', key: 'think', tone: 'info', active: true, thinking: delta };
        } else {
          arr[arr.length - 1] = { ...last, tone: 'info', thinking: (last.thinking || '') + delta };
        }
        return arr;
      }
      arr.push({ kind: 'phase', key: 'think', tone: 'info', active: true, thinking: delta });
      return arr;
    });
  };
  /** 写入正文：正文一开始就说明这一轮思考结束，把进行中的过程节点就地定格（不再闪烁） */
  const pushText = (delta: string) => {
    setTimeline((t) => {
      const arr = [...t];
      const last = arr[arr.length - 1];
      if (last && last.kind === 'phase' && last.active) {
        arr[arr.length - 1] = {
          ...last,
          key: last.key === 'access' ? 'think' : last.key,
          tone: last.key === 'retry' ? 'warn' : 'info',
          active: false,
        };
      }
      const tail = arr[arr.length - 1];
      if (tail && tail.kind === 'text') {
        arr[arr.length - 1] = { kind: 'text', text: tail.text + delta };
        return arr;
      }
      arr.push({ kind: 'text', text: delta });
      return arr;
    });
  };

  const driveStream = async (sessionId: string, action: 'run' | 'retry', text?: string) => {
    setRunning(true);
    clearLive();
    // 起点节点：正在访问上游（收到首个字节后原地转为「正在思考」）
    setTimeline([{ kind: 'phase', key: 'access', tone: 'info', active: true }]);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    // 过程记录：本流内累计的重试次数 / 是否出错 / 最终耗时
    let retries = 0;
    let hadError = false;
    let doneMs: number | undefined;
    try {
      const handler = (ev: AiStreamEvent) => {
        const toolName = typeof ev.tool === 'string' ? ev.tool : ev.tool?.name || '';
        switch (ev.type) {
          case 'delta':
            if (ev.text) pushText(ev.text);
            break;
          case 'thinking':
            // 模型思考正文增量：折叠在思考节点里，用户可点击展开
            if (ev.text) pushThinking(ev.text);
            break;
          case 'step_start':
            // 工具卡前先定格当前过程节点（思考完成），再把工具卡按顺序排进去
            setTimeline((t) => [...freezePhases(t), {
              kind: 'step',
              step: { tool: toolName, args: typeof ev.tool === 'object' ? ev.tool?.args : undefined, running: true },
            }]);
            break;
          case 'step_end':
            setTimeline((t) => {
              const arr = [...t];
              for (let i = arr.length - 1; i >= 0; i--) {
                const it = arr[i];
                if (it.kind === 'step' && it.step.running && it.step.tool === toolName) {
                  arr[i] = { kind: 'step', step: { ...it.step, running: false, ok: ev.ok, output: ev.output } };
                  break;
                }
              }
              return arr;
            });
            // 工具执行完，模型进入下一轮思考：把「正在思考」节点排在工具卡之后
            setPhase({ key: 'think', tone: 'info' });
            break;
          case 'file_change':
            setTimeline((t) => {
              const arr = [...t];
              for (let i = arr.length - 1; i >= 0; i--) {
                const it = arr[i];
                if (it.kind === 'step') { arr[i] = { kind: 'step', step: { ...it.step, change: ev.change } }; break; }
              }
              return arr;
            });
            break;
          case 'error':
            hadError = true;
            setErrorText(typeof ev.message === 'string' ? ev.message : (ev.message as { message?: string } | undefined)?.message || '执行出错');
            break;
          case 'step_retry':
            retries += 1;
            // 重试节点：就地接替当前进行中的过程节点，避免「已连接/思考」与「瞬断」同时出现
            setPhase({ key: 'retry', tone: 'warn', attempt: ev.attempt ?? retries, max: ev.max ?? 0 });
            break;
          case 'step_note':
            // 过程提示（如「未调用工具但疑似未完成，已自动续跑」）：定格记录，按发生顺序排进时间线
            setTimeline((t) => [...freezePhases(t), {
              kind: 'phase', key: 'note', tone: 'info', active: false,
              text: String(ev.text || '已自动续跑'),
            }]);
            break;
          case 'usage':
            // 本步用量到达：服务端已算好「会话累计」，直接显示即可（无需前端累加，也就不会算重）
            setStreamUsage(ev.session ?? null);
            break;
          case 'done':
            doneMs = (ev.message as AiMessage | undefined)?.durationMs;
            setTimeline((t) => freezePhases(t));
            break;
          default:
            break;
        }
      };
      if (action === 'run') await streamRun(sessionId, text || '', handler, ctrl.signal);
      else await streamRetry(sessionId, handler, ctrl.signal);
    } catch (err) {
      if (!ctrl.signal.aborted) { hadError = true; setErrorText(err instanceof Error ? err.message : '请求失败'); }
    } finally {
      abortRef.current = null;
      setRunning(false);
      await loadSession(sessionId);
      await refreshSessions();
      // 流内容已由持久化消息接管，清掉避免重复；过程状态条定格在原位置
      clearLive();
      if (!ctrl.signal.aborted) {
        setTurnOutcome(hadError
          ? { kind: 'error', retries }
          : { kind: 'done', retries, durationMs: doneMs });
      }
    }
  };

  /** 发送：空闲直接执行；执行中 / 已有排队 → 进入排队队列 */
  const send = async () => {
    const text = input.trim();
    if (!text || !activeId) return;
    if (busy || queueRef.current.length > 0) {
      enqueueCmd(text);
      setInput('');
      return;
    }
    setInput('');
    setSession((prev) => (prev ? { ...prev, messages: [...prev.messages, { role: 'user', content: text, time: Date.now() } as AiMessage] } : prev));
    await driveStream(activeId, 'run', text);
  };

  const resendLast = async () => {
    if (busy || !session) return;
    // 本地乐观弹出尾部错误卡片，补回该用户消息
    setSession((prev) => {
      if (!prev) return prev;
      const msgs = [...prev.messages];
      while (msgs.length && msgs[msgs.length - 1].role === 'assistant' && msgs[msgs.length - 1].isError) msgs.pop();
      return { ...prev, messages: msgs };
    });
    await driveStream(session.id, 'retry');
  };

  const stop = async () => {
    abortRef.current?.abort();
    if (activeId) { try { await aiApi.stopSession(activeId); } catch { /* ignore */ } }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  /** 最后一条用户消息是否可长按重发（会话处于出错态即可，具体路径由后端 retry 决定） */
  const lastUserErrorIndex = (msgs: AiMessage[]): number => {
    if (busy || session?.status !== 'error') return -1;
    const last = msgs[msgs.length - 1];
    if (!last) return -1;
    if (last.role === 'user') return msgs.length - 1;
    if (last.role === 'assistant' && last.isError) {
      const prev = msgs[msgs.length - 2];
      return prev?.role === 'user' ? msgs.length - 2 : -1;
    }
    return -1; // 断点在工具步骤后：用错误卡片上的「重试」按钮触发
  };

  const renderMessages = (msgs: AiMessage[]) => {
    const retryableIdx = lastUserErrorIndex(msgs);
    // 顺序累加会话用量：每个渲染分支前先并入本条消息的 usage，
    // 于是「本轮答复的耗时行」上显示的就是**截至该轮**的本会话累计。
    const acc: TurnUsage = { ...ZERO_USAGE };
    return (
      <>
        {msgs.map((m, i) => {
          addUsage(acc, m.usage);
          if (m.role === 'user') {
            const retryable = i === retryableIdx;
            return (
              <div key={i} className="mb-3 flex justify-end">
                <div
                  role={retryable ? 'button' : undefined}
                  tabIndex={retryable ? 0 : undefined}
                  title={retryable ? '长按重发这条消息' : undefined}
                  className={cn(
                    'max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-teal-500 px-3.5 py-2 text-sm text-white shadow-sm md:max-w-[70%]',
                    retryable && 'select-none opacity-80 ring-2 ring-rose-300',
                  )}
                  onContextMenu={(e) => { if (retryable) e.preventDefault(); }}
                  onPointerDown={(e) => {
                    if (!retryable || e.button !== 0) return;
                    pressTimer.current = setTimeout(() => {
                      pressTimer.current = null;
                      if (window.confirm('这条消息上次执行出错了，重发吗？')) resendLast();
                    }, 550);
                  }}
                  onPointerUp={(() => { if (pressTimer.current) { clearTimeout(pressTimer.current); pressTimer.current = null; } })}
                  onPointerLeave={() => { if (pressTimer.current) { clearTimeout(pressTimer.current); pressTimer.current = null; } }}
                >
                  {m.content}
                </div>
              </div>
            );
          }
          if (m.role === 'tool') {
            return <StepCard key={i} step={{ tool: m.toolName || 'tool', ok: m.toolOk, output: m.content, change: m.change }} />;
          }
          // 落库的过程节点（思考完成 / 上游瞬断重试 / 自动续跑）：刷新网页后依然按顺序定格在原位
          if (m.note) {
            return (
              <div key={i} className="mb-0.5">
                <PhaseChip
                  node={{
                    kind: 'phase',
                    key: m.noteKind || 'note',
                    tone: m.noteKind === 'retry' ? 'warn' : 'info',
                    active: false,
                    text: m.note,
                    thinking: m.thinking,
                  }}
                />
              </div>
            );
          }
          if (m.isError) {
            return (
              <div key={i} className="mb-3 flex gap-2">
                <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-rose-600 text-white">
                  <XCircle className="h-3.5 w-3.5" />
                </div>
                <div className="min-w-0 flex-1 break-all rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-xs text-rose-700">
                  {m.content.replace(/^⚠️\s*执行出错：?/, '')}
                  {!busy && (
                    <button
                      type="button"
                      onClick={resendLast}
                      className="ml-2 inline-flex items-center gap-0.5 rounded-md border border-rose-300 bg-white px-1.5 py-0.5 text-[11px] font-medium text-rose-600 hover:bg-rose-100"
                    >
                      <RotateCcw className="h-3 w-3" /> 重试
                    </button>
                  )}
                </div>
              </div>
            );
          }
          // 工具步骤前的空叙述（收紧提示词后模型直接给调用、不再铺垫）：不渲染空气泡，紧跟的工具卡自会呈现
          if (!m.content && m.toolCalls?.length) return null;
          return (
            <div key={i} className="mb-3 flex gap-2">
              <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-800 text-white">
                <Bot className="h-3.5 w-3.5" />
              </div>
              <div className="min-w-0 flex-1">
                {m.content ? <MarkdownContent markdown={m.content} className="text-sm" /> : null}
                {m.changes && m.changes.length > 0 && <FileGrid changes={m.changes} />}
                {!!m.durationMs && (
                  <div className="mt-1 flex flex-wrap items-baseline gap-x-3">
                    {/* 本会话累计 token 用量：放在「耗时」记录的左侧 */}
                    <UsageChips usage={acc} />
                    <span className="ml-auto shrink-0 font-mono text-[10px] text-slate-300">耗时 {fmtDuration(m.durationMs)}</span>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </>
    );
  };

  // ---------- 会话列表视图 ----------
  if (view === 'list') {
    return (
      <div className="kk-card flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between px-3 py-2.5">
          <div className="text-sm font-medium text-slate-700">对话</div>
          <Button size="sm" onClick={newSession}><Plus className="h-3.5 w-3.5" /> 新建会话</Button>
        </div>
        <div className="no-scrollbar min-h-0 flex-1 space-y-1 overflow-y-auto px-2.5 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {sessions.map((s) => {
            const isRunning = serverRunningIds.includes(s.id) || s.status === 'running';
            return (
              <div
                key={s.id}
                role="button"
                tabIndex={0}
                onClick={() => openSession(s.id)}
                onKeyDown={(e) => { if (e.key === 'Enter') openSession(s.id); }}
                className="group flex cursor-pointer items-center gap-2.5 rounded-xl border border-transparent px-2.5 py-2.5 hover:border-slate-200/70 hover:bg-white/60"
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-800 text-white">
                  <Bot className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-sm text-slate-800">{s.title}</span>
                    {isRunning && <Loader2 className="h-3 w-3 shrink-0 animate-spin text-teal-500" />}
                    {s.status === 'error' && !isRunning && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-rose-500" title="上次执行出错" />}
                  </div>
                  <div className="truncate text-xs text-slate-400">
                    {new Date(s.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </div>
                </div>
                <button type="button" aria-label="重命名" className="shrink-0 p-1 text-slate-300 hover:text-slate-600 md:opacity-0 md:group-hover:opacity-100" onClick={(e) => renameSession(s, e)}>
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button type="button" aria-label="删除会话" className="shrink-0 p-1 text-slate-300 hover:text-rose-500 md:opacity-0 md:group-hover:opacity-100" onClick={(e) => removeSession(s.id, e)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
          {!sessions.length && (
            <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-800 text-white">
                <Bot className="h-6 w-6" />
              </div>
              <div className="text-xs text-slate-400">还没有对话，点上方「新建会话」开始</div>
            </div>
          )}
        </div>
        <ProfileDialog open={configOpen} onOpenChange={onConfigOpenChange} />
      </div>
    );
  }

  // ---------- 对话视图 ----------
  // 顶栏（返回 / 标题 / 配置）已并入全局置顶栏，这里不再自带顶栏
  return (
    <div className="kk-card flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-3 py-3 md:px-4">
        {!session || !session.messages.length ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-800 text-white">
              <Bot className="h-6 w-6" />
            </div>
            <div className="max-w-xs text-xs leading-5 text-slate-400">
              分析 plugins/、log/ 内容，连续创作与修改插件，改动逐文件展示差异。
            </div>
          </div>
        ) : (
          renderMessages(session.messages)
        )}

        {/* 过程时间线：文本、工具卡、思考/重试节点按发生顺序排列；到点就定格在原位置 */}
        {(timeline.length > 0 || errorText || busy || turnOutcome) && (
          <div className="mb-3 flex gap-2">
            <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-800 text-white">
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Bot className="h-3.5 w-3.5" />}
            </div>
            <div className="min-w-0 flex-1">
              {timeline.map((it, i) => {
                if (it.kind === 'text') return <MarkdownContent key={i} markdown={it.text} className="text-sm" />;
                if (it.kind === 'step') return <StepCard key={i} step={it.step} />;
                return <PhaseChip key={i} node={it} />;
              })}
              {errorText && (
                <div className="mt-1.5 break-all rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-xs text-rose-700">
                  {errorText}
                </div>
              )}
              {/* 实时耗时 + 会话累计 token：跟着最近内容走，不再有钉在底部的状态条。
                  上游每步回传 usage（OpenAI stream_options.include_usage / Anthropic message_delta），
                  因此这里会随流逐步刷新。 */}
              {running && (
                <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3">
                  <UsageChips usage={liveUsage} />
                  <span className="ml-auto shrink-0 font-mono text-[10px] text-slate-400" title="从接到指令到现在">
                    已执行 {fmtDuration(elapsed * 1000)}
                  </span>
                </div>
              )}
              {/* 刷新/切走再回来：本地已没有流，但服务端还在跑——明确告知，别让用户以为空闲了 */}
              {serverRunning && !running && (
                <div className="mt-1.5 inline-flex items-center gap-1.5 rounded-full border border-teal-200 bg-teal-50 px-2.5 py-1 text-[11px] text-teal-600">
                  <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                  <span className="kk-blink">服务端仍在执行本轮，进度每 2 秒自动同步（本轮实时增量需刷新前保持页面）</span>
                </div>
              )}
              {/* 过程定格：整轮结束后这一行留在末尾，取代之前一直闪烁的旧状态 */}
              {!busy && turnOutcome && (
                <div className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-slate-400">
                  {turnOutcome.kind === 'done' ? (
                    <>
                      <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-500" />
                      <span>
                        已完成
                        {turnOutcome.retries > 0 && `（瞬断已自动恢复 ${turnOutcome.retries} 次）`}
                        {turnOutcome.durationMs ? ` · 耗时 ${fmtDuration(turnOutcome.durationMs)}` : ''}
                      </span>
                    </>
                  ) : (
                    <>
                      <XCircle className="h-3 w-3 shrink-0 text-rose-500" />
                      <span>执行中断{turnOutcome.retries > 0 && `（已自动重试 ${turnOutcome.retries} 次仍未成功）`} · 可重试</span>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 输入区：整体一个容器，内部底部固定一行放模型按钮与发送键；执行中输入框保持可用（发送即排队） */}
      <div className="shrink-0 p-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] md:p-3">
        {queue.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-1.5">
            {queue.map((q) => (
              <div
                key={q.id}
                className="flex max-w-full items-center gap-1 rounded-full border border-teal-200 bg-teal-50/90 px-2.5 py-1 text-xs text-slate-600"
              >
                <span className="max-w-[14rem] truncate md:max-w-[24rem]" title={q.text}>{q.text}</span>
                <span className="shrink-0 text-[10px] text-teal-500">排队中</span>
                <button
                  type="button"
                  aria-label="修改这条排队消息"
                  title="取回输入框修改"
                  className="shrink-0 text-slate-400 hover:text-teal-600"
                  onClick={() => editQueued(q)}
                >
                  <Pencil className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  aria-label="撤回这条排队消息"
                  title="撤回"
                  className="shrink-0 text-slate-400 hover:text-rose-500"
                  onClick={() => withdrawQueued(q.id)}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="kk-input-slot flex-1 rounded-2xl">
          <Textarea
            ref={taRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            className="block max-h-32 min-h-[3rem] w-full resize-none overflow-y-auto no-scrollbar border-0 bg-transparent px-3 pt-2 text-sm leading-5 shadow-none focus-visible:ring-0"
            rows={2}
          />
          <div className="flex h-9 items-center justify-between px-1.5 pb-1">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 max-w-[10rem] gap-1.5 px-2 text-xs text-slate-600"
                  title={currentProfile
                    ? `当前：${currentProfile.name}${currentProfile.model ? ` · ${currentProfile.model}` : ''}`
                    : '选择模型服务'}
                  aria-label="选择模型服务"
                >
                  {currentProfile ? (
                    <>
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-teal-500" />
                      <span className="min-w-0 truncate">{currentProfile.name}</span>
                    </>
                  ) : (
                    <>
                      <Plus className="h-4 w-4" />
                      <span className="hidden md:inline">选择模型</span>
                    </>
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-72 min-w-[15rem] overflow-y-auto no-scrollbar">
                {profiles.length ? (
                  profiles.map((p) => (
                    <DropdownMenuItem key={p.id} className="gap-2 text-xs" onClick={() => void switchProfile(p.id)}>
                      <Check className={cn('h-3.5 w-3.5 shrink-0', p.id === currentProfileId ? 'text-emerald-500' : 'opacity-0')} />
                      <span className="min-w-0 flex-1 truncate">{p.name}</span>
                      <span className="shrink-0 text-[10px] text-slate-400">{p.model || '未设模型'}</span>
                    </DropdownMenuItem>
                  ))
                ) : (
                  <div className="px-2 py-3 text-center text-xs text-slate-400">还没有模型服务，先在下面添加一个</div>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem className="gap-2 text-xs" onClick={() => setConfigOpen(true)}>
                  <Settings2 className="h-3.5 w-3.5" /> 添加 / 管理模型服务…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              size="icon"
              className="h-7 w-7"
              variant={busy && !input.trim() ? 'outline' : 'default'}
              title={busy ? (input.trim() ? '加入排队' : '停止执行') : '发送'}
              aria-label={busy ? (input.trim() ? '加入排队' : '停止执行') : '发送'}
              disabled={busy ? false : (!input.trim() || !activeId)}
              onClick={() => {
                if (!busy) { void send(); return; }
                if (input.trim()) { void send(); } else { void stop(); }
              }}
            >
              {busy && !input.trim() ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </div>

      <ProfileDialog open={configOpen} onOpenChange={onConfigOpenChange} />
    </div>
  );
}
