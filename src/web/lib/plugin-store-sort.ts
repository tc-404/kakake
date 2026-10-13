import type { StoreOrigin, StoreResource } from '@/lib/types';

export type StoreSortMode =
  | 'default'
  | 'time_asc'
  | 'time_desc'
  | 'updated_near'
  | 'updated_far'
  | 'author_many'
  | 'author_few'
  | 'views_many'
  | 'views_few'
  | 'downloads_many'
  | 'downloads_few'
  | 'stars_many'
  | 'stars_few';

export const STORE_SORT_OPTIONS: { id: StoreSortMode; label: string }[] = [
  { id: 'default', label: '默认' },
  { id: 'time_asc', label: '时间正序' },
  { id: 'time_desc', label: '时间倒序' },
  { id: 'updated_near', label: '更新时间(近)' },
  { id: 'updated_far', label: '更新时间(远)' },
  { id: 'stars_many', label: '星标数(多)' },
  { id: 'stars_few', label: '星标数(少)' },
  { id: 'author_many', label: '作者资源(多)' },
  { id: 'author_few', label: '作者资源(少)' },
  { id: 'views_many', label: '浏览次数(多)' },
  { id: 'views_few', label: '浏览次数(少)' },
  { id: 'downloads_many', label: '下载次数(多)' },
  { id: 'downloads_few', label: '下载次数(少)' },
];

/** GitHub 源基础可用的排序（上架时间 / 浏览数没有数据支撑，不提供） */
const GITHUB_SORT_IDS: StoreSortMode[] = [
  'default', 'updated_near', 'updated_far', 'stars_many', 'stars_few', 'author_many', 'author_few',
];

/**
 * 某来源下「下载次数」是否有数据支撑：
 * - 咔咔珂源：商城接口直出，恒可用；
 * - GitHub 源：需本机配置 GitHub Token（逐个仓库查 releases），没配就一列全是无值，排序无意义。
 */
export type SortCapabilities = { downloadCounts?: boolean };

/**
 * 按来源给出可用排序项：
 * - GitHub 源：只保留有数据支撑的项，并提供「星标数」排序；
 * - 咔咔珂源：保留原有项，隐藏 GitHub 专属的星标排序。
 * downloadCounts 为 false 时（GitHub 源未配 Token）隐藏「下载次数」。
 */
export function getSortOptions(
  origin: StoreOrigin,
  caps?: SortCapabilities,
): { id: StoreSortMode; label: string }[] {
  const downloadsOk = origin !== 'github' || caps?.downloadCounts !== false;
  const ids: StoreSortMode[] = origin === 'github'
    ? (downloadsOk ? [...GITHUB_SORT_IDS, 'downloads_many', 'downloads_few'] : GITHUB_SORT_IDS)
    : (STORE_SORT_OPTIONS.map((o) => o.id).filter((id) => id !== 'stars_many' && id !== 'stars_few'));
  return STORE_SORT_OPTIONS.filter((o) => ids.includes(o.id));
}

/** 某排序项在该来源下是否可用（用于来源切换后回退到默认） */
export function isSortAvailable(
  mode: StoreSortMode,
  origin: StoreOrigin,
  caps?: SortCapabilities,
): boolean {
  return getSortOptions(origin, caps).some((o) => o.id === mode);
}

export type StoreResourceWithOrder = StoreResource & { orderIndex: number };

function authorKey(author: string | undefined): string {
  return String(author || '').trim();
}

function parseTime(value: string | undefined): number {
  const t = Date.parse(String(value || '').trim());
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
}

/** 在全量列表上统计每位作者的作品数 */
export function buildAuthorCounts(list: StoreResource[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const r of list) {
    const key = authorKey(r.author);
    map.set(key, (map.get(key) || 0) + 1);
  }
  return map;
}

export function withOrderIndex(list: StoreResource[]): StoreResourceWithOrder[] {
  return list.map((r, i) => ({ ...r, orderIndex: i }));
}

/**
 * 对已过滤列表排序。
 * authorCounts 基于搜索前全量列表统计。
 */
