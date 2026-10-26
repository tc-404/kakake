/**
 * 控制台着色：只有屏幕能带转义序列（日志文件 / Web 页是纯文本，写入会变乱码），
 * 故所有输出仅用于 process.stdout，且需确认终端支持 ANSI（NO_COLOR 关 / FORCE_COLOR 开 / 非 TTY 关）。
 */

const enabled = detectColorSupport();

function detectColorSupport(): boolean {
  if (process.env.NO_COLOR) return false;
  const force = process.env.FORCE_COLOR;
  if (force && force !== '0' && force !== 'false') return true;
  if (!process.stdout.isTTY) return false;
  if (process.env.TERM === 'dumb') return false;
  // Windows 10 之后（Terminal / PowerShell）都支持虚拟终端序列
  return true;
}

export const supportsColor = enabled;

/** 包一层 SGR 控制符，末尾统一 \x1b[0m 复位 */
const wrap = (open: number) => (s: string): string =>
  enabled ? `\x1b[${open}m${s}\x1b[0m` : String(s);

export const bold = wrap(1);
export const dim = wrap(2);
export const underline = wrap(4);
export const red = wrap(31);
export const green = wrap(32);
export const yellow = wrap(33);
export const blue = wrap(34);
export const magenta = wrap(35);
export const cyan = wrap(36);
export const brightGreen = wrap(92);
export const brightYellow = wrap(93);
export const brightCyan = wrap(96);

/** CJK 全角字符占两列，padEnd 按码元算会把中文行对不齐 */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6);
    w += wide ? 2 : 1;
  }
  return w;
}

/** 按显示宽度右补齐到 width 列 */
export function padDisplay(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - displayWidth(s)));
}

/** 分隔线（GBK 也收录了制表符，中文 Windows 控制台不会变乱码） */
export function rule(width = 58): string {
  return '─'.repeat(width);
}
