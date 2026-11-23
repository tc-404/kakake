import path from 'node:path';
import { PATHS } from '../paths.js';

/** 三浏览器渲染工具：浏览器标识 */
export type BrowserId = 'chrome' | 'edge' | 'chromium';

/** 浏览器进程运行模式 */
export type BrowserMode = 'always' | 'plugin' | 'idle';

export const BROWSER_IDS: readonly BrowserId[] = ['chrome', 'edge', 'chromium'];

/** 各浏览器默认 CDP 调试端口（可用配置覆盖，需互不冲突） */
export const DEFAULT_BROWSER_PORTS: Record<BrowserId, number> = {
  chrome: 9333,
  edge: 9334,
  chromium: 9335,
};

export interface BrowserDef {
  id: BrowserId;
  label: string;
  /** 系统已安装浏览器的探测路径（按平台） */
  systemPaths: Partial<Record<NodeJS.Platform, string[]>>;
  /** kakake 安装后的可执行文件路径（相对安装目录） */
  managedExecutable: string;
  /** 下载与版本探测 */
  download: BrowserDownload;
  /** 包体大小（字节，压缩） */
  archiveBytes: number;
  /** 解压后大小（字节） */
  unpackedBytes: number;
}

export interface BrowserDownload {
  /** 探测最新稳定版下载地址的 API（返回 JSON，从中解析出压缩包 URL） */
  versionApi?: string;
  /** 平台 → 下载直链模板；{url} 由 versionApi 解析结果替换，{ver} 由版本替换 */
  urlTemplate?: Partial<Record<NodeJS.Platform, string>>;
  /** 无 versionApi 时的固定直链（按平台） */
  fixedUrl?: Partial<Record<NodeJS.Platform, string>>;
  /** 压缩包类型 */
  archive: 'zip' | 'tar.gz';
  /** 官方首页（未装时给用户看的手动下载地址） */
  homepage: string;
}

const WIN = process.env.ProgramFiles || 'C:\\Program Files';
const WIN86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
const LOCAL = process.env.LOCALAPPDATA || '';

/**
 * 浏览器定义表。下载源均为官方发布地址：
 * - Chrome for Testing：googlechromelabs 官方 JSON，按平台取 chrome 下载项
 * - Edge：微软官方 Products API，按平台取 Stable 版 exe
 * - Chromium：Chrome for Testing 官方 chrome-headless-shell（无头 Chromium 构建）
 */
export const BROWSER_DEFS: Record<BrowserId, BrowserDef> = {
  chrome: {
    id: 'chrome',
    label: 'Chrome',
    systemPaths: {
      win32: [
        path.join(WIN, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(WIN86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(LOCAL, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ],
      darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
      linux: [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/opt/google/chrome/chrome',
      ],
    },
    managedExecutable:
      process.platform === 'win32' ? 'chrome-win64/chrome.exe'
        : process.platform === 'darwin' ? 'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
          : 'chrome-linux64/chrome',
    download: {
      versionApi: 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json',
      archive: 'zip',
      homepage: 'https://www.google.com/chrome/',
    },
    archiveBytes: 160 * 1024 * 1024,
    unpackedBytes: 420 * 1024 * 1024,
  },
  edge: {
    id: 'edge',
    label: 'Edge',
    systemPaths: {
      win32: [
        path.join(WIN86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(WIN, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ],
      darwin: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
      linux: ['/usr/bin/microsoft-edge', '/opt/microsoft/msedge/microsoft-edge'],
    },
    managedExecutable:
      process.platform === 'win32' ? 'msedge-win64/msedge.exe'
        : process.platform === 'darwin' ? 'msedge-mac-x64/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
          : 'msedge-linux64/msedge',
    download: {
      versionApi: 'https://edgeupdates.microsoft.com/api/products?view=enterprise',
      archive: 'zip',
      homepage: 'https://www.microsoft.com/edge/',
    },
    archiveBytes: 130 * 1024 * 1024,
    unpackedBytes: 360 * 1024 * 1024,
  },
  chromium: {
    id: 'chromium',
    label: 'Chromium',
    systemPaths: {
      win32: [
        path.join(LOCAL, 'Chromium', 'Application', 'chrome.exe'),
        path.join(WIN, 'Chromium', 'Application', 'chrome.exe'),
      ],
      darwin: ['/Applications/Chromium.app/Contents/MacOS/Chromium'],
      linux: ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'],
    },
    // Chromium 用 CFT 的完整 chrome 构建：headless-shell 启动即退、无法常驻 CDP（实测），
    // 完整 chrome 加 --headless=new 可稳定常驻并暴露调试端口。与 Chrome 卡同源，独立目录。
    // CFT chrome zip 解压结构：chrome-<platform>/chrome[.exe]
    managedExecutable:
      process.platform === 'win32' ? 'chrome-win64/chrome.exe'
        : process.platform === 'darwin'
          ? (process.arch === 'arm64'
            ? 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
            : 'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
          : (process.arch === 'arm64'
            ? 'chrome-linux64/chrome'
            : 'chrome-linux64/chrome'),
    download: {
      versionApi: 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json',
      archive: 'zip',
      homepage: 'https://www.chromium.org/',
    },
    archiveBytes: 150 * 1024 * 1024,
    unpackedBytes: 400 * 1024 * 1024,
  },
};

/** kakake 安装的某个浏览器根目录 */
export function managedBrowserDir(id: BrowserId): string {
  return path.join(PATHS.browsersDir, id);
}

/** kakake 安装的某个浏览器可执行文件完整路径 */
export function managedBrowserExecutable(id: BrowserId): string {
  return path.join(managedBrowserDir(id), BROWSER_DEFS[id].managedExecutable);
}

/** 版本 API 里按平台取下载项时用的平台键 */
export const CFTOKEN_PLATFORM: Record<string, string> = {
  win32: 'win64',
  darwin: process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64',
  linux: 'linux64',
};

/** Edge Products API 里按平台匹配的 Product 字段 */
export const EDGE_PLATFORM: Record<string, string> = {
  win32: 'win64',
  darwin: 'macos',
  linux: 'linux64',
};
