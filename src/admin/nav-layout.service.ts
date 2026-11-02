/**
 * 侧边栏导航自定义：显示顺序 + 隐藏项，存在 data/nav-layout.json（换设备仍保留）。
 * 顺序必须是全集的一个排列：新增项按默认位置插入，不堆到末尾。
 * 只有白名单项可隐藏；接口代理默认隐藏（DEFAULT_HIDDEN）。
 */

import { readJsonSafe, writeJsonAtomic } from '../storage/atomic-file.js';
import { PATHS } from '../paths.js';

/**
 * 侧边栏全部导航路径，顺序 = 出厂默认顺序。
 * 与前端 src/web/components/console-shell.tsx 的 NAV 保持一致；
 * 不一致时以后端这份为准做补全（未知路径丢弃、缺失路径按默认位置补全）。
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
  '/proxy-api',
  '/settings',
];

/** 允许隐藏的入口：其余一律不可移除 */
export const NAV_HIDABLE: readonly string[] = [
  '/tools',
  '/open-platform',
  '/ai',
  '/simulate',
  '/proxy-api',
];

/** 出厂默认隐藏的入口：编辑模式里可随时打开 */
export const DEFAULT_HIDDEN: readonly string[] = ['/proxy-api'];

const HIDABLE_SET = new Set<string>(NAV_HIDABLE);
const HREF_SET = new Set<string>(NAV_HREFS);

export interface NavLayout {
  /** 显示顺序，NAV_HREFS 的一个排列 */
  order: string[];
  /** 被隐藏的路径，只可能落在 NAV_HIDABLE 内 */
  hidden: string[];
}

export const DEFAULT_NAV_LAYOUT: NavLayout = {
  order: [...NAV_HREFS],
  hidden: [...DEFAULT_HIDDEN],
};

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * 收口成合法布局。
 *
 * - 未知的 / 重复的路径丢掉
 * - 出厂列表里新增的、旧配置没有的，按**默认相对位置**插入（例如接口代理
 *   插在系统设置之前），而不是一律堆到末尾——否则新入口会掉到列表最底下
 * - hidden 白名单照旧；此外对「配置里从未出现过」的条目套用出厂默认隐藏
 *   （新装实例与旧配置迁移共用这条规则；用户保存过布局后以保存值为准）
 */
export function normalizeNavLayout(raw: unknown): NavLayout {
  const src = (raw && typeof raw === 'object' ? raw : {}) as { order?: unknown; hidden?: unknown };

  const seen = new Set<string>();
  const order: string[] = [];
  for (const href of asStringArray(src.order)) {
    if (!HREF_SET.has(href) || seen.has(href)) continue;
    seen.add(href);
    order.push(href);
  }

  // 补齐：缺失项按默认相对位置插入——在默认顺序里排在它后面的、且已存在于
  // 用户顺序中的第一项之前；找不到就排到末尾
  const backfilled = new Set<string>();
  for (const href of NAV_HREFS) {
    if (seen.has(href)) continue;
    seen.add(href);
    backfilled.add(href);
    const defIdx = NAV_HREFS.indexOf(href);
    let insertAt = order.length;
    for (let i = defIdx + 1; i < NAV_HREFS.length; i++) {
      const idx = order.indexOf(NAV_HREFS[i]);
      if (idx !== -1) {
        insertAt = idx;
        break;
      }
    }
    order.splice(insertAt, 0, href);
  }

  const hiddenSet = new Set<string>();
  // 出厂默认隐藏：仅对配置里从未出现过的条目生效（新装 / 旧配置迁移）；
  // 用户保存过一次布局后，raw.hidden 就是唯一事实源
  for (const href of DEFAULT_HIDDEN) {
    if (backfilled.has(href)) hiddenSet.add(href);
  }
  for (const href of asStringArray(src.hidden)) {
    if (!HIDABLE_SET.has(href) || !order.includes(href)) continue;
    hiddenSet.add(href);
  }
  // 兜底：万一将来白名单大幅扩大，别把侧栏清空
  if (hiddenSet.size >= order.length) hiddenSet.clear();

  return { order, hidden: [...hiddenSet] };
}

class NavLayoutService {
  private cache: NavLayout | null = null;

  getState(): NavLayout {
    if (this.cache) return this.cache;
    const raw = readJsonSafe<unknown>(PATHS.navLayout, DEFAULT_NAV_LAYOUT, { label: 'nav-layout.json' });
    this.cache = normalizeNavLayout(raw);
    return this.cache;
  }

  save(raw: unknown): NavLayout {
    const next = normalizeNavLayout(raw);
    writeJsonAtomic(PATHS.navLayout, next, { trailingNewline: true });
    this.cache = next;
    return next;
  }

  /** 恢复出厂顺序并全部显示 */
  reset(): NavLayout {
    const next = normalizeNavLayout(DEFAULT_NAV_LAYOUT);
    writeJsonAtomic(PATHS.navLayout, next, { trailingNewline: true });
    this.cache = next;
    return next;
  }
}

export const navLayoutService = new NavLayoutService();
