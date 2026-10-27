import fs from 'node:fs';
import path from 'node:path';
import { rootLogger } from '../core/logger.js';
import { githubAuthHeaders } from '../core/github-token.js';
import { PATHS } from '../paths.js';
import { getFrameworkVersion } from './agreement.service.js';

/**
 * 更新检查（GitHub Release tag）：多镜像并行探测，10 分钟 TTL 自动检查。
 * 正式版只跟踪正式版；已安装预发布版的用户继续跟踪预发布通道。
 */

/** 目标仓库 owner/name */
export const REPO = 'tc-404/kakake';
/** 发行版列表接口（取全部版本，用于版本下拉；各镜像以此为基准拼前缀） */
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases?per_page=30`;
/** Atom 源（同样含全部发行版） */
const ATOM_URL = `https://github.com/${REPO}/releases.atom`;
/** 最新发行版页面 */
const RELEASES_LATEST_URL = `https://github.com/${REPO}/releases`;

/**
 * 自动检查的最小间隔：同一个登录会话内，距上次检查不足这个时长就直接复用结果。
 *
 * 之前是「会话内只查一次」，但登录会话最长 3 小时：用户登录后第一次检查完、
 * 期间仓库发了新版本，侧边栏的 NEW 红点会一直不亮，直到会话过期重新登录。
 * 改成 10 分钟节流后，刷新页面 / 切回前台都会重新读一次状态，最多 10 分钟发现新版本。
 */
const AUTO_CHECK_TTL_MS = 10 * 60 * 1000;

function releasePageUrl(tag: string): string {
  return `https://github.com/${REPO}/releases/tag/${encodeURIComponent(tag)}`;
}

export type MirrorKind = 'gh-api' | 'gh-atom' | 'jsdelivr';

export type MirrorDef = {
  id: string;
  label: string;
  kind: MirrorKind;
  url: string;
};

/**
 * 默认镜像源（均为实测当前可用；公共代理会不定期失效，联不通时显示「失败/超时」，
 * 用户改选可用且最快的即可）：
 * - gh-api 读 releases 列表 JSON；gh-atom 解析 releases.atom；jsdelivr（保留支持）读 jsDelivr 版本清单。
 * - 港澳台/国际用户通常能直连 GitHub 官方；大陆用户走 gh-proxy.com / gh.catmak.name。
 * 列表是常量，随时可增删/替换。
 */
export const MIRRORS: MirrorDef[] = [
  // —— 国际 / 港澳台（直连）——
  { id: 'github', label: 'GitHub 官方 API（国际/港澳台）', kind: 'gh-api', url: RELEASES_API },
  { id: 'gh_atom', label: 'GitHub Atom 直连（国际/港澳台）', kind: 'gh-atom', url: ATOM_URL },
  // —— 中国大陆加速 ——
  { id: 'gh_proxy_com', label: 'gh-proxy.com 加速（大陆）', kind: 'gh-api', url: `https://gh-proxy.com/${RELEASES_API}` },
  { id: 'gh_catmak', label: 'catmak.name 加速（大陆）', kind: 'gh-api', url: `https://gh.catmak.name/${RELEASES_API}` },
];

/** 单个镜像探测超时 */
const PING_TIMEOUT_MS = 8_000;

/**
 * 给定镜像 id，返回把官方 `https://api.github.com/...` / `https://github.com/...`
 * 变成该镜像加速地址的前缀（形如 `https://gh-proxy.com/`）。
 * 官方直连镜像（github / gh_atom）返回空串。安装服务据此对下载地址做加速。
 */
export function mirrorPrefixFor(mirrorId?: string | null): string {
  const m = MIRRORS.find((x) => x.id === mirrorId);
  if (!m) return '';
  const marker = 'https://api.github.com';
  const idx = m.url.indexOf(marker);
  // idx>0 说明镜像 url 是「前缀 + 官方 url」形式，截出前缀
  if (idx > 0) return m.url.slice(0, idx);
  return '';
}

/** 读取某会话当前自动选定的镜像 id（资源界面与在线更新共用同一镜像） */
export function getActiveMirrorId(key: string): string {
  return getOrInit(key).activeMirrorId || '';
}

export type MirrorStatus = 'idle' | 'checking' | 'latest' | 'update' | 'unreachable';

/** 发布通道：stable = 正式版（界面打 LTS 标）；其余为预发布 */
export type VersionChannel = 'stable' | 'beta' | 'rc' | 'alpha';