export function sortStoreResources(
  list: StoreResourceWithOrder[],
  mode: StoreSortMode,
  authorCounts: Map<string, number>,
): StoreResourceWithOrder[] {
  const items = list.slice();

  if (mode === 'default') {
    return items.sort((a, b) => a.orderIndex - b.orderIndex);
  }

  if (mode === 'time_asc') {
    return items.sort((a, b) => {
      const d = parseTime(a.created_at) - parseTime(b.created_at);
      return d !== 0 ? d : a.orderIndex - b.orderIndex;
    });
  }

  if (mode === 'time_desc') {
    return items.sort((a, b) => {
      const ta = parseTime(a.created_at);
      const tb = parseTime(b.created_at);
      const aMissing = !Number.isFinite(ta) || ta === Number.POSITIVE_INFINITY;
      const bMissing = !Number.isFinite(tb) || tb === Number.POSITIVE_INFINITY;
      if (aMissing && bMissing) return a.orderIndex - b.orderIndex;
      if (aMissing) return 1;
      if (bMissing) return -1;
      const d = tb - ta;
      return d !== 0 ? d : a.orderIndex - b.orderIndex;
    });
  }

  if (mode === 'updated_near') {
    // 最近更新靠前（updated_at 降序）
    return items.sort((a, b) => {
      const ta = parseTime(a.updated_at);
      const tb = parseTime(b.updated_at);
      const aMissing = !Number.isFinite(ta) || ta === Number.POSITIVE_INFINITY;
      const bMissing = !Number.isFinite(tb) || tb === Number.POSITIVE_INFINITY;
      if (aMissing && bMissing) return a.orderIndex - b.orderIndex;
      if (aMissing) return 1;
      if (bMissing) return -1;
      const d = tb - ta;
      return d !== 0 ? d : a.orderIndex - b.orderIndex;
    });
  }

  if (mode === 'updated_far') {
    // 更新越早（离现在越远）靠前（updated_at 升序）
    return items.sort((a, b) => {
      const d = parseTime(a.updated_at) - parseTime(b.updated_at);
      return d !== 0 ? d : a.orderIndex - b.orderIndex;
    });
  }

  if (mode === 'stars_many' || mode === 'stars_few') {
    const dir = mode === 'stars_many' ? -1 : 1;
    const val = (r: StoreResourceWithOrder): number | null =>
      typeof r.stars === 'number' && Number.isFinite(r.stars) ? r.stars : null;
    return items.sort((a, b) => {
      const sa = val(a);
      const sb = val(b);
      // 星标未知的沉底（两个方向都排在已知项之后）
      if (sa == null && sb == null) return a.orderIndex - b.orderIndex;
      if (sa == null) return 1;
      if (sb == null) return -1;
      const d = (sa - sb) * dir;
      return d !== 0 ? d : a.orderIndex - b.orderIndex;
    });
  }

  if (mode === 'views_many' || mode === 'views_few') {
    const dir = mode === 'views_many' ? -1 : 1;
    return items.sort((a, b) => {
      const d = (a.preview_count - b.preview_count) * dir;
      return d !== 0 ? d : a.orderIndex - b.orderIndex;
    });
  }

  if (mode === 'downloads_many' || mode === 'downloads_few') {
    const dir = mode === 'downloads_many' ? -1 : 1;
    // 无值的（GitHub 源拿不到次数）两个方向都沉底，避免用 NaN 参与比较
    const val = (r: StoreResourceWithOrder): number | null =>
      typeof r.download_count === 'number' && Number.isFinite(r.download_count) ? r.download_count : null;
    return items.sort((a, b) => {
      const da = val(a);
      const db = val(b);
      if (da == null && db == null) return a.orderIndex - b.orderIndex;
      if (da == null) return 1;
      if (db == null) return -1;
      const d = (da - db) * dir;
      return d !== 0 ? d : a.orderIndex - b.orderIndex;
    });
  }

  if (mode === 'author_many' || mode === 'author_few') {
    const dir = mode === 'author_many' ? -1 : 1;
    return items.sort((a, b) => {
      const ca = authorCounts.get(authorKey(a.author)) || 0;
      const cb = authorCounts.get(authorKey(b.author)) || 0;
      if (ca !== cb) return (ca - cb) * dir;
      const ak = authorKey(a.author);
      const bk = authorKey(b.author);
      if (ak !== bk) return ak.localeCompare(bk, 'zh');
      return a.orderIndex - b.orderIndex;
    });
  }

  return items;
}
