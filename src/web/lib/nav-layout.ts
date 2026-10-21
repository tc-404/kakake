/**
 * 侧边栏导航自定义：显示顺序 + 隐藏项。
 *
 * 数据存在后端 data/nav-layout.json（不是浏览器缓存），换浏览器、清缓存、换设备
 * 登录同一个实例，排好的顺序都还在。这里只做一份轻量外部 store：
 * console-shell 里侧边栏与「首页跳转」两处都要读它，各自拉一次接口会打架。
 */

import { api } from './api';

export interface NavLayout {
  /** 显示顺序，NAV_HREFS 的一个排列 */
  order: string[];
  /** 被隐藏的路径 */
  hidden: string[];
}

/**
 * 侧边栏全部导航路径，顺序 = 出厂默认顺序。
 * 必须与后端 src/admin/nav-layout.service.ts 的 NAV_HREFS 一致。
 */
export const NAV_HREFS: readonly string[] = [
  '/',
  '/connections',
  '/plugins',
  '/plugin-store',
  '/tools',
  '/open-platform',
  '/ai',
  '/simulate',
  '/logs',
  '/settings',
];

/** 允许隐藏的入口：实用工具 / 开放平台 / 智能助手 / 模拟消息，其余不可移除 */
export const NAV_HIDABLE: readonly string[] = [
  '/tools',
  '/open-platform',
  '/ai',
  '/simulate',
];

const HIDABLE_SET = new Set<string>(NAV_HIDABLE);

/** 该项是否允许被隐藏（不允许的连叉号都不给它，避免点了没反应） */
export function isNavHidable(href: string): boolean {
  return HIDABLE_SET.has(href);
}

export const DEFAULT_NAV_LAYOUT: NavLayout = {
  order: [...NAV_HREFS],
  hidden: [],
};

/* ─────────── 轻量外部 store ─────────── */

let snapshot: NavLayout | null = null;
let loading = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

export function getNavLayoutSnapshot(): NavLayout {
  return snapshot ?? DEFAULT_NAV_LAYOUT;
}

/** 数据是否已从后端取回来（取回前不该拿默认值去覆盖用户的配置） */
export function isNavLayoutLoaded(): boolean {
  return snapshot !== null;
}

export function subscribeNavLayout(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 首次调用时拉一次；重复调用直接复用（登录会话内布局不会自己变） */
export async function loadNavLayout(): Promise<NavLayout> {
  if (snapshot) return snapshot;
  if (loading) return DEFAULT_NAV_LAYOUT;
  loading = true;
  try {
    const r = await api.navLayout.get();
    snapshot = normalizeNavLayout(r?.layout);
  } catch {
    // 拉不到就按默认顺序显示，别让侧栏空掉
    snapshot = DEFAULT_NAV_LAYOUT;
  } finally {
    loading = false;
  }
  emit();
  return snapshot;
}

/** 乐观更新：拖拽/隐藏时先本地生效，落库失败再回滚 */
export function setNavLayoutLocal(next: NavLayout): void {
  snapshot = next;
  emit();
}

/** 落库；失败时把入参回滚掉并返回 null，调用方据此提示 */
export async function saveNavLayout(next: NavLayout): Promise<NavLayout | null> {
  const prev = snapshot;
  setNavLayoutLocal(next);
  try {
    const r = await api.navLayout.save(next);
    const saved = normalizeNavLayout(r?.layout);
    snapshot = saved;
    emit();
    return saved;
  } catch {
    snapshot = prev;
    emit();
    return null;
  }
}

/** 恢复出厂：默认顺序 + 全部显示 */
export async function resetNavLayout(): Promise<NavLayout | null> {
  const prev = snapshot;
  try {
    const r = await api.navLayout.reset();
    snapshot = normalizeNavLayout(r?.layout);
    emit();
    return snapshot;
  } catch {
    snapshot = prev;
    emit();
    return null;
  }
}

/**
 * 收口：后端已经兜过一次，这里再兜一遍，防止接口异常返回把侧栏弄空。
 */
export function normalizeNavLayout(raw: Partial<NavLayout> | null | undefined): NavLayout {
  const src = raw ?? {};
  const known = new Set<string>(NAV_HREFS);
  const seen = new Set<string>();
  const order: string[] = [];
  for (const href of Array.isArray(src.order) ? src.order : []) {
    if (typeof href !== 'string' || !known.has(href) || seen.has(href)) continue;
    seen.add(href);
    order.push(href);
  }
  for (const href of NAV_HREFS) {
    if (seen.has(href)) continue;
    seen.add(href);
    order.push(href);
  }
  const hidden = new Set<string>();
  for (const href of Array.isArray(src.hidden) ? src.hidden : []) {
    if (typeof href !== 'string' || !HIDABLE_SET.has(href) || !order.includes(href)) continue;
    hidden.add(href);
  }
  if (hidden.size >= order.length) hidden.clear();
  return { order, hidden: [...hidden] };
}

/**
 * 只按 order 排序，不过滤隐藏项——编辑模式要把隐藏的也列出来，否则它们
 * 永远没有机会被恢复回去。
 */
export function orderNavBy<T extends { href: string }>(items: readonly T[], order: readonly string[]): T[] {
  const byHref = new Map(items.map((it) => [it.href, it]));
  const out: T[] = [];
  const seen = new Set<string>();
  for (const href of order) {
    const it = byHref.get(href);
    if (!it || seen.has(href)) continue;
    seen.add(href);
    out.push(it);
  }
  for (const it of items) {
    if (seen.has(it.href)) continue;
    seen.add(it.href);
    out.push(it);
  }
  return out;
}

/** 按当前布局把 NAV 排好并去掉隐藏项；返回 { href, navKey, shortKey, icon } 由调用方自带 */
export function applyNavLayout<T extends { href: string }>(items: readonly T[], layout: NavLayout): T[] {
  const hidden = new Set(layout.hidden);
  const byHref = new Map(items.map((it) => [it.href, it]));
  const out: T[] = [];
  for (const href of layout.order) {
    const it = byHref.get(href);
    if (!it || hidden.has(href)) continue;
    out.push(it);
  }
  // 兜底：布局里没有的（新增界面）补在后面
  for (const it of items) {
    if (!layout.order.includes(it.href) && !hidden.has(it.href)) out.push(it);
  }
  return out;
}
