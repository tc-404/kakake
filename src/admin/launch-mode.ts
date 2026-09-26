import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../paths.js';

/**
 * 启动方式 / 版本形态识别（在线更新与「网页重启」的前提判断）。
 *
 * 设计要点：
 * - 进程无法可靠地「一边运行一边替换自己再重启自己」，尤其 Windows 文件锁。
 *   所以真正的替换与重启由外层启动器（start.bat / start.sh / 便携启动脚本 / mk 拉起的
 *   重启循环）在两次进程之间完成。只有这些「受管重启」启动器会设置
 *   环境变量 KAKAKE_MANAGED_RELAUNCH=1，后端据此决定是否点亮「确定重启」。
 * - 直接 `node`、pm2、docker 里手动跑等未设置该变量的方式，一律视为「不可自动重启」，
 *   网页侧只暂存文件并提示用户手动重启。
 *
 * 版本形态：
 * - source（源码版）：含 scripts/bootstrap.mjs + package.json，更新走 GitHub 源码包（tarball）。
 * - portable（便携免 Node 版）：含 runtime/ 内置 node 且无 bootstrap，更新走 Release 的
 *   kakake-<平台>-x64.zip 便携包。
 */

/** 约定的「请应用暂存更新并重启」退出码；外层启动器只认这一个码做重启循环 */
export const RELAUNCH_EXIT_CODE = 86;

export type Edition = 'source' | 'portable';

/** 当前启动器是否支持网页触发的自动重启 */
export function isManagedRelaunch(): boolean {
  return process.env.KAKAKE_MANAGED_RELAUNCH === '1';
}

function fileExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/** 版本形态判定（与 mk 脚本 kakake_is_portable / kakake_is_source 对齐） */
export function detectEdition(): Edition {
  const root = PATHS.root;
  const hasBootstrap = fileExists(path.join(root, 'scripts', 'bootstrap.mjs'));
  const hasPackageJson = fileExists(path.join(root, 'package.json'));
  const hasRuntimeWin = fileExists(path.join(root, 'runtime', 'node.exe'));
  const hasRuntimeNix = fileExists(path.join(root, 'runtime', 'bin', 'node'));
  const hasServerBundle = fileExists(path.join(root, 'packages', 'server', 'main.mjs'));
  // 便携版：有内置 runtime 与打包产物，且没有开发用 bootstrap
  if (!hasBootstrap && hasServerBundle && (hasRuntimeWin || hasRuntimeNix)) {
    return 'portable';
  }
  // 其余含 package.json + bootstrap 的按源码版处理（默认也回落到 source）
  void hasPackageJson;
  return 'source';
}

/** 便携包 / 源码包对应的平台标识（用于选择 Release 资产） */
export function currentPlatformToken(): 'win' | 'linux' | 'other' {
  if (process.platform === 'win32') return 'win';
  if (process.platform === 'linux' || process.platform === 'android') return 'linux';
  return 'other';
}

export type LaunchModeInfo = {
  /** 是否可网页触发自动重启 */
  canRestart: boolean;
  edition: Edition;
  platform: 'win' | 'linux' | 'other';
  /** 便携版在 macOS 等无对应发行包的平台上无法在线更新 */
  onlineUpdateSupported: boolean;
  /** 面向用户的说明（不可重启 / 平台不支持时给出提示） */
  note: string;
};

export function getLaunchModeInfo(): LaunchModeInfo {
  const edition = detectEdition();
  const platform = currentPlatformToken();
  const canRestart = isManagedRelaunch();
  // 便携版依赖 Release 里的 win/linux 包；macOS 等无包，无法在线安装便携更新
  const onlineUpdateSupported = edition === 'source' || platform !== 'other';
  let note = '';
  if (!canRestart) {
    note = '当前启动方式不支持自动重启：可下载并暂存新版本，但需你自己手动重启进程后生效。';
  } else if (!onlineUpdateSupported) {
    note = '当前平台缺少对应的便携发行包，暂不支持在线更新，请手动下载安装。';
  }
  return { canRestart, edition, platform, onlineUpdateSupported, note };
}
