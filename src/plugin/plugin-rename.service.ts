import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PATHS } from '../paths.js';
import { rootLogger } from '../core/logger.js';
import { readJsonSafe, writeJsonAtomic } from '../storage/atomic-file.js';
import { moveDirectorySafe } from './plugin-dir-ops.js';
import { connectionPluginService } from './connection-plugin.service.js';
import { validateMetaValue, validatePluginDirName, type PluginKind, type PluginRenameErrorCode } from './plugin-rename.js';
import type { PluginEntry } from './plugin.types.js';

export type PluginMetaErrorCode =
  | PluginRenameErrorCode
  | 'PLUGIN_META_NOT_FOUND'
  | 'PLUGIN_META_DIR_MISSING'
  | 'PLUGIN_META_MASTER_ON'
  | 'PLUGIN_META_RUNNING'
  | 'PLUGIN_META_MANIFEST_INVALID'
  | 'PLUGIN_META_IO_DENIED'
  | 'PLUGIN_META_WRITE_FAILED'
  | 'PLUGIN_META_RESCAN_FAILED'
  | 'PLUGIN_META_ROLLBACK_INCOMPLETE';

export interface PluginMetaManager {
  getPluginInfo(pluginId: string): PluginEntry | undefined;
  isMasterEnabled(pluginId: string): boolean;
  getLoadedAccountKeys(pluginId: string): string[];
  rescanPlugins(): Promise<number>;
}

export interface PluginMetaSnapshot {
  name: string;
  displayName: string;
  version: string;
  author: string;
}

export interface PluginMetaInput {
  name: string;
  displayName?: string;
  version?: string;
  author?: string;
}

export type PluginMetaResult =
  | { ok: true; pluginId: string; renamed: boolean }
  | { ok: false; code: PluginMetaErrorCode; message: string };

interface ManifestFile {
  file: string;
  data: Record<string, unknown>;
}

const log = rootLogger.child('[PluginRename] ');

let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readManifest(file: string): ManifestFile | null {
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf-8');
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) throw new Error('清单不是 JSON 对象');
  return { file, data: parsed };
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function listDirs(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((ent) => ent.isDirectory())
      .map((ent) => ent.name);
  } catch {
    return [];
  }
}

function matchDirName(root: string, name: string): string | null {
  if (!fs.existsSync(root)) return null;
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    const exact = entries.find((ent) => ent.isDirectory() && ent.name === name);
    if (exact) return exact.name;
    const lower = name.toLowerCase();
    const hit = entries.find((ent) => ent.isDirectory() && ent.name.toLowerCase() === lower);
    return hit ? hit.name : null;
  } catch {
    return null;
  }
}

function resolveInstallDir(pluginId: string, manager: PluginMetaManager): { dir: string; dirName: string } | null {
  const entry = manager.getPluginInfo(pluginId);
  const candidates = [entry?.fileId, pluginId].filter((v): v is string => !!v && v.trim().length > 0);
  for (const name of candidates) {
    const dirName = matchDirName(PATHS.plugins, name);
    if (!dirName) continue;
    const dir = path.join(PATHS.plugins, dirName);
    try {
      if (fs.statSync(dir).isDirectory()) return { dir, dirName };
    } catch {
      continue;
    }
  }
  return null;
}

function statusFileOf(kind: PluginKind): string {
  if (kind === 'gf') return PATHS.gfPluginsStatus;
  if (kind === 'wx') return PATHS.wxPluginsStatus;
  if (kind === 'ss') return PATHS.ssPluginsStatus;
  if (kind === 'sssx') return PATHS.sssxPluginsStatus;
  if (kind === 'kz') return PATHS.kzPluginsStatus;
  if (kind === 'tg') return PATHS.tgPluginsStatus;
  return PATHS.pluginsStatus;
}

function mapError(error: unknown): { code: PluginMetaErrorCode; message: string } {
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: string }).code)
    : '';
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (message.includes('目标目录已存在')) {
    return { code: 'NAME_CONFLICT', message: '已存在同名插件' };
  }
  if (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY' || code === 'ENOTEMPTY') {
    return { code: 'PLUGIN_META_IO_DENIED', message: '文件被占用或没有权限，请关闭插件后重试' };
  }
  if (code === 'ENOENT') {
    return { code: 'PLUGIN_META_DIR_MISSING', message: '插件目录不存在' };
  }
  return { code: 'PLUGIN_META_WRITE_FAILED', message: message || '保存失败' };
}

export function readPluginMeta(pluginId: string, manager: PluginMetaManager): PluginMetaSnapshot | null {
  const resolved = resolveInstallDir(pluginId, manager);
  if (!resolved) return null;
  let pkg: ManifestFile | null = null;
  let manifest: ManifestFile | null = null;
  try {
    pkg = readManifest(path.join(resolved.dir, 'package.json'));
    manifest = readManifest(path.join(resolved.dir, 'plugin.json'));
  } catch {
    return null;
  }
  return {
    name: resolved.dirName,
    displayName: stringOf(manifest?.data.displayName) || stringOf(pkg?.data.plugin),
    version: stringOf(manifest?.data.version) || stringOf(pkg?.data.version),
    author: stringOf(manifest?.data.author) || stringOf(pkg?.data.author),
  };
}

