import fs from 'node:fs';
import path from 'node:path';

/**
 * Sharp 安装跨进程排他锁。
 *
 * ## 为什么需要它
 * `data/runtime-deps` 这个共享依赖目录，宿主（咔咔珂）与插件（如 MKbot）两个**不同进程**
 * 都会往里跑 `npm install`，安装前还会 `rm -rf node_modules/sharp node_modules/@img`。
 * 各自的「单飞」只在自己进程内有效，拦不住另一个进程——于是两个 npm 同时写同一份
 * node_modules，半残的 @img 原生包互相踩坏，表现就是「装了还是加载失败 / 反复失败」。
 *
 * ## 怎么用
 * - 跑 `npm install`（含清理）之前必须 `acquireSharpInstallLock(dir)`，成功后再 `releaseSharpInstallLock(dir)`。
 * - 锁文件：`<installDir>/.sharp-install.lock`，内容为 JSON `{ pid, startedAt, host }`。
 * - 已存在且 holder 进程仍存活 → 抢锁失败，应放弃本次安装并提示用户。
 * - holder 进程已死（PID 不存在）或锁龄超过 STALE_MS → 视为陈旧，允许接管。
 *
 * 宿主与插件必须遵守同一份协议（同一文件名、同一接管规则），才能互相拦住。
 */

export const SHARP_INSTALL_LOCK_FILE = '.sharp-install.lock';

/** 锁超过这么久仍无法确认 holder 存活时允许接管，避免死进程永久占锁（> 安装总超时） */
const STALE_MS = 20 * 60 * 1000;

type LockPayload = { pid: number; startedAt: number; host: string };

export interface SharpInstallLockHandle {
  acquired: boolean;
  holder?: LockPayload;
  reason?: string;
}

function lockPath(installDir: string): string {
  return path.join(path.resolve(installDir), SHARP_INSTALL_LOCK_FILE);
}

function pidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    // signal 0：不发送信号，仅探测进程是否存在
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === 'ESRCH') return false; // 进程不存在
    if (code === 'EPERM') return true; // 存在但无权限，仍视为存活
    return false;
  }
}

function readLock(installDir: string): LockPayload | null {
  try {
    const obj = JSON.parse(fs.readFileSync(lockPath(installDir), 'utf-8')) as Partial<LockPayload>;
    if (typeof obj.pid === 'number' && typeof obj.startedAt === 'number') {
      return {
        pid: obj.pid,
        startedAt: obj.startedAt,
        host: typeof obj.host === 'string' ? obj.host : 'unknown',
      };
    }
  } catch {
    // 不存在 / 损坏都当无锁
  }
  return null;
}

/**
 * 原子抢锁：用 `O_CREAT | O_EXCL`（`'wx'`）创建锁文件，创建成功即持锁。
 * 已存在则判断 holder 是否存活/陈旧：存活则失败；陈旧（进程已死或超龄）则删除后重试一次。
 */
export function acquireSharpInstallLock(installDir: string, host = 'kakake'): SharpInstallLockHandle {
  const dir = path.resolve(installDir);
  fs.mkdirSync(dir, { recursive: true });
  const p = lockPath(dir);
  const payload: LockPayload = { pid: process.pid, startedAt: Date.now(), host };

  const tryCreate = (): boolean => {
    try {
      const fd = fs.openSync(p, 'wx');
      fs.writeSync(fd, JSON.stringify(payload));
      fs.closeSync(fd);
      return true;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code === 'EEXIST') return false;
      throw e;
    }
  };

  if (tryCreate()) return { acquired: true };

  const holder = readLock(dir);
  if (!holder) {
    // 损坏的锁文件：删掉重试一次
    try { fs.rmSync(p, { force: true }); } catch { /* ignore */ }
    if (tryCreate()) return { acquired: true };
    return { acquired: false, reason: '锁文件状态异常，无法抢锁' };
  }

  const alive = pidAlive(holder.pid);
  const stale = Date.now() - holder.startedAt > STALE_MS;
  if (alive && !stale) {
    return {
      acquired: false,
      holder,
      reason: `另一进程（pid ${holder.pid}, ${holder.host}）正在安装 sharp`,
    };
  }

  // 陈旧或进程已死：接管
  try { fs.rmSync(p, { force: true }); } catch { /* ignore */ }
  if (tryCreate()) return { acquired: true };
  return { acquired: false, holder, reason: '锁已被陈旧进程占用，接管失败' };
}

/** 释放锁：仅当 holder 是本进程时才删，避免误删别人的锁 */
export function releaseSharpInstallLock(installDir: string): void {
  const p = lockPath(path.resolve(installDir));
  try {
    const holder = readLock(installDir);
    if (holder && holder.pid === process.pid) {
      fs.rmSync(p, { force: true });
    }
  } catch {
    // ignore
  }
}
