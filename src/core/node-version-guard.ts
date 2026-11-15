// ---------------------------------------------------------------------------
// 启动期 Node.js 版本安全检查。
//
// 为什么要有这个检查：Node.js 官方 2026-10-21 安全发布修的那批漏洞里，
// 「undici 收到恶意响应能让进程直接崩溃」这条对 kakake 是实打实的威胁——
// 框架有 40+ 处 fetch（AI 档案里用户自己填的 baseUrl、资源商城的远端
// readme/cover/download 地址、公告源…），任意一处打到恶意服务器就可能把
// 进程带崩。而且实测过：应用层 try/catch 已经捕获到 `fetch failed` 了，
// 进程照样被 uncaughtException 打断，改业务代码拦不住，只能升运行时。
//
// 所以框架自己在启动时提醒，别让用户带着一个「随时可能被一条响应打崩」
// 的运行时跑在公网上还浑然不觉。
//
// 维护说明：官方再发新的安全版时，改下面这张表就行，不用动逻辑。
// ---------------------------------------------------------------------------

import process from 'node:process';
import {
  bold,
  brightCyan,
  brightGreen,
  brightYellow,
  dim,
  displayWidth,
  padDisplay,
  rule,
  yellow,
} from './console-style.js';

/**
 * 各线「已发布且含本次修复」的稳定版，三条线各留一个。
 *
 * note 不在这里写死：推荐哪条线取决于用户当前跑的是哪条线（见
 * recommendedBaseline），写死会出现「用户跑 24 却推荐 22」的尴尬。
 */
export const NODE_SAFE_BASELINE: ReadonlyArray<{
  line: string;
  version: string;
  note: string;
}> = [
  { line: '22.x', version: '22.23.4', note: '' },
  { line: '24.x', version: '24.22.1', note: '' },
  { line: '26.x', version: '26.12.1', note: '' },
];

const SAFE_BY_MAJOR = new Map<number, string>([
  [22, '22.23.4'],
  [24, '24.22.1'],
  [26, '26.12.1'],
]);

/**
 * 推荐哪个版本：优先跟用户当前所在的主线对齐。
 *
 * 三条线都含本次修复，所以为了这条安全公告跨大版本搬家并不划算——跨线会换
 * ABI，已装的原生模块（sharp 之类）要重装；同线升小版本只需换运行时重启。
 * 只有当当前线已经拿不到安全更新（20.x 之类）时，才往 22.x LTS 上引。
 */
export function recommendedBaseline(major: number): { line: string; version: string; note: string } {
  const same = SAFE_BY_MAJOR.get(major);
  if (same) {
    const hit = NODE_SAFE_BASELINE.find((b) => b.version === same);
    if (hit) return { ...hit, note: '推荐 · 与当前主线一致' };
  }
  return { ...NODE_SAFE_BASELINE[0], note: '推荐' };
}

export type NodeSecurityVerdict = {
  /** 达标则不提示 */
  ok: boolean;
  current: string;
  major: number;
  /** 当前大版本线的安全基线；不在已知线内为 null */
  baseline: string | null;
  reason: string;
};

