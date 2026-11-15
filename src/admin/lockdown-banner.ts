import { bold, displayWidth, reverse, supportsColor } from '../core/console-style.js';
import { refreshConsoleFooter, rootLogger, setConsoleFooter } from '../core/logger.js';
import { globalBlockedMs, onGlobalLock } from './login-throttle.js';

let timer: NodeJS.Timeout | null = null;
let announced = false;

function clock(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function fit(text: string): string {
  const cols = process.stdout.columns || 0;
  if (!cols || cols <= 8) return text;
  const max = cols - 1;
  if (displayWidth(text) <= max) return text;
  let out = '';
  let width = 0;
  for (const ch of text) {
    const w = displayWidth(ch);
    if (width + w > max - 1) break;
    out += ch;
    width += w;
  }
  return `${out}…`;
}

function bannerText(getPort: () => number): string | null {
  const ms = globalBlockedMs();
  if (ms <= 0) return null;
  const text = fit(` 全局封禁中 · 剩余 ${clock(ms)} · 本机 http://127.0.0.1:${getPort()} 登录即可解除 `);
  return supportsColor ? reverse(bold(text)) : text;
}

export function startLockdownBanner(getPort: () => number): void {
  onGlobalLock(() => {
    if (timer) return;
    const tty = process.stdout.isTTY === true && supportsColor;
    if (tty) {
      setConsoleFooter(() => bannerText(getPort));
    } else if (!announced) {
      announced = true;
      rootLogger.warn(
        `全局封禁中（剩余约 60 分钟）：外部访问会被拒绝；`
        + `本机打开 http://127.0.0.1:${getPort()} 登录一次即可解除`,
      );
    }
    timer = setInterval(() => {
      if (globalBlockedMs() > 0) {
        if (tty) refreshConsoleFooter();
        return;
      }
      if (timer) clearInterval(timer);
      timer = null;
      announced = false;
      if (tty) setConsoleFooter(null);
      rootLogger.info('全局封禁已解除');
    }, 1000);
    timer.unref?.();
  });
}
