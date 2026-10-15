import * as React from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * 咔咔珂自有下拉选择组件（可输入 + 可选项列表）。
 *
 * 为什么不用原生 <datalist>：原生列表由浏览器绘制，样式完全不可控，
 * 与项目的 kk-glass 玻璃拟态风格割裂。这里用自绘面板，视觉与 Select 一致，
 * 同时保留自由输入（未匹配选项时按用户输入原样提交）。
 */
export type ComboboxProps = {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder?: string;
  id?: string;
  className?: string;
  /** 列表为空时的占位文案 */
  emptyHint?: React.ReactNode;
  /** 数值变化即自动展开面板（用于「获取模型」成功后主动弹出列表） */
  openSignal?: number;
  /** 输入框右侧的附加操作（例如「获取模型」按钮）由父级渲染，这里只控制列表 */
  disabled?: boolean;
};

export function Combobox({
  value,
  onChange,
  options,
  placeholder,
  id,
  className,
  emptyHint,
  openSignal,
  disabled,
}: ComboboxProps) {
  const [open, setOpen] = React.useState(false);
  const [hover, setHover] = React.useState(-1);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const lastSignal = React.useRef(openSignal ?? 0);

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // 「获取模型」等外部动作完成后，凭信号主动展开面板
  React.useEffect(() => {
    if (openSignal && openSignal !== lastSignal.current) {
      lastSignal.current = openSignal;
      setOpen(true);
      setHover(-1);
    }
  }, [openSignal]);

  const filtered = React.useMemo(() => {
    const q = value.trim().toLowerCase();
    if (!q) return options;
    const hit = options.filter((o) => o.toLowerCase().includes(q));
    return hit.length ? hit : options;
  }, [options, value]);

  const choose = (v: string) => {
    onChange(v);
    setOpen(false);
    setHover(-1);
    inputRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      setOpen(true);
      return;
    }
    if (!open) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHover((h) => Math.min(h + 1, Math.max(filtered.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHover((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      if (hover >= 0 && filtered[hover]) {
        e.preventDefault();
        choose(filtered[hover]);
      } else {
        setOpen(false);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <div className="relative">
        <input
          id={id}
          ref={inputRef}
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(e) => {
            onChange(e.target.value);
            setOpen(true);
            setHover(-1);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          className={cn(
            'flex h-10 w-full rounded-xl border border-white/30 bg-white/20 px-3.5 py-2 pr-9 text-sm text-slate-800 outline-none transition-[background-color,border-color,box-shadow,opacity] duration-200',
            'backdrop-blur-sm placeholder:text-slate-500',
            'hover:bg-white/25',
            'focus:border-teal-400/50 focus:bg-white/30 focus:ring-2 focus:ring-teal-500/50',
            'disabled:cursor-not-allowed disabled:opacity-50',
          )}
        />
        <button
          type="button"
          tabIndex={-1}
          disabled={disabled}
          aria-label="展开模型列表"
          onClick={() => {
            setOpen((v) => !v);
            setHover(-1);
          }}
          className="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-white/40 hover:text-slate-600"
        >
          <ChevronDown className={cn('h-4 w-4 transition-transform duration-200', open && 'rotate-180')} />
        </button>
      </div>
      {open && (
        <div
          data-state="open"
          className="kk-glass-2 kk-glass-2-strong kk-pop no-scrollbar absolute z-50 mt-1.5 max-h-60 w-full overflow-y-auto overscroll-contain rounded-2xl p-1.5"
        >
          {filtered.length ? (
            filtered.map((o, i) => (
              <button
                key={o}
                type="button"
                onMouseEnter={() => setHover(i)}
                onClick={() => choose(o)}
                className={cn(
                  'flex w-full items-center rounded-xl px-3 py-2 text-left text-sm text-slate-700 transition-colors',
                  i === hover ? 'bg-teal-500/12 text-teal-900' : 'hover:bg-white/50',
                  o === value && 'font-medium text-teal-700',
                )}
              >
                <span className="truncate">{o}</span>
              </button>
            ))
          ) : (
            <div className="px-3 py-2 text-xs text-slate-400">{emptyHint ?? '无可选项，可直接输入'}</div>
          )}
        </div>
      )}
    </div>
  );
}
