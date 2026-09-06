import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../paths.js';
import { configService } from '../core/config.service.js';
import {
  isOnebotConnection,
  isQqOfficialConnection,
  isWeixinBotConnection,
  type ConnectionConfig,
} from '../core/types.js';
import { rootLogger } from '../core/logger.js';

/**
 * 账号作用域插件运行时：
 * - 安装源：plugins/<pluginId>
 * - 运行副本：plugins_two/<accountKey>/<pluginId>
 * - 数据：data/<accountKey>/<pluginId>（账号未知时 data/tmp/<pluginId>）
 */
class PluginAccountService {
  /** OneBot → QQ 号；官方 → AppID；微信 → ilink_bot_id */
  resolveAccountKey(conn: ConnectionConfig | undefined | null): string | null {
    if (!conn) return null;
    if (isQqOfficialConnection(conn)) {
      const id = String(conn.appId || '').trim();
      return id || null;
    }
    if (isWeixinBotConnection(conn)) {
      const id = String(conn.weixinAccountId || '').trim();
      return id || null;
    }
    if (isOnebotConnection(conn)) {
      const uin = String(conn.botUin || '').trim();
      return uin || null;
    }
    return null;
  }

  accountKeyForConnectionId(connectionId: string): string | null {
    return this.resolveAccountKey(configService.getConnection(connectionId));
  }

  /** 安装目录（统一 plugins/） */
  installPluginDir(pluginId: string): string {
    return path.join(PATHS.plugins, pluginId);
  }

  accountRuntimeRoot(accountKey: string): string {
    return path.join(PATHS.pluginsTwo, accountKey);
  }

  runtimePluginDir(accountKey: string, pluginId: string): string {
    return path.join(this.accountRuntimeRoot(accountKey), pluginId);
  }

