/**
 * 插件管理器共享工具：只收「逐行同构、零行为差异」的重复实现。
 *
 * 去重范围刻意收窄（行为零变更）：
 * - ob11（plugin.manager）与账号隔离基类（account-plugin.manager.base）在
 *   message_type 守卫、self_id 锁定、reload 语义、simulated 假返回值等方面是
 *   **有意的语义分叉**，那些部分不在此合并。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { PluginEntry } from './plugin.types.js';
import type { PluginRouterRegistryImpl } from './router-registry.js';
import { pluginAccountService } from './plugin-account.service.js';

/** 某账号下已加载的插件运行实例（三个管理器各自声明过同一份） */
export interface AccountRuntime {
  accountKey: string;
  pluginId: string;
  /** 该账号下的加载条目（pluginPath 指向 plugins_two） */
  entry: PluginEntry;
  router: PluginRouterRegistryImpl;
}

/** 事件处理串行化器：同一管理器的插件事件严格按顺序处理，避免并发重入 */
export function createTailSerializer() {
  let tail: Promise<void> = Promise.resolve();
  return {
    run(fn: () => Promise<void>): Promise<void> {
      const run = tail.then(fn, fn);
      tail = run.then(() => undefined, () => undefined);
      return run;
    },
  };
}

/**
 * 准备账号运行副本并解析入口文件路径（原 prepareRuntimePaths 的共享主体）：
 * 1. plugins_two 没有副本就先从 plugins/ 复制；
 * 2. 把安装目录的 entryPath 重映射到运行副本目录；
 * 3. 副本里找不到入口时按 baseName/index.js/index.mjs/index.cjs/main.js 兜底探测。
 *
 * @param rescan 传入各管理器 loader.rescanPlugin 的返回（含安装目录与入口路径）
 * @param logLabel 日志前缀，保持各管理器原有文案不变
 */
export function prepareRuntimeCopy(
  entry: PluginEntry,
  accountKey: string,
  rescan: (fileId: string) => { pluginPath: string; entryPath?: string } | null | undefined,
  logLabel: string,
  logger: { error: (...args: unknown[]) => void },
): boolean {
  try {
    if (!pluginAccountService.hasRuntimeCopy(accountKey, entry.id)) {
      pluginAccountService.copyPluginToAccount(entry.id, accountKey);
    }
    const runtimeDir = pluginAccountService.runtimePluginDir(accountKey, entry.id);
    const installMeta = rescan(entry.fileId || entry.id);
    if (!installMeta?.entryPath) return false;

    const rel = path.relative(installMeta.pluginPath, installMeta.entryPath);
    entry.pluginPath = runtimeDir;
    entry.entryPath = path.join(runtimeDir, rel);
    if (!fs.existsSync(entry.entryPath)) {
      const baseName = path.basename(installMeta.entryPath);
      const candidates = [
        path.join(runtimeDir, baseName),
        path.join(runtimeDir, 'index.js'),
        path.join(runtimeDir, 'index.mjs'),
        path.join(runtimeDir, 'index.cjs'),
        path.join(runtimeDir, 'main.js'),
      ];
      const found = candidates.find((p) => fs.existsSync(p));
      if (!found) return false;
      entry.entryPath = found;
    }
    return true;
  } catch (e) {
    logger.error(`[${logLabel}] 准备运行副本失败 ${entry.id}@${accountKey}:`, e);
    return false;
  }
}

/** 删除插件在 plugins/ 下的安装目录（卸载收尾，三处逐行相同） */
export function removeInstallDir(pluginId: string): void {
  const installPath = pluginAccountService.installPluginDir(pluginId);
  if (fs.existsSync(installPath)) {
    fs.rmSync(installPath, { recursive: true, force: true });
  }
}
