import { useCallback, useEffect, useMemo, useState } from 'react';
import { Search, Loader2, ListRestart, SlidersHorizontal, Check } from 'lucide-react';
import { api } from '@/lib/api';
import { useT, useLang } from '@/lib/i18n';
import { proxyTitleEn, proxyParamLabelEn } from '@/lib/proxy-api-en';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { usePageHeader } from '@/components/header-actions';
import { PROTOCOL_BADGE_LABEL, type ProxyProtocol } from '../../proxy/proxy.types.js';

/**
 * 「接口代理」页（对齐资源商城的布局形态）。
 *
 * - 路由为页面级滚动（LazyPage 非 fixed，同 /plugin-store）：搜索框 sticky
 *   top-12 吸在顶栏正下方，滚动时始终可达；列表随页面自然滚动。
 * - 标题由顶栏承载；刷新 + 协议筛选入口也在顶栏。协议筛选是 DropdownMenu
 *   弹出（同商城分类菜单），勾选行「文字居左、勾选框居右」，AND 语义
 *  （同时包含所有勾选协议才显示），默认全不选；空分类自然不出现。
 * - 详情悬浮窗内不用表格：实现对照 / 请求参数都改成逐条卡片块，
 *   手机与电脑都是同一套自上而下的阅读流。
 * - 分类吸顶行与弹窗内色块全部读 --glass-bg-* 外观管控变量或白/黑透明度，
 *   不再有任何固定编码的实心色块；滚动条一律隐藏（no-scrollbar）。
 */

/* ─────────────────────── 与后端一致的条目形态 ─────────────────────── */

type ProxyParamSpec = {
  key: string;
  label?: string;
  type?: string;
  required?: boolean;
  sample?: unknown;
  desc?: string;
  only?: string[];
  idSpace?: string;
};

type ProxyVariantView = {
  action?: string;
  path?: string;
  verb?: string;
  notes?: string;
  stub?: boolean;
};

type ProxyImplView = {
  variantBy?: string;
  variants?: Record<string, ProxyVariantView>;
  notes?: string;
  stub?: boolean;
  sameAs?: string[];
};

type ProxyApiEntryView = {
  name: string;
  title: string;
  summary: string;
  category: string;
  scope: string;
  support: ProxyProtocol[];
  risk: 'read' | 'write' | 'danger';
  status: 'stable' | 'experimental' | 'stub';
  readOnly?: boolean;
  alias?: string[];
  notes?: string;
  params?: ProxyParamSpec[];
  impl?: Partial<Record<ProxyProtocol, ProxyImplView>>;
  examples?: {
    request?: Record<string, unknown>;
    success?: unknown;
    error?: unknown;
    byProtocol?: Partial<Record<ProxyProtocol, { request?: Record<string, unknown>; success?: unknown; error?: unknown }>>;
  };
};

/* ─────────────────────────── 小组件 ─────────────────────────── */

function ProtocolBadges({ support }: { support: ProxyProtocol[] }) {
  return (
    <span className="flex shrink-0 flex-wrap gap-1">
      {support.map((p) => (
        <Badge
          key={p}
          variant="outline"
          className={cn(
            'px-1.5 py-0 text-[10px] font-medium leading-tight',
            p === 'napcat' && 'border-teal-300 bg-teal-50 text-teal-700',
            p === 'snowluma' && 'border-violet-300 bg-violet-50 text-violet-700',
            p === 'official' && 'border-amber-300 bg-amber-50 text-amber-700',
          )}
        >
          {PROTOCOL_BADGE_LABEL[p]}
        </Badge>
      ))}
    </span>
  );
}

function RiskDot({ risk }: { risk: ProxyApiEntryView['risk'] }) {
  const t = useT();
  const cls = risk === 'danger'
    ? 'bg-rose-500'
    : risk === 'write' ? 'bg-amber-500' : 'bg-emerald-500';
  return (
    <span className="flex shrink-0 items-center gap-1 text-[11px] text-slate-500">
      <span className={cn('h-1.5 w-1.5 rounded-full', cls)} />
      {t(`proxyApi.risk.${risk}`)}
    </span>
  );
}

