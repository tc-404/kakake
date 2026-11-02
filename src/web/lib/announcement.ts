/** 远程咔咔公告（原生 Markdown）——仅展示，门禁见 /api/agreement */

/** 主源：维护者自有站点 */
export const ANNOUNCEMENT_REMOTE_URL =
  'https://xn--mk-ub3cl61ae1v.xn--c5w857b.xn--fiqs8s/mkbot/%E5%92%94%E5%92%94%E5%85%AC%E5%91%8A.md';

/**
 * GitHub 源：仓库 tc-404/kakake-plugin-main 的 raw 正文。
 * ⚠️ 不能用 blob 页面地址——那个是 HTML 外壳，正文夹在页面数据里，取不到干净 Markdown。
 * 后端清单见 src/admin/announcement-source.ts，两边保持一致。
 */
export const ANNOUNCEMENT_GITHUB_URL =
  'https://raw.githubusercontent.com/tc-404/kakake-plugin-main/main/%E5%92%94%E5%92%94%E5%85%AC%E5%91%8A.md';

/** remote = 自有站点，github = GitHub 源，fallback = 本地备用文案 */
export type AnnouncementSource = 'remote' | 'github' | 'fallback';
