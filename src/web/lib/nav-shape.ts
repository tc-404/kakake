/**
 * 侧栏窄栏形态判定（纯函数，便于单测）。
 *
 * 编辑模式会额外占掉一行右侧 24px 的叉号 / 小锁按钮，外加间距与外边距。
 * 不把这部分算进去，就会出现「宽度刚够四字全称，一点编辑就被砍成两三个字」——
 * 与其让文字被 truncate 掉半截，不如直接提前降级：四字放不下→两字，两字放不下→图标。
 */

export type NavMode = 'full' | 'short' | 'text' | 'icon';

/** 电脑侧栏：四字全称 / 两字短名 / 只留文字 / 只留图标 */
export const NAV_COMPACT_PX = 140;
export const NAV_NO_ICON_PX = 105;
export const NAV_NO_TEXT_PX = 80;

/** 编辑模式额外占用：24px 按钮 + 约 8px 间距 */
export const NAV_EDIT_COST_PX = 32;
/** 手机侧栏用屏宽百分比，24px 在常见 375px 屏上约 6.4%，取 8 留余量 */
export const NAV_EDIT_COST_VW = 8;

export const NAV_COMPACT_VW = 40;
export const NAV_NO_TEXT_VW = 25;

function effective(width: number, editMode: boolean, cost: number): number {
  return width - (editMode ? cost : 0);
}

/** 电脑端（px）：≥140 全称、105~139 短名、80~104 只留文字、<80 只留图标 */
export function pcNavMode(widthPx: number, editMode = false): NavMode {
  const w = effective(widthPx, editMode, NAV_EDIT_COST_PX);
  if (w >= NAV_COMPACT_PX) return 'full';
  if (w >= NAV_NO_ICON_PX) return 'short';
  if (w >= NAV_NO_TEXT_PX) return 'text';
  return 'icon';
}

/** 手机端（屏宽百分比）：≥40% 全称、25~39% 只留短名、<25% 只留图标 */
export function mobileNavMode(widthVw: number, editMode = false): NavMode {
  const w = effective(widthVw, editMode, NAV_EDIT_COST_VW);
  if (w >= NAV_COMPACT_VW) return 'full';
  if (w >= NAV_NO_TEXT_VW) return 'text';
  return 'icon';
}
