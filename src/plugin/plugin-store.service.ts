import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PATHS } from '../paths.js';

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
const DEFAULT_ORIGIN: StoreOrigin = 'kakake';

const LIST_CACHE_TTL_MS = 60_000;
/** GitHub 仓库元信息（星数 / 更新时间）缓存更久，避开限流 */
const REPO_META_TTL_MS = 15 * 60_000;
/** README 缓存 */
const README_TTL_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 15_000;
/** 封面可能是大体积 PNG，单独放宽超时 */
const COVER_FETCH_TIMEOUT_MS = 90_000;
const COVER_MAX_BYTES = 12 * 1024 * 1024;
const DOWNLOAD_MAX_BYTES = 64 * 1024 * 1024;

/** sha256 校验失败：可被控制器识别并回传专属错误码 */
export class Sha256MismatchError extends Error {
  readonly code = 'sha256_mismatch';
  constructor(message = '安装包校验未通过，文件可能被篡改或损坏') {
    super(message);
    this.name = 'Sha256MismatchError';
  }
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
  /** 上游类型：官鸡 / 野鸡 / wxbot（咔咔源）；或 野生 / 官方 / 微信 / 其他（GitHub 源，见 type） */
  resource_type: string;
  summary: string;
  description: string;
  update_notes: string;
  sort_order: number;
  preview_count: number;
  download_count: number;
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
  /** 归一化类型：野生 / 官方 / 微信 / 其他 */
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

/** 归一化 type：只接受 野生/官方/微信/其他，其它一律 其他 */
function normalizeType(t?: string): string {
  const v = (t || '').trim();
  if (v === '野生' || v === '官方' || v === '微信' || v === '其他') return v;
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
  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Kakake-PluginStore/0.1',
      ...(init?.headers as Record<string, string> | undefined),
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
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

class PluginStoreService {
  /** 双源内存缓存（可为过期陈旧数据，用于秒开 + 兜底） */
  private listCache: Record<StoreOrigin, ListCache | null> = { kakake: null, github: null };
  /** 同源刷新去重：并发请求共享同一个在途 Promise */
  private inflight: Record<StoreOrigin, Promise<ListCache> | null> = { kakake: null, github: null };
  /** 是否已尝试从磁盘载入过缓存 */
  private diskLoaded = false;
  private catIdCache: { at: number; id: number } | null = null;
  private repoMetaCache = new Map<string, { at: number; stars?: number; updatedAt?: string }>();
  private readmeCache = new Map<string, { at: number; markdown: string | null }>();
  private originCache: StoreOrigin | null = null;

  /* ================= 来源开关 ================= */

  getOrigin(): StoreOrigin {
    if (this.originCache) return this.originCache;
    try {
      if (fs.existsSync(PATHS.pluginStoreState)) {
        const raw = JSON.parse(fs.readFileSync(PATHS.pluginStoreState, 'utf-8')) as { origin?: string };
        if (raw.origin === 'github' || raw.origin === 'kakake') {
          this.originCache = raw.origin;
          return raw.origin;
        }
      }
    } catch { /* ignore */ }
    this.originCache = DEFAULT_ORIGIN;
    return DEFAULT_ORIGIN;
  }

  setOrigin(origin: StoreOrigin): StoreOrigin {
    const next: StoreOrigin = origin === 'github' ? 'github' : 'kakake';
    this.originCache = next;
    try {
      fs.mkdirSync(path.dirname(PATHS.pluginStoreState), { recursive: true });
      fs.writeFileSync(PATHS.pluginStoreState, JSON.stringify({ origin: next }, null, 2), 'utf-8');
    } catch { /* ignore */ }
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
    try {
      if (!fs.existsSync(PATHS.pluginStoreCache)) return;
      const raw = JSON.parse(fs.readFileSync(PATHS.pluginStoreCache, 'utf-8')) as
        Partial<Record<StoreOrigin, ListCache>>;
      for (const src of ['kakake', 'github'] as StoreOrigin[]) {
        const entry = raw[src];
        if (entry && Array.isArray(entry.resources) && !this.listCache[src]) {
          this.listCache[src] = entry;
        }
      }
    } catch { /* 磁盘缓存损坏则忽略 */ }
  }

  private saveDiskCache(): void {
    try {
      fs.mkdirSync(path.dirname(PATHS.pluginStoreCache), { recursive: true });
      fs.writeFileSync(
        PATHS.pluginStoreCache,
        JSON.stringify({ kakake: this.listCache.kakake, github: this.listCache.github }),
        'utf-8',
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
      download_count: 0,
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
    const data = await fetchJson<{
      format?: string;
      plugins?: GithubPlugin[];
    }>(applyMirror(GITHUB_INDEX_URL, mirrorPrefix));

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

  /** 为 GitHub 资源补齐 stars / updated_at（后台执行，带独立缓存，避开限流） */
  private async enrichGithubMeta(resources: StoreResource[], mirrorPrefix?: string): Promise<void> {
    const now = Date.now();
    const targets = resources.filter((r) => parseRepo(r.homepage));
    await Promise.all(targets.map(async (r) => {
      const repo = parseRepo(r.homepage);
      if (!repo) return;
      const cacheKey = `${repo.owner}/${repo.repo}`.toLowerCase();
      const cached = this.repoMetaCache.get(cacheKey);
      if (cached && now - cached.at < REPO_META_TTL_MS) {
        if (cached.stars != null) r.stars = cached.stars;
        if (cached.updatedAt) r.updated_at = cached.updatedAt;
        return;
      }
      try {
        const meta = await fetchJson<{ stargazers_count?: number; pushed_at?: string }>(
          applyMirror(`https://api.github.com/repos/${repo.owner}/${repo.repo}`, mirrorPrefix),
          { headers: { Accept: 'application/vnd.github+json' } },
        );
        const stars = typeof meta.stargazers_count === 'number' ? meta.stargazers_count : undefined;
        const updatedAt = typeof meta.pushed_at === 'string' ? meta.pushed_at : undefined;
        this.repoMetaCache.set(cacheKey, { at: now, stars, updatedAt });
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
        const res = await fetch(applyMirror(url, mirrorPrefix), {
          headers: { 'User-Agent': 'Kakake-PluginStore/0.1' },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          redirect: 'follow',
        });
        if (!res.ok) continue;
        const text = await res.text();
        if (text && text.trim()) {
          this.readmeCache.set(cacheKey, { at: now, markdown: text });
          return text;
        }
      } catch { /* try next */ }
    }
    this.readmeCache.set(cacheKey, { at: now, markdown: null });
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

  async fetchCoverBuffer(id: number): Promise<{ buffer: Buffer; contentType: string }> {
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

    return { buffer, contentType };
  }

  /** 下载 zip 到 data/tmp，返回本地路径；GitHub 源带 sha256 时校验完整性 */
  async downloadToTemp(id: number, mirrorPrefix?: string): Promise<{ zipPath: string; resource: StoreResource }> {
    const resource = await this.getResourceById(id);
    if (!resource) throw new Error('资源不存在或不在咔咔插件分区');
    if (!resource.allow_download || !resource.links.download) {
      throw new Error(resource.download_block_reason || '该资源不允许下载');
    }

    const downloadUrl = resource.origin === 'github'
      ? applyMirror(resource.links.download, mirrorPrefix)
      : resource.links.download;
    const res = await fetch(downloadUrl, {
      headers: { 'User-Agent': 'Kakake-PluginStore/0.1' },
      signal: AbortSignal.timeout(120_000),
      redirect: 'follow',
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(text.trim() || `下载失败 HTTP ${res.status}`);
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 32) {
      throw new Error('下载内容过小，可能不是有效插件包');
    }
    if (buf.length > DOWNLOAD_MAX_BYTES) {
      throw new Error('下载内容过大');
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

    const tmpDir = path.join(PATHS.data, 'tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const zipPath = path.join(tmpDir, `store_${id}_${Date.now()}.zip`);
    fs.writeFileSync(zipPath, buf);
    return { zipPath, resource };
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
