import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 向上查找含 name=kakake 的 package.json（兼容 src/ 与 packages/server/ 打包入口） */
function resolveProjectRoot(startDir: string): string {
  let cur = path.resolve(startDir);
  for (let i = 0; i < 8; i++) {
    const pkgPath = path.join(cur, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { name?: string };
        if (pkg.name === 'kakake') return cur;
      } catch { /* keep walking */ }
    }
    if (fs.existsSync(path.join(cur, 'scripts', 'bootstrap.mjs'))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return path.resolve(startDir, '..');
}

/** 项目根目录（kakake/） */
export const ROOT_DIR = resolveProjectRoot(__dirname);

/** 源码目录 */
export const SRC_DIR = path.join(ROOT_DIR, 'src');

/** 数据目录 - 所有持久化读写 */
export const DATA_DIR = path.join(ROOT_DIR, 'data');

/** 插件安装目录（kakake-* / GF-* / WX-* 统一存放，按文件夹名前缀区分） */
export const PLUGINS_DIR = path.join(ROOT_DIR, 'plugins');

/**
 * 按账号隔离的插件运行副本目录：plugins_two/<QQ或AppID>/<pluginId>
 * （旧 GF_plugins 仅作迁移来源，不再作为安装目录）
 */
export const PLUGINS_TWO_DIR = path.join(ROOT_DIR, 'plugins_two');

/** @deprecated 旧官方插件目录，启动时迁入 plugins/ */
export const GF_PLUGINS_DIR = path.join(ROOT_DIR, 'GF_plugins');

/** 静态资源目录（旧 EJS 资源，保留兼容） */
export const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

/** Web UI 源码（src/web）；依赖与 Vite 产物在可删除的 packages/web */
export const WEB_APP_DIR = path.join(ROOT_DIR, 'src', 'web');
/** @deprecated 旧 Next 产物路径，保留兼容引用 */
export const WEB_DIST_DIR = path.join(ROOT_DIR, 'packages', 'web', '.next');
export const WEB_SPA_DIST_DIR = path.join(ROOT_DIR, 'packages', 'web', 'dist');
export const WEB_PKG_DIR = path.join(ROOT_DIR, 'packages', 'web');

/** 运行日志目录 */
export const LOG_DIR = path.join(ROOT_DIR, 'log');

export const PATHS = {
  root: ROOT_DIR,
  src: SRC_DIR,
  data: DATA_DIR,
  plugins: PLUGINS_DIR,
  pluginsTwo: PLUGINS_TWO_DIR,
  /** @deprecated 仅迁移用 */
  gfPluginsLegacy: GF_PLUGINS_DIR,
  /** @deprecated 与 plugins 相同，兼容旧引用 */
  gfPlugins: PLUGINS_DIR,
  public: PUBLIC_DIR,
  webApp: WEB_APP_DIR,
  /** @deprecated Next 产物目录；现改为 webSpaDist */
  webDist: WEB_DIST_DIR,
  /** Vite SPA 构建产物 */
  webSpaDist: path.join(ROOT_DIR, 'packages', 'web', 'dist'),
  webPkg: WEB_PKG_DIR,
  log: LOG_DIR,
  /** 图文 / 插件开发等教程原文 */
  tutorials: path.join(ROOT_DIR, '使用教程'),
  config: path.join(DATA_DIR, 'config.json'),
  pluginsStatus: path.join(DATA_DIR, 'plugins.json'),
  gfPluginsStatus: path.join(DATA_DIR, 'gf-plugins.json'),
  wxPluginsStatus: path.join(DATA_DIR, 'wx-plugins.json'),
  connectionPlugins: path.join(DATA_DIR, 'connection-plugins.json'),
  connections: path.join(DATA_DIR, 'connections.json'),
  /** 连接头像 base64 缓存（统一 JSON，非图片文件） */
  connectionAvatars: path.join(DATA_DIR, 'connection-avatars.json'),
  /** 后台登录密钥（强制鉴权） */
  authKey: path.join(DATA_DIR, 'auth-key.json'),
  /** 控制台外观参数（动效速度 / 透明度 / 模糊度） */
  appearance: path.join(DATA_DIR, 'appearance.json'),
  /** 自定义背景图存放目录（竖屏 / 横屏各一张） */
  appearanceDir: path.join(DATA_DIR, 'appearance'),
  /** 工具：Zepp Life 步数账号与 token */
  zeppSteps: path.join(DATA_DIR, 'tools', 'zepp-steps.json'),
} as const;
