import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

type PageToken = number | 'gap-l' | 'gap-r';

/** 生成带省略号的页码序列：页数 ≤7 全显示，否则首尾 + 当前页附近 + 省略号 */
function buildPages(current: number, total: number): PageToken[] {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const out: PageToken[] = [1];
  const left = Math.max(2, current - 1);
  const right = Math.min(total - 1, current + 1);
  if (left > 2) out.push('gap-l');
  for (let p = left; p <= right; p++) out.push(p);
  if (right < total - 1) out.push('gap-r');
  out.push(total);
  return out;
}

/**
 * 资源界面底部分页条：透明磨砂风格，随界面外观（模糊/透明度）联动。
 * - 页数 >1 才显示整条；
 * - 页数 >5 才显示「跳页输入框 + Go」。
 */
export function StorePagination({
  page,
  totalPages,
  onChange,
}: {
  page: number;
  totalPages: number;
  onChange: (next: number) => void;
}) {
  const [go, setGo] = useState('');
  if (totalPages <= 1) return null;

  const items = buildPages(page, totalPages);
  const showJump = totalPages > 5;

  const jump = () => {
    const n = Number.parseInt(go, 10);
    if (!Number.isFinite(n)) return;
    onChange(Math.min(totalPages, Math.max(1, n)));
    setGo('');
  };

  const circle =
    'inline-flex h-9 min-w-[2.25rem] items-center justify-center rounded-full border border-white/40 '
    + 'bg-white/15 px-2 text-sm text-slate-700 backdrop-blur-md transition-all duration-150 '
    + 'hover:bg-white/30 active:scale-95 disabled:pointer-events-none disabled:opacity-40';

  return (
    <nav
      aria-label="分页"
      className="flex flex-wrap items-center justify-center gap-1.5 pt-4"
    >
      <button
        type="button"
        aria-label="上一页"
        disabled={page <= 1}
        onClick={() => onChange(page - 1)}
        className={circle}
      >
        <ChevronLeft className="h-4 w-4" />
      </button>

      {items.map((it, i) =>
        it === 'gap-l' || it === 'gap-r' ? (
          <span key={`${it}-${i}`} className="select-none px-1 text-slate-400">…</span>
        ) : (
          <button
            key={it}
            type="button"
            aria-current={it === page ? 'page' : undefined}
            onClick={() => onChange(it)}
            className={cn(
              circle,
              it === page
                && 'border-teal-400/70 bg-teal-500/25 font-semibold text-teal-800 ring-1 ring-teal-400/50 hover:bg-teal-500/30',
            )}
          >
            {it}
          </button>
        ),
      )}

      <button
        type="button"
        aria-label="下一页"
        disabled={page >= totalPages}
        onClick={() => onChange(page + 1)}
        className={circle}
      >
        <ChevronRight className="h-4 w-4" />
      </button>

      {showJump ? (
        <span className="ml-1 inline-flex items-center gap-1.5">
          <input
            value={go}
            onChange={(e) => setGo(e.target.value.replace(/[^0-9]/g, ''))}
            onKeyDown={(e) => { if (e.key === 'Enter') jump(); }}
            inputMode="numeric"
            aria-label="跳转到页码"
            placeholder={String(page)}
            className="h-9 w-12 rounded-full border border-white/40 bg-white/15 text-center text-sm text-slate-700 outline-none backdrop-blur-md placeholder:text-slate-400 focus:border-teal-400/60 focus:bg-white/25 focus:ring-2 focus:ring-teal-500/20"
          />
          <button type="button" onClick={jump} className={cn(circle, 'px-3 font-medium')}>
            Go
          </button>
        </span>
      ) : null}
    </nav>
  );
}
