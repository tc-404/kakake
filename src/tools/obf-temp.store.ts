import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../paths.js';

/**
 * 图片混淆的服务端临时目录：data/tmp/image-obf
 *
 *   <root>/in/<jobId>.<ext>     上传的待处理原图 / 待还原容器
 *   <root>/out/<token>.bin      处理结果（凭 token 下载）
 *   <root>/out/<token>.json     结果元数据（原始文件名、MIME、大小）
 *
 * 设计要点：**纯临时**，不参与任何持久化。
 * - 模块加载（= 框架启动）即清空 —— 满足「重启框架会清空整个文件夹」；
 * - 前端刷新/关页面用 sendBeacon 调 clear、点「清空」也调 clear；
 * - 每个任务处理完成后立刻删掉自己的输入文件，结果只留最新一个（写新结果前先清 out）。
 */
const ROOT = path.join(PATHS.data, 'tmp', 'image-obf');
const IN_DIR = path.join(ROOT, 'in');
const OUT_DIR = path.join(ROOT, 'out');

function mkdirp(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function obfInDir(): string {
  return mkdirp(IN_DIR);
}

export function obfOutDir(): string {
  return mkdirp(OUT_DIR);
}

/** 清空整个临时目录（目录本身也删掉重建，保证不残留） */
export function clearObfTmpDir(): void {
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* 清不掉就算了，下次再试；不影响主流程 */
  }
}

export type ObfTmpMeta = {
  name: string;
  mime: string;
  size: number;
  createdAt: number;
};

export function obfOutFilePath(token: string): string {
  return path.join(OUT_DIR, `${token}.bin`);
}

export function writeObfOut(token: string, meta: ObfTmpMeta, bytes: Uint8Array): void {
  mkdirp(OUT_DIR);
  // 只保留最新结果，避免反复处理把磁盘堆满
  for (const f of fs.readdirSync(OUT_DIR)) {
    if (f !== `${token}.bin` && f !== `${token}.json`) {
      try {
        fs.rmSync(path.join(OUT_DIR, f), { force: true });
      } catch {
        /* 忽略 */
      }
    }
  }
  fs.writeFileSync(obfOutFilePath(token), bytes);
  fs.writeFileSync(path.join(OUT_DIR, `${token}.json`), JSON.stringify(meta), 'utf-8');
}

export function readObfOutMeta(token: string): ObfTmpMeta | null {
  try {
    const raw = fs.readFileSync(path.join(OUT_DIR, `${token}.json`), 'utf-8');
    const parsed = JSON.parse(raw) as ObfTmpMeta;
    if (typeof parsed?.name !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 删掉某个任务的输入文件（处理完成后调用，无论成败） */
export function removeObfInput(jobId: string): void {
  try {
    for (const f of fs.readdirSync(IN_DIR)) {
      if (f.startsWith(`${jobId}.`)) fs.rmSync(path.join(IN_DIR, f), { force: true });
    }
  } catch {
    /* 目录可能还没建 */
  }
}

/** token 只允许 UUID 形态，杜绝 ../../ 之类的路径穿越 */
export function isSafeToken(token: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token);
}

/** 任务 ID 同样只允许 UUID */
export function isSafeJobId(id: string): boolean {
  return isSafeToken(id);
}

// 框架启动即清空：上一次运行残留的输入/结果不该跨重启存活
clearObfTmpDir();
