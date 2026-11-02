import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PATHS } from '../paths.js';
import { githubAuthHeaders, getGithubToken } from '../core/github-token.js';
import { readJsonSafe, writeJsonAtomic } from '../storage/atomic-file.js';
import { verifyUpdateSignature } from '../update/verify-keys.js';

/** 资源商店来源 */
export type StoreOrigin = 'kakake' | 'github';

/** 咔咔珂源：资源商城公开 API（Node 版：/zhiyuan） */
export const PLUGIN_STORE_BASE =
  'https://xn--mk-ub3cl61ae1v.xn--c5w857b.xn--fiqs8s/zhiyuan';

/** 站点根（用于补全相对 links） */
export const PLUGIN_STORE_ORIGIN =
  'https://xn--mk-ub3cl61ae1v.xn--c5w857b.xn--fiqs8s';

/** 仅对接此分类名 */
export const PLUGIN_STORE_CAT_NAME = '咔咔插件';

/** GitHub 源：index.json raw 直链（可改成你自己的商店仓库） */
export const GITHUB_INDEX_URL =
  'https://raw.githubusercontent.com/tc-404/kakake-plugin-main/main/index.json';

/** 默认来源（可在设置页切换） */
const DEFAULT_ORIGIN: StoreOrigin = 'github';

const LIST_CACHE_TTL_MS = 60_000;
/** GitHub 仓库元信息（星数 / 更新时间）缓存更久，避开限流 */
const REPO_META_TTL_MS = 15 * 60_000;
/** GitHub 仓库下载次数：变化慢、每仓库一次 API，缓存更久 */
const REPO_DOWNLOADS_TTL_MS = 30 * 60_000;
/** README 缓存 */
const README_TTL_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 15_000;
/** 封面可能是大体积 PNG，单独放宽超时 */
const COVER_FETCH_TIMEOUT_MS = 90_000;
const COVER_MAX_BYTES = 12 * 1024 * 1024;
const DOWNLOAD_MAX_BYTES = 64 * 1024 * 1024;

/** 安装级并发闸：商城安装与链接导入共享；每个安装峰值可达数百 MB，不设上限就是 OOM 排队 */
const INSTALL_MAX_CONCURRENT = 2;
let installRunning = 0;

export async function withInstallSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (installRunning >= INSTALL_MAX_CONCURRENT) {
    throw new Error('已有插件安装任务进行中，请等待完成后再试');
  }
  installRunning += 1;
  try {
    return await fn();
  } finally {
    installRunning -= 1;
  }
}

/** 插件商城安装下载进度（前端凭 taskId 轮询，随 install 请求结束清除） */
export type StoreInstallProgress = {
  downloaded: number;
  /** 0 表示响应未带 Content-Length，总量未知 */
  total: number;
  phase: 'downloading' | 'installing';
  /** 用户已请求取消，读包循环据此把中断翻译成「已取消」而不是网络错误 */
  cancelled?: boolean;
};

/** 安装结果暂存：页面刷新后 install 的 POST 已随页面断开，结果留给重连方取走 */
export type StashedInstallResult = {
  ok: boolean;
  code?: string;
  message: string;
  pluginId?: string;
  kind?: string;
  at: number;
};

const INSTALL_RESULT_TTL_MS = 15 * 60_000;
const INSTALL_RESULT_MAX = 20;

/** 插件下载配置（设置页「多线程下载」）；multiThread 仅对 GitHub/URL 直链源生效 */
export type StoreDownloadConfig = {
  multiThread: boolean;
  mode: 'always' | 'minSize';
  minSizeMB: number;
};

const DEFAULT_DOWNLOAD_CONFIG: StoreDownloadConfig = { multiThread: false, mode: 'minSize', minSizeMB: 4 };

function sanitizeDownloadConfig(raw: unknown): StoreDownloadConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<StoreDownloadConfig>;
  const mb = Number.isFinite(r.minSizeMB) ? Math.round(Number(r.minSizeMB)) : DEFAULT_DOWNLOAD_CONFIG.minSizeMB;
  return {
    multiThread: r.multiThread === true,
    mode: r.mode === 'always' ? 'always' : 'minSize',
    minSizeMB: Math.min(1024, Math.max(1, mb)),
  };
}

/** sha256 校验失败：可被控制器识别并回传专属错误码 */
export class Sha256MismatchError extends Error {
  readonly code = 'sha256_mismatch';
  constructor(message = '安装包校验未通过，文件可能被篡改或损坏') {
    super(message);
    this.name = 'Sha256MismatchError';
  }
}

/** 用户主动取消下载：控制器回传 code='cancelled'，且不触发单流回退 */
export class StoreInstallCancelledError extends Error {
  constructor(message = '已取消下载') {
    super(message);
    this.name = 'StoreInstallCancelledError';
  }
}

/**
 * 商城网络错误（超时 / 连不上 / 证书 / HTTP 状态码）。
 *
 * 带 `code` 是为了让控制台能按码翻译：以前底层 fetch 超时抛的是英文
 * （"This operation was aborted due to timeout"）或 Node 的原始错误串，
 * 直接上屏既不通顺、英文模式下也没法翻。这里统一归一成中文 + 错误码。
 */
export class StoreFetchError extends Error {
  readonly code: 'timeout' | 'network' | 'tls' | 'http';
  constructor(code: 'timeout' | 'network' | 'tls' | 'http', message: string) {
    super(message);
    this.name = 'StoreFetchError';
    this.code = code;
  }
}

/** 错误码对应的默认中文文案 */
const STORE_FETCH_MESSAGE: Record<StoreFetchError['code'], string> = {
  timeout: '请求超时，请检查网络后重试',
  network: '网络连接失败，请检查网络后重试',
  tls: 'HTTPS 证书校验失败，请检查系统时间或网络环境',
  http: '服务端返回异常状态码',
};

