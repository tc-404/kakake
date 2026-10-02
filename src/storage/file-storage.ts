import fs from 'node:fs';
import path from 'node:path';
import {
  ensureDirFor,
  readJsonSafe,
  readTextSafe,
  writeJsonAtomic,
  writeTextAtomic,
} from './atomic-file.js';

export class FileStorage {
  constructor(private readonly baseDir: string) {
    this.ensureDir(baseDir);
  }

  ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  readJson<T>(filePath: string, fallback: T): T {
    return readJsonSafe(this.resolve(filePath), fallback);
  }

  writeJson(filePath: string, data: unknown): void {
    writeJsonAtomic(this.resolve(filePath), data);
  }

  readText(filePath: string, fallback = ''): string {
    return readTextSafe(this.resolve(filePath), fallback);
  }

  writeText(filePath: string, content: string): void {
    writeTextAtomic(this.resolve(filePath), content);
  }

  exists(relativePath: string): boolean {
    return fs.existsSync(this.resolve(relativePath));
  }

  resolve(relativePath: string): string {
    if (path.isAbsolute(relativePath)) return relativePath;
    return path.join(this.baseDir, relativePath);
  }

  /** 插件数据目录: data/<account|tmp>/{pluginId}/ */
  pluginDataDir(pluginId: string, accountKey?: string | null): string {
    const key = String(accountKey || '').trim();
    const dir = key
      ? path.join(this.baseDir, key, pluginId)
      : path.join(this.baseDir, 'tmp', pluginId);
    this.ensureDir(dir);
    return dir;
  }

  pluginConfigPath(pluginId: string, accountKey?: string | null): string {
    return path.join(this.pluginDataDir(pluginId, accountKey), 'config.json');
  }
}

// 保留 ensureDirFor 的再导出，便于其它模块需要时统一入口
export { ensureDirFor };
