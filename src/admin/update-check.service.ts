import { rootLogger } from '../core/logger.js';
import { getFrameworkVersion } from './agreement.service.js';
import { compareVersions } from './announcement-update.service.js';

/**
 * 更新检查（GitHub 路线）。
 *
 * 设计要点（见需求）：
 * - 版本号权威来源 = GitHub Release 的 tag（不是标题）。
 * - 国内不一定能直连 github.com / api.github.com，所以提供一组「镜像源」（官方 +
 *   常见公共加速代理），每个镜像都指向同一个 releases 列表接口的不同入口。
 * - 「自动检查」：进入后台时后台异步 ping 所有镜像，选延迟最低且可用的一个取版本列表，
 *   用最新版本与本地版本对比。整个过程 fire-and-forget，不阻塞主流程。
 * - 每个登录会话只自动检查一次：无论「发现新版本」还是「全部镜像联不通」，都标记不再自动访问。
 * - 悬浮窗里的「一键 Ping / 测试访问」是用户手动触发（仅测速，不改动版本对比结果），
 *   但会顺带刷新可选版本列表。
 *
 * 镜像列表是一个常量，随时可增删/替换。
 */

/** 目标仓库 owner/name */
const REPO = 'tc-404/kakake';
/** 发行版列表接口（取全部版本，用于版本下拉；各镜像以此为基准拼前缀） */
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases?per_page=30`;
/** Atom 源（同样含全部发行版） */
const ATOM_URL = `https://github.com/${REPO}/releases.atom`;
/** 最新发行版页面 */
const RELEASES_LATEST_URL = `https://github.com/${REPO}/releases`;

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

export type MirrorStatus = 'idle' | 'checking' | 'latest' | 'update' | 'unreachable';

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
  remoteVersion: string;
  hasUpdate: boolean;
  activeMirrorId: string;
  message: string;
  probes: Record<string, Probe>;
  /** 最近一次成功访问拿到的版本列表（供版本下拉） */
  versions: VersionInfo[];
};

const sessionStates = new Map<string, SessionUpdateState>();
const autoInflight = new Set<string>();

function emptyState(): SessionUpdateState {
  return {
    status: 'idle',
    checkedThisSession: false,
    currentVersion: getFrameworkVersion(),
    remoteVersion: '',
    hasUpdate: false,
    activeMirrorId: '',
    message: '',
    probes: {},
    versions: [],
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

/** 从镜像响应体解析出完整版本列表（最新在前） */
function parseVersions(kind: MirrorKind, body: string): VersionInfo[] {
  if (kind === 'jsdelivr') {
    // jsDelivr 只给版本号数组（已按语义化版本从新到旧），无精确 tag/标题，
    // 下载地址退回发行版列表页。
    try {
      const j = JSON.parse(body) as { versions?: string[] };
      return (j.versions || [])
        .filter((v) => typeof v === 'string' && v)
        .map((v) => ({
          version: normalizeTag(v),
          tag: v,
          name: '',
          url: RELEASES_LATEST_URL,
          publishedAt: '',
        }));
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
      });
    }
    return out;
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
    });
  }
  return out;
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

/**
 * 把探测结果写回状态。
 * 版本列表（versions）在任何一次成功访问后都会刷新（供下拉展示）；
 * 但 remoteVersion / hasUpdate 只在 recomputeVersion=true（自动检查）时更新。
 */
function applyProbes(state: SessionUpdateState, probes: ProbeResult[], recomputeVersion = true): boolean {
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
  if (best) state.versions = best.versions;
  if (recomputeVersion) {
    if (best) {
      state.activeMirrorId = best.id;
      state.remoteVersion = best.version;
    }
    state.currentVersion = getFrameworkVersion();
    state.hasUpdate = !!state.remoteVersion && compareVersions(state.remoteVersion, state.currentVersion) > 0;
  }
  return reachable.length > 0;
}

/**
 * 自动检查（后台、非阻塞）：本次会话仅一次。
 */
export function triggerAutoCheck(key: string): void {
  const state = getOrInit(key);
  if (state.checkedThisSession || state.status === 'checking' || autoInflight.has(key)) return;
  state.status = 'checking';
  autoInflight.add(key);
  void (async () => {
    try {
      const probes = await pingMirrors();
      const anyReachable = applyProbes(state, probes, true);
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
 * 只测延迟与可用性、顺带刷新版本列表；不重新做版本号对比——版本对比只由自动检查负责。
 */
export async function pingSession(key: string, mirrorIds?: string[] | null): Promise<void> {
  const state = getOrInit(key);
  try {
    const probes = await pingMirrors(mirrorIds && mirrorIds.length ? mirrorIds : undefined);
    applyProbes(state, probes, false);
  } catch (e) {
    state.message = e instanceof Error ? e.message : String(e);
  }
}

/** 面向前端的可序列化视图：镜像列表按「最近检测时间」倒序（最新在最上） */
export function getSessionUpdateView(key: string) {
  const state = getOrInit(key);
  state.currentVersion = getFrameworkVersion();
  state.hasUpdate = !!state.remoteVersion && compareVersions(state.remoteVersion, state.currentVersion) > 0;

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
    remoteVersion: state.remoteVersion,
    hasUpdate: state.hasUpdate,
    activeMirrorId: state.activeMirrorId,
    message: state.message,
    releaseUrl: RELEASES_LATEST_URL,
    mirrors,
    versions: state.versions,
  };
}
