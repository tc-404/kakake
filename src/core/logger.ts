import { appendLog, type LogCategory } from './log-store.js';
import { formatLogArgs } from './log-format.js';
import { formatLocalClock } from './log-time.js';
import { brightCyan, cyan, dim, red, yellow } from './console-style.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 级别标签配色：一眼扫出异常行 */
const LEVEL_STYLE: Record<LogLevel, (s: string) => string> = {
  debug: dim,
  info: cyan,
  warn: yellow,
  error: red,
};

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export class Logger {
  constructor(
    private readonly prefix: string,
    private level: LogLevel = 'info',
    private readonly category: LogCategory = 'system',
  ) {}

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  getLevel(): LogLevel {
    return this.level;
  }

  child(prefix: string): Logger {
    return new Logger(`${this.prefix}${prefix}`, this.level, this.category);
  }

  withCategory(category: LogCategory): Logger {
    return new Logger(this.prefix, this.level, category);
  }

  debug(...args: unknown[]): void {
    this.write('debug', args);
  }

  info(...args: unknown[]): void {
    this.write('info', args);
  }

  warn(...args: unknown[]): void {
    this.write('warn', args);
  }

  error(...args: unknown[]): void {
    this.write('error', args);
  }

  log = (...args: unknown[]) => this.info(...args);
  logDebug = (...args: unknown[]) => this.debug(...args);
  logWarn = (...args: unknown[]) => this.warn(...args);
  logError = (...args: unknown[]) => this.error(...args);

  private write(level: LogLevel, args: unknown[]): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const time = formatLocalClock();
    const tag = level.toUpperCase().padEnd(5);
    const message = formatLogArgs(args);
    // 着色只作用于屏幕：head 与 message 的彩色副本都不进 appendLog，
    // 否则日志文件和后台「日志」页会存下一段段转义序列
    const levelStyle = LEVEL_STYLE[level];
    const head = `${dim(`[${time}]`)} ${levelStyle(tag)} ${brightCyan(this.prefix)}`;
    // 异常行的正文也跟着上色，刷日志时更容易被看到
    const screenMessage = level === 'error' ? red(message) : level === 'warn' ? yellow(message) : message;
    clearFooterLine();
    process.stdout.write(message ? `${head} ${screenMessage}\n` : `${head}\n`);
    drawFooterLine();
    appendLog({
      level,
      category: this.category,
      prefix: this.prefix.trim(),
      message,
    });
  }
}

let footerProvider: (() => string | null) | null = null;
let footerDrawn = false;

function clearFooterLine(): void {
  if (!footerDrawn) return;
  process.stdout.write('\x1b[1A\x1b[2K');
  footerDrawn = false;
}

function drawFooterLine(): void {
  if (!footerProvider || !process.stdout.isTTY) return;
  const text = footerProvider();
  if (!text) return;
  process.stdout.write(`${text}\n`);
  footerDrawn = true;
}

export function setConsoleFooter(provider: (() => string | null) | null): void {
  clearFooterLine();
  footerProvider = provider;
  drawFooterLine();
}

export function refreshConsoleFooter(): void {
  if (!footerProvider) return;
  clearFooterLine();
  drawFooterLine();
}

export function createLogger(prefix: string, category: LogCategory, level: LogLevel = 'info'): Logger {
  return new Logger(prefix, level, category);
}

export const rootLogger = new Logger('[咔咔珂] ', 'info', 'system');
