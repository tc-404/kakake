import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { PATHS } from '../paths.js';
import { rootLogger } from '../core/logger.js';
import { getFrameworkVersion } from './agreement.service.js';
import { REPO, mirrorPrefixFor } from './update-check.service.js';
import { detectEdition, currentPlatformToken, getLaunchModeInfo, type Edition } from './launch-mode.js';

/**
 * 在线更新「下载 + 校验 + 暂存」服务（GitHub 路线）。
 *
 * 分工（关键设计，避免一边运行一边替换自己）：
 * - 本服务只做：解析选定 tag 的下载地址 → 流式下载到 data/update-staging/ →
 *   边下边算 sha256 → 校验（便携包对 Release 资产 digest；源码包校验 gzip 头）→
 *   写 data/update-pending.json（待应用清单）。**全程不替换任何现有文件。**
 * - 真正的「解压 + 替换 + 重启」由外层启动器在进程退出后调用 scripts/apply-update.mjs 完成。
 *
 * 稳定性硬约束（见需求「严禁内存溢出 / CPU 溢出 / 缓存没清理 / 死循环」）：
 * - 单飞锁：同一时刻只允许一个安装任务，拒绝并发。
 * - 流式落盘 + 流式哈希：绝不把整包读进内存。
 * - 体积上限 + content-length 预检：防超大包与 zip 炸弹式膨胀。
 * - 连接超时 + 停顿看门狗（长时间无数据即中止）：杜绝挂死。
 * - try/finally 清理 .part 与失败残留；启动时清扫无主暂存。
 * - 无重试风暴：单次任务失败即结束并报错，由用户手动再次触发。
 */

/** 包体硬上限：便携包约 40~50MB，留足冗余，超过即判为异常 */
const MAX_ARCHIVE_BYTES = 400 * 1024 * 1024;
/** 连接建立超时 */
const CONNECT_TIMEOUT_MS = 20_000;
/** 停顿看门狗：超过该时长无新数据即中止下载 */
const STALL_TIMEOUT_MS = 60_000;

type InstallPhase =
  | 'idle'
  | 'resolving'
  | 'downloading'
  | 'verifying'
  | 'staged'
  | 'error';

type PendingManifest = {
  tag: string;
  version: string;
  edition: Edition;
  platform: string;
  /** 'zip' | 'tar.gz' */
  format: 'zip' | 'tar.gz';
  /** 相对项目根目录的暂存包路径（apply-update 以根目录为 cwd） */
  archiveRel: string;
  /** 十六进制 sha256；源码包无官方 digest 时为空串 */
  sha256: string;
  assetName: string;
  createdAt: string;
};

type InstallJob = {
  phase: InstallPhase;
  tag: string;
  version: string;
  edition: Edition;
  percent: number;
  receivedBytes: number;
  totalBytes: number;
  message: string;
  error: string;
  startedAt: string;
  finishedAt: string;
};

let job: InstallJob | null = null;
let inflight = false;
let cancelRequested = false;