/** 把底层 fetch 异常（超时 / DNS / 连接被拒 / 证书…）归一成 StoreFetchError */
function classifyFetchError(e: unknown): StoreFetchError {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  const name = e instanceof Error ? e.name : '';
  const msg = e instanceof Error ? e.message : String(e ?? '');

  if (name === 'TimeoutError' || /timed ?out|timeout/i.test(msg)) {
    return new StoreFetchError('timeout', STORE_FETCH_MESSAGE.timeout);
  }
  if (code === 'ETIMEDOUT') return new StoreFetchError('timeout', STORE_FETCH_MESSAGE.timeout);
  if (
    code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ECONNREFUSED'
    || code === 'ECONNRESET' || code === 'ECONNABORTED' || code === 'EHOSTUNREACH'
    || code === 'ENETUNREACH' || code === 'EPIPE' || code === 'EHOSTDOWN'
    || /fetch failed|failed to fetch|network/i.test(msg)
  ) {
    return new StoreFetchError('network', STORE_FETCH_MESSAGE.network);
  }
  if (/certificate|SSL|TLS|self.signed/i.test(msg)) {
    return new StoreFetchError('tls', STORE_FETCH_MESSAGE.tls);
  }
  return new StoreFetchError('network', STORE_FETCH_MESSAGE.network);
}

/** 根据文件头识别真实图片类型（远端 Content-Type 常不准，PNG 透明图尤甚） */
function sniffImageContentType(buf: Buffer, headerType = ''): string | null {
  if (buf.length >= 8) {
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      return 'image/png';
    }
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
      return 'image/jpeg';
    }
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
      return 'image/gif';
    }
    if (
      buf.length >= 12
      && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
      && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
    ) {
      return 'image/webp';
    }
  }
  const clean = (headerType || '').split(';')[0].trim().toLowerCase();
  if (clean.startsWith('image/') && clean !== 'image/*') return clean;
  return null;
}

export type StoreCategory = { id: number; name: string };

export type StoreResource = {
  id: number;
  title: string;
  version: string;
  author: string;
  category_id: number;
  cat_name: string;
  /** 上游类型：官鸡 / 野鸡 / wxbot（咔咔源）；或 野生 / 官方 / 双生 / 微信 / 其他（GitHub 源，见 type） */
  resource_type: string;
  summary: string;
  description: string;
  update_notes: string;
  sort_order: number;
  preview_count: number;
  /**
   * 下载次数。咔咔珂源由商城接口直出，恒为数字；
   * GitHub 源**无值 = 拿不到**（未配置 Token，或接口限流失败），前端遇到无值不显示。
   */
  download_count?: number;
  tags: string[];
  allow_list: 0 | 1;
  allow_detail: 0 | 1;
  allow_cover_preview: 0 | 1;
  allow_download: 0 | 1;
  download_block_reason: string;
  uploader_name: string;
  created_at: string;
  updated_at: string;
  links: { cover: string; download: string };

  /* ---- GitHub 源扩展字段（咔咔源为空/缺省） ---- */
  /** 数据来源 */
  origin?: StoreOrigin;
  /** 插件包标识（= 插件 plugin.json 的 name），用于「已安装/可更新」判断 */
  plugin_id?: string;
  /** 作者 GitHub 用户名（login） */
  github?: string;
  /** 归一化类型：野生 / 官方 / 双生 / 微信 / 其他 */
  type?: string;
  /** 要求的咔咔珂最低版本 */
  min_kakake?: string;
  /** 源码仓库地址 */
  homepage?: string;
  /** 头像直链（GitHub 源用作卡片图标） */
  avatar_url?: string;
  /** 仓库星数（best-effort，可能缺省） */
  stars?: number;
  /** 安装包 sha256（可选，安装时校验） */
  sha256?: string;
};

export type StoreComment = {
  id: number;
  nickname: string;
  body: string;
  created_at: string;
  created_at_label: string;
};

/** GitHub index.json 里的插件对象（精简后的 kakake-plugins-v1） */
type GithubPlugin = {
  title?: string;
  version?: string;
  plugin_id?: string;
  name?: string;
  type?: string;
  min_kakake?: string;
  homepage?: string;
  summary?: string;
  description?: string;
  update_notes?: string;
  tags?: string[];
  pinned?: boolean;
  download?: string;
  sha256?: string;
};

type ListCache = {
  at: number;
  catId: number;
  categories: StoreCategory[];
  resources: StoreResource[];
  pinned: StoreResource[];
};

function absoluteUrl(maybeRelative: string): string {
  const s = (maybeRelative || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('/')) return `${PLUGIN_STORE_ORIGIN}${s}`;
  return `${PLUGIN_STORE_BASE}/${s.replace(/^\.\//, '')}`;
}

function normalizeResource(raw: StoreResource): StoreResource {
  return {
    ...raw,
    version: raw.version || '',
    author: raw.author || '',
    resource_type: raw.resource_type || '',
    summary: raw.summary || '',
    description: raw.description || '',
    update_notes: raw.update_notes || '',
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    download_count: typeof raw.download_count === 'number' && Number.isFinite(raw.download_count)
      ? raw.download_count
      : 0,
    download_block_reason: raw.download_block_reason || '',
    origin: 'kakake',
    links: {
      cover: absoluteUrl(raw.links?.cover || ''),
      download: absoluteUrl(raw.links?.download || ''),
    },
  };
}

/** 稳定字符串 → 正整数（作为 GitHub 源资源的合成 id） */
function stableId(key: string): number {
  let h = 5381;
  for (let i = 0; i < key.length; i++) {
    h = ((h << 5) + h + key.charCodeAt(i)) | 0;
  }
  return (h & 0x7fffffff) || 1;
}

/**
 * 归一化 type：只接受 野生/官方/双生/微信/其他，其它一律 其他。
 *
 * 「双生」= OneBot + QQ 官方双协议插件（目录前缀 sssx-plugin-*）。
 * index.json 里也可能写作 sssx / twin / 双生插件，这里一律并到「双生」，
 * 否则会被下面的兜底吞成「其他」，前端就永远显示不出双生角标。
 */
function normalizeType(t?: string): string {
  const v = (t || '').trim();
  if (v === '野生' || v === '官方' || v === '微信' || v === '其他') return v;
  const low = v.toLowerCase();
  if (v === '双生' || v === '双生插件' || low === 'sssx' || low === 'sssx-plugin' || low === 'twin') {
    return '双生';
  }
  return '其他';
}

