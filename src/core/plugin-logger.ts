import type { LogLevel } from './logger.js';
import { appendLog, type LogCategory } from './log-store.js';
import { formatLogArgs } from './log-format.js';
import { formatLocalClock } from './log-time.js';
import type { PluginLogger } from '../plugin/plugin.types.js';

export type PluginLoggerOptions = {
  /** 默认 plugin；官方机器人插件用 gf_plugin */
  category?: Extract<LogCategory, 'plugin' | 'gf_plugin' | 'system'>;
  /**
   * 为 true 时不写入 Node 进程 stdout（SSH/终端），
   * 仍写入后台「运行日志」与 log/ 文件。
   */
  silentStdout?: boolean;
};

/**
 * 插件 Logger
 * - 完整实现 log/info/warn/error/debug 及 logDebug/logWarn/logError
 * - 插件日志不受框架 logLevel 过滤
 * - 支持多参数与 Error 对象格式化
 */
export function createPluginLogger(pluginId: string, opts?: PluginLoggerOptions): PluginLogger {
  const prefix = `[Plugin:${pluginId}]`;
  const category = opts?.category ?? 'plugin';
  const silentStdout = !!opts?.silentStdout;

  const write = (level: LogLevel, args: unknown[]): void => {
    const message = formatLogArgs(args);
    if (!silentStdout) {
      const time = formatLocalClock();
      const tag = level.toUpperCase().padEnd(5);
      console.log(`[${time}] ${tag} ${prefix}`, ...args);
    }
    appendLog({
      level,
      category,
      prefix,
      message,
    });
  };

  const logger: PluginLogger = {
    log: (...args: unknown[]) => write('info', args),
    debug: (...args: unknown[]) => write('debug', args),
    info: (...args: unknown[]) => write('info', args),
    warn: (...args: unknown[]) => write('warn', args),
    error: (...args: unknown[]) => write('error', args),
    logDebug: (...args: unknown[]) => write('debug', args),
    logWarn: (...args: unknown[]) => write('warn', args),
    logError: (...args: unknown[]) => write('error', args),
  };

  return logger;
}
