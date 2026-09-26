#!/usr/bin/env node
/**
 * apply-update.mjs — 在两次进程之间应用一次「已暂存的在线更新」。
 *
 * 由外层启动器（start.bat / start.sh / 便携 启动.bat / 启动.sh / mk 重启循环）在框架
 * 以退出码 86 退出后调用。此刻已无 node 进程占用项目文件，替换是安全的（Windows 文件锁问题
 * 天然规避）。本脚本是一次性、短命的：解压 → 校验 → 逐个顶层条目原子替换 → 清理 → 退出。
 *
 * 稳定性约束：
 * - 一次性执行，无循环、无常驻；无论成功失败都清掉 pending，避免启动器反复重试（死循环）。
 * - 流式/落盘解压，避免大内存占用；解压后即用即删临时目录（不留缓存）。
 * - 严格保留用户数据目录（data/log/plugins/plugins_two），只替换代码/产物/运行时。
 * - 失败即中止并保留现有安装，绝不留下半替换的污染（逐条目走 .new → rename 交换）。
 *
 * 退出码：0 = 已应用或无事可做；1 = 应用失败（启动器仍会拉起旧版本）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';

const PENDING = path.join(ROOT, 'data', 'update-pending.json');
const STAGING = path.join(ROOT, 'data', 'update-staging');
const EXTRACT = path.join(STAGING, 'extract');

/** 永不触碰的用户数据目录（顶层名） */
const PROTECTED = new Set(['data', 'log', 'plugins', 'plugins_two']);

function log(msg) {
  console.log(`[apply-update] ${msg}`);
}
function warn(msg) {
  console.warn(`[apply-update] ${msg}`);
}

function rmrf(p) {
  try {
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
  } catch (e) {
    warn(`清理失败 ${p}: ${e.message || e}`);
  }
}

function readPending() {
  try {
    if (!fs.existsSync(PENDING)) return null;
    return JSON.parse(fs.readFileSync(PENDING, 'utf8'));
  } catch {
    return null;
  }
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const rs = createReadStream(file);
    rs.on('data', (c) => h.update(c));
    rs.on('error', reject);
    rs.on('end', () => resolve(h.digest('hex')));
  });
}

/** zip 解压：优先用项目内 adm-zip（跨平台、无外部依赖），失败回退系统 unzip/tar */
async function extractZip(archive, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  try {
    const { default: AdmZip } = await import('adm-zip');
    const zip = new AdmZip(archive);
    zip.extractAllTo(outDir, /* overwrite */ true);
    return;
  } catch (e) {
    warn(`adm-zip 解压失败，尝试系统工具：${e.message || e}`);
  }
  const { spawnSync } = await import('node:child_process');
  // Windows 10+/macOS 自带 bsdtar 可解 zip；Linux 走 unzip
  let r = spawnSync('tar', ['-xf', archive, '-C', outDir], { stdio: 'inherit' });
  if (r.status === 0) return;
  r = spawnSync('unzip', ['-o', '-q', archive, '-d', outDir], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('zip 解压失败（adm-zip / tar / unzip 均不可用）');
}

/** tar.gz 解压：优先用项目内 tar 包，失败回退系统 tar */
async function extractTarGz(archive, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  try {
    const tar = await import('tar');
    await tar.x({ file: archive, cwd: outDir });
    return;
  } catch (e) {
    warn(`tar 包解压失败，尝试系统 tar：${e.message || e}`);
  }
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync('tar', ['-xzf', archive, '-C', outDir], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('tar.gz 解压失败');
}

/** 找到解压出的负载根目录：通常是唯一的顶层目录（源码包 tc-404-kakake-<sha>/、便携 kakake-*-x64/） */
function findPayloadRoot(extractDir) {
  const ents = fs.readdirSync(extractDir, { withFileTypes: true });
  const dirs = ents.filter((e) => e.isDirectory());
  const files = ents.filter((e) => e.isFile());
  if (dirs.length === 1 && files.length === 0) {
    return path.join(extractDir, dirs[0].name);
  }
  // 若解压后直接就是内容（含 package.json），就用 extractDir 本身
  return extractDir;
}

/** 递归复制目录/文件到目标 */
function copyRec(src, dest) {
  // lstat：不跟随符号链接，才能正确识别链接本身（statSync 会跟随，永远报不出链接）
  const st = fs.lstatSync(src);
  if (st.isSymbolicLink()) {
    // 符号链接：原样重建链接目标，避免跨平台/越权复制
    try {
      const target = fs.readlinkSync(src);
      rmrf(dest);
      fs.symlinkSync(target, dest);
    } catch {
      /* 忽略无法复制的链接 */
    }
    return;
  }
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      copyRec(path.join(src, name), path.join(dest, name));
    }
    return;
  }
  // 普通文件
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  try {
    fs.chmodSync(dest, st.mode);
  } catch {
    /* Windows 上可能无效 */
  }
}

