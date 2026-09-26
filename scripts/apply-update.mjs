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

/**
 * 本地生成物 / 运行时 / 元数据（顶层名）：做「精确镜像」删多余时必须跳过，否则会误删关键文件。
 * - node_modules / packages：本地依赖与构建产物（源码发布包里没有），删了要重装/重建；
 * - runtime：便携版内置的 Node（启动器就是靠它重新拉起进程！删了会直接把安装变「未安装」）；
 * - config：用户配置目录（部分版本用到），等同用户数据，绝不能删；
 * - .git：开发元数据。
 */
const KEEP_LOCAL = new Set(['node_modules', 'packages', 'runtime', 'config', '.git']);

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

/**
 * 清理源码版的构建产物，确保下次启动从新源码全量重建。
 * 只删产物（Web dist、服务端 bundle、TS 增量缓存），保留 packages/web/node_modules
 * 避免重复安装依赖。产物缺失时 ensureWebBuild / ensureServerBuild 会自动触发重建。
 */
function invalidateBuildOutputs() {
  const targets = [
    path.join(ROOT, 'packages', 'web', 'dist'),
    path.join(ROOT, 'packages', 'server', 'main.mjs'),
    path.join(ROOT, 'src', 'web', 'tsconfig.tsbuildinfo'),
  ];
  let cleared = 0;
  for (const t of targets) {
    try {
      if (fs.existsSync(t)) {
        rmrf(t);
        cleared += 1;
      }
    } catch {
      /* 删不掉也不致命：产物过期最坏是本次不重建，下次仍会修正 */
    }
  }
  if (cleared > 0) log('已清理旧构建产物，下次启动将用新源码重建');
}

/**
 * 「缺一不可」的精确镜像收尾：删除本地存在、但新发布版顶层已不再包含的条目，
 * 让项目与发布版严格一致（避免旧版残留文件继续参与运行）。
 * 绝不删用户数据（PROTECTED）与本地生成物/元数据（KEEP_LOCAL）。
 * 目录内部的「多余」无需在此处理：被替换的顶层目录是整目录 rmrf→重建，内部旧文件已随之清除。
 */
function removeOrphans(payload) {
  let payloadNames;
  try {
    payloadNames = new Set(fs.readdirSync(payload, { withFileTypes: true }).map((e) => e.name));
  } catch {
    return; // 读不到负载目录：放弃删多余，宁可保守
  }
  let rootEntries;
  try {
    rootEntries = fs.readdirSync(ROOT, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of rootEntries) {
    const name = ent.name;
    if (PROTECTED.has(name)) continue; // 用户数据
    if (KEEP_LOCAL.has(name)) continue; // 依赖/产物/git
    if (payloadNames.has(name)) continue; // 新版仍有 → 已被替换，不是多余
    try {
      rmrf(path.join(ROOT, name));
      log(`已删除新版不再包含的多余项：${name}`);
    } catch (e) {
      warn(`删除多余项失败（忽略）：${name} — ${e.message || e}`);
    }
  }
}

/**
 * 应用后自检：确认这份新文件真的「装得起来」。
 * - 源码版：需有 package.json + scripts/bootstrap.mjs（服务端 bundle 会由 bootstrap 重建，故此处不查）；
 * - 便携版：需有内置 runtime（node）+ packages/server/main.mjs，否则启动器无法用它重新拉起进程。
 * 缺失即抛错——多为选到的发行包没有对应平台/结构的产物，明确报错胜过留一个「未安装」空壳。
 */
function verifyInstallable(edition) {
  const has = (...seg) => fs.existsSync(path.join(ROOT, ...seg));
  if (edition === 'portable') {
    const hasNode = has('runtime', 'bin', 'node') || has('runtime', 'node.exe') || has('runtime', 'node.exe.new');
    const hasServer = has('packages', 'server', 'main.mjs');
    if (!hasNode || !hasServer) {
      throw new Error(
        `便携版应用后关键文件缺失（内置 Node=${hasNode} / 服务端 bundle=${hasServer}），` +
          '该版本可能未提供当前平台的便携产物，已保留现有文件请勿重启',
      );
    }
    return;
  }
  const hasPkg = has('package.json');
  const hasBootstrap = has('scripts', 'bootstrap.mjs');
  if (!hasPkg || !hasBootstrap) {
    throw new Error(
      `源码版应用后关键文件缺失（package.json=${hasPkg} / bootstrap=${hasBootstrap}），疑似包结构异常`,
    );
  }
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

    // 精确镜像：仅源码版执行——删掉新发布版已不再包含的顶层多余项，保留用户数据与本地生成物。
    // 便携版跳过：其代码整体在 packages/ 里、已被上面整目录替换刷新；对便携顶层做镜像会有
    // 误删内置 runtime / 启动器的风险（会把安装打成「未安装」、且下次无法自我重启）。
    if (pending.edition !== 'portable') {
      removeOrphans(payload);
    }

    // 应用后自检：确认这份新文件确实「可启动」。若缺关键入口，多半是选到的发行包结构不对
    // （例如某个早期版本没有对应平台的便携产物），此时明确报错，避免留下一个「未安装」的空壳。
    verifyInstallable(pending.edition);

    ok = true;
    log('更新已应用完成');

    // 源码版关键收尾：解压会保留归档内的旧文件 mtime，而 bootstrap 判断「是否重建」
    // 依赖「src 是否比产物新」的 mtime 比较——于是替换进来的（旧 mtime）源码会被误判为
    // 「产物已最新、无需重建」，导致 packages/server 的 bundle 与 packages/web/dist 仍是旧的：
    // 表现就是「版本号变了、但界面/行为啥都没变，自动重启白跑一趟」。
    // 直接删掉构建产物，逼迫下次启动用新源码全量重建。便携版是预构建包、无需重建，跳过。
    if (pending.edition !== 'portable') {
      invalidateBuildOutputs();
    }
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
