import path from 'node:path';
import { PATHS } from '../paths.js';
import { readJsonSafe, writeJsonAtomic } from '../storage/atomic-file.js';
import { apiTimeoutMs } from '../core/api-timeout.js';
import { rootLogger } from '../core/logger.js';

export type SponsorTier = 'rainbow' | 'gold' | 'silver' | 'bronze';

export interface SponsorEntry {
  name: string;
  qq: string;
  amount: string;
  thanks: string;
  priority: number;
  tier: SponsorTier;
}

const SOURCE_URLS = [
  'https://raw.githubusercontent.com/tc-404/kakake-plugin-main/main/%E8%B5%9E%E5%8A%A9.json',
  'https://cdn.jsdelivr.net/gh/tc-404/kakake-plugin-main@main/%E8%B5%9E%E5%8A%A9.json',
];

const CACHE_FILE = path.join(PATHS.data, 'sponsors.json');
const CACHE_TTL_MS = 10 * 60_000;

const TIER_RANK: Record<SponsorTier, number> = {
  rainbow: 0,
  gold: 1,
  silver: 2,
  bronze: 3,
};

function tierOf(raw: unknown): SponsorTier {
  const text = String(raw ?? '').trim();
  if (text === '彩') return 'rainbow';
  if (text === '金') return 'gold';
  if (text === '银') return 'silver';
  return 'bronze';
}

function amountText(raw: unknown): string {
  if (typeof raw === 'string') return raw.trim();
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  return '';
}

function normalize(raw: unknown): SponsorEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item, index) => {
      const src = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
      return {
        name: String(src.name ?? '').trim() || '匿名赞助者',
        qq: String(src.qq ?? '').trim(),
        amount: amountText(src.amount),
        thanks: String(src.thanks ?? '').trim(),
        priority: Number.isFinite(Number(src.priority)) ? Number(src.priority) : 999,
        tier: tierOf(src.uiType),
        index,
      };
    })
    .sort((a, b) => (
      TIER_RANK[a.tier] - TIER_RANK[b.tier]
      || a.priority - b.priority
      || a.index - b.index
    ))
    .map(({ index: _index, ...entry }) => entry);
}

class SponsorService {
  private cache: { at: number; sponsors: SponsorEntry[] } | null = null;
  private inflight: Promise<SponsorEntry[]> | null = null;

  private readDisk(): { at: number; sponsors: SponsorEntry[] } | null {
    const raw = readJsonSafe<Record<string, unknown>>(CACHE_FILE, {}, { label: 'sponsors.json' });
    const at = Number(raw.updatedAt);
    const sponsors = normalize(raw.sponsors);
    if (!Number.isFinite(at) || at <= 0 || sponsors.length === 0) return null;
    return { at, sponsors };
  }

  private persist(sponsors: SponsorEntry[]): void {
    try {
      writeJsonAtomic(CACHE_FILE, { updatedAt: Date.now(), sponsors }, { trailingNewline: true });
    } catch (err) {
      rootLogger.warn(`[赞助名单] 缓存写入失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async fetchOne(url: string): Promise<SponsorEntry[]> {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'kakake-sponsors/1.0',
      },
      signal: AbortSignal.timeout(apiTimeoutMs()),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const list = normalize(await res.json());
    if (list.length === 0) throw new Error('空列表');
    return list;
  }

  private async refresh(): Promise<SponsorEntry[]> {
    for (const url of SOURCE_URLS) {
      try {
        const sponsors = await this.fetchOne(url);
        this.cache = { at: Date.now(), sponsors };
        this.persist(sponsors);
        return sponsors;
      } catch (err) {
        rootLogger.warn(`[赞助名单] 拉取失败 ${url}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const fallback = this.cache ?? this.readDisk();
    if (fallback) {
      this.cache = fallback;
      return fallback.sponsors;
    }
    return [];
  }

  async get(): Promise<{ sponsors: SponsorEntry[]; updatedAt: number }> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < CACHE_TTL_MS) {
      return { sponsors: this.cache.sponsors, updatedAt: this.cache.at };
    }
    if (!this.inflight) this.inflight = this.refresh();
    try {
      const sponsors = await this.inflight;
      return { sponsors, updatedAt: this.cache?.at ?? now };
    } finally {
      this.inflight = null;
    }
  }
}

export const sponsorService = new SponsorService();