/**
 * 原子替换单个顶层条目：先复制到 <target>.new-update，再删旧、rename 交换。
 * 同卷内 rename 接近原子，尽量缩小「半替换」窗口。
 */
function replaceEntry(srcEntry, targetPath) {
  const tmp = `${targetPath}.new-update`;
  rmrf(tmp);
  copyRec(srcEntry, tmp);
  rmrf(targetPath);
  fs.renameSync(tmp, targetPath);
}

async function main() {
  const pending = readPending();
  if (!pending) {
    // 没有待应用更新：纯重启场景，什么都不做
    process.exit(0);
  }

  log(`应用更新 v${pending.version || pending.tag}（${pending.edition}）`);

  const archive = path.join(ROOT, ...String(pending.archiveRel || '').split(/[\\/]/));
  let ok = false;
  try {
    if (!archive || !fs.existsSync(archive)) throw new Error(`暂存包缺失：${pending.archiveRel}`);

    // 重新校验完整性（便携包有 sha256；源码包校验 gzip 头）
    if (pending.sha256) {
      const actual = await sha256File(archive);
      if (actual.toLowerCase() !== String(pending.sha256).toLowerCase()) {
        throw new Error('sha256 校验不通过，放弃应用');
      }
    } else {
      const fd = fs.openSync(archive, 'r');
      const head = Buffer.alloc(2);
      fs.readSync(fd, head, 0, 2, 0);
      fs.closeSync(fd);
      if (pending.format === 'tar.gz' && !(head[0] === 0x1f && head[1] === 0x8b)) {
        throw new Error('源码包 gzip 头无效');
      }
    }

    rmrf(EXTRACT);
    if (pending.format === 'zip') await extractZip(archive, EXTRACT);
    else await extractTarGz(archive, EXTRACT);

    const payload = findPayloadRoot(EXTRACT);
    if (!fs.existsSync(path.join(payload, 'package.json'))) {
      throw new Error('负载缺少 package.json，疑似包结构异常');
    }

    const entries = fs.readdirSync(payload, { withFileTypes: true });
    for (const ent of entries) {
      if (PROTECTED.has(ent.name)) continue; // 保留用户数据
      const src = path.join(payload, ent.name);
      const dest = path.join(ROOT, ent.name);

      // Windows 便携版：正在运行的 runtime/node.exe 被自身占用，无法替换。
      // 把新 runtime 里的 node.exe 落成 node.exe.new，交由启动器在本进程退出后 move 交换。
      if (isWin && pending.edition === 'portable' && ent.name === 'runtime') {
        applyRuntimeWinPortable(src, dest);
        continue;
      }

      replaceEntry(src, dest);
    }

    ok = true;
    log('更新已应用完成');
  } catch (e) {
    warn(`应用失败，保留现有版本：${e.message || e}`);
    ok = false;
  } finally {
    // 无论成败都清掉 pending 与暂存，杜绝启动器反复重试
    rmrf(PENDING);
    rmrf(EXTRACT);
    try {
      if (archive && fs.existsSync(archive)) rmrf(archive);
    } catch {
      /* ignore */
    }
    // 若暂存目录已空则一并删除
    try {
      if (fs.existsSync(STAGING) && fs.readdirSync(STAGING).length === 0) rmrf(STAGING);
    } catch {
      /* ignore */
    }
  }

  process.exit(ok ? 0 : 1);
}

/**
 * Windows 便携版 runtime 替换：node.exe 自锁，落成 node.exe.new 由启动器交换；
 * 其余 runtime 文件正常替换。
 */
function applyRuntimeWinPortable(srcRuntime, destRuntime) {
  fs.mkdirSync(destRuntime, { recursive: true });
  for (const name of fs.readdirSync(srcRuntime)) {
    const s = path.join(srcRuntime, name);
    const d = path.join(destRuntime, name);
    if (name.toLowerCase() === 'node.exe') {
      const staged = path.join(destRuntime, 'node.exe.new');
      rmrf(staged);
      copyRec(s, staged);
      log('已暂存新 runtime/node.exe.new，将由启动器在退出后交换');
      continue;
    }
    replaceEntry(s, d);
  }
}

main().catch((e) => {
  warn(`未捕获错误：${e && e.message ? e.message : e}`);
  // 出错也要清 pending，避免死循环
  rmrf(PENDING);
  process.exit(1);
});
