import fs from 'node:fs';
import path from 'node:path';

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
    const abs = this.resolve(filePath);
    if (!fs.existsSync(abs)) {
      return fallback;
    }
    try {
      return JSON.parse(fs.readFileSync(abs, 'utf-8')) as T;
    } catch {
      return fallback;
    }
  }

  writeJson(filePath: string, data: unknown): void {
    const abs = this.resolve(filePath);
    this.ensureDir(path.dirname(abs));
    fs.writeFileSync(abs, JSON.stringify(data, null, 2), 'utf-8');
  }

  readText(filePath: string, fallback = ''): string {
    const abs = this.resolve(filePath);
    if (!fs.existsSync(abs)) return fallback;
    return fs.readFileSync(abs, 'utf-8');
  }

  writeText(filePath: string, content: string): void {
    const abs = this.resolve(filePath);
    this.ensureDir(path.dirname(abs));
    fs.writeFileSync(abs, content, 'utf-8');
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