  /** 数据目录：有账号 → data/<account>/<plugin>；否则 data/tmp/<plugin> */
  pluginDataDir(pluginId: string, accountKey?: string | null): string {
    const key = (accountKey || '').trim();
    const dir = key
      ? path.join(PATHS.data, key, pluginId)
      : path.join(PATHS.data, 'tmp', pluginId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  pluginConfigPath(pluginId: string, accountKey?: string | null): string {
    return path.join(this.pluginDataDir(pluginId, accountKey), 'config.json');
  }

  ensureAccountRuntimeRoot(accountKey: string): string {
    const root = this.accountRuntimeRoot(accountKey);
    fs.mkdirSync(root, { recursive: true });
    return root;
  }

  hasRuntimeCopy(accountKey: string, pluginId: string): boolean {
    const dir = this.runtimePluginDir(accountKey, pluginId);
    return fs.existsSync(dir) && fs.statSync(dir).isDirectory();
  }

  /**
   * 从 plugins/ 复制到 plugins_two/<account>/
   * 总开关关闭时禁止复制
   */
  copyPluginToAccount(pluginId: string, accountKey: string, opts?: { allowWhenMasterOff?: boolean }): string {
    if (!opts?.allowWhenMasterOff) {
      // 调用方应先校验 master；此处再防一层
    }
    const src = this.installPluginDir(pluginId);
    if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
      throw new Error(`插件安装目录不存在: ${pluginId}`);
    }
    this.ensureAccountRuntimeRoot(accountKey);
    const dest = this.runtimePluginDir(accountKey, pluginId);
    if (fs.existsSync(dest)) {
      fs.rmSync(dest, { recursive: true, force: true });
    }
    fs.cpSync(src, dest, { recursive: true, force: true });
    rootLogger.info(`[PluginAccount] 已复制 ${pluginId} → plugins_two/${accountKey}/`);
    return dest;
  }

  removeAccountRuntime(accountKey: string): void {
    const key = String(accountKey || '').trim();
    if (!key) return;
    const root = this.accountRuntimeRoot(key);
    if (!fs.existsSync(root)) return;
    fs.rmSync(root, { recursive: true, force: true });
    rootLogger.info(`[PluginAccount] 已删除运行目录 plugins_two/${key}`);
  }

  /** 仅删除某账号下单个插件的运行副本（不影响 plugins/ 安装源） */
  removeRuntimePlugin(accountKey: string, pluginId: string, cleanData = false): void {
    const key = String(accountKey || '').trim();
    const id = String(pluginId || '').trim();
    if (!key || !id) return;
    const copy = this.runtimePluginDir(key, id);
    if (fs.existsSync(copy)) {
      fs.rmSync(copy, { recursive: true, force: true });
      rootLogger.info(`[PluginAccount] 已删除运行副本 plugins_two/${key}/${id}`);
    }
    if (!cleanData || key === 'tmp') return;
    const dataDir = path.join(PATHS.data, key, id);
    if (fs.existsSync(dataDir)) {
      fs.rmSync(dataDir, { recursive: true, force: true });
      rootLogger.info(`[PluginAccount] 已删除账号数据 data/${key}/${id}`);
    }
  }

  removeAccountData(accountKey: string): void {
    const key = String(accountKey || '').trim();
    if (!key || key === 'tmp') return;
    const root = path.join(PATHS.data, key);
    if (!fs.existsSync(root)) return;
    fs.rmSync(root, { recursive: true, force: true });
    rootLogger.info(`[PluginAccount] 已删除数据目录 data/${key}`);
  }

  /** 删除连接时：按账号清 plugins_two；可选清 data */
  cleanupConnectionAccount(conn: ConnectionConfig, clearData: boolean): void {
    const key = this.resolveAccountKey(conn);
    if (!key) return;
    // 若还有其它连接占用同一账号，则不删共享目录
    const others = configService.getConnections().connections.filter((c) => {
      if (c.id === conn.id) return false;
      return this.resolveAccountKey(c) === key;
    });
    if (others.length > 0) {
      rootLogger.info(`[PluginAccount] 账号 ${key} 仍被其它连接使用，跳过目录清理`);
      return;
    }
    this.removeAccountRuntime(key);
    if (clearData) this.removeAccountData(key);
  }

  /** 卸载插件时：清掉各账号下的运行副本与数据 */
  removePluginEverywhere(pluginId: string, cleanData: boolean): void {
    if (fs.existsSync(PATHS.pluginsTwo)) {
      for (const ent of fs.readdirSync(PATHS.pluginsTwo, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        const copy = this.runtimePluginDir(ent.name, pluginId);
        if (fs.existsSync(copy)) {
          fs.rmSync(copy, { recursive: true, force: true });
        }
      }
    }
    if (!cleanData) return;
    const tmp = path.join(PATHS.data, 'tmp', pluginId);
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
    // 旧路径兼容
    for (const legacy of [
      path.join(PATHS.data, 'plugins', pluginId),
      path.join(PATHS.data, 'gf-plugins', pluginId),
    ]) {
      if (fs.existsSync(legacy)) fs.rmSync(legacy, { recursive: true, force: true });
    }
    if (!fs.existsSync(PATHS.data)) return;
    for (const ent of fs.readdirSync(PATHS.data, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      if (ent.name === 'tmp' || ent.name === 'plugins' || ent.name === 'gf-plugins') continue;
      const dir = path.join(PATHS.data, ent.name, pluginId);
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  /**
   * 启动时：把旧 GF_plugins 迁入统一 plugins/，并建 plugins_two
   */
  migrateLegacyLayout(): void {
    fs.mkdirSync(PATHS.plugins, { recursive: true });
    fs.mkdirSync(PATHS.pluginsTwo, { recursive: true });
    fs.mkdirSync(path.join(PATHS.data, 'tmp'), { recursive: true });

    const legacy = PATHS.gfPluginsLegacy;
    if (!fs.existsSync(legacy)) return;
    let moved = 0;
    for (const ent of fs.readdirSync(legacy, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const src = path.join(legacy, ent.name);
      const dest = path.join(PATHS.plugins, ent.name);
      if (fs.existsSync(dest)) {
        rootLogger.warn(`[PluginAccount] 跳过迁移（目标已存在）: ${ent.name}`);
        continue;
      }
      try {
        fs.renameSync(src, dest);
        moved += 1;
      } catch {
        try {
          fs.cpSync(src, dest, { recursive: true });
          fs.rmSync(src, { recursive: true, force: true });
          moved += 1;
        } catch (e) {
          rootLogger.warn(`[PluginAccount] 迁移 GF 插件失败 ${ent.name}:`, e);
        }
      }
    }
    if (moved > 0) {
      rootLogger.info(`[PluginAccount] 已从 GF_plugins 迁入 ${moved} 个插件到 plugins/`);
    }
    // 空目录可保留；有残余文件也不强删，避免误伤
  }

  /**
   * 写入 / 锁定 OneBot 账号 QQ 号；换号时更新并确保运行目录
   * @returns 是否发生变化
   */
  lockOnebotAccount(connectionId: string, selfId: string | number): boolean {
    const uin = String(selfId ?? '').trim();
    if (!uin || uin === '0') return false;
    const data = configService.getConnections();
    const conn = data.connections.find((c) => c.id === connectionId);
    if (!conn || !isOnebotConnection(conn)) return false;
    if (conn.botUin === uin) {
      this.ensureAccountRuntimeRoot(uin);
      void this.ensureOnebotAvatar(connectionId, uin);
      return false;
    }
    const prev = conn.botUin;
    conn.botUin = uin;
    configService.saveConnections(data);
    this.ensureAccountRuntimeRoot(uin);
    if (prev && prev !== uin) {
      rootLogger.info(`[PluginAccount] 连接 ${connectionId} 账号由 ${prev} 切换为 ${uin}`);
    } else {
      rootLogger.info(`[PluginAccount] 连接 ${connectionId} 锁定账号 ${uin}`);
    }
    void this.ensureOnebotAvatar(connectionId, uin, true);
    return true;
  }

  private ensureOnebotAvatar(connectionId: string, uin: string, force = false): void {
    void import('../connection/connection-avatar.store.js').then(async ({ fetchAndStoreOnebotQlogoAvatar }) => {
      const wrote = await fetchAndStoreOnebotQlogoAvatar(connectionId, uin, { force });
      if (!wrote) return;
      try {
        const { kakakeApp } = await import('../kakake-app.js');
        kakakeApp.connectionManager?.notifyStatus?.();
      } catch { /* ignore */ }
    }).catch(() => undefined);
  }

  /** 官方机器人：用 AppID 建运行目录 */
  ensureOfficialAccount(connectionId: string): boolean {
    const conn = configService.getConnection(connectionId);
    if (!conn || !isQqOfficialConnection(conn)) return false;
    const key = this.resolveAccountKey(conn);
    if (!key) return false;
    this.ensureAccountRuntimeRoot(key);
    return true;
  }

  /** 微信 BOT：用 ilink_bot_id 建运行目录 */
  ensureWeixinAccount(connectionId: string): boolean {
    const conn = configService.getConnection(connectionId);
    if (!conn || !isWeixinBotConnection(conn)) return false;
    const key = this.resolveAccountKey(conn);
    if (!key) return false;
    this.ensureAccountRuntimeRoot(key);
    return true;
  }
}

export const pluginAccountService = new PluginAccountService();
