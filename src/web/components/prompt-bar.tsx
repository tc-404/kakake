import {
  isValidElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ComponentType,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { Check, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, FileText, Plus, Sparkles, Upload, X } from 'lucide-react';
import './prompt-bar.css';

/**
 * 会话输入框（React Bits 的 PromptBar，按本项目改造）。
 *
 * 与原版的三处差异，都是为了不额外拉依赖、并接进智能助手页：
 * 1. 不依赖 motion：SendGlyph 的箭头 → 方块形变由 rAF 自己驱动（见 useMorph），
 *    动画曲线用 easeInOutCubic 近似原版的 cubic-bezier(0.77,0,0.175,1)；
 * 2. 不依赖 @hugeicons：图标一律走项目已有的 lucide-react；
 * 3. 文本与附件可受控（value / attachments），因为智能助手页要接管这份状态
 *    （排队消息取回输入框、挂起文件的元信息等都在页面侧）。
 */

export interface PromptBarSource {
  key: string;
  name: string;
  description?: string;
  icon?: ReactNode | ComponentType<{ className?: string; style?: CSSProperties }>;
  attach?: boolean;
}

export interface PromptBarCommand {
  key: string;
  name: string;
  description?: string;
}

export interface PromptBarModel {
  key: string;
  name: string;
  tag?: string;
}

export interface PromptBarSendDetail {
  attachments: string[];
  model?: PromptBarModel;
  effort?: string;
}

export interface PromptBarProps {
  placeholder?: string;
  sources?: PromptBarSource[];
  commands?: PromptBarCommand[];
  models?: PromptBarModel[];
  defaultModel?: string;
  /** 受控的当前模型 key；不传则由组件自己记住选择 */
  modelKey?: string;
  onModelChange?: (key: string) => void;
  efforts?: string[];
  defaultEffort?: string;
  /** 受控的当前强度档位；不传则由组件自己记住选择（智能助手页用它跟模型服务的思考强度同步） */
  effort?: string;
  onEffortChange?: (effort: string) => void;
  /** 受控文本；不传则由组件自己持有 */
  value?: string;
  onValueChange?: (value: string) => void;
  /** 受控附件名（只显示名字，元信息留在调用方）；不传则由组件自己持有 */
  attachments?: string[];
  onRemoveAttachment?: (index: number) => void;
  /** 工具栏最左侧的额外按钮位（智能助手页用它放「管理模型服务」） */
  leadingTools?: ReactNode;
  busy?: boolean;
  onSend?: (text: string, detail: PromptBarSendDetail) => void;
  onStop?: () => void;
  onAttach?: () => string | string[] | void | Promise<string | string[] | void>;
  /**
   * 指令面板相关（由调用方注入状态与行为）：
   * - 模式（计划 / 问答，勾选制；都不勾选即默认）→ modePlan / modeAsk / onModeToggle
   * - 技能（Skill）：列表 + 导入 + 删除 → skills / onImportSkill / onDeleteSkill
   * - 添加文件（面板第一项）→ onAddFile
   */
  modePlan?: boolean;
  modeAsk?: boolean;
  onModeToggle?: (which: 'plan' | 'ask') => void;
  skills?: { name: string; displayName: string; description?: string; hasSkillMd?: boolean }[];
  /** 已被「加载」（勾选）的技能名；显示在输入框的技能标签里，仅作展示与卸载 */
  selectedSkills?: string[];
  onAddFile?: () => void;
  onImportSkill?: () => void;
  onDeleteSkill?: (name: string) => void;
  /** 点击技能列表项 = 切换「加载 / 卸载」该技能（默认不加载，勾选才注入 prompt） */
  onToggleSkill?: (name: string) => void;
  /**
   * 面板 / 悬浮窗 / 文字色。不传就走 CSS 默认值 —— 默认值读界面外观的
   * 卡片透明度 / 模糊度（--kk-card-alpha、--kk-blur）与全局配色 token，
   * 这样设置页怎么调输入框就跟着怎么变，波浪暗色下也自动是深玻璃。
   * 传了则按调用方的来（独立用途想要固定配色时用）。
   */
  background?: string;
  color?: string;
  menuBackground?: string;
  sparkColor?: string;
  sparkBoost?: number;
  width?: number;
  radius?: number;
  maxRows?: number;
  morphDuration?: number;
  squash?: number;
  tilt?: number;
  pressScale?: number;
  className?: string;
}

type Row = {
  key: string;
  name: string;
  description?: string;
  tag?: string;
  icon?: ReactNode | ComponentType<{ className?: string; style?: CSSProperties }>;
  attach?: boolean;
};
type Token = { kind: 'at' | 'slash'; query: string; start: number };
type Latest = Pick<
  PromptBarProps,
  'onSend' | 'onStop' | 'onAttach' | 'onEffortChange' | 'onAddFile' | 'onImportSkill' | 'onDeleteSkill' | 'onModeToggle' | 'onToggleSkill'
>;
type Spark = {
  x: number;
  y: number;
  r: number;
  vy: number;
  sway: number;
  phase: number;
  life: number;
  span: number;
};

interface SendGlyphProps {
  busy: boolean;
  morphDuration: number;
  squash: number;
  tilt: number;
}

const ARROW_UP = [12, 4.5, 18.5, 11, 14.25, 11, 14.25, 19.5, 9.75, 19.5, 9.75, 11, 5.5, 11];
const SQUARE = [12, 6, 18, 6, 18, 12, 18, 18, 6, 18, 6, 12, 6, 6];
const LINE = 22;
// 滑块首/末档的圆心距轨道边缘 = 圆形拖拽钮半径（20px/2），
// 这样拖到最左/最右时圆钮恰好贴住轨道两端，不再有空隙。
const EDGE = 10;

const DEFAULT_COMMANDS: PromptBarCommand[] = [];

const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const pathAt = (a: number[], b: number[], t: number) => {
  let d = '';
  for (let i = 0; i < a.length; i += 2) {
    d += `${i ? 'L' : 'M'}${mix(a[i], b[i], t).toFixed(2)} ${mix(a[i + 1], b[i + 1], t).toFixed(2)}`;
  }
  return `${d}Z`;
};

/** 原版 motion 的 cubic-bezier(0.77, 0, 0.175, 1)，这里用三次缓动近似：进出都平滑，观感一致 */
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

const parseToken = (draft: string): Token | null => {
  const m = /(^|\s)([@/])([\w-]*)$/.exec(draft);
  if (!m) return null;
  return { kind: m[2] === '@' ? 'at' : 'slash', query: m[3].toLowerCase(), start: m.index + m[1].length };
};

function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduce(mq.matches);
    const onChange = () => setReduce(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduce;
}

const renderIcon = (icon: Row['icon']) => {
  if (!icon) return null;
  if (isValidElement(icon)) return icon;
  const Icon = icon as ComponentType<{ className?: string }>;
  return <Icon className="prompt-bar__glyph-icon" />;
};

function SendGlyph({ busy, morphDuration, squash, tilt }: SendGlyphProps) {
  const reduce = usePrefersReducedMotion();
  const svgRef = useRef<SVGSVGElement>(null);
  const pathRef = useRef<SVGPathElement>(null);
  const current = useRef(busy ? 1 : 0);

  useEffect(() => {
    const target = busy ? 1 : 0;
    const from = current.current;
    const paint = (v: number, dir: number) => {
      pathRef.current?.setAttribute('d', pathAt(ARROW_UP, SQUARE, v));
      const goo = reduce ? 0 : Math.sin(v * Math.PI);
      const sx = 1 - squash * goo;
      if (svgRef.current) {
        svgRef.current.style.transform = goo
          ? `rotate(${dir * tilt * goo}deg) scale(${sx}, ${1 / sx})`
          : '';
      }
    };
    if (from === target) {
      paint(target, target > 0.5 ? 1 : -1);
      return undefined;
    }
    const dir = target > from ? 1 : -1;
    if (reduce) {
      current.current = target;
      paint(target, dir);
      return undefined;
    }
    let raf = 0;
    const t0 = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / Math.max(1, morphDuration));
      const v = mix(from, target, easeInOut(k));
      current.current = v;
      paint(v, dir);
      if (k < 1) raf = requestAnimationFrame(step);
      else current.current = target;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [busy, morphDuration, reduce, squash, tilt]);

  return (
    <svg
      ref={svgRef}
      className="prompt-bar__glyph"
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="currentColor"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
    >
      <path ref={pathRef} d={pathAt(ARROW_UP, SQUARE, current.current)} />
    </svg>
  );
}

export function PromptBar({
  placeholder = 'Ask anything',
  sources = [],
  commands = DEFAULT_COMMANDS,
  models = [],
  defaultModel = '',
  modelKey: modelKeyProp,
  onModelChange,
  efforts = [],
  defaultEffort = '',
  effort: effortProp,
  onEffortChange,
  value,
  onValueChange,
  attachments: attachmentsProp,
  onRemoveAttachment,
  leadingTools,
  busy = false,
  onSend,
  onStop,
  onAttach,
  modePlan = false,
  modeAsk = false,
  onModeToggle,
  skills = [],
  selectedSkills = [],
  onAddFile,
  onImportSkill,
  onDeleteSkill,
  onToggleSkill,
  background,
  color,
  menuBackground,
  sparkColor = '#b39dff',
  sparkBoost = 1,
  width = 400,
  radius = 16,
  maxRows = 5,
  morphDuration = 240,
  squash = 0.12,
  tilt = 8,
  pressScale = 0.96,
  className = '',
}: PromptBarProps) {
  const reduce = usePrefersReducedMotion();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const glowRef = useRef<HTMLSpanElement>(null);
  const sparkRef = useRef<HTMLCanvasElement>(null);
  const typing = useRef({ energy: 0, strokes: 0 });
  const boost = useRef(sparkBoost);
  boost.current = sparkBoost;
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const lastOpen = useRef<string | null>(null);
  const latest = useRef<Latest>({});
  latest.current = { onSend, onStop, onAttach, onEffortChange, onAddFile, onImportSkill, onDeleteSkill, onModeToggle, onToggleSkill };

  const [ownDraft, setOwnDraft] = useState('');
  const [ownFiles, setOwnFiles] = useState<string[]>([]);
  const [modelKey, setModelKey] = useState(defaultModel);
  const [plusOpen, setPlusOpen] = useState(false);
  const [cmdView, setCmdView] = useState<'root' | 'mode' | 'skills'>('root');
  const [modelOpen, setModelOpen] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  const [ownEffort, setOwnEffort] = useState(() => {
    const i = efforts.indexOf(defaultEffort);
    return i >= 0 ? efforts[i] : efforts[Math.max(0, Math.floor((efforts.length - 1) / 2))] ?? '';
  });
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);
  const [pressed, setPressed] = useState(false);

  const draft = value !== undefined ? value : ownDraft;
  const attachments = attachmentsProp ?? ownFiles;
  /** 文本受控时调用方才是真源，这里只回传；同理附件 */
  const setDraft = useCallback((next: string) => {
    if (value === undefined) setOwnDraft(next);
    onValueChange?.(next);
  }, [value, onValueChange]);
  const dropAttachment = useCallback((index: number) => {
    if (attachmentsProp) onRemoveAttachment?.(index);
    else setOwnFiles((a) => a.filter((_, j) => j !== index));
  }, [attachmentsProp, onRemoveAttachment]);

  const activeModelKey = modelKeyProp ?? modelKey;
  const model = models.find((m) => m.key === activeModelKey) ?? models[0];
  const token = dismissed ? null : parseToken(draft);
  const open = plusOpen ? 'commands' : (token?.kind ?? (modelOpen ? 'model' : effortOpen ? 'effort' : null));
  const query = plusOpen ? '' : (token?.query ?? '');
  const list = useMemo<Row[]>(() => {
    if (open === 'at') return sources.filter((s) => s.name.toLowerCase().includes(query));
    if (open === 'slash') return commands.filter((c) => c.name.replace(/^\//, '').toLowerCase().startsWith(query));
    if (open === 'model') return models;
    return [];
  }, [open, query, sources, commands, models]);
  const cursor = Math.min(active, Math.max(0, list.length - 1));
  const canSend = draft.trim().length > 0 || attachments.length > 0;
  const armed = busy || canSend;
  const level = effortProp ?? ownEffort;
  const effortIndex = Math.max(0, efforts.indexOf(level));
  const maxed = efforts.length > 1 && effortIndex === efforts.length - 1;

  const focusInput = () => inputRef.current?.focus({ preventScroll: true });
  const closeMenus = useCallback(() => {
    setPlusOpen(false);
    setCmdView('root');
    setModelOpen(false);
    setEffortOpen(false);
  }, []);

  useLayoutEffect(() => {
    const glow = glowRef.current;
    if (!glow || !open) return;
    const row = rowRefs.current[cursor];
    if (!row) {
      glow.style.opacity = '0';
      return;
    }
    const fresh = lastOpen.current !== open;
    lastOpen.current = open;
    if (fresh) glow.style.transition = 'none';
    glow.style.top = `${row.offsetTop}px`;
    glow.style.height = `${row.offsetHeight}px`;
    glow.style.opacity = '1';
    if (fresh) {
      void glow.offsetHeight;
      glow.style.transition = '';
    }
  }, [open, cursor, list]);
  useEffect(() => {
    if (!open) lastOpen.current = null;
  }, [open]);

  useEffect(() => {
    if (!plusOpen && !modelOpen && !effortOpen) return undefined;
    const onDown = (e: globalThis.PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) closeMenus();
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [plusOpen, modelOpen, effortOpen, closeMenus]);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = '0px';
    const max = LINE * maxRows;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }, [draft, maxRows]);

  useEffect(() => {
    const canvas = sparkRef.current;
    if (!maxed || reduce || !canvas) return undefined;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    typing.current.strokes = 0;
    let raf = 0;
    let last = performance.now();
    let w = 0;
    let h = 0;
    let due = 0;
    let speed = 1;
    let pulse = 0;
    const parts: Spark[] = [];
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      w = rect.width;
      h = rect.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const spawn = (burst: boolean) => {
      parts.push({
        x: Math.random() * w,
        y: burst ? h * (0.2 + Math.random() * 0.8) : h + 3,
        r: 0.9 + Math.random() * 1.1,
        vy: -(7 + Math.random() * 9),
        sway: (Math.random() - 0.5) * 10,
        phase: Math.random() * Math.PI * 2,
        life: burst ? Math.random() * 1.2 : 0,
        span: 2.4 + Math.random() * 2.4,
      });
    };
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const typed = typing.current;
      const gain = boost.current;
      typed.energy *= Math.exp(-dt / 0.8);
      pulse *= Math.exp(-dt / 0.16);
      if (typed.strokes > 0) {
        typed.strokes = 0;
        if (gain > 0) pulse = 1;
      }
      const energy = typed.energy * gain;
      speed += (1 + energy * 6 - speed) * (1 - Math.exp(-dt / 0.15));
      due += dt;
      while (due > 0.14) {
        due -= 0.14;
        if (parts.length < 30) spawn(false);
      }
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = sparkColor;
      ctx.shadowColor = sparkColor;
      ctx.shadowBlur = 6 + energy * 10 + pulse * 6;
      for (let i = parts.length - 1; i >= 0; i -= 1) {
        const p = parts[i];
        p.life += dt;
        if (p.life > p.span) {
          parts.splice(i, 1);
          continue;
        }
        const k = p.life / p.span;
        const twinkle = 0.7 + 0.3 * Math.sin((now / 160) * (1 + energy) + p.phase);
        p.y += p.vy * dt * speed;
        if (p.y < -4) {
          p.y = h + 3;
          p.x = Math.random() * w;
        }
        const edge = Math.min(1, Math.max(0, p.y / 14), Math.max(0, (h - p.y) / 14));
        ctx.globalAlpha = Math.min(1, Math.sin(k * Math.PI) * (0.9 + energy * 0.25) * twinkle) * edge;
        ctx.beginPath();
        ctx.arc(
          p.x + Math.sin((now / 900) * (1 + energy * 0.8) + p.phase) * p.sway,
          p.y,
          p.r * twinkle * (1 + energy * 0.35),
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
      raf = requestAnimationFrame(tick);
    };
    resize();
    for (let i = 0; i < 26; i += 1) spawn(true);
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      ctx.clearRect(0, 0, w, h);
    };
  }, [maxed, reduce, sparkColor]);

  const setEffort = (i: number) => {
    const next = Math.max(0, Math.min(efforts.length - 1, i));
    if (next === effortIndex) return;
    const label = efforts[next];
    // 受控时调用方才是真源，这里只回传
    if (effortProp === undefined) setOwnEffort(label);
    latest.current.onEffortChange?.(label);
  };
  const effortFromPointer = (e: PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const k = (e.clientX - rect.left - EDGE) / Math.max(1, rect.width - 2 * EDGE);
    setEffort(Math.round(k * (efforts.length - 1)));
  };
  const onEffortKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step =
      e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
    if (step) {
      e.preventDefault();
      setEffort(effortIndex + step);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setEffort(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setEffort(efforts.length - 1);
    } else if (e.key === 'Escape') {
      setEffortOpen(false);
      focusInput();
    }
  };
  const stepAt = (i: number) => `calc(${EDGE}px + (100% - ${EDGE * 2}px) * ${i / Math.max(1, efforts.length - 1)})`;
  // 填充到当前档：末档直接铺满 100%；其余铺到「该档圆心 + 圆钮半径(10px)」，让填充正好盖住圆钮。
  const fillAt = (i: number) => (i === efforts.length - 1 ? '100%' : `calc(${stepAt(i)} + 10px)`);

  const runAttach = () => {
    Promise.resolve(latest.current.onAttach?.()).then((files) => {
      if (!files) return;
      const names = Array.isArray(files) ? files : [files];
      if (attachmentsProp) return; // 受控：文件由调用方自己入列
      setOwnFiles((a) => [...a, ...names]);
    });
  };

  const pick = (row: Row) => {
    if (open === 'model') {
      if (modelKeyProp === undefined) setModelKey(row.key);
      onModelChange?.(row.key);
      setModelOpen(false);
      focusInput();
      return;
    }
    const head = token ? draft.slice(0, token.start) : draft;
    if (row.attach) {
      setDraft(head);
      runAttach();
    } else if (open === 'at') {
      setDraft(`${head}@${row.name} `);
    } else {
      setDraft(`${head}${row.name} `);
    }
    setPlusOpen(false);
    setDismissed(false);
    focusInput();
  };

  const send = () => {
    if (!canSend || busy) return;
    latest.current.onSend?.(draft.trim(), { attachments, model, effort: level });
    setDraft('');
    setOwnFiles([]);
    setDismissed(false);
    closeMenus();
    focusInput();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open && list.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((cursor + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length);
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault();
        pick(list[cursor]);
        return;
      }
    }
    if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        setDismissed(true);
        closeMenus();
      }
      return;
    }
    // 回车即换行，不触发发送；发送仅通过点击发送按钮（与后备输入框一致）
  };

  const down = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 || !armed) return;
    setPressed(true);
  };
  const up = () => setPressed(false);

  return (
    <div
      ref={rootRef}
      className={`prompt-bar${className ? ` ${className}` : ''}`}
      data-busy={busy ? '' : undefined}
      data-max={maxed ? '' : undefined}
      style={
        {
          // 三个颜色不传就不写内联值：CSS 里的默认值读界面外观 token，
          // 设置页的卡片透明度 / 模糊度 / 全局配色即刻生效
          ...(background ? { '--pb-bg': background } : null),
          ...(color ? { '--pb-ink': color } : null),
          ...(menuBackground ? { '--pb-menu': menuBackground } : null),
          '--pb-w': `${width}px`,
          '--pb-radius': `${radius}px`,
          '--pb-spark': sparkColor,
          '--pb-press': pressScale,
        } as CSSProperties
      }
    >
      {open ? (
        <div
          className="prompt-bar__menu"
          role={open === 'effort' || open === 'commands' ? 'dialog' : 'listbox'}
          aria-label={
            open === 'at' ? '附件来源' : open === 'slash' ? '指令' : open === 'model' ? '模型服务' : open === 'commands' ? '指令面板' : '强度'
          }
          data-kind={open}
        >
          {open === 'commands' ? (
            <div className="prompt-bar__commands">
              {cmdView === 'root' ? (
                <>
                  {/* 第一项：添加文件（图标 + 四个字），直接触发文件选择 */}
                  <button
                    type="button"
                    className="prompt-bar__row prompt-bar__cmd-addfile"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      latest.current.onAddFile?.();
                      setPlusOpen(false);
                      focusInput();
                    }}
                  >
                    <span className="prompt-bar__row-icon"><FileText className="prompt-bar__glyph-icon" /></span>
                    <span className="prompt-bar__row-name">添加文件</span>
                  </button>

                  {/* 模式：下钻到子菜单 */}
                  <button
                    type="button"
                    className="prompt-bar__cmd-nav"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setCmdView('mode')}
                  >
                    <span className="prompt-bar__cmd-nav-name">模式</span>
                    <span className="prompt-bar__cmd-nav-meta">
                      {modePlan ? '计划' : modeAsk ? '问答' : '默认'}
                    </span>
                    <ChevronRight className="prompt-bar__cmd-nav-arrow" />
                  </button>

                  {/* 技能 Skill：下钻到子菜单；显示「已加载/总数」 */}
                  <button
                    type="button"
                    className="prompt-bar__cmd-nav"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setCmdView('skills')}
                  >
                    <span className="prompt-bar__cmd-nav-name">技能 Skill</span>
                    <span className="prompt-bar__cmd-nav-meta">
                      {selectedSkills.length}/{skills.length}
                    </span>
                    <ChevronRight className="prompt-bar__cmd-nav-arrow" />
                  </button>
                </>
              ) : null}

              {cmdView === 'mode' ? (
                <>
                  <button
                    type="button"
                    className="prompt-bar__cmd-back"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setCmdView('root')}
                  >
                    <ChevronLeft className="prompt-bar__cmd-back-arrow" />
                    返回
                  </button>
                  <div className="prompt-bar__cmd-section">
                    <div className="prompt-bar__cmd-section-title">模式</div>
                    <button
                      type="button"
                      className="prompt-bar__cmd-toggle"
                      data-on={modePlan ? '' : undefined}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => latest.current.onModeToggle?.('plan')}
                    >
                      <span className="prompt-bar__cmd-box">{modePlan ? <Check className="prompt-bar__glyph-icon" /> : null}</span>
                      <span className="prompt-bar__cmd-label">计划<span className="prompt-bar__cmd-sub">Plan</span></span>
                      <span className="prompt-bar__cmd-desc">只读不写 · 拟出计划</span>
                    </button>
                    <button
                      type="button"
                      className="prompt-bar__cmd-toggle"
                      data-on={modeAsk ? '' : undefined}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => latest.current.onModeToggle?.('ask')}
                    >
                      <span className="prompt-bar__cmd-box">{modeAsk ? <Check className="prompt-bar__glyph-icon" /> : null}</span>
                      <span className="prompt-bar__cmd-label">问答<span className="prompt-bar__cmd-sub">Ask</span></span>
                      <span className="prompt-bar__cmd-desc">只读 · 回答问题</span>
                    </button>
                  </div>
                </>
              ) : null}

              {cmdView === 'skills' ? (
                <>
                  <button
                    type="button"
                    className="prompt-bar__cmd-back"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setCmdView('root')}
                  >
                    <ChevronLeft className="prompt-bar__cmd-back-arrow" />
                    返回
                  </button>
                  <div className="prompt-bar__cmd-section-row">
                    <span className="prompt-bar__cmd-section-title">技能 Skill</span>
                    <button
                      type="button"
                      className="prompt-bar__cmd-import"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        latest.current.onImportSkill?.();
                        setPlusOpen(false);
                      }}
                    >
                      <Upload className="prompt-bar__glyph-icon" />
                      导入
                    </button>
                  </div>
                  {skills.length ? (
                    <div className="prompt-bar__cmd-skills">
                      {skills.map((s) => {
                        const on = selectedSkills.includes(s.name);
                        return (
                          <div key={s.name} className="prompt-bar__cmd-skill" data-on={on ? '' : undefined}>
                            <button
                              type="button"
                              className="prompt-bar__cmd-skill-main"
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => latest.current.onToggleSkill?.(s.name)}
                              title={s.description || s.displayName}
                            >
                              <span className="prompt-bar__cmd-box">{on ? <Check className="prompt-bar__glyph-icon" /> : null}</span>
                              <span className="prompt-bar__cmd-skill-name">{s.displayName}</span>
                            </button>
                            <button
                              type="button"
                              className="prompt-bar__cmd-skill-x"
                              aria-label={`删除 ${s.displayName}`}
                              title="删除"
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => latest.current.onDeleteSkill?.(s.name)}
                            >
                              <X className="prompt-bar__glyph-icon" />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="prompt-bar__cmd-empty">还没有导入技能，点右上角「导入」</div>
                  )}
                </>
              ) : null}
            </div>
          ) : open === 'effort' ? (
            <>
              <div className="prompt-bar__effort-head">
                <span className="prompt-bar__effort-title">强度</span>
                <span className="prompt-bar__effort-level">{level}</span>
                <span className="prompt-bar__effort-help" title="强度越高，回答前思考得越久">
                  <CircleHelp className="prompt-bar__glyph-icon" />
                </span>
              </div>
              <div className="prompt-bar__effort-ends">
                <span>更快</span>
                <span>更聪明</span>
              </div>
              <div
                className="prompt-bar__effort-track"
                role="slider"
                tabIndex={0}
                aria-label="强度"
                aria-valuemin={0}
                aria-valuemax={efforts.length - 1}
                aria-valuenow={effortIndex}
                aria-valuetext={level}
                style={
                  { '--pb-effort-x': stepAt(effortIndex), '--pb-effort-fill': fillAt(effortIndex) } as CSSProperties
                }
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  try {
                    e.currentTarget.setPointerCapture(e.pointerId);
                  } catch { /* 指针已释放等情况，忽略 */ }
                  e.currentTarget.focus({ preventScroll: true });
                  effortFromPointer(e);
                }}
                onPointerMove={(e) => {
                  if (e.buttons & 1) effortFromPointer(e);
                }}
                onKeyDown={onEffortKey}
              >
                <span className="prompt-bar__effort-fill" />
                {efforts.map((label, i) => (
                  <i key={label} className="prompt-bar__effort-dot" style={{ left: stepAt(i) }} />
                ))}
                <span className="prompt-bar__effort-thumb" />
              </div>
            </>
          ) : (
            <>
              <span ref={glowRef} className="prompt-bar__glow" aria-hidden="true" />
              {list.map((row, i) => (
                <button
                  key={row.key}
                  ref={(el) => {
                    rowRefs.current[i] = el;
                  }}
                  type="button"
                  role="option"
                  aria-selected={i === cursor}
                  className="prompt-bar__row"
                  onMouseDown={(e) => e.preventDefault()}
                  onPointerEnter={() => setActive(i)}
                  onClick={() => pick(row)}
                >
                  {open === 'at' ? <span className="prompt-bar__row-icon">{renderIcon(row.icon)}</span> : null}
                  <span className="prompt-bar__row-name">{row.name}</span>
                  {row.description ? <span className="prompt-bar__row-desc">{row.description}</span> : null}
                  {open === 'model' ? (
                    <>
                      <span className="prompt-bar__row-tag">{row.tag}</span>
                      <span className="prompt-bar__row-check" data-on={row.key === model?.key ? '' : undefined}>
                        <Check className="prompt-bar__glyph-icon" />
                      </span>
                    </>
                  ) : null}
                </button>
              ))}
              {list.length === 0 ? <div className="prompt-bar__empty">没有匹配项</div> : null}
            </>
          )}
        </div>
      ) : null}

      <div
        className="prompt-bar__field"
        role="presentation"
        data-max={maxed ? '' : undefined}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget || e.target === inputRef.current) closeMenus();
        }}
        onClick={(e) => {
          // 仅当点击的是输入区本身（文本框或空白区），或点击前文本框已处于输入态时，
          // 才让文本框获得焦点；点工具栏按钮（加号 / 模型 / 强度 / 发送 / 管理模型服务）
          // 不应触发输入态，除非原本就在输入态——否则一按按钮就把键盘焦点抢进文本框。
          const onField = e.target === e.currentTarget;
          const onInput = e.target === inputRef.current;
          const wasFocused = document.activeElement === inputRef.current;
          if (onField || onInput || wasFocused) focusInput();
        }}
      >
        <canvas ref={sparkRef} className="prompt-bar__sparks" aria-hidden="true" />
        {attachments.length > 0 ? (
          <div className="prompt-bar__chips">
            {attachments.map((file, i) => (
              <span key={`${file}-${i}`} className="prompt-bar__chip">
                <FileText className="prompt-bar__chip-icon" />
                <span className="prompt-bar__chip-name">{file}</span>
                <button
                  type="button"
                  className="prompt-bar__chip-x"
                  aria-label={`移除 ${file}`}
                  onClick={() => dropAttachment(i)}
                >
                  <X className="prompt-bar__chip-x-icon" />
                </button>
              </span>
            ))}
          </div>
        ) : null}

        {/* 已「加载」的技能：以标签形式显示在输入框内，点 × = 卸载（不再注入 prompt） */}
        {selectedSkills.length > 0 ? (
          <div className="prompt-bar__skill-chips">
            {selectedSkills.map((name) => {
              const meta = skills.find((x) => x.name === name);
              return (
                <span key={name} className="prompt-bar__chip prompt-bar__chip--skill" data-on="">
                  <Sparkles className="prompt-bar__chip-icon" />
                  <span className="prompt-bar__chip-name">{meta?.displayName ?? name}</span>
                  <button
                    type="button"
                    className="prompt-bar__chip-x"
                    aria-label={`卸载 ${meta?.displayName ?? name}`}
                    title="卸载（停止注入）"
                    onClick={() => latest.current.onToggleSkill?.(name)}
                  >
                    <X className="prompt-bar__chip-x-icon" />
                  </button>
                </span>
              );
            })}
          </div>
        ) : null}

        <textarea
          ref={inputRef}
          className="prompt-bar__input"
          rows={1}
          value={draft}
          placeholder={placeholder}
          aria-label="输入内容"
          onChange={(e) => {
            setDraft(e.target.value);
            typing.current.energy = Math.min(1.6, typing.current.energy + 0.22);
            typing.current.strokes = Math.min(4, typing.current.strokes + 1);
            setDismissed(false);
            closeMenus();
            setActive(0);
          }}
          /* 注意：这里绝不能挂 onFocus={closeMenus}。
           * 浏览器在按下输入区附近时会把焦点先调回文本框（FOCUSIN 先于 pointerdown），
           * 一挂就变成「悬浮窗刚展开就被同一次点击收掉」——强度滑块因此永远拖不动，
           * 行为还时好时坏（文本框已持有焦点时 focus 是空操作，菜单才侥幸留得住）。
           * 收起菜单交给 field 的 onPointerDown 与 textarea 的 onChange，路径是确定的。 */
          onKeyDown={onKeyDown}
        />

        <div className="prompt-bar__bar">
          {leadingTools}
          <button
            type="button"
            className="prompt-bar__tool prompt-bar__tool--plus"
            aria-label="指令面板"
            aria-expanded={plusOpen}
            data-on={plusOpen ? '' : undefined}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              // 加号 = 指令面板（添加文件 / 模式 / 技能 都是它的子菜单），不再直接弹文件框
              setModelOpen(false);
              setEffortOpen(false);
              setActive(0);
              const nv = !plusOpen;
              // 每次展开都回到根菜单（添加文件 / 模式 / 技能），由子菜单再下钻
              setCmdView('root');
              setPlusOpen(nv);
              // 注意：这里不能 focusInput() —— 文本框的 onFocus 是 closeMenus，
              // 刚展开的菜单会被同一次点击同步关掉（只有文本框已持有焦点时
              // focus() 才是空操作，菜单才侥幸留得住，行为于是时好时坏）。
            }}
          >
            <Plus className="prompt-bar__tool-icon" />
          </button>
          {models.length > 0 ? (
            <button
              type="button"
              className="prompt-bar__pick"
              aria-label="选择模型服务"
              aria-expanded={modelOpen}
              data-on={modelOpen ? '' : undefined}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setPlusOpen(false);
                setEffortOpen(false);
                setActive(Math.max(0, models.indexOf(model)));
                setModelOpen((v) => !v);
              }}
            >
              <span className="prompt-bar__pick-name">{model.name}</span>
              <ChevronDown className="prompt-bar__pick-icon" />
            </button>
          ) : null}
          {efforts.length > 0 ? (
            <button
              type="button"
              className="prompt-bar__pick"
              aria-label="选择思考强度"
              aria-expanded={effortOpen}
              data-on={effortOpen ? '' : undefined}
              data-max={maxed ? '' : undefined}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setPlusOpen(false);
                setModelOpen(false);
                setEffortOpen((v) => !v);
              }}
            >
              <Sparkles className="prompt-bar__pick-spark" />
              <span className="prompt-bar__pick-name">{level}</span>
            </button>
          ) : null}
          <span className="prompt-bar__spacer" />
          <button
            type="button"
            className="prompt-bar__send"
            disabled={!armed}
            aria-label={busy ? '停止' : '发送'}
            data-armed={armed ? '' : undefined}
            data-pressed={pressed ? '' : undefined}
            onMouseDown={(e) => e.preventDefault()}
            onPointerDown={down}
            onPointerUp={up}
            onPointerCancel={up}
            onPointerLeave={up}
            onClick={() => {
              if (busy) latest.current.onStop?.();
              else send();
            }}
          >
            <SendGlyph busy={busy} morphDuration={morphDuration} squash={squash} tilt={tilt} />
          </button>
        </div>
      </div>
    </div>
  );
}

export default PromptBar;
