/**
 * 侧边栏导航自定义：显示顺序 + 隐藏项。
 *
 * 存在 data/nav-layout.json（不是浏览器缓存）：换浏览器、清缓存、换设备登录同一个
 * 实例时，排好的顺序都还在。
 *
 * 两处刻意的收口：
 * - **顺序必须是全集的一个排列**。前端 NAV 增减（以后加新界面）时，老配置文件里
 *   缺的那些会被按默认顺序补到末尾，而不是让侧边栏少几项。
 * - **只有白名单里的四项可以隐藏**（实用工具 / 开放平台 / 智能助手 / 模拟消息）。
 *   总览、连接、插件、资源商城、日志、设置是日常要用到的入口，藏起来只会让人
 *   以为功能没了，所以后端也不接受对它们的隐藏请求。
 */

import { readJsonSafe, writeJsonAtomic } from '../storage/atomic-file.js';
import { PATHS } from '../paths.js';

/**
 * 侧边栏全部导航路径，顺序 = 出厂默认顺序。
 * 与前端 src/web/components/console-shell.tsx 的 NAV 保持一致；
 * 不一致时以后端这份为准做补全（未知路径丢弃、缺失路径补末尾）。
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

/** 允许隐藏的入口：其余一律不可移除 */
export const NAV_HIDABLE: readonly string[] = [
  '/tools',
  '/open-platform',
  '/ai',
  '/simulate',
];

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
  hidden: [],
};

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * 收口成合法布局。
 *
 * - 未知的 / 重复的路径丢掉
 * - 出厂列表里新增的、旧配置没有的，按默认顺序补到末尾
 * - hidden 只保留白名单内且仍在 order 里的
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
  // 补齐：新增的界面排在被排过的后面，不打乱用户已有的安排
  for (const href of NAV_HREFS) {
    if (seen.has(href)) continue;
    seen.add(href);
    order.push(href);
  }

  const hiddenSet = new Set<string>();
  for (const href of asStringArray(src.hidden)) {
    if (!HIDABLE_SET.has(href) || !order.includes(href)) continue;
    hiddenSet.add(href);
  }
  // 兜底：理论上不可能（可隐藏的只有 4 项），但万一将来白名单扩大，别把侧栏清空
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
