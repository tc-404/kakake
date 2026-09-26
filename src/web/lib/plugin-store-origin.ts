import type { PluginItem, StoreOrigin, StoreResource } from '@/lib/types';

/** 咔咔资源官网（原资源页标题外链） */
export const PLUGIN_STORE_OFFICIAL_URL =
  'https://xn--mk-ub3cl61ae1v.xn--c5w857b.xn--fiqs8s/zhiyuan/';

/** 本商店 GitHub 仓库主页（GitHub 源标题外链） */
export const PLUGIN_STORE_GITHUB_URL =
  'https://github.com/tc-404/kakake-plugin-main';

export const STORE_ORIGIN_LABEL: Record<StoreOrigin, string> = {
  kakake: '咔咔珂源',
  github: 'GitHub 源',
};

/**
 * 语义化版本比较（宽松）：处理 1.2.3 / 2.3.9.alpha.2 等。
 * 返回 <0 / 0 / >0：a 小于 / 等于 / 大于 b。
 * 预发布号（alpha/beta/rc）视为小于同数字的正式版。
 */
export function compareVersion(a: string, b: string): number {
  const norm = (v: string) => (v || '').trim().replace(/^v/i, '');
  const va = norm(a);
  const vb = norm(b);
  if (va === vb) return 0;
  if (!va) return -1;
  if (!vb) return 1;

  const pre = (s: string): number => {
    const t = s.toLowerCase();
    if (/alpha/.test(t)) return -3;
    if (/beta/.test(t)) return -2;
    if (/rc/.test(t)) return -1;
    return 0;
  };

  const splitParts = (v: string): { nums: number[]; preRank: number } => {
    const nums: number[] = [];
    let preRank = 0;
    for (const seg of v.split(/[.\-+_]/)) {
      if (!seg) continue;
      if (/^\d+$/.test(seg)) {
        nums.push(Number(seg));
      } else {
        // 含字母段：取预发布等级，并把其中的数字并入
        preRank = Math.min(preRank, pre(seg));
        const n = /(\d+)/.exec(seg)?.[1];
        if (n) nums.push(Number(n));
      }
    }
    return { nums, preRank };
  };

  const pa = splitParts(va);
  const pb = splitParts(vb);
  const len = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < len; i++) {
    const x = pa.nums[i] ?? 0;
    const y = pb.nums[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (pa.preRank !== pb.preRank) return pa.preRank < pb.preRank ? -1 : 1;
  return 0;
}

export type InstallState = 'none' | 'installed' | 'update';

/**
 * 判断某商店资源的本地安装状态。
 * 用 plugin_id ↔ 已装插件 id 匹配；缺 plugin_id 时退化用 title↔name。
 */
export function resolveInstallState(
  resource: StoreResource,
  installed: PluginItem[],
): { state: InstallState; localVersion?: string } {
  const key = (resource.plugin_id || '').trim().toLowerCase();
  const title = (resource.title || '').trim().toLowerCase();
  const hit = installed.find((p) => {
    if (key && p.id.trim().toLowerCase() === key) return true;
    if (key && (p.name || '').trim().toLowerCase() === key) return true;
    if (!key && title && (p.name || '').trim().toLowerCase() === title) return true;
    return false;
  });
  if (!hit) return { state: 'none' };
  const localVersion = hit.version || '';
  const remote = resource.version || '';
  if (remote && localVersion && compareVersion(localVersion, remote) < 0) {
    return { state: 'update', localVersion };
  }
  return { state: 'installed', localVersion };
}