/** 一个发行版（用于版本下拉与「去下载该版本」） */
export type VersionInfo = {
  /** 归一化版本号（去掉前导 v，用于展示/比较） */
  version: string;
  /** 原始 tag（用于构造下载地址） */
  tag: string;
  /** 发行标题 */
  name: string;
  /** 该版本发行页地址 */
  url: string;
  /** 发布时间（ISO；可能为空） */
  publishedAt: string;
  /** 发布通道：正式版 / Beta / RC / Alpha */
  channel: VersionChannel;
};

/** 每个镜像存下来的探测结果（不含版本列表，保持精简） */
type Probe = {
  latencyMs: number | null;
  reachable: boolean;
  version: string;
  error: string;
  lastCheckedAt: string;
};

/** 探测返回：在 Probe 基础上附带解析出的完整版本列表 */
type ProbeResult = Probe & { id: string; versions: VersionInfo[] };

type SessionUpdateState = {
  status: MirrorStatus;
  checkedThisSession: boolean;
  currentVersion: string;
  /** 当前安装版本所属通道 */
  currentChannel: VersionChannel;
  /** 当前通道跟踪到的最新版本（正式版用户只会是正式版） */
  remoteVersion: string;
  remoteChannel: VersionChannel;
  /** 列表里最新的预发布版本（无论是否比当前高），供悬浮窗提示 */
  latestPrerelease: string;
  latestPrereleaseTag: string;
  hasUpdate: boolean;
  /** 有比当前版本更高的预发布（不点亮 NEW，只在悬浮窗提示） */
  hasPrerelease: boolean;
  activeMirrorId: string;
  message: string;
  probes: Record<string, Probe>;
  /** 最近一次成功访问拿到的版本列表（供版本下拉） */
  versions: VersionInfo[];
  /** 上次自动检查的起始时间（ms），用于 TTL 节流；0 = 从未查过 */
  lastAutoCheckAt: number;
};

const sessionStates = new Map<string, SessionUpdateState>();
const autoInflight = new Set<string>();

function emptyState(): SessionUpdateState {
  const currentVersion = getCurrentVersion();
  return {
    status: 'idle',
    checkedThisSession: false,
    currentVersion,
    currentChannel: detectChannel(currentVersion),
    remoteVersion: '',
    remoteChannel: 'stable',
    latestPrerelease: '',
    latestPrereleaseTag: '',
    hasUpdate: false,
    hasPrerelease: false,
    activeMirrorId: '',
    message: '',
    probes: {},
    versions: [],
    lastAutoCheckAt: 0,
  };
}

function getOrInit(key: string): SessionUpdateState {
  let s = sessionStates.get(key);
  if (!s) {
    s = emptyState();
    sessionStates.set(key, s);
  }
  return s;
}