function nowIso(): string {
  return new Date().toISOString();
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function rmrf(p: string): void {
  try {
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* 清理失败不致命，下一轮再扫 */
  }
}

/** 启动时清扫无主暂存：没有有效 pending 清单时，删掉整个暂存目录 */
export function sweepStaleStaging(): void {
  try {
    if (!fs.existsSync(PATHS.updateStaging)) return;
    if (!fs.existsSync(PATHS.updatePending)) {
      rmrf(PATHS.updateStaging);
      return;
    }
    // 有 pending：保留其引用的包，删掉其余残留（.part 等）
    const manifest = readPending();
    const keep = manifest ? path.basename(manifest.archiveRel) : '';
    for (const name of fs.readdirSync(PATHS.updateStaging)) {
      if (name !== keep) rmrf(path.join(PATHS.updateStaging, name));
    }
  } catch (e) {
    rootLogger.warn(`[update] 清扫暂存失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

function readPending(): PendingManifest | null {
  try {
    if (!fs.existsSync(PATHS.updatePending)) return null;
    return JSON.parse(fs.readFileSync(PATHS.updatePending, 'utf8')) as PendingManifest;
  } catch {
    return null;
  }
}

function writePending(m: PendingManifest): void {
  ensureDir(path.dirname(PATHS.updatePending));
  fs.writeFileSync(PATHS.updatePending, `${JSON.stringify(m, null, 2)}\n`, 'utf8');
}

/** 供 UI：是否已有暂存好、待重启应用的更新 */
export function getPendingUpdate(): { tag: string; version: string; edition: Edition } | null {
  const m = readPending();
  if (!m) return null;
  return { tag: m.tag, version: m.version, edition: m.edition };
}

/** 取消暂存并清理（若已 staged 也允许撤销） */
export function cancelInstall(): { ok: boolean } {
  cancelRequested = true;
  if (!inflight) {
    // 没有进行中的任务：清掉已暂存的 pending
    rmrf(PATHS.updatePending);
    rmrf(PATHS.updateStaging);
    if (job && job.phase === 'staged') job = null;
  }
  return { ok: true };
}

type ResolvedTarget = {
  url: string;
  format: 'zip' | 'tar.gz';
  sha256: string;
  assetName: string;
};

type GithubAsset = { name?: string; browser_download_url?: string; digest?: string; size?: number };
type GithubRelease = { tag_name?: string; assets?: GithubAsset[]; tarball_url?: string };

/** 解析选定 tag 的下载目标（便携包资产 / 源码 tarball），带镜像加速前缀 */
async function resolveTarget(tag: string, edition: Edition, mirrorId?: string | null): Promise<ResolvedTarget> {
  const prefix = mirrorPrefixFor(mirrorId);
  const apiUrl = `${prefix}https://api.github.com/repos/${REPO}/releases/tags/${encodeURIComponent(tag)}`;
  const resp = await fetch(apiUrl, {
    headers: { 'User-Agent': 'Kakake-Update/1.0', Accept: 'application/vnd.github+json, application/json, */*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`获取版本信息失败 HTTP ${resp.status}`);
  const rel = (await resp.json()) as GithubRelease;

  if (edition === 'portable') {
    const platform = currentPlatformToken();
    if (platform === 'other') throw new Error('当前平台无对应便携发行包');
    const assets = Array.isArray(rel.assets) ? rel.assets : [];
    // 优先精确名 kakake-<plat>-x64.zip，其次含平台标识的 zip
    const platRe = platform === 'win' ? /win/i : /linux/i;
    const exact = assets.find((a) => new RegExp(`kakake-${platform}-x64\\.zip$`, 'i').test(String(a.name || '')));
    const loose = assets.find(
      (a) => platRe.test(String(a.name || '')) && /\.zip$/i.test(String(a.name || '')),
    );
    const asset = exact || loose;
    if (!asset || !asset.browser_download_url) {
      throw new Error(`该版本未提供 ${platform} 便携包资产`);
    }
    if (asset.size && asset.size > MAX_ARCHIVE_BYTES) throw new Error('便携包体积异常');
    const digest = String(asset.digest || '');
    const sha256 = digest.startsWith('sha256:') ? digest.slice('sha256:'.length).trim() : '';
    return {
      url: `${prefix}${asset.browser_download_url}`,
      format: 'zip',
      sha256,
      assetName: String(asset.name || `kakake-${platform}-x64.zip`),
    };
  }

  // 源码版：GitHub 源码 tarball（无官方 digest，靠 gzip 头 + 结构校验兜底）
  const tarball = String(rel.tarball_url || `https://api.github.com/repos/${REPO}/tarball/${tag}`);
  return {
    url: `${prefix}${tarball}`,
    format: 'tar.gz',
    sha256: '',
    assetName: `kakake-${tag}-source.tar.gz`,
  };
}

/** 流式下载到 dest，边下边算 sha256；返回十六进制哈希与首 2 字节（校验 gzip 头用） */
async function downloadWithHash(url: string, dest: string): Promise<{ sha256: string; head: Buffer }> {
  const controller = new AbortController();
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Kakake-Update/1.0', Accept: 'application/octet-stream, */*' },
    redirect: 'follow',
    signal: controller.signal,
  });
  if (!resp.ok || !resp.body) {
    controller.abort();
    throw new Error(`下载失败 HTTP ${resp.status}`);
  }
  const total = Number(resp.headers.get('content-length')) || 0;
  if (total && total > MAX_ARCHIVE_BYTES) {
    controller.abort();
    throw new Error('包体超过大小上限');
  }
  if (job) job.totalBytes = total;

  const out = fs.createWriteStream(dest);
  const hash = createHash('sha256');
  let received = 0;
  const head: number[] = [];

  let stallTimer: NodeJS.Timeout | null = null;
  const armStall = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => controller.abort(), STALL_TIMEOUT_MS);
  };

  try {
    armStall();
    // resp.body 是 Web ReadableStream，Node 20 支持 for await 迭代
    for await (const chunk of resp.body as unknown as AsyncIterable<Uint8Array>) {
      if (cancelRequested) {
        controller.abort();
        throw new Error('已取消');
      }
      const buf = Buffer.from(chunk);
      received += buf.length;
      if (received > MAX_ARCHIVE_BYTES) {
        controller.abort();
        throw new Error('包体超过大小上限');
      }
      if (head.length < 2) for (const b of buf) { if (head.length < 2) head.push(b); }
      hash.update(buf);
      if (!out.write(buf)) await once(out, 'drain');
      armStall();
      if (job) {
        job.receivedBytes = received;
        // 下载阶段占进度条 5% ~ 90%
        job.percent = total > 0 ? 5 + Math.floor((received / total) * 85) : Math.min(89, 5 + Math.floor(received / (1024 * 1024)));
      }
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  } finally {
    if (stallTimer) clearTimeout(stallTimer);
    if (!out.destroyed) out.destroy();
  }

  return { sha256: hash.digest('hex'), head: Buffer.from(head) };
}

/** 开始一次安装（下载 + 校验 + 暂存）。同一时刻只允许一个任务。 */
export function startInstall(tag: string, mirrorId?: string | null): { ok: boolean; message?: string } {
  const cleanTag = String(tag || '').trim();
  if (!cleanTag) return { ok: false, message: '缺少目标版本' };
  if (inflight) return { ok: false, message: '已有安装任务进行中' };

  const info = getLaunchModeInfo();
  if (!info.onlineUpdateSupported) {
    return { ok: false, message: info.note || '当前环境不支持在线更新' };
  }

  const edition = detectEdition();
  inflight = true;
  cancelRequested = false;
  job = {
    phase: 'resolving',
    tag: cleanTag,
    version: cleanTag.replace(/^v/i, ''),
    edition,
    percent: 2,
    receivedBytes: 0,
    totalBytes: 0,
    message: '正在解析下载地址…',
    error: '',
    startedAt: nowIso(),
    finishedAt: '',
  };

  void (async () => {
    const partPath = path.join(PATHS.updateStaging, 'download.part');
    try {
      // 每次新任务先清掉旧暂存与旧 pending，避免叠加
      rmrf(PATHS.updatePending);
      rmrf(PATHS.updateStaging);
      ensureDir(PATHS.updateStaging);

      const target = await resolveTarget(cleanTag, edition, mirrorId);
      if (cancelRequested) throw new Error('已取消');
      if (job) {
        job.phase = 'downloading';
        job.percent = 5;
        job.message = `正在下载 ${target.assetName}…`;
      }

      const { sha256, head } = await downloadWithHash(target.url, partPath);

      if (job) {
        job.phase = 'verifying';
        job.percent = 92;
        job.message = '正在校验完整性…';
      }

      // 校验
      if (target.format === 'tar.gz') {
        // gzip 魔数 1f 8b
        if (head.length < 2 || head[0] !== 0x1f || head[1] !== 0x8b) {
          throw new Error('源码包不是有效的 gzip 归档');
        }
      } else {
        // zip 魔数 PK\x03\x04
        if (head.length < 2 || head[0] !== 0x50 || head[1] !== 0x4b) {
          throw new Error('便携包不是有效的 zip 归档');
        }
      }
      if (target.sha256) {
        if (sha256.toLowerCase() !== target.sha256.toLowerCase()) {
          throw new Error('sha256 校验不通过（包体可能损坏或被篡改）');
        }
      }

      // 落定：重命名为正式包名并写 pending
      const ext = target.format === 'zip' ? 'zip' : 'tar.gz';
      const finalName = `kakake-update.${ext}`;
      const finalPath = path.join(PATHS.updateStaging, finalName);
      rmrf(finalPath);
      fs.renameSync(partPath, finalPath);

      const manifest: PendingManifest = {
        tag: cleanTag,
        version: cleanTag.replace(/^v/i, ''),
        edition,
        platform: currentPlatformToken(),
        format: target.format,
        archiveRel: path.posix.join('data', 'update-staging', finalName),
        sha256: target.sha256 ? target.sha256.toLowerCase() : '',
        assetName: target.assetName,
        createdAt: nowIso(),
      };
      writePending(manifest);

      if (job) {
        job.phase = 'staged';
        job.percent = 100;
        job.message = '新版本已就绪，可点击重启应用';
        job.finishedAt = nowIso();
      }
      rootLogger.info(`[update] 已暂存新版本 v${manifest.version}（${edition}），等待重启应用`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (job) {
        job.phase = 'error';
        job.error = msg;
        job.message = `安装失败：${msg}`;
        job.finishedAt = nowIso();
      }
      // 清理失败残留，绝不留下半包污染
      rmrf(partPath);
      rmrf(PATHS.updatePending);
      rootLogger.warn(`[update] 安装失败：${msg}`);
    } finally {
      inflight = false;
    }
  })();

  return { ok: true };
}

/** 面向前端的可序列化状态 */
export function getInstallView() {
  const info = getLaunchModeInfo();
  const pending = getPendingUpdate();
  return {
    ok: true,
    currentVersion: getFrameworkVersion(),
    edition: info.edition,
    platform: info.platform,
    canRestart: info.canRestart,
    onlineUpdateSupported: info.onlineUpdateSupported,
    launchNote: info.note,
    inflight,
    job: job
      ? {
          phase: job.phase,
          tag: job.tag,
          version: job.version,
          percent: job.percent,
          receivedBytes: job.receivedBytes,
          totalBytes: job.totalBytes,
          message: job.message,
          error: job.error,
        }
      : null,
    pending,
  };
}
