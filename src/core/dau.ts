import { PATHS } from '../paths.js';
import { readJsonSafe, writeJsonAtomic } from '../storage/atomic-file.js';

/**
 * QQ 官方机器人日活（DAU）统计。
 *
 * 官方开放平台没有公开的日活接口，这里在框架侧本地统计：
 * 每收到一条 QQ 官方消息事件（单聊/群聊），按「AppID + 日期 + 用户 openid」去重累加，
 * 落盘到 data/dau.json（结构 { [appId]: { [YYYY-MM-DD]: openid[] } }）。
 * 进程重启不清空，历史日活可跨天累加。
 */

type DauState = Record<string, Record<string, string[]>>;

let cache: DauState | null = null;
let dirty = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function dateStr(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function load(): DauState {
  if (cache === null) {
    cache = readJsonSafe<DauState>(PATHS.dau, {}, { label: 'dau.json' });
  }
  return cache;
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushDau();
  }, 3000);
}

/** 立即落盘（优雅退出 / 定时器触发时调用） */
export function flushDau(): void {
  if (!dirty || cache === null) return;
  dirty = false;
  try {
    writeJsonAtomic(PATHS.dau, cache, { trailingNewline: true });
  } catch {
    /* 落盘失败不影响运行 */
  }
}

/**
 * 计入日活的事件：单聊 / 群聊 / 频道消息。
 * 只认「上行消息」——官方后台「数据」页的「上行消息人数」也是这个口径。
 * 按钮回调（INTERACTION_CREATE）、进退群等不计入。
 */
export const QQ_DAU_EVENTS = new Set([
  'C2C_MESSAGE_CREATE',
  'GROUP_AT_MESSAGE_CREATE',
  'GROUP_MESSAGE_CREATE',
  'AT_MESSAGE_CREATE',
  'DIRECT_MESSAGE_CREATE',
]);

/**
 * 从一个 QQ 官方事件里抽出发言人 openid 并计入日活。
 * WebSocket 与 HTTPS 回调两条链路共用，避免其中一条漏埋点。
 */
export function recordDauFromQqEvent(appId: string | undefined, eventType: string, event: unknown): void {
  if (!appId || !QQ_DAU_EVENTS.has(eventType)) return;
  const author = (event as Record<string, unknown> | undefined)?.author as Record<string, unknown> | undefined;
  if (!author) return;
  // 单聊是 user_openid、群聊是 member_openid、频道是 id
  const openid = author.user_openid ?? author.member_openid ?? author.id;
  if (openid === undefined || openid === null || openid === '') return;
  // 机器人自己发的消息不算活跃
  if (author.bot === true) return;
  recordQqOfficialActivity(String(appId), String(openid));
}

/** 记录一次活跃：同一 AppID 同一天同一 openid 只记一次 */
export function recordQqOfficialActivity(appId: string, openid: string): void {
  const a = String(appId || '').trim();
  const o = String(openid || '').trim();
  if (!a || !o) return;

  const state = load();
  const byDate = (state[a] ??= {});
  const day = dateStr(new Date());
  const list = (byDate[day] ??= []);
  if (!list.includes(o)) {
    list.push(o);
    dirty = true;
    scheduleFlush();
  }
}

export interface DauStats {
  /** 今日活跃用户数 */
  today: number;
  /** 昨日活跃用户数 */
  yesterday: number;
  /** 近 7 天不重复活跃用户数 */
  last7d: number;
  /** 累计不重复活跃用户数 */
  total: number;
  /** 近 7 天每日活跃数（旧 → 新，用于折线/柱状展示） */
  daily: Array<{ date: string; count: number }>;
}

export function getDauStats(appId: string): DauStats {
  const state = load();
  const byDate = state[String(appId || '').trim()] ?? {};

  const now = new Date();
  const todayStr = dateStr(now);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = dateStr(yesterday);

  const daily: Array<{ date: string; count: number }> = [];
  const last7Set = new Set<string>();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = dateStr(d);
    const list = byDate[key] ?? [];
    daily.push({ date: key, count: list.length });
    for (const u of list) last7Set.add(u);
  }

  const totalSet = new Set<string>();
  for (const key of Object.keys(byDate)) {
    for (const u of byDate[key] ?? []) totalSet.add(u);
  }

  return {
    today: (byDate[todayStr] ?? []).length,
    yesterday: (byDate[yesterdayStr] ?? []).length,
    last7d: last7Set.size,
    total: totalSet.size,
    daily,
  };
}