/** 归一化 tag：去掉前导 v / V */
function normalizeTag(tag: string): string {
  return String(tag || '').trim().replace(/^v/i, '');
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** 发布时间转毫秒（缺失/非法按 0，用于同版本号时的次级排序） */
function publishedMs(iso: string): number {
  const t = Date.parse(String(iso || ''));
  return Number.isFinite(t) ? t : 0;
}

/**
 * 从 tag 识别发布通道（alpha/beta/rc），GitHub 的 prerelease 标记仅作兜底。
 * 通道词前必须是分隔符或数字，避免把 0.6.9-source 里的 rc 认成 RC。
 */
export function detectChannel(tag: string, prereleaseFlag = false): VersionChannel {
  const t = String(tag || '').trim().toLowerCase();
  const m = /(?:^|[.\-_+]|\d)(alpha|beta|rc)(?:[.\-_+]?(\d+))?/.exec(t);
  if (m) {
    if (m[1] === 'alpha') return 'alpha';
    if (m[1] === 'beta') return 'beta';
    if (m[1] === 'rc') return 'rc';
  }
  return prereleaseFlag ? 'beta' : 'stable';
}

/** 只比数字核心（忽略 -beta/-rc 后缀），用于判断两个版本是否同一发布线。 */
function compareVersionCore(a: string, b: string): number {
  const toNums = (v: string) =>
    (/(\d+(?:\.\d+)*)/.exec(String(v || ''))?.[1] || '')
      .split('.')
      .map((n) => parseInt(n, 10) || 0);
  const pa = toNums(a);
  const pb = toNums(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * 当前实际所属的发布通道。
 * 版本号自带 alpha/beta/rc 时直接归到该通道；否则看版本列表里同一核心是否只有预发布——
 * 历史 beta 包的 package.json 仍写成 0.6.9，只能靠同核心的发行记录补出通道。
 */
export function resolveCurrentChannel(
  currentVersion: string,
  versions: VersionInfo[] = [],
): VersionChannel {
  const byTag = detectChannel(currentVersion);
  if (byTag !== 'stable') return byTag;
  const sameCore = versions.filter((v) => compareVersionCore(v.version, currentVersion) === 0);
  if (sameCore.some((v) => v.channel === 'stable')) return 'stable';
  const pre = sameCore.find((v) => v.channel !== 'stable');
  return pre ? pre.channel : 'stable';
}

type InstalledBuildInfo = { version?: string; tag?: string };

function readBuildInfo(file: string): InstalledBuildInfo | null {
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const raw = JSON.parse(text) as InstalledBuildInfo;
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

/**
 * 当前实际运行的版本。历史 beta 包的 package.json 可能仍是 0.6.9，真实 tag 由安装
 * （data/installed-build.json）或打包（build-info.json）记录；只在核心版本一致时采用，
 * 避免旧标记盖过手动升级。
 */
export function getCurrentVersion(): string {
  const pkg = getFrameworkVersion();
  const candidates = [
    readBuildInfo(path.join(PATHS.data, 'installed-build.json')),
    readBuildInfo(path.join(PATHS.root, 'build-info.json')),
  ];
  let best = pkg;
  for (const info of candidates) {
    const v = String(info?.version || info?.tag || '').trim().replace(/^v/i, '');
    if (!v || compareVersionCore(v, best) !== 0) continue;
    if (detectChannel(best) === 'stable' && detectChannel(v) !== 'stable') best = v;
  }
  return best;
}

/** 把版本号拆成「数字核心 + 通道 + 通道序号」 */
function parseRelease(version: string, prereleaseFlag = false): {
  core: number[];
  channel: VersionChannel;
  preNum: number;
} {
  const raw = String(version || '').trim().replace(/^v/i, '');
  const coreMatch = /^(\d+(?:\.\d+)*)/.exec(raw);
  const core = coreMatch ? coreMatch[1].split('.').map((n) => parseInt(n, 10) || 0) : [];
  const channel = detectChannel(raw, prereleaseFlag);
  let preNum = 0;
  if (channel !== 'stable') {
    const m = /(?:alpha|beta|rc)(?:[.\-_+]?(\d+))?/i.exec(raw);
    preNum = m?.[1] ? parseInt(m[1], 10) || 0 : 0;
  }
  return { core, channel, preNum };
}

/** 同核心版本之间的通道优先级：正式版 > RC > Beta > Alpha */
const CHANNEL_RANK: Record<VersionChannel, number> = {
  stable: 4,
  rc: 3,
  beta: 2,
  alpha: 1,
};

/** 发行版比较：认语义化预发布规则（0.6.9-beta.1 < 0.6.9），不是只比数字。 */
export function compareReleaseVersions(a: string, b: string): number {
  const pa = parseRelease(a);
  const pb = parseRelease(b);
  const len = Math.max(pa.core.length, pb.core.length);
  for (let i = 0; i < len; i++) {
    const d = (pa.core[i] || 0) - (pb.core[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  const byChannel = CHANNEL_RANK[pa.channel] - CHANNEL_RANK[pb.channel];
  if (byChannel !== 0) return byChannel > 0 ? 1 : -1;
  if (pa.channel !== 'stable' && pa.preNum !== pb.preNum) {
    return pa.preNum > pb.preNum ? 1 : -1;
  }
  return 0;
}

function pickNewer(a: VersionInfo | null, b: VersionInfo | null): VersionInfo | null {
  if (!a) return b;
  if (!b) return a;
  return compareReleaseVersions(a.version, b.version) >= 0 ? a : b;
}

export type UpdateTrack = {
  /** 列表里最高的正式版 */
  latestStable: VersionInfo | null;
  /** 列表里最高的预发布版（alpha/beta/rc 中版本号最大的那个） */
  latestPrerelease: VersionInfo | null;
  /** 当前通道实际应该跟踪的版本：正式版用户只看正式版，预发布用户两者取高 */
  applicable: VersionInfo | null;
  hasUpdate: boolean;
  /** 存在比当前版本更高的预发布（正式版用户只在悬浮窗里做提示，不点亮 NEW） */
  hasPrerelease: boolean;
};

/**
 * 纯函数：给定当前版本与版本列表（需已按版本降序），算出该不该提示更新。
 * 单独抽出来是为了让「beta 不冒充正式更新」这条规则可以直接单元测试。
 */
export function resolveUpdateTrack(
  currentVersion: string,
  versions: VersionInfo[],
  currentChannel: VersionChannel = detectChannel(currentVersion),
): UpdateTrack {
  const latestStable = versions.find((v) => v.channel === 'stable') || null;
  const latestPrerelease = versions.find((v) => v.channel !== 'stable') || null;
  const applicable =
    currentChannel === 'stable' ? latestStable : pickNewer(latestStable, latestPrerelease);
  return {
    latestStable,
    latestPrerelease,
    applicable,
    hasUpdate: !!applicable && compareReleaseVersions(applicable.version, currentVersion) > 0,
    hasPrerelease:
      !!latestPrerelease && compareReleaseVersions(latestPrerelease.version, currentVersion) > 0,
  };
}

/**
 * 版本列表排序：优先按版本号（大.中.小 三级语义化）从高到低；版本号相同时，
 * 再按发布时间从新到旧。不同镜像（GitHub API 按创建时间、Atom 按更新时间、
 * jsDelivr 按语义化）给的原始顺序不一，这里统一成同一套确定性排序。
 */
function sortVersions(list: VersionInfo[]): VersionInfo[] {
  return list.slice().sort((a, b) => {
    const byVer = compareReleaseVersions(b.version, a.version); // 版本高的在前
    if (byVer !== 0) return byVer;
    return publishedMs(b.publishedAt) - publishedMs(a.publishedAt); // 同版本：新的在前
  });
}

/** 从镜像响应体解析出完整版本列表（统一按版本号高→低、同版本按时间新→旧排序） */
function parseVersions(kind: MirrorKind, body: string): VersionInfo[] {
  if (kind === 'jsdelivr') {
    // jsDelivr 只给版本号数组（已按语义化版本从新到旧），无精确 tag/标题，
    // 下载地址退回发行版列表页。
    try {
      const j = JSON.parse(body) as { versions?: string[] };
      return sortVersions(
        (j.versions || [])
          .filter((v) => typeof v === 'string' && v)
          .map((v) => ({
            version: normalizeTag(v),
            tag: v,
            name: '',
            url: RELEASES_LATEST_URL,
            publishedAt: '',
            channel: detectChannel(v),
          })),
      );
    } catch {
      return [];
    }
  }

  if (kind === 'gh-api') {
    let data: unknown;
    try {
      data = JSON.parse(body);
    } catch {
      return [];
    }
    const arr = Array.isArray(data) ? data : [data];
    const out: VersionInfo[] = [];
    for (const item of arr) {
      const r = item as {
        tag_name?: string;
        name?: string;
        html_url?: string;
        published_at?: string;
        created_at?: string;
        draft?: boolean;
        prerelease?: boolean;
      };
      if (!r || r.draft) continue;
      const tag = String(r.tag_name || '').trim();
      if (!tag) continue;
      out.push({
        version: normalizeTag(tag),
        tag,
        name: String(r.name || tag),
        url: String(r.html_url || releasePageUrl(tag)),
        publishedAt: String(r.published_at || r.created_at || ''),
        channel: detectChannel(tag, !!r.prerelease),
      });
    }
    return sortVersions(out);
  }

  // gh-atom：每个 <entry> 一个发行版
  const chunks = body.split('<entry>').slice(1);
  const out: VersionInfo[] = [];
  for (const raw of chunks) {
    const entry = raw.split('</entry>')[0] || raw;
    let tag = '';
    const byTag = entry.match(/\/releases\/tag\/([^"'<>\s]+)/);
    if (byTag) tag = safeDecode(byTag[1]);
    if (!tag) {
      const byId = entry.match(/<id>[^<]*\/([^</]+)<\/id>/);
      if (byId) tag = safeDecode(byId[1]);
    }
    if (!tag) continue;
    const hrefM = entry.match(/href="([^"]*\/releases\/tag\/[^"]+)"/);
    const titleM = entry.match(/<title>([^<]*)<\/title>/);
    const updM = entry.match(/<updated>([^<]*)<\/updated>/);
    out.push({
      version: normalizeTag(tag),
      tag,
      name: titleM ? titleM[1].trim() : tag,
      url: hrefM ? hrefM[1] : releasePageUrl(tag),
      publishedAt: updM ? updM[1].trim() : '',
      channel: detectChannel(tag),
    });
  }
  return sortVersions(out);
}

/** 探测单个镜像：测延迟 + 取版本列表 */
async function probeMirror(def: MirrorDef): Promise<ProbeResult> {
  const at = new Date().toISOString();
  const started = Date.now();
  try {
    const resp = await fetch(def.url, {
      headers: {
        'User-Agent': 'Kakake-Update/1.0',
        Accept:
          def.kind === 'gh-atom'
            ? 'application/atom+xml, application/xml, text/xml, */*'
            : 'application/json, application/vnd.github+json, */*',
        // 直连官方 API 时附带已配置的 Token；镜像前缀 url 的主机是代理域名，自动不带
        ...githubAuthHeaders(def.url),
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
    const latencyMs = Date.now() - started;
    if (!resp.ok) {
      return { id: def.id, latencyMs, reachable: false, version: '', versions: [], error: `HTTP ${resp.status}`, lastCheckedAt: at };
    }
    const body = await resp.text();
    const versions = parseVersions(def.kind, body);
    if (versions.length === 0) {
      return { id: def.id, latencyMs, reachable: false, version: '', versions: [], error: '未解析到版本号', lastCheckedAt: at };
    }
    return { id: def.id, latencyMs, reachable: true, version: versions[0].version, versions, error: '', lastCheckedAt: at };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      id: def.id,
      latencyMs: null,
      reachable: false,
      version: '',
      versions: [],
      error: /timed out|abort/i.test(msg) ? '超时' : msg,
      lastCheckedAt: at,
    };
  }
}

/** 并发探测选定镜像（不传则全部） */
async function pingMirrors(mirrorIds?: string[]): Promise<ProbeResult[]> {
  const defs =
    mirrorIds && mirrorIds.length ? MIRRORS.filter((m) => mirrorIds.includes(m.id)) : MIRRORS;
  const results = await Promise.allSettled(defs.map((d) => probeMirror(d)));
  const out: ProbeResult[] = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') out.push(r.value);
    else {
      out.push({
        id: defs[i].id,
        latencyMs: null,
        reachable: false,
        version: '',
        versions: [],
        error: r.reason instanceof Error ? r.reason.message : String(r.reason),
        lastCheckedAt: new Date().toISOString(),
      });
    }
  });
  return out;
}

/** 按当前安装版本重新算 hasUpdate / hasPrerelease（remoteVersion 只增不减） */
function refreshDerived(state: SessionUpdateState): void {
  state.currentVersion = getCurrentVersion();
  state.currentChannel = resolveCurrentChannel(state.currentVersion, state.versions);
  state.hasUpdate =
    !!state.remoteVersion && compareReleaseVersions(state.remoteVersion, state.currentVersion) > 0;
  state.hasPrerelease =
    !!state.latestPrerelease &&
    compareReleaseVersions(state.latestPrerelease, state.currentVersion) > 0;
}

/**
 * 并入版本列表：remote / latestPrerelease 只向上修正，落后镜像不能压低已发现的新版本。
 * 正式版用户只跟正式版；预发布用户继续跟预发布通道。
 */
function trackVersions(state: SessionUpdateState, versions: VersionInfo[]): void {
  if (versions.length === 0) return;
  const current = getCurrentVersion();
  const track = resolveUpdateTrack(current, versions, resolveCurrentChannel(current, versions));
  if (
    track.applicable &&
    (!state.remoteVersion ||
      compareReleaseVersions(track.applicable.version, state.remoteVersion) > 0)
  ) {
    state.remoteVersion = track.applicable.version;
    state.remoteChannel = track.applicable.channel;
  }
  if (
    track.latestPrerelease &&
    (!state.latestPrerelease ||
      compareReleaseVersions(track.latestPrerelease.version, state.latestPrerelease) > 0)
  ) {
    state.latestPrerelease = track.latestPrerelease.version;
    state.latestPrereleaseTag = track.latestPrerelease.tag;
  }
  refreshDerived(state);
}

/** 把探测结果写回状态；版本列表刷新，remote / latestPre 只向上修正。 */
function applyProbes(
  state: SessionUpdateState,
  probes: ProbeResult[],
  updateActive = true,
): boolean {
  for (const p of probes) {
    state.probes[p.id] = {
      latencyMs: p.latencyMs,
      reachable: p.reachable,
      version: p.version,
      error: p.error,
      lastCheckedAt: p.lastCheckedAt,
    };
  }
  const reachable = probes.filter((p) => p.reachable && p.versions.length > 0);
  reachable.sort((a, b) => (a.latencyMs ?? Number.MAX_SAFE_INTEGER) - (b.latencyMs ?? Number.MAX_SAFE_INTEGER));
  const best = reachable[0];
  if (best) {
    state.versions = best.versions;
    // 自动检查（全量测速）才切「当前镜像」；单测一个镜像不改变资源下载用的镜像
    if (updateActive) state.activeMirrorId = best.id;
    trackVersions(state, best.versions);
  } else {
    refreshDerived(state);
  }
  return reachable.length > 0;
}

/** 后台自动检查：按 10 分钟 TTL 节流；页面刷新 / 切回前台都会调用，不阻塞。 */
export function triggerAutoCheck(key: string): void {
  const state = getOrInit(key);
  if (state.status === 'checking' || autoInflight.has(key)) return;
  const now = Date.now();
  if (state.lastAutoCheckAt && now - state.lastAutoCheckAt < AUTO_CHECK_TTL_MS) return;
  state.lastAutoCheckAt = now;
  state.status = 'checking';
  autoInflight.add(key);
  void (async () => {
    try {
      const probes = await pingMirrors();
      const anyReachable = applyProbes(state, probes);
      state.status = anyReachable ? (state.hasUpdate ? 'update' : 'latest') : 'unreachable';
      state.message = anyReachable ? '' : '所有镜像均无法连接';
      if (state.hasUpdate) {
        rootLogger.info(`[update] 发现新版本 v${state.remoteVersion}（镜像 ${state.activeMirrorId}）`);
      }
    } catch (e) {
      state.status = 'unreachable';
      state.message = e instanceof Error ? e.message : String(e);
    } finally {
      state.checkedThisSession = true;
      autoInflight.delete(key);
    }
  })();
}

/**
 * 手动 ping / 测速（用户触发，随时可用，会等待结果返回）。
 * 除测速与刷新版本列表外，还会把 remoteVersion **向上**修正：
 * 用户手动检查到新版本时，侧边栏的 NEW 红点必须立刻亮起来，而不是等下一次自动检查。
 */
export async function pingSession(key: string, mirrorIds?: string[] | null): Promise<void> {
  const state = getOrInit(key);
  try {
    const probes = await pingMirrors(mirrorIds && mirrorIds.length ? mirrorIds : undefined);
    if (applyProbes(state, probes, false)) {
      state.status = state.hasUpdate ? 'update' : 'latest';
    }
  } catch (e) {
    state.message = e instanceof Error ? e.message : String(e);
  }
}

/** 面向前端的可序列化视图：镜像列表按「最近检测时间」倒序（最新在最上） */
export function getSessionUpdateView(key: string) {
  const state = getOrInit(key);
  refreshDerived(state);

  const mirrors = MIRRORS.map((m) => {
    const p = state.probes[m.id];
    return {
      id: m.id,
      label: m.label,
      url: m.url,
      latencyMs: p?.latencyMs ?? null,
      reachable: p?.reachable ?? false,
      version: p?.version ?? '',
      error: p?.error ?? '',
      lastCheckedAt: p?.lastCheckedAt ?? '',
    };
  });
  mirrors.sort((a, b) => {
    const ta = a.lastCheckedAt ? Date.parse(a.lastCheckedAt) : 0;
    const tb = b.lastCheckedAt ? Date.parse(b.lastCheckedAt) : 0;
    return tb - ta;
  });

  return {
    ok: true,
    status: state.status,
    checkedThisSession: state.checkedThisSession,
    currentVersion: state.currentVersion,
    currentChannel: state.currentChannel,
    remoteVersion: state.remoteVersion,
    remoteChannel: state.remoteChannel,
    latestPrerelease: state.latestPrerelease,
    latestPrereleaseTag: state.latestPrereleaseTag,
    hasUpdate: state.hasUpdate,
    hasPrerelease: state.hasPrerelease,
    activeMirrorId: state.activeMirrorId,
    message: state.message,
    releaseUrl: RELEASES_LATEST_URL,
    mirrors,
    versions: state.versions,
  };
}