export function updatePluginMeta(
  pluginId: string,
  input: PluginMetaInput,
  kind: PluginKind,
  manager: PluginMetaManager,
): Promise<PluginMetaResult> {
  return enqueue(async () => {
    const id = String(pluginId || '').trim();
    if (!id) return { ok: false, code: 'PLUGIN_META_NOT_FOUND', message: '缺少插件 ID' };
    if (id.includes('..') || /[\\/]/.test(id)) {
      return { ok: false, code: 'PLUGIN_META_NOT_FOUND', message: '非法插件 ID' };
    }

    const resolved = resolveInstallDir(id, manager);
    if (!resolved) return { ok: false, code: 'PLUGIN_META_NOT_FOUND', message: '插件不存在' };

    const entry = manager.getPluginInfo(id);
    const checks = [id, resolved.dirName, entry?.id].filter((v): v is string => !!v);
    if (checks.some((key) => manager.isMasterEnabled(key) !== false)) {
      return { ok: false, code: 'PLUGIN_META_MASTER_ON', message: '请先关闭插件总开关' };
    }
    if (entry?.loaded === true || manager.getLoadedAccountKeys(id).length > 0) {
      return { ok: false, code: 'PLUGIN_META_RUNNING', message: '插件仍在运行，请先关闭' };
    }

    const nameCheck = validatePluginDirName(kind, input.name);
    if (!nameCheck.ok) return { ok: false, code: nameCheck.code, message: nameCheck.message };
    const newDirName = nameCheck.dirName;

    const displayCheck = input.displayName === undefined ? null : validateMetaValue(input.displayName);
    if (displayCheck && !displayCheck.ok) {
      return { ok: false, code: displayCheck.code, message: displayCheck.message };
    }
    const versionCheck = input.version === undefined ? null : validateMetaValue(input.version);
    if (versionCheck && !versionCheck.ok) {
      return { ok: false, code: versionCheck.code, message: versionCheck.message };
    }
    const authorCheck = input.author === undefined ? null : validateMetaValue(input.author);
    if (authorCheck && !authorCheck.ok) {
      return { ok: false, code: authorCheck.code, message: authorCheck.message };
    }

    const renamed = newDirName !== resolved.dirName;
    if (renamed) {
      const lower = newDirName.toLowerCase();
      const conflict = listDirs(PATHS.plugins).some(
        (name) => name.toLowerCase() === lower && name !== resolved.dirName,
      );
      if (conflict) return { ok: false, code: 'NAME_CONFLICT', message: '已存在同名插件' };
    }

    let pkg: ManifestFile | null = null;
    let manifest: ManifestFile | null = null;
    try {
      pkg = readManifest(path.join(resolved.dir, 'package.json'));
      manifest = readManifest(path.join(resolved.dir, 'plugin.json'));
    } catch (error) {
      log.warn(`清单解析失败: ${resolved.dirName}`, error);
      return { ok: false, code: 'PLUGIN_META_MANIFEST_INVALID', message: '插件清单不是合法 JSON，请先修复' };
    }

    const undos: Array<() => void | Promise<void>> = [];
    let rollbackBroken = false;

    const runUndo = async (): Promise<void> => {
      for (let i = undos.length - 1; i >= 0; i--) {
        try {
          await undos[i]();
        } catch (error) {
          rollbackBroken = true;
          log.error('回滚步骤失败', error);
        }
      }
    };

    const moveDir = async (from: string, to: string): Promise<void> => {
      await moveDirectorySafe(from, to, { overwrite: false, logger: rootLogger });
    };

    try {
      let currentDir = resolved.dir;
      if (renamed) {
        const staging = path.join(PATHS.plugins, `__kk-rename-${randomUUID()}`);
        await moveDir(resolved.dir, staging);
        try {
          await moveDir(staging, path.join(PATHS.plugins, newDirName));
        } catch (error) {
          await moveDir(staging, resolved.dir).catch((restoreError) => {
            rollbackBroken = true;
            log.error('恢复安装目录失败', restoreError);
          });
          throw error;
        }
        currentDir = path.join(PATHS.plugins, newDirName);
        undos.push(() => moveDir(currentDir, resolved.dir));
      }

      const writeManifest = (target: ManifestFile, nameKey: string, displayKey: string): void => {
        const next: Record<string, unknown> = { ...target.data };
        if (renamed) next[nameKey] = newDirName;
        if (displayCheck) {
          if (displayCheck.value) next[displayKey] = displayCheck.value;
          else delete next[displayKey];
        }
        if (versionCheck) {
          if (versionCheck.value) next.version = versionCheck.value;
          else delete next.version;
        }
        if (authorCheck) {
          if (authorCheck.value) next.author = authorCheck.value;
          else delete next.author;
        }
        const original = fs.readFileSync(target.file);
        writeJsonAtomic(target.file, next);
        undos.push(() => fs.writeFileSync(target.file, original));
      };

      if (pkg) writeManifest({ file: path.join(currentDir, 'package.json'), data: pkg.data }, 'name', 'plugin');
      if (manifest) writeManifest({ file: path.join(currentDir, 'plugin.json'), data: manifest.data }, 'name', 'displayName');

      if (renamed) {
        for (const account of listDirs(PATHS.pluginsTwo)) {
          const from = path.join(PATHS.pluginsTwo, account, resolved.dirName);
          const to = path.join(PATHS.pluginsTwo, account, newDirName);
          if (!fs.existsSync(from)) continue;
          await moveDir(from, to);
          undos.push(() => moveDir(to, from));
        }

        for (const account of listDirs(PATHS.data)) {
          if (account === resolved.dirName) continue;
          const from = path.join(PATHS.data, account, resolved.dirName);
          if (!fs.existsSync(from)) continue;
          const to = path.join(PATHS.data, account, newDirName);
          await moveDir(from, to);
          undos.push(() => moveDir(to, from));
        }

        const tmpFrom = path.join(PATHS.data, 'tmp', resolved.dirName);
        if (fs.existsSync(tmpFrom)) {
          const tmpTo = path.join(PATHS.data, 'tmp', newDirName);
          await moveDir(tmpFrom, tmpTo);
          undos.push(() => moveDir(tmpTo, tmpFrom));
        }

        const dataFrom = path.join(PATHS.data, resolved.dirName);
        if (fs.existsSync(dataFrom)) {
          const dataTo = path.join(PATHS.data, newDirName);
          await moveDir(dataFrom, dataTo);
          undos.push(() => moveDir(dataTo, dataFrom));
        }

        const configRoot = path.join(PATHS.root, 'config', 'plugins');
        const linkOld = path.join(configRoot, resolved.dirName);
        const linkNew = path.join(configRoot, newDirName);
        const stat = fs.lstatSync(linkOld, { throwIfNoEntry: false });
        if (stat?.isSymbolicLink()) {
          const target = fs.readlinkSync(linkOld);
          fs.rmSync(linkOld, { recursive: true, force: true });
          undos.push(() => {
            if (fs.existsSync(linkNew)) fs.rmSync(linkNew, { recursive: true, force: true });
            if (!fs.existsSync(linkOld)) {
              fs.symlinkSync(target, linkOld, process.platform === 'win32' ? 'junction' : 'dir');
            }
          });
          const nextTarget = path.basename(target) === resolved.dirName
            ? path.join(path.dirname(target), newDirName)
            : target;
          if (fs.existsSync(nextTarget) && !fs.existsSync(linkNew)) {
            fs.symlinkSync(nextTarget, linkNew, process.platform === 'win32' ? 'junction' : 'dir');
          }
        } else if (stat?.isDirectory()) {
          await moveDir(linkOld, linkNew);
          undos.push(() => moveDir(linkNew, linkOld));
        }
      }

      if (renamed) {
        const statusFile = statusFileOf(kind);
        const status = readJsonSafe<Record<string, boolean>>(statusFile, {});
        const aliasKeys = [resolved.dirName, entry?.id].filter((v): v is string => !!v && v !== newDirName);
        const hitKey = aliasKeys.find((key) => key in status);
        if (hitKey) {
          const snapshot = { ...status };
          const value = status[hitKey];
          for (const key of aliasKeys) delete status[key];
          if (!(newDirName in status)) status[newDirName] = value;
          writeJsonAtomic(statusFile, status);
          undos.push(() => writeJsonAtomic(statusFile, snapshot));
        }

        connectionPluginService.renamePluginEverywhere(resolved.dirName, newDirName, kind);
        undos.push(() => connectionPluginService.renamePluginEverywhere(newDirName, resolved.dirName, kind));
      }

      try {
        await manager.rescanPlugins();
      } catch (error) {
        throw Object.assign(new Error('重新扫描插件失败'), { cause: error, code: 'RESCAN_FAILED' });
      }

      return { ok: true, pluginId: newDirName, renamed };
    } catch (error) {
      await runUndo();
      if (rollbackBroken) {
        return {
          ok: false,
          code: 'PLUGIN_META_ROLLBACK_INCOMPLETE',
          message: '保存失败且回滚不完整，请检查 plugins 与 plugins_two 目录',
        };
      }
      if (error && typeof error === 'object' && (error as { code?: string }).code === 'RESCAN_FAILED') {
        return { ok: false, code: 'PLUGIN_META_RESCAN_FAILED', message: '已保存，但重新扫描插件失败' };
      }
      const mapped = mapError(error);
      return { ok: false, code: mapped.code, message: mapped.message };
    }
  });
}
