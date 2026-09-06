import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../paths.js';
import { configService } from './config.service.js';
import { DEFAULT_CONFIG, DEFAULT_CONNECTIONS } from './types.js';
import { rootLogger } from './logger.js';
import { initLogFiles } from './log-file-writer.js';
import { pluginAccountService } from '../plugin/plugin-account.service.js';

/** 首次启动初始化 data/ 目录与默认配置 */
export function initDataDirs(): void {
  for (const dir of [
    PATHS.data,
    PATHS.plugins,
    PATHS.pluginsTwo,
    PATHS.log,
    path.join(PATHS.data, 'tmp'),
    path.join(PATHS.data, 'agreement'),
    path.join(PATHS.root, 'config', 'plugins'),
  ]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      rootLogger.info(`创建目录: ${dir}`);
    }
  }

  pluginAccountService.migrateLegacyLayout();

  if (!fs.existsSync(PATHS.config)) {
    configService.saveConfig(DEFAULT_CONFIG);
    rootLogger.info('已写入默认 config.json');
  }

  if (!fs.existsSync(PATHS.connections)) {
    configService.saveConnections(DEFAULT_CONNECTIONS);
    rootLogger.info('已写入默认 connections.json');
  }

  if (!fs.existsSync(PATHS.pluginsStatus)) {
    configService.savePluginStatus({});
  }

  if (!fs.existsSync(PATHS.gfPluginsStatus)) {
    fs.writeFileSync(PATHS.gfPluginsStatus, '{}\n', 'utf-8');
  }

  if (!fs.existsSync(PATHS.wxPluginsStatus)) {
    fs.writeFileSync(PATHS.wxPluginsStatus, '{}\n', 'utf-8');
  }

  // 登录密钥文件在 bootstrap 中 ensureAuthKey，此处仅保证 data 目录已就绪

  initLogFiles();
}

/**
 * 部分插件会通过 ../../config/plugins/{id} 访问数据
 * 联接指向 data/<account|tmp>/<pluginId>
 */
export function ensurePluginDataLink(pluginId: string, accountKey?: string | null): void {
  const target = pluginAccountService.pluginDataDir(pluginId, accountKey);
  const link = path.join(PATHS.root, 'config', 'plugins', pluginId);
  const linkParent = path.dirname(link);
  if (!fs.existsSync(linkParent)) fs.mkdirSync(linkParent, { recursive: true });

  try {
    if (fs.existsSync(link)) {
      const st = fs.lstatSync(link);
      if (st.isSymbolicLink() || st.isDirectory()) {
        // 更新联接目标（换账号时）
        try {
          const current = fs.realpathSync(link);
          if (path.resolve(current) === path.resolve(target)) return;
        } catch { /* recreate */ }
        fs.rmSync(link, { recursive: true, force: true });
      }
    }
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    try {
      if (!fs.existsSync(link)) fs.mkdirSync(link, { recursive: true });
    } catch { /* ignore */ }
  }
}

/** @deprecated 官方插件数据也走 ensurePluginDataLink */
export function ensureGfPluginDataLink(pluginId: string, accountKey?: string | null): void {
  ensurePluginDataLink(pluginId, accountKey);
}
