/**
 * Puppeteer 插件兼容桥接。
 *
 * kakake-plugin-puppeteer 的 findBrowserPath() 检测顺序：
 *   1) 配置里的 executablePath
 *   2) %LOCALAPPDATA%\puppeteer\chrome\chrome-<plat>\chrome.exe  ← 本模块对接这一条
 *   3) 写死的系统路径
 *
 * kakake 把浏览器装在 data/runtime-deps/browsers/<id>/ 下，插件不认识这个位置。
 * 本模块在第 2 条的标准路径创建一个「目录联接（Windows junction）/ 软链接（POSIX）」
 * 指向 kakake 托管的浏览器目录，插件即可零改动检测到并正常 launch。
 *
 * 原则：
 * - 若标准路径已有「用户自己的真实浏览器目录」，绝不覆盖（与「用户自带浏览器不管」一致）。
 * - 只管理由本模块创建的链接，卸载时仅移除链接，不碰 kakake 的真实安装目录以外的数据。
 * - Chrome / Chromium 的 CFT 构建目录名与插件期望完全一致（chrome-<plat>），可直接链接。
 *   Edge 官方产物目录名不同（msedge-*），插件不会按 chrome-<plat> 找到它，故不纳入。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PATHS } from '../paths.js';
import { rootLogger } from '../core/logger.js';
import type { BrowserId } from './browser-defs.js';

/** 与插件 getPlatformForDownload() 一致的平台目录名 */
export function cftPlatformDir(): string {
  const p = process.platform;
  if (p === 'win32') return process.arch === 'ia32' ? 'chrome-win32' : 'chrome-win64';
  if (p === 'darwin') return process.arch === 'arm64' ? 'chrome-mac-arm64' : 'chrome-mac-x64';
  return process.arch === 'arm64' ? 'chrome-linux-arm64' : 'chrome-linux64';
}

/** 插件期望的 puppeteer chrome 根目录 */
function puppeteerChromeRoot(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'puppeteer', 'chrome');
  }
  return path.join(os.homedir(), '.cache', 'puppeteer', 'chrome');
}

/** 链接应落到的完整路径，例如 .../puppeteer/chrome/chrome-win64 */
export function puppeteerLinkPath(): string {
  return path.join(puppeteerChromeRoot(), cftPlatformDir());
}

/** 该路径是否是指向 kakake 托管目录的链接（含失效链接） */
function isOurLink(linkPath: string): boolean {
  try {
    const st = fs.lstatSync(linkPath);
    const isLink = st.isSymbolicLink() || st.isDirectory(); // Windows junction 在某些 Node 版本报 isDirectory
    if (!isLink) return false;
    // 只有符号链接/junction 才有 realpath 指向别处；普通目录 realpath 等于自身
    const real = fs.realpathSync(linkPath);
    return path.resolve(real).toLowerCase().startsWith(path.resolve(PATHS.browsersDir).toLowerCase());
  } catch {
    // lstat 成功但 realpath 失败 = 失效链接，仍可能是我们建的
    try {
      const st = fs.lstatSync(linkPath);
      return st.isSymbolicLink();
    } catch { return false; }
  }
}

/** 安全删除一个链接（无论是否有效），不递归进目标目录 */
function removeLink(linkPath: string): void {
  try {
    if (process.platform === 'win32') {
      // junction 用 rmdirSync 只删链接本身，绝不递归
      fs.rmdirSync(linkPath);
    } else {
      fs.unlinkSync(linkPath);
    }
  } catch {
    // 已不存在
  }
}

/** kakake 托管目录里，可被插件直接 launch 的浏览器目录（CFT chrome 构建） */
function managedBrowserSource(id: BrowserId): string {
  return path.join(PATHS.browsersDir, id, cftPlatformDir());
}

function sourceHasExecutable(src: string): boolean {
  const exe = process.platform === 'win32' ? 'chrome.exe'
    : process.platform === 'darwin'
      ? path.join('Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing')
      : 'chrome';
  return fs.existsSync(path.join(src, exe));
}

/**
 * 建立/刷新 Puppeteer 桥接链接。安装成功后、宿主启动时调用。
 * 返回实际链接到的浏览器，null 表示未建立（无可链接浏览器，或用户自有目录占位）。
 */
export function syncPuppeteerBridge(): BrowserId | null {
  const linkPath = puppeteerLinkPath();
  // 优先级：Chrome > Chromium（两者都是 CFT chrome 构建，目录名匹配）；Edge 不适用
  const candidates: BrowserId[] = ['chrome', 'chromium'];
  const source = candidates.map(managedBrowserSource).find(sourceHasExecutable);
  if (!source) return null;

  // 目标路径已存在：若是用户自有真实目录则保留不动；若是我们建的旧链接则刷新
  let exists = false;
  try { fs.lstatSync(linkPath); exists = true; } catch { /* 不存在 */ }
  if (exists) {
    if (!isOurLink(linkPath)) {
      rootLogger.info('[渲染工具] Puppeteer 已有自有浏览器目录，跳过桥接');
      return null;
    }
    try {
      if (path.resolve(fs.realpathSync(linkPath)) === path.resolve(source)) return null; // 已指向正确目标
    } catch { /* 失效链接，下面重建 */ }
    removeLink(linkPath);
  }

  try {
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    // Windows 用 junction（目录链接，无需管理员权限）；POSIX 用 dir 软链接
    fs.symlinkSync(source, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    const bridged = candidates.find((id) => managedBrowserSource(id) === source) ?? 'chrome';
    rootLogger.info(`[渲染工具] 已为 Puppeteer 插件桥接浏览器: ${linkPath} → ${source}`);
    return bridged;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    rootLogger.warn(`[渲染工具] Puppeteer 桥接失败（不影响咔咔珂自身使用）: ${msg}`);
    return null;
  }
}

/** 卸载时调用：仅移除我们建的链接；若当前链接指向的正是被卸载的浏览器则清掉 */
export function removePuppeteerBridge(browserId: BrowserId): void {
  const linkPath = puppeteerLinkPath();
  try {
    if (!isOurLink(linkPath)) return;
    const real = fs.realpathSync(linkPath);
    const unlinkedBrowser = path.resolve(real);
    if (unlinkedBrowser === path.resolve(managedBrowserSource(browserId))) {
      removeLink(linkPath);
      rootLogger.info(`[渲染工具] 已移除 ${browserId} 的 Puppeteer 桥接链接`);
    }
  } catch { /* ignore */ }
}