function parse(v: string): [number, number, number] {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) return [0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compare(a: string, b: string): number {
  const [x1, y1, z1] = parse(a);
  const [x2, y2, z2] = parse(b);
  if (x1 !== x2) return x1 - x2;
  if (y1 !== y2) return y1 - y2;
  return z1 - z2;
}

/**
 * 判断当前运行时是否达到安全基线。
 *
 * 判定的三个边界情况：
 * - 比 22 还老（20.x 之类）：已停止维护，且本次官方根本没给这些线发补丁，
 *   必须提示，且推荐版本只能往 22/24/26 上引。
 * - 夹在中间的奇数线（23.x、25.x）：短期线，本次同样没有补丁，也要提示
 *   —— 早先版本漏了这条，导致这类用户完全收不到告警。
 * - 比 26 还新（将来出的线）：假定已包含本次修复，不打扰用户。
 */
export function checkNodeSecurity(current = process.versions.node): NodeSecurityVerdict {
  const [major] = parse(current);
  const baseline = SAFE_BY_MAJOR.get(major) ?? null;

  if (baseline === null) {
    // 比 26 还新：将来的线，假定已包含本次修复，不打扰
    if (major > 26) {
      return { ok: true, current, major, baseline: null, reason: '' };
    }
    // 22/24/26 之外的线本次官方都没发补丁：
    // 比 22 老的是已停止维护的 LTS，中间夹着的是 23.x/25.x 这类短期线
    const why = major < 22 ? '已停止维护' : '是短期线（非 LTS）';
    return {
      ok: false,
      current,
      major,
      baseline: null,
      reason: `${major}.x ${why}，本次官方未为其发布安全补丁`,
    };
  }

  if (compare(current, baseline) < 0) {
    return {
      ok: false,
      current,
      major,
      baseline,
      reason: `低于 ${major}.x 安全基线 ${baseline}`,
    };
  }
  return { ok: true, current, major, baseline, reason: '' };
}

/**
 * 不达标时在启动横幅之后单独划一块分界线提示：只写 stdout，达标则返回 null。
 *
 * 这里刻意不 import rootLogger：logger 与 storage 那几条链存在循环引用，
 * 多一个模块在初始化期访问它就会触发 `Cannot access 'rootLogger' before
 * initialization`。要记日志请在调用方（main.ts 已持有 rootLogger）里记。
 *
 * @returns 达标返回 null；否则返回判定详情，供调用方补一条日志
 */
export function printNodeSecurityNotice(): NodeSecurityVerdict | null {
  const v = checkNodeSecurity();
  if (v.ok) return null;

  // 高亮分层：边框/标题用警示黄先把视线拉过来，版本号加粗，动作词用亮青，
  // 说明正文一律 dim —— 全亮等于没有重点，留暗才能衬出该看的数字
  const line = brightYellow(rule());
  const rec = recommendedBaseline(v.major);
  const rows = NODE_SAFE_BASELINE.map((b) => ({
    label: `Node.js ${b.line}`,
    version: b.version,
    note: b.version === rec.version ? rec.note : b.note,
  }));
  const width = rows.reduce((w, r) => Math.max(w, displayWidth(r.label)), 0) + 2;

  const out: string[] = ['', line];
  out.push(`  ${bold(brightYellow('Node.js 版本安全提示'))}`);
  out.push(`  ${dim('当前')} ${bold(brightYellow(`v${v.current}`))}   ${dim('·')}   ${yellow(v.reason)}`);
  out.push('');
  out.push(`  ${dim('官方 2026-10-21 安全公告修复了多项高危漏洞，其中 undici 的问题')}`);
  out.push(`  ${dim('可被一条恶意响应直接打崩本框架进程，且应用层 try/catch 拦不住，')}`);
  out.push(`  ${dim('只能靠升级 Node.js 运行时解决。')}`);
  out.push('');
  out.push(`  ${dim('推荐安装以下任一稳定版（均已包含本次修复）：')}`);
  for (const r of rows) {
    const note = r.note ? bold(brightYellow(`   ${r.note}`)) : '';
    out.push(`    ${dim(padDisplay(r.label, width))}${bold(brightGreen(`v${r.version}`))}${note}`);
  }
  // 说清为什么推荐这条线，否则用户跑 24 却看到推 22 会以为推荐错了
  const recWhy = v.baseline === null
    ? `当前 ${v.major}.x 已无安全更新，需迁到受支持的线`
    : `与当前 ${v.major}.x 主线一致，原地升级即可（跨大版本需重装原生模块）`;
  out.push('');
  out.push(`  ${dim('推荐')} ${bold(brightGreen(`v${rec.version}`))}${dim(`：${recWhy}`)}`);
  out.push('');
  out.push(
    `  ${dim('升级后需')}${bold(brightCyan('重启本框架'))}`
    + `${dim('才会生效（运行时在进程启动时已载入内存）。')}`,
  );
  out.push(line, '');

  process.stdout.write(out.join('\n'));
  return v;
}