/** 从 homepage 解析 GitHub owner/repo */
function parseRepo(homepage?: string): { owner: string; repo: string } | null {
  const s = (homepage || '').trim();
  const m = /github\.com\/([^/\s]+)\/([^/\s#?]+)/i.exec(s);
  if (!m) return null;
  const owner = m[1];
  const repo = m[2].replace(/\.git$/i, '');
  if (!owner || !repo) return null;
  return { owner, repo };
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Kakake-PluginStore/0.1',
        ...(init?.headers as Record<string, string> | undefined),
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    // 超时 / DNS / 连接被拒：归一成带错误码的中文错误，控制台才能双语展示
    throw classifyFetchError(e);
  }
  if (!res.ok) {
    throw new Error(`商城接口 HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

/**
 * 按更新中心选定的镜像前缀改写 GitHub 系列地址（与在线更新共用同一个源）。
 * prefix 形如 `https://gh-proxy.com/`；官方直连镜像 prefix 为空，返回原地址。
 */
function applyMirror(url: string, prefix?: string): string {
  const p = (prefix || '').trim();
  if (!p) return url;
  if (/^https:\/\/(api\.github\.com|github\.com|raw\.githubusercontent\.com|codeload\.github\.com|objects\.githubusercontent\.com)\//i.test(url)) {
    return `${p}${url}`;
  }
  return url;
}

/** 条目数兜底：受信数据源也可能撑大内存，超限丢最老的键（Map 迭代序即插入序） */
function capMap<T>(m: Map<string, T>, limit: number): void {
  if (m.size <= limit) return;
  let drop = m.size - limit;
  for (const k of m.keys()) {
    if (drop <= 0) break;
    m.delete(k);
    drop -= 1;
  }
}

class PluginStoreService {
  /** 双源内存缓存（可为过期陈旧数据，用于秒开 + 兜底） */
  private listCache: Record<StoreOrigin, ListCache | null> = { kakake: null, github: null };
  /** 同源刷新去重：并发请求共享同一个在途 Promise */
  private inflight: Record<StoreOrigin, Promise<ListCache> | null> = { kakake: null, github: null };
  /** 是否已尝试从磁盘载入过缓存 */
  private diskLoaded = false;
  private catIdCache: { at: number; id: number } | null = null;
  private repoMetaCache = new Map<string, { at: number; stars?: number; updatedAt?: string }>();  /** GitHub 仓库下载次数缓存（仅配置 Token 时才会写入） */
  private repoDownloadsCache = new Map<string, { at: number; downloads: number | null }>();
  private readmeCache = new Map<string, { at: number; markdown: string | null }>();
  private originCache: StoreOrigin | null = null;
  private downloadCfg: StoreDownloadConfig | null = null;
  /** 进行中的安装下载进度，键为前端生成的 taskId */
  private installProgress = new Map<string, StoreInstallProgress>();
  /** 各 taskId 下载阶段的 AbortController，取消接口据此掐断在途 fetch */
  private installAborts = new Map<string, AbortController>();
  /** 已结束安装的结果暂存（TTL 内可被刷新后的页面取走） */
  private installResults = new Map<string, StashedInstallResult>();

  getInstallProgress(taskId: string): StoreInstallProgress | null {
    return this.installProgress.get(taskId) ?? null;
  }

  /** 建立下载进度账（total 0 = 未知）；商城安装与链接导入共用同一套账 */
  beginInstallProgress(taskId: string, total: number): void {
    this.installProgress.set(taskId, { downloaded: 0, total, phase: 'downloading' });
  }

  reportInstallProgress(taskId: string, downloaded: number, total: number): void {
    this.installProgress.set(taskId, { downloaded, total, phase: 'downloading' });
  }

  setInstallPhase(taskId: string, phase: StoreInstallProgress['phase']): void {
    const cur = this.installProgress.get(taskId);
    if (cur) this.installProgress.set(taskId, { ...cur, phase });
  }

  clearInstallProgress(taskId: string): void {
    this.installProgress.delete(taskId);
  }

  registerInstallAbort(taskId: string, ac: AbortController): void {
    this.installAborts.set(taskId, ac);
  }

  clearInstallAbort(taskId: string): void {
    this.installAborts.delete(taskId);
  }

  /** 取消下载：仅在下载阶段有效，标记后掐断在途 fetch */
  cancelInstall(taskId: string): { ok: boolean; message?: string } {
    const entry = this.installProgress.get(taskId);
    if (!entry) return { ok: false, message: '没有进行中的下载' };
    if (entry.phase !== 'downloading') return { ok: false, message: '已进入安装阶段，无法取消' };
    entry.cancelled = true;
    const ac = this.installAborts.get(taskId);
    if (!ac) return { ok: false, message: '下载已结束，无法取消' };
    ac.abort();
    return { ok: true };
  }

  /** 暂存安装结果；顺手清理过期项并限容，映射不会无界增长 */
  stashInstallResult(taskId: string, result: Omit<StashedInstallResult, 'at'>): void {
    const now = Date.now();
    for (const [k, v] of this.installResults) {
      if (now - v.at > INSTALL_RESULT_TTL_MS) this.installResults.delete(k);
    }
    while (this.installResults.size >= INSTALL_RESULT_MAX) {
      let oldestKey = '';
      let oldestAt = Infinity;
      for (const [k, v] of this.installResults) {
        if (v.at < oldestAt) {
          oldestAt = v.at;
          oldestKey = k;
        }
      }
      if (!oldestKey) break;
      this.installResults.delete(oldestKey);
    }
    this.installResults.set(taskId, { ...result, at: now });
  }

  /** 取走暂存结果（一次性），没有则返回 null */
  popInstallResult(taskId: string): StashedInstallResult | null {
    const r = this.installResults.get(taskId) ?? null;
    if (r) this.installResults.delete(taskId);
    return r;
  }

  /** 安装流程收尾：结果先入暂存，再清进度与 abort 登记（重连方靠它收敛，顺序不能反） */
  finishInstall(
    taskId: string,
    result: { ok: boolean; code?: string; message: string; pluginId?: string; kind?: string },
  ): void {
    this.stashInstallResult(taskId, result);
    this.clearInstallProgress(taskId);
    this.clearInstallAbort(taskId);
  }

  /* ================= 来源开关与下载配置 ================= */

  private readStateFile(): { origin?: string; download?: Partial<StoreDownloadConfig> } {
    return readJsonSafe<{ origin?: string; download?: Partial<StoreDownloadConfig> } | null>(
      PATHS.pluginStoreState,
      null,
      { label: 'plugin-store.json' },
    ) || {};
  }

  private writeStateFile(patch: { origin?: StoreOrigin; download?: StoreDownloadConfig }): void {
    try {
      writeJsonAtomic(PATHS.pluginStoreState, { ...this.readStateFile(), ...patch });
    } catch { /* ignore */ }
  }

  getOrigin(): StoreOrigin {
    if (this.originCache) return this.originCache;
    const raw = this.readStateFile();
    if (raw.origin === 'github' || raw.origin === 'kakake') {
      this.originCache = raw.origin;
      return raw.origin;
    }
    this.originCache = DEFAULT_ORIGIN;
    return DEFAULT_ORIGIN;
  }

  setOrigin(origin: StoreOrigin): StoreOrigin {
    const next: StoreOrigin = origin === 'github' ? 'github' : 'kakake';
    this.originCache = next;
    this.writeStateFile({ origin: next });
    return next;
  }

  getDownloadConfig(): StoreDownloadConfig {
    if (this.downloadCfg) return this.downloadCfg;
    this.downloadCfg = sanitizeDownloadConfig(this.readStateFile().download);
    return this.downloadCfg;
  }

  setDownloadConfig(patch: Partial<StoreDownloadConfig>): StoreDownloadConfig {
    const cur = this.getDownloadConfig();
    const next = sanitizeDownloadConfig({
      multiThread: typeof patch.multiThread === 'boolean' ? patch.multiThread : cur.multiThread,
      mode: patch.mode === 'always' || patch.mode === 'minSize' ? patch.mode : cur.mode,
      minSizeMB: Number.isFinite(patch.minSizeMB) ? Number(patch.minSizeMB) : cur.minSizeMB,
    });
    this.downloadCfg = next;
    this.writeStateFile({ download: next });
    return next;
  }

  /* ================= 列表分发（陈旧即用 + 后台刷新 + 磁盘兜底） ================= */

  private pick(c: ListCache): {
    catId: number;
    categories: StoreCategory[];
    pinned: StoreResource[];
    resources: StoreResource[];
  } {
    return { catId: c.catId, categories: c.categories, pinned: c.pinned, resources: c.resources };
  }

  /** 首次访问时从磁盘载入上次成功的列表，避免冷启动干等网络 */
  private loadDiskCache(): void {
    if (this.diskLoaded) return;
    this.diskLoaded = true;
    const raw = readJsonSafe<Partial<Record<StoreOrigin, ListCache>> | null>(
      PATHS.pluginStoreCache,
      null,
      { label: 'plugin-store-cache.json' },
    );
    if (!raw) return;
    for (const src of ['kakake', 'github'] as StoreOrigin[]) {
      const entry = raw[src];
      if (entry && Array.isArray(entry.resources) && !this.listCache[src]) {
        this.listCache[src] = entry;
      }
    }
  }

  private saveDiskCache(): void {
    try {
      writeJsonAtomic(
        PATHS.pluginStoreCache,
        { kakake: this.listCache.kakake, github: this.listCache.github },
        { indent: null },
      );
    } catch { /* ignore */ }
  }

  /** 真正抓取并写入缓存（同源去重，避免并发重复请求外网） */
  private async refresh(src: StoreOrigin, mirrorPrefix?: string): Promise<ListCache> {
    if (this.inflight[src]) return this.inflight[src]!;
    const task = (async () => {
      const built = src === 'github'
        ? await this.buildGithubList(mirrorPrefix)
        : await this.buildKakakeList();
      this.listCache[src] = built;
      this.saveDiskCache();
      return built;
    })();
    this.inflight[src] = task;
    try {
      return await task;
    } finally {
      this.inflight[src] = null;
    }
  }

  async fetchList(force = false, origin?: StoreOrigin, mirrorPrefix?: string): Promise<{
    origin: StoreOrigin;
    catId: number;
    categories: StoreCategory[];
    pinned: StoreResource[];
    resources: StoreResource[];
  }> {
    const src = origin || this.getOrigin();
    this.loadDiskCache();
    const cached = this.listCache[src];
    const fresh = cached && Date.now() - cached.at < LIST_CACHE_TTL_MS;

    // 新鲜缓存：直接返回
    if (cached && fresh && !force) {
      return { origin: src, ...this.pick(cached) };
    }

    // 有陈旧缓存：立刻返回旧数据，后台静默刷新（点刷新按钮时也先尝试拿新的，失败回退旧的）
    if (cached) {
      if (force) {
        try {
          return { origin: src, ...this.pick(await this.refresh(src, mirrorPrefix)) };
        } catch {
          return { origin: src, ...this.pick(cached) };
        }
      }
      void this.refresh(src, mirrorPrefix).catch(() => { /* 后台刷新失败保留旧缓存 */ });
      return { origin: src, ...this.pick(cached) };
    }

    // 无任何缓存：只能前台等待一次冷抓取
    return { origin: src, ...this.pick(await this.refresh(src, mirrorPrefix)) };
  }

  /* ================= 咔咔珂源（原逻辑） ================= */

  private async resolveKakakeCatId(force = false): Promise<number> {
    const now = Date.now();
    if (!force && this.catIdCache && now - this.catIdCache.at < LIST_CACHE_TTL_MS) {
      return this.catIdCache.id;
    }
    const data = await fetchJson<{
      ok?: boolean;
      categories?: StoreCategory[];
    }>(`${PLUGIN_STORE_BASE}/api/list`);
    if (!data.ok || !Array.isArray(data.categories)) {
      throw new Error('无法获取商城分类');
    }
    const hit = data.categories.find((c) => c.name === PLUGIN_STORE_CAT_NAME);
    if (!hit) {
      throw new Error(`未找到分类「${PLUGIN_STORE_CAT_NAME}」`);
    }
    this.catIdCache = { at: now, id: hit.id };
    return hit.id;
  }

  private async buildKakakeList(): Promise<ListCache> {
    const now = Date.now();
    const catId = await this.resolveKakakeCatId(true);
    const data = await fetchJson<{
      ok?: boolean;
      format?: string;
      categories?: StoreCategory[];
      pinned?: StoreResource[];
      main?: Array<{ resources?: StoreResource[] }>;
    }>(`${PLUGIN_STORE_BASE}/api/list?cat=${catId}`);

    if (!data.ok || data.format !== 'zhiyuan-storefront-list') {
      throw new Error('商城列表格式无效');
    }

    const pinned = (data.pinned || []).map(normalizeResource);
    const mainResources = (data.main || []).flatMap((g) => g.resources || []).map(normalizeResource);
    const seen = new Set<number>();
    const resources: StoreResource[] = [];
    for (const r of [...pinned, ...mainResources]) {
      if (seen.has(r.id)) continue;
      if (r.cat_name && r.cat_name !== PLUGIN_STORE_CAT_NAME) continue;
      if (r.category_id && r.category_id !== catId) continue;
      seen.add(r.id);
      resources.push(r);
    }

    const categories = (data.categories || []).filter((c) => c.name === PLUGIN_STORE_CAT_NAME);
    return {
      at: now,
      catId,
      categories,
      pinned: pinned.filter((r) => r.category_id === catId || r.cat_name === PLUGIN_STORE_CAT_NAME),
      resources,
    };
  }

  /* ================= GitHub 源 ================= */

  private githubToResource(p: GithubPlugin): StoreResource {
    const title = (p.title || '').trim();
    const github = (p.name || '').trim();
    const key = (p.plugin_id || title).trim();
    const id = stableId(key || title || github);
    const type = normalizeType(p.type);
    return {
      id,
      title,
      version: (p.version || '').trim(),
      author: github, // 展示用作者名 = GitHub 用户名
      category_id: 1,
      cat_name: PLUGIN_STORE_CAT_NAME,
      resource_type: type,
      summary: (p.summary || '').trim(),
      description: (p.description || '').trim(),
      update_notes: (p.update_notes || '').trim(),
      sort_order: 0,
      preview_count: 0,
      // 下载次数不在这里给 0：0 与「拿不到」必须区分开，后台补数据时才会填入
      tags: Array.isArray(p.tags) ? p.tags : [],
      allow_list: 1,
      allow_detail: 1,
      allow_cover_preview: 0,
      allow_download: p.download ? 1 : 0,
      download_block_reason: p.download ? '' : '缺少下载链接',
      uploader_name: github,
      created_at: '',
      updated_at: '',
      links: { cover: '', download: (p.download || '').trim() },
      origin: 'github',
      plugin_id: (p.plugin_id || '').trim(),
      github,
      type,
      min_kakake: (p.min_kakake || '').trim(),
      homepage: (p.homepage || '').trim(),
      avatar_url: github ? `https://github.com/${encodeURIComponent(github)}.png` : '',
      sha256: (p.sha256 || '').trim().toLowerCase(),
    };
  }

  private async buildGithubList(mirrorPrefix?: string): Promise<ListCache> {
    const now = Date.now();
    // 注意：不加时间戳缓存穿透参数，让 raw CDN 命中缓存以加快冷启动
    // Token（若已配置）只在直连官方域名时附带；走镜像前缀时主机是代理域名，自动不带
    const indexUrl = applyMirror(GITHUB_INDEX_URL, mirrorPrefix);
    const data = await fetchJson<{
      format?: string;
      plugins?: GithubPlugin[];
    }>(indexUrl, { headers: githubAuthHeaders(indexUrl) });

    if (data.format !== 'kakake-plugins-v1' || !Array.isArray(data.plugins)) {
      throw new Error('GitHub 源 index.json 格式无效');
    }

    const all = data.plugins
      .filter((p) => (p.title || '').trim())
      .map((p) => this.githubToResource(p));

    const pinned = all.filter((r, i) => data.plugins![i]?.pinned);
    const resources = all;

    const categories: StoreCategory[] = [{ id: 1, name: PLUGIN_STORE_CAT_NAME }];
    const built: ListCache = { at: now, catId: 1, categories, pinned, resources };

    // 先返回列表（星数/更新时间即使拿不到也不阻塞）；
    // 元数据后台补齐后回填到同一批对象并落盘，下次打开即带上。
    this.listCache.github = built;
    void this.enrichGithubMeta(resources, mirrorPrefix)
      .then(() => this.saveDiskCache())
      .catch(() => { /* 限流/网络失败：保持无星数 */ });

    return built;
  }

  /** 为 GitHub 资源补齐 stars / updated_at / 下载次数（后台执行，带独立缓存，避开限流） */
  private async enrichGithubMeta(resources: StoreResource[], mirrorPrefix?: string): Promise<void> {
    const now = Date.now();
    const targets = resources.filter((r) => parseRepo(r.homepage));
    /**
     * 下载次数要**逐个仓库**打 releases 接口，只有本机配置了 GitHub Token 时才做：
     * 匿名额度 60 次/时，几十个插件一轮补齐就能把额度打穿，还会连累星数一起 403。
     * 没配 Token → 这个字段保持无值，前端据此不显示（见 downloadCountsAvailable）。
     */
    const wantDownloads = !!getGithubToken();
    await Promise.all(targets.map(async (r) => {
      const repo = parseRepo(r.homepage);
      if (!repo) return;
      const cacheKey = `${repo.owner}/${repo.repo}`.toLowerCase();
      if (wantDownloads) await this.fillDownloadCount(r, repo, cacheKey, mirrorPrefix, now);
      const cached = this.repoMetaCache.get(cacheKey);
      if (cached && now - cached.at < REPO_META_TTL_MS) {
        if (cached.stars != null) r.stars = cached.stars;
        if (cached.updatedAt) r.updated_at = cached.updatedAt;
        return;
      }
      try {
        const metaUrl = applyMirror(`https://api.github.com/repos/${repo.owner}/${repo.repo}`, mirrorPrefix);
        const meta = await fetchJson<{ stargazers_count?: number; pushed_at?: string }>(
          metaUrl,
          { headers: { Accept: 'application/vnd.github+json', ...githubAuthHeaders(metaUrl) } },
        );
        const stars = typeof meta.stargazers_count === 'number' ? meta.stargazers_count : undefined;
        const updatedAt = typeof meta.pushed_at === 'string' ? meta.pushed_at : undefined;
        this.repoMetaCache.set(cacheKey, { at: now, stars, updatedAt });
        capMap(this.repoMetaCache, 300);
        if (stars != null) r.stars = stars;
        if (updatedAt) r.updated_at = updatedAt;
      } catch {
        // 限流 / 网络失败：保留缓存旧值或留空
        if (cached) {
          if (cached.stars != null) r.stars = cached.stars;
          if (cached.updatedAt) r.updated_at = cached.updatedAt;
        }
      }
    }));
  }

  /**
   * 取一个仓库的「下载次数」= 所有发行版里**用户上传资产**的 download_count 合计。
   * GitHub 自动生成的源码包（Source code zip/tar.gz）不在 assets 里，天然不计入。
   * 仅在已配置 Token 时被调用；失败/限流一律静默，保留上一次缓存值。
   */
  private async fillDownloadCount(
    r: StoreResource,
    repo: { owner: string; repo: string },
    cacheKey: string,
    mirrorPrefix: string | undefined,
    now: number,
  ): Promise<void> {
    const cached = this.repoDownloadsCache.get(cacheKey);
    if (cached && now - cached.at < REPO_DOWNLOADS_TTL_MS) {
      if (cached.downloads != null) r.download_count = cached.downloads;
      return;
    }
    try {
      const url = applyMirror(
        `https://api.github.com/repos/${repo.owner}/${repo.repo}/releases?per_page=100`,
        mirrorPrefix,
      );
      const list = await fetchJson<Array<{ assets?: Array<{ download_count?: number }> }>>(url, {
        headers: { Accept: 'application/vnd.github+json', ...githubAuthHeaders(url) },
      });
      if (!Array.isArray(list)) throw new Error('releases 格式无效');
      let total = 0;
      for (const rel of list) {
        if (!Array.isArray(rel?.assets)) continue;
        for (const asset of rel.assets) {
          const n = asset?.download_count;
          if (typeof n === 'number' && Number.isFinite(n) && n > 0) total += n;
        }
      }
      this.repoDownloadsCache.set(cacheKey, { at: now, downloads: total });
      capMap(this.repoDownloadsCache, 300);
      r.download_count = total;
    } catch {
      /* 限流 / 网络失败：保留旧值或无值 */
    }
  }

  /**
   * 当前源是否具备「下载次数」数据：
   * 咔咔珂源由商城接口直出，恒为 true；GitHub 源要靠本机 Token 逐个仓库查，没配就没有。
   * 前端据此决定「下载次数(多/少)」排序项是否出现。
   */
  downloadCountsAvailable(origin?: StoreOrigin): boolean {
    const src = origin || this.getOrigin();
    return src !== 'github' || !!getGithubToken();
  }

  /** Token 变更后调用：丢掉 GitHub 列表与下载次数缓存，下次拉取即带新数据 */
  invalidateGithub(): void {
    this.listCache.github = null;
    this.repoDownloadsCache.clear();
    this.saveDiskCache();
  }

  /** 拉取插件仓库 README（GitHub 源详情「文档」区用），拉不到返回 null */
  async fetchReadme(repoParam: string, force = false, mirrorPrefix?: string): Promise<string | null> {
    const repo = parseRepo(repoParam) || parseRepo(`https://github.com/${repoParam}`);
    if (!repo) return null;
    const cacheKey = `${repo.owner}/${repo.repo}`.toLowerCase();
    const now = Date.now();
    const cached = this.readmeCache.get(cacheKey);
    if (!force && cached && now - cached.at < README_TTL_MS) {
      return cached.markdown;
    }
    const candidates = [
      `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/HEAD/README.md`,
      `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/HEAD/readme.md`,
      `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/HEAD/插件文档.md`,
    ];
    for (const url of candidates) {
      try {
        const readmeUrl = applyMirror(url, mirrorPrefix);
        const res = await fetch(readmeUrl, {
          headers: { 'User-Agent': 'Kakake-PluginStore/0.1', ...githubAuthHeaders(readmeUrl) },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          redirect: 'follow',
        });
        if (!res.ok) continue;
        const text = await res.text();
        if (text && text.trim()) {
          this.readmeCache.set(cacheKey, { at: now, markdown: text });
          capMap(this.readmeCache, 300);
          return text;
        }
      } catch { /* try next */ }
    }
    this.readmeCache.set(cacheKey, { at: now, markdown: null });
    capMap(this.readmeCache, 300);
    return null;
  }

  /* ================= 通用 ================= */

  async getResourceById(id: number, origin?: StoreOrigin): Promise<StoreResource | undefined> {
    const { resources, pinned } = await this.fetchList(false, origin);
    return pinned.find((r) => r.id === id) || resources.find((r) => r.id === id);
  }

  async fetchComments(id: number, limit = 50): Promise<{
    resource_id: number;
    total: number;
    comments: StoreComment[];
  }> {
    // GitHub 源无评论
    if (this.getOrigin() === 'github') {
      return { resource_id: id, total: 0, comments: [] };
    }
    const lim = Math.min(100, Math.max(1, limit));
    const data = await fetchJson<{
      ok?: boolean;
      message?: string;
      resource_id?: number;
      total?: number;
      comments?: StoreComment[];
    }>(`${PLUGIN_STORE_BASE}/api/comments?id=${id}&limit=${lim}`);
    if (!data.ok) {
      throw new Error(data.message || '获取评论失败');
    }
    return {
      resource_id: data.resource_id ?? id,
      total: data.total ?? (data.comments?.length ?? 0),
      comments: data.comments || [],
    };
  }

  /** 封面内存缓存：脚本可绕过浏览器缓存反复回源，这里按资源 id LRU 兜底 */
  private coverCache = new Map<string, { buffer: Buffer; contentType: string; at: number }>();
  private static readonly COVER_CACHE_MAX = 30;
  private static readonly COVER_CACHE_TTL_MS = 60 * 60_000;

  async fetchCoverBuffer(id: number): Promise<{ buffer: Buffer; contentType: string }> {
    const cacheKey = String(id);
    const cached = this.coverCache.get(cacheKey);
    if (cached && Date.now() - cached.at < PluginStoreService.COVER_CACHE_TTL_MS) {
      return { buffer: cached.buffer, contentType: cached.contentType };
    }

    const resource = await this.getResourceById(id);
    if (!resource) throw new Error('资源不存在或不在咔咔插件分区');
    if (!resource.allow_cover_preview || !resource.links.cover) {
      throw new Error('该资源不允许封面预览');
    }

    const coverUrl = resource.links.cover;
    const res = await fetch(coverUrl, {
      headers: {
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'User-Agent': 'Kakake-PluginStore/0.1',
        Referer: `${PLUGIN_STORE_ORIGIN}/zhiyuan/`,
      },
      signal: AbortSignal.timeout(COVER_FETCH_TIMEOUT_MS),
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`封面获取失败 HTTP ${res.status}`);

    const headerType = res.headers.get('content-type') || '';
    const lenHeader = Number(res.headers.get('content-length') || 0);
    if (Number.isFinite(lenHeader) && lenHeader > COVER_MAX_BYTES) {
      throw new Error('封面过大');
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length < 8) throw new Error('封面内容过小');
    if (buffer.length > COVER_MAX_BYTES) throw new Error('封面过大');

    const contentType = sniffImageContentType(buffer, headerType);
    if (!contentType) {
      throw new Error(`封面不是有效图片（远端类型: ${headerType || '未知'}）`);
    }

    if (this.coverCache.size >= PluginStoreService.COVER_CACHE_MAX) {
      const oldest = [...this.coverCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]?.[0];
      if (oldest !== undefined) this.coverCache.delete(oldest);
    }
    this.coverCache.set(cacheKey, { buffer, contentType, at: Date.now() });
    return { buffer, contentType };
  }

  /** 下载 zip 到 data/tmp，返回本地路径；带 taskId 时流式记录进度供前端轮询 */
  async downloadToTemp(id: number, mirrorPrefix?: string, taskId?: string): Promise<{ zipPath: string; resource: StoreResource }> {
    const resource = await this.getResourceById(id);
    if (!resource) throw new Error('资源不存在或不在咔咔插件分区');
    if (!resource.allow_download || !resource.links.download) {
      throw new Error(resource.download_block_reason || '该资源不允许下载');
    }

    const downloadUrl = resource.origin === 'github'
      ? applyMirror(resource.links.download, mirrorPrefix)
      : resource.links.download;

    let buf: Buffer | null = null;

    // 这颗控制器同时承载 120s 整体超时与用户取消；取消标记记在进度账上
    const ac = new AbortController();
    const killer = setTimeout(() => ac.abort(), 120_000);
    if (taskId) this.registerInstallAbort(taskId, ac);
    try {
      // 多线程只认 GitHub/URL 直链源；咔咔珂源保持单流原机制
      const cfg = this.getDownloadConfig();
      if (resource.origin === 'github' && cfg.multiThread) {
        const probe = await this.probeRemoteSize(downloadUrl);
        const eligible = !!probe
          && probe.acceptRanges
          && probe.total > 0
          && probe.total <= DOWNLOAD_MAX_BYTES
          && (cfg.mode === 'always' || probe.total >= cfg.minSizeMB * 1024 * 1024);
        if (probe && eligible) {
          try {
            buf = await this.downloadRangeParallel(downloadUrl, probe.total, ac.signal, taskId);
          } catch {
            // 取消必须向上抛（不许回退重下）；其余分段失败 → 整体回退单流
            if (taskId && this.installProgress.get(taskId)?.cancelled) throw new StoreInstallCancelledError();
            buf = null;
          }
        }
      }

      if (!buf) {
        try {
          let res: Response;
          try {
            res = await fetch(downloadUrl, {
              headers: { 'User-Agent': 'Kakake-PluginStore/0.1', ...githubAuthHeaders(downloadUrl) },
              signal: ac.signal,
              redirect: 'follow',
            });
          } catch (e) {
            throw classifyFetchError(e);
          }
          if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(text.trim() || `下载失败 HTTP ${res.status}`);
          }

          const totalHeader = Number(res.headers.get('content-length'));
          const total = Number.isFinite(totalHeader) && totalHeader > 0 ? Math.round(totalHeader) : 0;
          if (taskId) this.installProgress.set(taskId, { downloaded: 0, total, phase: 'downloading' });

          // 流式收包：边读边记进度，超限即刻中断，不再整包读进内存后才校验
          const chunks: Buffer[] = [];
          let downloaded = 0;
          if (res.body) {
            const reader = res.body.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              const chunk = Buffer.from(value);
              chunks.push(chunk);
              downloaded += chunk.length;
              if (downloaded > DOWNLOAD_MAX_BYTES) {
                void reader.cancel().catch(() => {});
                throw new Error('下载内容过大');
              }
              if (taskId) this.installProgress.set(taskId, { downloaded, total, phase: 'downloading' });
            }
          } else {
            chunks.push(Buffer.from(await res.arrayBuffer()));
            downloaded = chunks[0].length;
          }
          if (taskId) this.installProgress.set(taskId, { downloaded, total, phase: 'downloading' });

          buf = Buffer.concat(chunks);
        } catch (e) {
          // fetch 与读包两个阶段都可能被取消/超时打断，统一在这里翻译
          if (taskId && this.installProgress.get(taskId)?.cancelled) throw new StoreInstallCancelledError();
          if (e instanceof StoreFetchError) throw e;
          if (e instanceof Error && e.name === 'AbortError') {
            throw new StoreFetchError('timeout', STORE_FETCH_MESSAGE.timeout);
          }
          throw e;
        }
      }
    } finally {
      clearTimeout(killer);
      if (taskId) this.clearInstallAbort(taskId);
    }

    if (buf.length < 32) {
      throw new Error('下载内容过小，可能不是有效插件包');
    }

    // sha256 校验（仅当资源声明了 sha256）
    const expected = (resource.sha256 || '').trim().toLowerCase();
    if (expected) {
      const actual = crypto.createHash('sha256').update(buf).digest('hex');
      if (actual !== expected) {
        throw new Sha256MismatchError(
          `安装包校验未通过：期望 ${expected.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…，文件可能被篡改或损坏`,
        );
      }
    }

    // Ed25519 离线验签（与在线更新共用公钥环，见 src/update/verify-keys.ts）：
    // 若下载地址存在同伴 <url>.sig 签名文件则**必须**验过才接受；签名文件不存在时
    // 维持既有行为（兼容未接入签名的资源源），由 sha256（如声明）与安装确认兜底。
    try {
      const sigRes = await fetch(`${downloadUrl}.sig`, {
        headers: { 'User-Agent': 'Kakake-PluginStore/0.1', ...githubAuthHeaders(`${downloadUrl}.sig`) },
        signal: AbortSignal.timeout(30_000),
        redirect: 'follow',
      });
      if (sigRes.ok) {
        const sigText = (await sigRes.text()).trim();
        let sigObj: { keyId?: unknown; signature?: unknown } | null = null;
        try { sigObj = JSON.parse(sigText) as { keyId?: unknown; signature?: unknown }; } catch { /* 非 JSON 视为无效 */ }
        const keyId = typeof sigObj?.keyId === 'string' ? sigObj.keyId : '';
        const signature = typeof sigObj?.signature === 'string' ? sigObj.signature : '';
        if (!verifyUpdateSignature(buf, signature, keyId)) {
          throw new Error('插件包签名验证失败，已拒绝安装（包体可能被篡改或来源不可信）');
        }
      }
    } catch (e: unknown) {
      // 只吞「网络取签名文件失败」，验签不通过抛出的错误必须向上传播
      if (e instanceof Error && e.message.includes('签名验证失败')) throw e;
      // 签名文件取不到（404/网络异常）→ 无签名资源，按既有行为继续
    }

    const tmpDir = path.join(PATHS.data, 'tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const zipPath = path.join(tmpDir, `store_${id}_${Date.now()}.zip`);
    fs.writeFileSync(zipPath, buf);
    return { zipPath, resource };
  }

  /** HEAD 探测远端大小与 Range 支持；任何失败都按「不支持」处理 */
  private async probeRemoteSize(url: string): Promise<{ total: number; acceptRanges: boolean } | null> {
    try {
      const res = await fetch(url, {
        method: 'HEAD',
        headers: { 'User-Agent': 'Kakake-PluginStore/0.1', ...githubAuthHeaders(url) },
        signal: AbortSignal.timeout(15_000),
        redirect: 'follow',
      });
      if (!res.ok) return null;
      const len = Number(res.headers.get('content-length'));
      return {
        total: Number.isFinite(len) && len > 0 ? Math.round(len) : 0,
        acceptRanges: (res.headers.get('accept-ranges') || '').toLowerCase().includes('bytes'),
      };
    } catch {
      return null;
    }
  }

  /**
   * Range 并行分段下载进预分配缓冲，固定 4 路。
   * 缓冲按 total 一次分配、运行期不增长（防溢出）；任一分段异常即整体中止，
   * 由调用方回退单流，这里不重试不吞错。
   */
  private async downloadRangeParallel(
    url: string,
    total: number,
    cancelSignal?: AbortSignal,
    taskId?: string,
  ): Promise<Buffer> {
    const parts = 4;
    const buf = Buffer.allocUnsafe(total);
    const seg = Math.ceil(total / parts);
    const ac = new AbortController();
    const onOuterAbort = () => ac.abort();
    if (cancelSignal) {
      if (cancelSignal.aborted) ac.abort();
      else cancelSignal.addEventListener('abort', onOuterAbort, { once: true });
    }
    const killer = setTimeout(() => ac.abort(), 120_000);
    let downloaded = 0;
    const tick = (n: number) => {
      downloaded += n;
      if (taskId) this.installProgress.set(taskId, { downloaded, total, phase: 'downloading' });
    };
    try {
      await Promise.all(
        Array.from({ length: parts }, (_, i) => {
          const start = i * seg;
          const end = Math.min(total, start + seg) - 1;
          if (start > end) return Promise.resolve();
          return this.downloadRangeInto(url, start, end, buf, ac, tick);
        }),
      );
    } finally {
      clearTimeout(killer);
      if (cancelSignal) cancelSignal.removeEventListener('abort', onOuterAbort);
    }
    return buf;
  }

  /** 单分段：必须 206，恰好写满 [start,end]；多发/少发/空包风暴都算失败 */
  private async downloadRangeInto(
    url: string,
    start: number,
    end: number,
    buf: Buffer,
    ac: AbortController,
    tick: (n: number) => void,
  ): Promise<void> {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Kakake-PluginStore/0.1',
        ...githubAuthHeaders(url),
        Range: `bytes=${start}-${end}`,
      },
      signal: ac.signal,
      redirect: 'follow',
    });
    if (res.status !== 206 || !res.body) {
      void res.body?.cancel().catch(() => {});
      ac.abort();
      throw new Error(`分段 ${start}-${end} 返回 HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    let pos = start;
    let emptyStreak = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) {
        if (++emptyStreak > 64) {
          ac.abort();
          throw new Error(`分段 ${start}-${end} 空包过多`);
        }
        continue;
      }
      emptyStreak = 0;
      if (pos + value.length > end + 1) {
        ac.abort();
        throw new Error(`分段 ${start}-${end} 越界`);
      }
      Buffer.from(value).copy(buf, pos);
      pos += value.length;
      tick(value.length);
    }
    if (pos !== end + 1) {
      ac.abort();
      throw new Error(`分段 ${start}-${end} 不完整`);
    }
  }

  invalidateCache(): void {
    this.listCache.kakake = null;
    this.listCache.github = null;
    this.catIdCache = null;
    this.repoMetaCache.clear();
    this.readmeCache.clear();
  }
}

export const pluginStoreService = new PluginStoreService();