/** 代码 / JSON 内容框：black 透明度 + 模糊，跟随玻璃材质且不参与 slate 反相 */
function JsonBlock({ value }: { value: unknown }) {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? 'null';
  } catch {
    text = String(value);
  }
  return (
    <pre className="no-scrollbar max-h-64 overflow-auto rounded-xl border border-white/25 bg-black/55 p-3 text-[12px] leading-relaxed text-white/90 backdrop-blur-sm">
      <code>{text}</code>
    </pre>
  );
}

/** 请求参数卡：一个参数一块，自上而下阅读，手机/电脑同构（取代表格） */
function ParamCard({ p, t }: { p: ProxyParamSpec; t: (k: string, params?: Record<string, string | number | undefined>) => string }) {
  const lang = useLang();
  const sampleText = p.sample === undefined || p.sample === null || p.sample === ''
    ? ''
    : typeof p.sample === 'object' ? JSON.stringify(p.sample) : String(p.sample);
  return (
    <div className="rounded-xl border border-white/30 bg-white/15 p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <code className="font-mono text-xs font-medium text-slate-700">{p.key}</code>
        {p.required ? (
          <span className="rounded-full bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-medium text-rose-600">
            {t('proxyApi.colRequired')}
          </span>
        ) : null}
        {p.type ? (
          <span className="rounded-full bg-white/25 px-1.5 py-0.5 text-[10px] text-slate-500">{p.type}</span>
        ) : null}
        {p.only && p.only.length > 0 ? (
          <span className="ml-auto text-[10px] text-slate-400">{t('proxyApi.onlyFor', { list: p.only.join(' / ') })}</span>
        ) : null}
      </div>
      {p.label ? <div className="mt-1 text-xs text-slate-600">{lang === 'en' ? proxyParamLabelEn(p.label) : p.label}</div> : null}
      {sampleText ? (
        <div className="mt-1.5 break-all font-mono text-[11px] text-slate-600">
          <span className="text-slate-400">{t('proxyApi.colSample')}： </span>{sampleText}
        </div>
      ) : null}
      {p.desc ? <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{p.desc}</p> : null}
    </div>
  );
}

/** 协议实现对照卡：一个协议一块（取代表格） */
function ImplCard({ p, impl, t }: { p: ProxyProtocol; impl?: ProxyImplView; t: (k: string, params?: Record<string, string | number | undefined>) => string }) {
  const entries = impl?.variants ? Object.entries(impl.variants) : [];
  return (
    <div className="rounded-xl border border-white/30 bg-white/15 p-3">
      <div className="flex items-center gap-2">
        <Badge variant="outline" className="text-[10px]">{PROTOCOL_BADGE_LABEL[p]}</Badge>
      </div>
      {entries.length === 0 ? (
        <div className="mt-1.5 text-xs text-slate-400">—</div>
      ) : (
        <ul className="mt-1.5 flex flex-col gap-1">
          {entries.map(([k, v]) => (
            <li key={k} className="break-all font-mono text-[11px] text-slate-600">
              {entries.length > 1 ? <span className="text-slate-400">{k} → </span> : null}
              {v.action ?? `${v.verb ?? 'POST'} ${v.path ?? ''}`}
              {v.stub ? <span className="ml-1 text-amber-600">{t('proxyApi.stub')}</span> : null}
            </li>
          ))}
        </ul>
      )}
      {impl?.sameAs && impl.sameAs.length > 0 ? (
        <div className="mt-1.5 text-[11px] text-slate-400">
          {t('proxyApi.sameAs')}：{impl.sameAs.join('、')}
        </div>
      ) : null}
      {impl?.notes ? (
        <div className="mt-1 text-[11px] leading-relaxed text-slate-400">{impl.notes}</div>
      ) : null}
    </div>
  );
}

/** 详情弹窗内的子分类 */
type DetailTab = 'overview' | 'impl' | 'params' | 'examples';

/* ─────────────────────────── 页面 ─────────────────────────── */

