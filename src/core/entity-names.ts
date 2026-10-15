/**
 * 实体名缓存：把 QQ 官方机器人的 openid 换成可读名字。
 *
 * 为什么需要它：官方事件里群只有 `group_openid`（32 位十六进制）、人只有
 * `member_openid` / `user_openid`，直接摆进日志预览就是一长串不可读的 ID。
 * 但群名要打 `GET /v2/groups/{group_openid}/info`，接口只有 30 QPM 且对非白名单
 * 机器人会直接报错，不能在渲染日志的同步路径上现查。
 *
 * 所以这里做的是「先缓存、再异步补」：
 * - 读：同步命中缓存，没命中就退化成短 ID（不会阻塞日志，也不会打接口）
 * - 写：由连接侧注册的取数器异步补进缓存，同一个 key 在负缓存期内不重复打
 *
 * 落盘在 `data/entity-names.json`，按 AppID 分桶——官方的 group_openid /
 * member_openid 都是「每个机器人一套」，跨账号并不通用，不能混在一个桶里。
 */
import { PATHS } from '../paths.js';
import { readJsonSafe, writeJsonAtomic } from '../storage/atomic-file.js';

/** 单个账号下最多缓存多少条，防止长期运行把文件撑大 */
const MAX_ENTRIES_PER_ACCOUNT = 2000;
/** 查不到（接口报错 / 无权限）后多久内不再重试 */
const NEGATIVE_TTL_MS = 6 * 60 * 60 * 1000;
/** 群名拿到后多久允许后台再刷一次，应对群改名 */
const GROUP_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;
/** 官方群资料接口 30 QPM，串行 + 间隔是最省事的节流 */
const FETCH_GAP_MS = 2200;

interface NameEntry {
  name: string;
  updatedAt: number;
}

interface BotSelfEntry {
  openid: string;
  name: string;
  updatedAt: number;
}

interface EntityNameFile {
  version: 1;
  /** appId -> 群 openid -> 群名 */
  groups: Record<string, Record<string, NameEntry>>;
  /** appId -> 用户 openid -> 昵称 */
  users: Record<string, Record<string, NameEntry>>;
  /** appId -> 机器人自身（@ 到自己时要能叫出名字） */
  self: Record<string, BotSelfEntry>;
  /** appId -> "group:xxx" / "user:xxx" -> 失败时间戳（负缓存） */
  failed: Record<string, Record<string, number>>;
}

function emptyFile(): EntityNameFile {
  return { version: 1, groups: {}, users: {}, self: {}, failed: {} };
}

let cache: EntityNameFile | null = null;

function readFile(): EntityNameFile {
  if (cache) return cache;
  const parsed = readJsonSafe<EntityNameFile>(PATHS.entityNames, emptyFile(), {
    label: 'entity-names.json',
  });
  const safe: EntityNameFile = parsed && typeof parsed === 'object'
    ? {
        version: 1,
        groups: isRecord(parsed.groups) ? parsed.groups : {},
        users: isRecord(parsed.users) ? parsed.users : {},
        self: isRecord(parsed.self) ? parsed.self : {},
        failed: isRecord(parsed.failed) ? parsed.failed : {},
      }
    : emptyFile();
  cache = safe;
  return cache;
}

function writeFile(): void {
  if (!cache) return;
  writeJsonAtomic(PATHS.entityNames, cache);
}

function isRecord(v: unknown): v is Record<string, any> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function trimBucket(bucket: Record<string, any>): void {
  const keys = Object.keys(bucket);
  if (keys.length <= MAX_ENTRIES_PER_ACCOUNT) return;
  // 按更新时间丢最旧的，保留最近用到的
  const sorted = keys
    .map((k) => ({ k, t: Number(bucket[k]?.updatedAt ?? 0) }))
    .sort((a, b) => a.t - b.t);
  const drop = sorted.slice(0, keys.length - MAX_ENTRIES_PER_ACCOUNT);
  for (const { k } of drop) delete bucket[k];
}

