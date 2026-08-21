import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../paths.js';

/** 资源商城公开 API（Node 版：/zhiyuan） */
export const PLUGIN_STORE_BASE =
  'https://xn--mk-ub3cl61ae1v.xn--c5w857b.xn--fiqs8s/zhiyuan';

/** 站点根（用于补全相对 links） */
export const PLUGIN_STORE_ORIGIN =
  'https://xn--mk-ub3cl61ae1v.xn--c5w857b.xn--fiqs8s';

/** 仅对接此分类名 */
export const PLUGIN_STORE_CAT_NAME = '咔咔插件';

const LIST_CACHE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 15_000;
/** 封面可能是大体积 PNG，单独放宽超时 */
const COVER_FETCH_TIMEOUT_MS = 90_000;
const COVER_MAX_BYTES = 12 * 1024 * 1024;

/** 根据文件头识别真实图片类型（远端 Content-Type 常不准，PNG 透明图尤甚） */
function sniffImageContentType(buf: Buffer, headerType = ''): string | null {
  if (buf.length >= 8) {
    // PNG / APNG
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      return 'image/png';
    }
    // JPEG
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
      return 'image/jpeg';
    }
    // GIF
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
      return 'image/gif';
    }
    // WEBP: RIFF....WEBP
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
  /** 上游类型：官鸡 / 野鸡 / wxbot 等 */
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
};

export type StoreComment = {
  id: number;
  nickname: string;
  body: string;
  created_at: string;
  created_at_label: string;
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
    links: {
      cover: absoluteUrl(raw.links?.cover || ''),
      download: absoluteUrl(raw.links?.download || ''),
    },
  };
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

class PluginStoreService {
  private listCache: ListCache | null = null;
  private catIdCache: { at: number; id: number } | null = null;

  /** 按名称解析「咔咔插件」分类 ID */
  async resolveKakakeCatId(force = false): Promise<number> {
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

  async fetchList(force = false): Promise<{
    catId: number;
    categories: StoreCategory[];
    pinned: StoreResource[];
    resources: StoreResource[];
  }> {
    const now = Date.now();
    if (!force && this.listCache && now - this.listCache.at < LIST_CACHE_TTL_MS) {
      return {
        catId: this.listCache.catId,
        categories: this.listCache.categories,
        pinned: this.listCache.pinned,
        resources: this.listCache.resources,
      };
    }

    const catId = await this.resolveKakakeCatId(force);
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
    // 去重（置顶也可能出现在 main）
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
    this.listCache = {
      at: now,
      catId,
      categories,
      pinned: pinned.filter((r) => r.category_id === catId || r.cat_name === PLUGIN_STORE_CAT_NAME),
      resources,
    };

    return {
      catId,
      categories: this.listCache.categories,
      pinned: this.listCache.pinned,
      resources: this.listCache.resources,
    };
  }

  async getResourceById(id: number): Promise<StoreResource | undefined> {
    const { resources, pinned } = await this.fetchList();
    return pinned.find((r) => r.id === id) || resources.find((r) => r.id === id);
  }

  async fetchComments(id: number, limit = 50): Promise<{
    resource_id: number;
    total: number;
    comments: StoreComment[];
  }> {
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

  /** 下载 zip 到 data/tmp，返回本地路径 */
  async downloadToTemp(id: number): Promise<{ zipPath: string; resource: StoreResource }> {
    const resource = await this.getResourceById(id);
    if (!resource) throw new Error('资源不存在或不在咔咔插件分区');
    if (!resource.allow_download || !resource.links.download) {
      throw new Error(resource.download_block_reason || '该资源不允许下载');
    }

    const res = await fetch(resource.links.download, {
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

    const tmpDir = path.join(PATHS.data, 'tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const zipPath = path.join(tmpDir, `store_${id}_${Date.now()}.zip`);
    fs.writeFileSync(zipPath, buf);
    return { zipPath, resource };
  }

  invalidateCache(): void {
    this.listCache = null;
    this.catIdCache = null;
  }
}

export const pluginStoreService = new PluginStoreService();
