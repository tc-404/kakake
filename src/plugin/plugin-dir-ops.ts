import fs from 'node:fs';
import { copyTreeSync } from './plugin-account.service.js';

export interface DirOpLogger {
  warn(message: string, error?: unknown): void;
}

export interface MoveDirOptions {
  overwrite: boolean;
  logger: DirOpLogger;
}

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: string }).code)
    : '';
}

function isRetryable(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY' || code === 'ENOTEMPTY';
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function moveDirectorySafe(
  sourceDir: string,
  targetDir: string,
  opts: MoveDirOptions,
): Promise<void> {
  if (!opts.overwrite && fs.existsSync(targetDir)) {
    throw new Error(`目标目录已存在：${targetDir}`);
  }

  if (opts.overwrite) {
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        if (fs.existsSync(targetDir)) {
          fs.rmSync(targetDir, { recursive: true, force: true });
        }
        break;
      } catch (error) {
        if (attempt === 5 || !isRetryable(error)) throw error;
        await sleep(120 * (attempt + 1));
      }
    }
  }

  try {
    fs.renameSync(sourceDir, targetDir);
    return;
  } catch (renameError) {
    try {
      copyTreeSync(sourceDir, targetDir);
    } catch (copyError) {
      throw renameError instanceof Error ? renameError : copyError;
    }
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        if (fs.existsSync(sourceDir)) {
          fs.rmSync(sourceDir, { recursive: true, force: true });
        }
        return;
      } catch (error) {
        if (attempt === 5) {
          opts.logger.warn(`[PluginDir] 已复制到目标，清理源目录失败: ${sourceDir}`, error);
          return;
        }
        if (!isRetryable(error)) {
          opts.logger.warn(`[PluginDir] 清理源目录失败: ${sourceDir}`, error);
          return;
        }
        await sleep(120 * (attempt + 1));
      }
    }
  }
}
