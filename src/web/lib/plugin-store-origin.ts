import type { PluginItem, StoreOrigin, StoreResource } from './types';

/** 咔咔资源官网（原资源页标题外链） */
export const PLUGIN_STORE_OFFICIAL_URL =
  'https://xn--mk-ub3cl61ae1v.xn--c5w857b.xn--fiqs8s/zhiyuan/';

/** 本商店 GitHub 仓库主页（GitHub 源标题外链） */
export const PLUGIN_STORE_GITHUB_URL =
  'https://github.com/tc-404/kakake-plugin-main';

/**
 * 来源标签的 i18n key：切英文时按钮文案要跟着变，
 * 所以这里只存 key，真正取文案走 storeOriginLabel()（需要传入 t）。
 */
export const STORE_ORIGIN_LABEL_KEY: Record<StoreOrigin, string> = {
  kakake: 'settings.originKakake',
  github: 'settings.originGithub',
};

/** 取来源标签（跟随当前语言）。t 由调用方从 useT() 拿，保证切换语言时会重渲染。 */
export function storeOriginLabel(
  origin: StoreOrigin,
  t: (key: string, params?: Record<string, string | number | undefined>) => string,
): string {
  return t(STORE_ORIGIN_LABEL_KEY[origin]);
}

/**
 * 语义化版本比较（宽松）：处理 1.2.3 / 1.2.3-beta.2 / 2.3.9.alpha.2 / v1.2.3 等。
 * 返回 <0 / 0 / >0：a 小于 / 等于 / 大于 b。
 *
 * 规则（对齐语义化版本的直觉）：
 *   ① 先比基础数字段（逐位补 0）；
 *   ② 预发布版 < 同号正式版；等级 alpha(-3) < beta(-2) < rc 及其它字母段(-1) < 正式版(0)；
 *   ③ 同级再比预发布内的数字尾巴，按数字比（beta.10 > beta.9，不是按字符串）。
 *
 * 历史坑：旧实现把 `beta.3` 的 `3` 并进了基础数字段，于是 `1.2.0-beta.3` 会在第 4 位
 * 顶掉正式版缺失的 0，被判成 `> 1.2.0`——预发布等级永远轮不到出场。数字尾巴现在单独
 * 存进 preNums，只在 nums 与等级都打平时才比。
 */
export function compareVersion(a: string, b: string): number {
  const norm = (v: string) => (v || '').trim().replace(/^v/i, '');
  const va = norm(a);
  const vb = norm(b);
  if (va === vb) return 0;
  if (!va) return -1;
  if (!vb) return 1;

  const preRank = (seg: string): number => {
    const t = seg.toLowerCase();
    if (/alpha/.test(t)) return -3;
    if (/beta/.test(t)) return -2;
    return -1; // rc 与其它字母段（dev / canary / next …）同为预发布
  };

  /**
   * 拆成 { nums, rank, preNums }：
   * - nums    基础数字段（第一个带字母的段之前）；
   * - rank    预发布等级：正式版 0（最大），字母段起为负（alpha -3 / beta -2 / 其余 -1）；
   * - preNums 预发布段的数字尾巴（`beta.3` → [3]，`beta3` → [3]），打平时才比。
   */
  const splitParts = (v: string): { nums: number[]; rank: number; preNums: number[] } => {
    const nums: number[] = [];
    const preNums: number[] = [];
    let rank = 0;
    for (const seg of v.split(/[.\-+_]/)) {
      if (!seg) continue;
      if (/^\d+$/.test(seg)) {
        // 还没遇到字母段就都是基础版本号；进入预发布区后的数字属于尾巴
        (rank === 0 ? nums : preNums).push(Number(seg));
        continue;
      }
      // 带字母的段：从此进入预发布区，取等级，段内数字记入 preNums
      rank = Math.min(rank, preRank(seg));
      const n = /(\d+)/.exec(seg)?.[1];
      if (n) preNums.push(Number(n));
    }
    return { nums, rank, preNums };
  };

  const pa = splitParts(va);
  const pb = splitParts(vb);

  // ① 基础数字段
  const len = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < len; i++) {
    const x = pa.nums[i] ?? 0;
    const y = pb.nums[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }

  // ② 预发布等级：正式版(0) > rc/其它(-1) > beta(-2) > alpha(-3)
  if (pa.rank !== pb.rank) return pa.rank < pb.rank ? -1 : 1;

  // ③ 同级预发布比数字尾巴（按数字，beta.10 > beta.9）
  const plen = Math.max(pa.preNums.length, pb.preNums.length);
  for (let i = 0; i < plen; i++) {
    const x = pa.preNums[i] ?? 0;
    const y = pb.preNums[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
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
