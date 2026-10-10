import { appendLog, type LogCategory } from './log-store.js';
import { formatLogArgs } from './log-format.js';
import { formatLocalClock } from './log-time.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

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
    // 直接写 stdout：message 已由 formatLogArgs 拼好，console.log 会再做一次 util.format（Windows 控制台下开销明显）
    const head = `[${time}] ${tag} ${this.prefix}`;
    process.stdout.write(message ? `${head} ${message}\n` : `${head}\n`);
    appendLog({
      level,
      category: this.category,
      prefix: this.prefix.trim(),
      message,
    });
  }
}

export function createLogger(prefix: string, category: LogCategory, level: LogLevel = 'info'): Logger {
  return new Logger(prefix, level, category);
}

export const rootLogger = new Logger('[咔咔珂] ', 'info', 'system');
