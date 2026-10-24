import { PATHS } from '../paths.js';
import { readJsonSafe, writeJsonAtomic } from '../storage/atomic-file.js';

/**
 * GitHub API Token（可选配置，设置页可读写）。
 *
 * 两条硬约束：
 * 1. **只在直连 GitHub 官方域名时附带**。走 gh-proxy / catmak 这类第三方加速镜像时，
 *    请求实际发往代理服务器，带上 Authorization 等于把 Token 交给第三方 —— 所以一律不下发
 *    （`githubAuthHeaders(url)` 按 URL 主机判断，镜像前缀后的主机名是代理域名，天然不匹配）。
 * 2. 只做宽松规范化，不做格式硬校验：GitHub 的 Token 前缀（ghp_ / github_pat_ / gho_ …）
 *    会随策略变化，写死会误伤；真正的有效性由 `verifyGithubToken()` 打官方接口验证。
 */

/** 允许携带凭据的官方主机（其余主机 = 镜像代理或非 GitHub 目标，一律不带） */
const CREDENTIAL_HOSTS = new Set([
  'api.github.com',
  'github.com',
  'codeload.github.com',
  'raw.githubusercontent.com',
  'objects.githubusercontent.com',
]);

type GithubAuthState = { token?: string };

/** 内存缓存：null = 尚未从磁盘读过 */
let cached: string | null = null;

/** 规范化用户输入：去空白、兼容直接粘贴「Bearer xxx」，只保留可放进请求头的字符集 */
function normalizeToken(raw: unknown): string {
  let t = typeof raw === 'string' ? raw.trim() : '';
  if (!t) return '';
  t = t.replace(/^(?:bearer|token)\s+/i, '').trim();
  // Token 只由字母数字与 _-. 组成；含空白/换行/中文等一律视为无效输入
  if (!/^[A-Za-z0-9_.-]{8,255}$/.test(t)) return '';
  return t;
}

/** 读取当前 Token（未配置返回空串） */
export function getGithubToken(): string {
  if (cached !== null) return cached;
  const raw = readJsonSafe<GithubAuthState | null>(PATHS.githubAuth, null, {
    label: 'github-auth.json',
  });
  cached = normalizeToken(raw?.token);
  return cached;
}

/** 保存 Token（空串 = 清空 / 停止使用）。写盘失败不影响本次运行内存值 */
export function setGithubToken(raw: unknown): string {
  const token = normalizeToken(raw);
  cached = token;
  try {
    writeJsonAtomic(PATHS.githubAuth, { token }, { trailingNewline: true });
  } catch { /* 落盘失败：下次启动回落匿名 */ }
  return token;
}

/** 该 URL 是否直连 GitHub 官方域名（镜像前缀拼接后的 URL 主机是代理域名 → false） */
function isOfficialHost(url: string): boolean {
  try {
    return CREDENTIAL_HOSTS.has(new URL(url).host.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * 供 fetch 展开的鉴权头：仅当「已配置 Token」且「目标是官方域名」时返回
 * `{ Authorization: 'Bearer …' }`，其余情况返回空对象（可安全地 `...githubAuthHeaders(url)`）。
 */
export function githubAuthHeaders(url: string): Record<string, string> {
  const token = getGithubToken();
  if (!token || !isOfficialHost(url)) return {};
  return { Authorization: `Bearer ${token}` };
}

export type GithubTokenVerify = {
  /** Token 可用（或匿名可用） */
  valid: boolean;
  /** HTTP 状态码；0 = 网络失败 */
  status: number;
  /** 剩余额度（次/小时） */
  remaining?: number;
  /** 额度上限（匿名 60 / 带 Token 5000） */
  limit?: number;
  message?: string;
};

/** 打官方 /rate_limit 验证 Token 并取回额度；不传参数则验证当前已保存的 Token */
export async function verifyGithubToken(rawToken?: unknown): Promise<GithubTokenVerify> {
  const token = typeof rawToken === 'undefined' ? getGithubToken() : normalizeToken(rawToken);
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Kakake-Admin/1.0',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const res = await fetch('https://api.github.com/rate_limit', {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401) {
      return { valid: false, status: 401, message: 'Token 无效或已被撤销' };
    }
    if (!res.ok) {
      return { valid: false, status: res.status, message: `GitHub 返回 HTTP ${res.status}` };
    }
    const data = (await res.json()) as {
      resources?: { core?: { remaining?: number; limit?: number } };
    };
    const core = data.resources?.core;
    return { valid: true, status: 200, remaining: core?.remaining, limit: core?.limit };
  } catch (e) {
    return {
      valid: false,
      status: 0,
      message: e instanceof Error ? e.message : '网络请求失败',
    };
  }
}