export default function ProxyApiPage() {
  const t = useT();
  const lang = useLang();
  /** 展示标题：en 走英文覆盖层（未覆盖回退注册表原文），zh 走注册表原文 */
  const titleOf = (e: { name: string; title: string }) =>
    lang === 'en' ? proxyTitleEn(e.name, e.title) : e.title;
  const [items, setItems] = useState<ProxyApiEntryView[] | null>(null);
  const [error, setError] = useState('');
  const [keyword, setKeyword] = useState('');
  const [protocols, setProtocols] = useState<Set<ProxyProtocol>>(new Set());
  const [selected, setSelected] = useState('');
  const [tab, setTab] = useState<DetailTab>('overview');

  const load = useCallback(() => {
    setError('');
    setItems(null);
    api.proxyApis()
      .then((r) => setItems(r.items as unknown as ProxyApiEntryView[]))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => { load(); }, [load]);

  const all = items ?? [];

  // AND 语义：勾选了 N 个协议，就必须同时包含这 N 个才显示
  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return all.filter((e) => {
      if (protocols.size > 0 && ![...protocols].every((p) => e.support.includes(p))) return false;
      if (!kw) return true;
      return e.name.includes(kw)
        || e.title.toLowerCase().includes(kw)
        || (lang === 'en' && proxyTitleEn(e.name, e.title).toLowerCase().includes(kw))
        || (e.alias ?? []).some((a) => a.toLowerCase().includes(kw));
    });
  }, [all, keyword, protocols, lang]);

  // 按分类分组展示；分类顺序沿用注册表注册顺序，被过滤空的分类自然不出现
  const grouped = useMemo(() => {
    const map = new Map<string, ProxyApiEntryView[]>();
    for (const e of filtered) {
      const arr = map.get(e.category);
      if (arr) arr.push(e);
      else map.set(e.category, [e]);
    }
    return [...map.entries()];
  }, [filtered]);

  const current = useMemo(
    () => all.find((e) => e.name === selected) ?? null,
    [all, selected],
  );

  const toggleProtocol = (p: ProxyProtocol) => {
    setProtocols((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  };

  // 顶栏注入：刷新 + 协议筛选（DropdownMenu 弹出，同商城分类菜单）
  const headerBtnClass =
    'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-600 transition-colors hover:bg-white/35 disabled:opacity-50';
  usePageHeader(() => ({
    actions: (
      <>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              title={t('proxyApi.protocolFilter')}
              aria-label={t('proxyApi.protocolFilter')}
              className={cn(headerBtnClass, protocols.size > 0 && 'bg-teal-500/15 text-teal-700')}
            >
              <SlidersHorizontal className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <div className="flex items-center justify-between gap-2 px-2 pb-1 pt-1.5">
              <span className="text-xs font-medium text-slate-600">{t('proxyApi.protocolFilter')}</span>
              {protocols.size > 0 ? (
                <button
                  type="button"
                  className="text-[11px] text-slate-400 underline-offset-2 hover:text-slate-600 hover:underline"
                  onClick={() => setProtocols(new Set())}
                >
                  {t('proxyApi.filterReset')}
                </button>
              ) : null}
            </div>
            {(Object.keys(PROTOCOL_BADGE_LABEL) as ProxyProtocol[]).map((p) => {
              const active = protocols.has(p);
              return (
                <div
                  key={p}
                  role="menuitemcheckbox"
                  aria-checked={active}
                  onClick={() => toggleProtocol(p)}
                  className={cn(
                    'flex cursor-pointer select-none items-center gap-2.5 rounded-xl px-2 py-2 text-xs transition',
                    active ? 'bg-teal-500/15 text-teal-700' : 'text-slate-600 hover:bg-white/30',
                  )}
                >
                  <span className="font-medium">{PROTOCOL_BADGE_LABEL[p]}</span>
                  {/* 勾选框居右：kakake 风格自绘指示器（teal 填充 + 对勾），
                      不用原生 checkbox——传统方框质感与玻璃外观脱节 */}
                  <span
                    aria-hidden
                    className={cn(
                      'ml-auto flex h-5 w-5 shrink-0 items-center justify-center rounded-[0.45rem] border transition-all duration-200',
                      active
                        ? 'border-teal-400/80 bg-teal-500 text-white shadow-[0_2px_8px_rgb(13_148_136/0.35)]'
                        : 'border-white/40 bg-white/20',
                    )}
                  >
                    <Check
                      className={cn(
                        'h-3.5 w-3.5 transition-all duration-200',
                        active ? 'scale-100 opacity-100' : 'scale-50 opacity-0',
                      )}
                    />
                  </span>
                </div>
              );
            })}
            <DropdownMenuSeparator />
            <p className="px-2 py-1.5 text-[11px] leading-relaxed text-slate-400">{t('proxyApi.filterHint')}</p>
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          type="button"
          onClick={load}
          aria-label="reload"
          className={headerBtnClass}
        >
          <ListRestart className="h-4 w-4" />
        </button>
      </>
    ),
  }), [load, protocols, t]);

  const openDetail = (name: string) => {
    setSelected(name);
    setTab('overview');
  };

  const detailTabs: { key: DetailTab; label: string; visible: boolean }[] = [
    { key: 'overview', label: t('proxyApi.tabOverview'), visible: true },
    { key: 'impl', label: t('proxyApi.tabImpl'), visible: !!current?.impl },
    { key: 'params', label: t('proxyApi.tabParams'), visible: true },
    { key: 'examples', label: t('proxyApi.tabExamples'), visible: true },
  ];

  // 与商城完全同构的页面骨架：页面级滚动，搜索框 sticky top-12 吸在顶栏正下方
  return (
    <div className="mx-auto flex w-full flex-col gap-4 md:gap-5">
      {/* 搜索栏：吸顶（top-12 = 顶栏高度；z-10 低于顶栏 z-20），kk-field 单层材质，
          图标 z-[1] 叠在输入框背景之上 */}
      <div className="sticky top-12 z-10 shrink-0">
        <div className="relative min-w-0">
          <Search className="pointer-events-none absolute left-3 top-1/2 z-[1] h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder={t('proxyApi.searchPh')}
            className="kk-field h-10 w-full rounded-xl pl-9 pr-3 text-sm text-slate-800 outline-none placeholder:text-slate-500"
            aria-label={t('proxyApi.searchPh')}
          />
        </div>
      </div>

      {items === null && !error ? (
        <div className="flex items-center justify-center gap-2 py-20 text-sm text-slate-500">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : error ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-white/40 bg-white/15 py-16 text-center text-sm text-rose-600 backdrop-blur-md">
          <span>{t('proxyApi.loadFailed')}</span>
          <span className="text-xs text-slate-400">{error}</span>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-1 rounded-2xl border border-dashed border-white/40 bg-white/15 py-16 text-center backdrop-blur-md">
          <span className="text-sm text-slate-600">{t('proxyApi.listEmpty')}</span>
          <span className="text-xs text-slate-400">{t('proxyApi.listEmptyHint')}</span>
        </div>
      ) : (
        <section className="kk-glass rounded-[1.25rem]">
          <ul className="divide-y divide-white/20">
            {grouped.map(([cat, list], gi) => (
              <li key={cat}>
                {/* 分类吸顶行：top-[88px] = 顶栏 48 + 搜索框 40，正好贴在搜索栏下沿。
                    注意卡片不能加 overflow-hidden——它会把 sticky 劫持到一个
                    永不滚动的容器里，分类行就再也不吸顶了（首尾圆角改为逐元素补）。 */}
                <div
                  className={cn(
                    'sticky top-[88px] z-[5] border-b border-white/20 bg-[var(--glass-bg-strong)] px-4 py-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-400 backdrop-blur',
                    gi === 0 && 'rounded-t-[1.25rem]',
                  )}
                >
                  {t(`proxyApi.cat.${cat}`) === `proxyApi.cat.${cat}` ? cat : t(`proxyApi.cat.${cat}`)} · {list.length}
                </div>
                <ul className="divide-y divide-white/20">
                  {list.map((e) => (
                    <li key={e.name}>
                      <button
                        type="button"
                        onClick={() => openDetail(e.name)}
                        className={cn(
                          'flex w-full flex-col gap-1 px-4 py-2.5 text-left transition hover:bg-white/30',
                          gi === grouped.length - 1 && e === list[list.length - 1] && 'rounded-b-[1.25rem]',
                        )}
                      >
                        <span className="flex items-start justify-between gap-2">
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium text-slate-800">{titleOf(e)}</span>
                            <span className="block truncate font-mono text-[11px] text-slate-400">{e.name}</span>
                          </span>
                          <ProtocolBadges support={e.support} />
                        </span>
                        <RiskDot risk={e.risk} />
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* 详情悬浮窗：内部按子分类分页；实现对照/参数用逐条卡片，不再用表格 */}
      <Dialog open={!!current} onOpenChange={(o) => { if (!o) setSelected(''); }}>
        <DialogContent className="max-w-2xl">
          {current ? (
            <>
              <DialogHeader>
                <div className="flex flex-wrap items-center gap-2 pr-8">
                  <DialogTitle className="text-lg font-semibold text-slate-800">{titleOf(current)}</DialogTitle>
                  <ProtocolBadges support={current.support} />
                </div>
                <code className="mt-1 block w-fit rounded-md bg-white/25 px-2 py-0.5 font-mono text-xs text-slate-600">
                  {current.name}
                </code>
                <div className="mt-1 flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
                  <span>{t(`proxyApi.scope.${current.scope}`)}</span>
                  <span>{t(`proxyApi.status.${current.status}`)}</span>
                  <RiskDot risk={current.risk} />
                  {current.readOnly ? <span>{t('proxyApi.readOnly')}</span> : null}
                </div>
              </DialogHeader>

              {/* 子分类标签行 */}
              <div className="flex gap-1 rounded-xl bg-white/20 p-1" role="tablist">
                {detailTabs.filter((x) => x.visible).map((x) => (
                  <button
                    key={x.key}
                    type="button"
                    role="tab"
                    aria-selected={tab === x.key}
                    onClick={() => setTab(x.key)}
                    className={cn(
                      'flex-1 rounded-lg px-2 py-1.5 text-xs font-medium transition',
                      tab === x.key
                        ? 'bg-white/70 text-slate-800 shadow-sm'
                        : 'text-slate-500 hover:bg-white/30 hover:text-slate-700',
                    )}
                  >
                    {x.label}
                  </button>
                ))}
              </div>

              <div className="no-scrollbar -mx-1 max-h-[52dvh] overflow-y-auto px-1">
                {tab === 'overview' ? (
                  <div className="flex flex-col gap-3">
                    <p className="text-sm leading-relaxed text-slate-600">{current.summary}</p>
                    {current.notes ? (
                      <p className="rounded-xl border border-amber-300/40 bg-amber-400/15 p-3 text-xs leading-relaxed text-amber-700">
                        {t('proxyApi.notes')}：{current.notes}
                      </p>
                    ) : null}
                    {current.alias && current.alias.length > 0 ? (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-xs text-slate-500">{t('proxyApi.aliases')}</span>
                        {current.alias.map((a) => (
                          <code key={a} className="rounded bg-white/25 px-1.5 py-0.5 font-mono text-[11px] text-slate-500">{a}</code>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {tab === 'impl' && current ? (
                  <div className="flex flex-col gap-2">
                    {current.support.map((p) => (
                      <ImplCard key={p} p={p} impl={current.impl?.[p]} t={t} />
                    ))}
                  </div>
                ) : null}

                {tab === 'params' ? (
                  !current.params || current.params.length === 0 ? (
                    <p className="text-xs text-slate-400">{t('proxyApi.paramsEmpty')}</p>
                  ) : (
                    <div className="flex flex-col gap-2">
                      {current.params.map((p) => (
                        <ParamCard key={p.key} p={p} t={t} />
                      ))}
                    </div>
                  )
                ) : null}

                {tab === 'examples' ? (
                  <div className="flex flex-col gap-4">
                    <div className="flex flex-col gap-1.5">
                      <h3 className="text-sm font-semibold text-slate-700">{t('proxyApi.exRequest')}</h3>
                      {current.examples?.request && Object.keys(current.examples.request).length > 0
                        ? <JsonBlock value={current.examples.request} />
                        : <p className="text-xs text-slate-400">{t('proxyApi.exEmpty')}</p>}
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <h3 className="text-sm font-semibold text-emerald-700">{t('proxyApi.exSuccess')}</h3>
                      {current.examples?.success !== undefined
                        ? <JsonBlock value={current.examples.success} />
                        : <p className="text-xs text-slate-400">{t('proxyApi.exEmpty')}</p>}
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <h3 className="text-sm font-semibold text-rose-700">{t('proxyApi.exError')}</h3>
                      {current.examples?.error !== undefined
                        ? <JsonBlock value={current.examples.error} />
                        : <p className="text-xs text-slate-400">{t('proxyApi.exEmpty')}</p>}
                    </div>
                  </div>
                ) : null}
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