/** openid 这类长 ID 的短写形式：4106E363…6F8443E */
export function shortId(id: string, head = 4, tail = 5): string {
  const s = String(id ?? '').trim();
  if (!s) return '?';
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

// ---------------------------------------------------------------- 机器人自身

export function rememberBotSelf(appId: string, openid: string, name: string): void {
  const app = String(appId ?? '').trim();
  const id = String(openid ?? '').trim();
  const nm = String(name ?? '').trim();
  if (!app || !id || !nm) return;
  const f = readFile();
  f.self[app] = { openid: id, name: nm, updatedAt: Date.now() };
  // 机器人自己也是个「用户」，@ 到自己时按昵称回
  putUser(app, id, nm);
  writeFile();
}

export function getBotSelf(appId: string): { openid: string; name: string } | undefined {
  const app = String(appId ?? '').trim();
  if (!app) return undefined;
  const e = readFile().self[app];
  if (!e?.name) return undefined;
  return { openid: e.openid, name: e.name };
}

// ---------------------------------------------------------------- 群

function putUser(app: string, openid: string, name: string): void {
  const f = readFile();
  const bucket = (f.users[app] ??= {});
  bucket[openid] = { name, updatedAt: Date.now() };
  trimBucket(bucket);
}

export function rememberGroupName(appId: string, groupOpenid: string, name: string): void {
  const app = String(appId ?? '').trim();
  const gid = String(groupOpenid ?? '').trim();
  const nm = String(name ?? '').trim();
  if (!app || !gid || !nm) return;
  const f = readFile();
  const bucket = (f.groups[app] ??= {});
  bucket[gid] = { name: nm, updatedAt: Date.now() };
  trimBucket(bucket);
  // 查到了就把负缓存清掉，下次改名才能正常刷新
  if (f.failed[app]) delete f.failed[app][`group:${gid}`];
  writeFile();
}

export function rememberUserNickname(appId: string, openid: string, name: string): void {
  const app = String(appId ?? '').trim();
  const id = String(openid ?? '').trim();
  const nm = String(name ?? '').trim();
  if (!app || !id || !nm) return;
  putUser(app, id, nm);
  writeFile();
}

export function getGroupName(appId: string, groupOpenid: string): string | undefined {
  const app = String(appId ?? '').trim();
  const gid = String(groupOpenid ?? '').trim();
  if (!app || !gid) return undefined;
  return readFile().groups[app]?.[gid]?.name || undefined;
}

export function getUserNickname(appId: string, openid: string): string | undefined {
  const app = String(appId ?? '').trim();
  const id = String(openid ?? '').trim();
  if (!app || !id) return undefined;
  return readFile().users[app]?.[id]?.name || undefined;
}

// ---------------------------------------------------------------- 负缓存

function failedKey(kind: 'group' | 'user', key: string): string {
  return `${kind}:${key}`;
}

export function markLookupFailed(appId: string, kind: 'group' | 'user', key: string): void {
  const app = String(appId ?? '').trim();
  const k = String(key ?? '').trim();
  if (!app || !k) return;
  const f = readFile();
  const bucket = (f.failed[app] ??= {});
  bucket[failedKey(kind, k)] = Date.now();
  writeFile();
}

function failedAt(app: string, kind: 'group' | 'user', key: string): number {
  return Number(readFile().failed[app]?.[failedKey(kind, key)] ?? 0);
}

/** 这个值还有没有必要去打接口（没缓存过、或已过负缓存期、或群名已过期） */
export function needsLookup(appId: string, kind: 'group' | 'user', key: string): boolean {
  const app = String(appId ?? '').trim();
  const k = String(key ?? '').trim();
  if (!app || !k) return false;
  const lastFail = failedAt(app, kind, k);
  if (lastFail && Date.now() - lastFail < NEGATIVE_TTL_MS) return false;
  if (kind === 'group') {
    const updated = Number(readFile().groups[app]?.[k]?.updatedAt ?? 0);
    if (updated && Date.now() - updated < GROUP_REFRESH_MS) return false;
  } else {
    const updated = Number(readFile().users[app]?.[k]?.updatedAt ?? 0);
    if (updated) return false;
  }
  return true;
}

// ---------------------------------------------------------------- 异步取数队列

/** 由连接侧注入：给定 appId 与群 openid，返回群名或 null */
export type GroupInfoFetcher = (appId: string, groupOpenid: string) => Promise<string | null>;

const fetchers = new Map<string, GroupInfoFetcher>();

export function registerGroupInfoFetcher(appId: string, fn: GroupInfoFetcher): void {
  const app = String(appId ?? '').trim();
  if (!app) return;
  fetchers.set(app, fn);
}

export function unregisterGroupInfoFetcher(appId: string): void {
  fetchers.delete(String(appId ?? '').trim());
}

const queue: Array<{ appId: string; groupOpenid: string }> = [];
const queued = new Set<string>();
let draining = false;
let lastFetchAt = 0;

/**
 * 后台补一次群名。同步路径只管调用，不等待结果——下次同群上报就能用上名字。
 * 同一个 (appId, 群) 在队列里只留一份，且受 30 QPM 的串行节流保护。
 */
export function requestGroupName(appId: string, groupOpenid: string): void {
  const app = String(appId ?? '').trim();
  const gid = String(groupOpenid ?? '').trim();
  if (!app || !gid) return;
  if (!fetchers.has(app)) return;
  if (!needsLookup(app, 'group', gid)) return;
  const key = `${app}|${gid}`;
  if (queued.has(key)) return;
  queued.add(key);
  queue.push({ appId: app, groupOpenid: gid });
  void drainQueue();
}

async function drainQueue(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const job = queue.shift();
      if (!job) break;
      const key = `${job.appId}|${job.groupOpenid}`;
      try {
        const wait = FETCH_GAP_MS - (Date.now() - lastFetchAt);
        if (wait > 0) await sleep(wait);
        const fn = fetchers.get(job.appId);
        if (fn) {
          lastFetchAt = Date.now();
          const name = await fn(job.appId, job.groupOpenid);
          if (name) rememberGroupName(job.appId, job.groupOpenid, name);
          else markLookupFailed(job.appId, 'group', job.groupOpenid);
        }
      } catch {
        markLookupFailed(job.appId, 'group', job.groupOpenid);
      } finally {
        queued.delete(key);
      }
    }
  } finally {
    draining = false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------- 展示用标签

/** 群展示名：优先缓存群名，没拿到就退回短 ID，绝不把 32 位 openid 整条摆出来 */
export function groupLabel(appId: string, groupOpenid: string): string {
  const gid = String(groupOpenid ?? '').trim();
  if (!gid) return '?';
  return getGroupName(appId, gid)
    ?? (appId ? undefined : findGroupNameAnyAccount(gid))
    ?? shortId(gid);
}

/**
 * 没有 appId 时（读历史日志文件这条链路拿不到连接信息）跨账号找一遍。
 * group_openid 本身是按机器人隔离的，同一个值只会属于一个账号，命中即唯一。
 */
export function findGroupNameAnyAccount(groupOpenid: string): string | undefined {
  const gid = String(groupOpenid ?? '').trim();
  if (!gid) return undefined;
  for (const bucket of Object.values(readFile().groups)) {
    const hit = bucket?.[gid]?.name;
    if (hit) return hit;
  }
  return undefined;
}

export function findUserNicknameAnyAccount(openid: string): string | undefined {
  const id = String(openid ?? '').trim();
  if (!id) return undefined;
  for (const bucket of Object.values(readFile().users)) {
    const hit = bucket?.[id]?.name;
    if (hit) return hit;
  }
  return undefined;
}

/** 发言人展示名：缓存昵称 > 机器人自身昵称 > 跨账号兜底 > 短 ID */
export function userLabel(appId: string, openid: string): string {
  const id = String(openid ?? '').trim();
  if (!id) return '?';
  return getUserNickname(appId, id)
    ?? (appId ? undefined : findUserNicknameAnyAccount(id))
    ?? shortId(id);
}
