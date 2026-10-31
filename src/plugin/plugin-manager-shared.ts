/**
 * 插件管理器共享工具：只收「逐行同构、零行为差异」的重复实现。
 * 去重范围刻意收窄——ob11 与账号隔离基类在 message_type 守卫 / self_id 锁定 / reload / simulated 返回值等方面是有意语义分叉，不在此合并。
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

/** 插件事件 handler 单次派发超时：与 kakake_api 默认超时（proxy facade 30s）对齐 */
export const PLUGIN_EVENT_HANDLER_TIMEOUT_MS = 30_000;
/** 同一会话串行链最大在途事件数：超出即丢弃新事件，防止慢插件把链排到无界 */
export const PLUGIN_EVENT_QUEUE_LIMIT = 64;

/** awaitPluginHandler 的结果：timedOut=true 表示超时后放弃等待，handler 可能仍在后台运行 */
export type PluginHandlerWait = { timedOut: false; elapsedMs: number } | { timedOut: true; elapsedMs: number };

/**
 * 等待插件 handler 最多 timeoutMs：超时返回 timedOut=true 并继续（原 promise 的
 * 后续 resolve/reject 已被本函数挂接，不会变成 unhandledRejection）；窗口内抛错
 * 原样上抛，交给调用方按既有 catch 记日志。timeoutMs<=0 时不限时。
 * 插件钩子允许同步返回 void，这里统一按 thenable 归一。
 */
export async function awaitPluginHandler(handler: unknown, timeoutMs: number): Promise<PluginHandlerWait> {
  const promise = Promise.resolve(handler as PromiseLike<unknown>);
  const start = Date.now();
  if (!(timeoutMs > 0)) {
    await promise;
    return { timedOut: false, elapsedMs: Date.now() - start };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      promise.then(
        () => ({ settled: true as const }),
        (error: unknown) => ({ settled: true as const, error }),
      ),
      new Promise<{ settled: false }>((resolve) => {
        timer = setTimeout(() => resolve({ settled: false }), timeoutMs);
      }),
    ]);
    if (!outcome.settled) return { timedOut: true, elapsedMs: Date.now() - start };
    if ('error' in outcome) throw outcome.error;
    return { timedOut: false, elapsedMs: Date.now() - start };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
