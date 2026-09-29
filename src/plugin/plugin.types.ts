/** 咔咔珂插件系统类型定义 */

import type { ActionCaller } from '../connection/onebot.types.js';

// ==================== 插件包信息 ====================

export interface PluginPackageJson {
  name?: string;
  plugin?: string;
  version?: string;
  main?: string;
  description?: string;
  author?: string;
  homepage?: string;
  /** 经典 HTML 后台入口（相对插件根目录） */
  webui?: string;
  /**
   * 宿主控制台动态加载的 ESM 模块入口（相对插件根目录），例如 `webui/remote.js`。
   * 需 external react / react-dom / react-router-dom，由宿主 importmap 注入同实例。
   */
  webuiModule?: string;
  icon?: string;
  napcat?: {
    tags?: string[];
    minVersion?: string;
    homepage?: string;
  };
}

/** 咔咔珂插件 manifest（plugin.json） */
export interface KakakePluginManifest {
  name?: string;
  displayName?: string;
  author?: string;
  version?: string;
  icon?: string;
  runtime?: string;
  entry?: string;
  loader?: string;
  compat_layer?: string;
  description?: string;
  /**
   * 为 true 时插件 ctx.logger 不写进程 stdout（SSH），
   * 仍进入后台运行日志与 log/ 文件。
   */
  logSilentStdout?: boolean;
}

// ==================== 配置 Schema ====================

export interface PluginConfigItem {
  key: string;
  type: 'string' | 'number' | 'boolean' | 'select' | 'multi-select' | 'html' | 'text';
  label: string;
  description?: string;
  default?: unknown;
  options?: { label: string; value: string | number }[];
  placeholder?: string;
  reactive?: boolean;
  hidden?: boolean;
}

export type PluginConfigSchema = PluginConfigItem[];

export interface PluginConfigUIController {
  updateSchema: (schema: PluginConfigSchema) => void;
  updateField: (key: string, field: Partial<PluginConfigItem>) => void;
  removeField: (key: string) => void;
  addField: (field: PluginConfigItem, afterKey?: string) => void;
  showField: (key: string) => void;
  hideField: (key: string) => void;
  getCurrentConfig: () => Record<string, unknown>;
}

// ==================== 路由 ====================

export type HttpMethod = 'get' | 'post' | 'put' | 'delete' | 'patch' | 'all';

export interface PluginHttpRequest {
  path: string;
  method: string;
  query: Record<string, unknown>;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
  params: Record<string, string>;
  raw: unknown;
}

export interface PluginHttpResponse {
  status(code: number): PluginHttpResponse;
  type(contentType: string): PluginHttpResponse;
  json(data: unknown): void;
  send(data: string | Buffer): void;
  setHeader(name: string, value: string): PluginHttpResponse;
  sendFile(filePath: string): void;
  redirect(url: string): void;
  raw: unknown;
}

export type PluginRequestHandler = (
  req: PluginHttpRequest,
  res: PluginHttpResponse,
  next: (err?: unknown) => void,
) => void | Promise<void>;

/** 插件后台页面投递形态 */
export type PluginPageKind = 'html' | 'module';

export interface PluginPageDefinition {
  path: string;
  title: string;
  icon?: string;
  /**
   * HTML 入口（kind=html 或作为 iframe 回退）。
   * kind=module 且仅挂远程组件时可省略。
   */
  htmlFile?: string;
  /**
   * ESM 远程模块（相对插件根目录）。设置后默认 kind=module。
   * 默认导出 React 组件，props 见宿主 `PluginRemoteProps`。
   */
  module?: string;
  /** 省略时：有 module → module，否则 html */
  kind?: PluginPageKind;
  description?: string;
}

/** 解析页面实际 kind */
export function resolvePluginPageKind(page: Pick<PluginPageDefinition, 'kind' | 'module' | 'htmlFile'>): PluginPageKind {
  if (page.kind === 'module' || page.kind === 'html') return page.kind;
  if (page.module) return 'module';
  return 'html';
}

export interface MemoryStaticFile {
  path: string;
  content: string | Buffer | (() => string | Buffer | Promise<string | Buffer>);
  contentType?: string;
}

export interface PluginRouterRegistry {
  api(method: HttpMethod, path: string, handler: PluginRequestHandler): void;
  get(path: string, handler: PluginRequestHandler): void;
  post(path: string, handler: PluginRequestHandler): void;
  put(path: string, handler: PluginRequestHandler): void;
  delete(path: string, handler: PluginRequestHandler): void;
  apiNoAuth(method: HttpMethod, path: string, handler: PluginRequestHandler): void;
  getNoAuth(path: string, handler: PluginRequestHandler): void;
  postNoAuth(path: string, handler: PluginRequestHandler): void;
  putNoAuth(path: string, handler: PluginRequestHandler): void;
  deleteNoAuth(path: string, handler: PluginRequestHandler): void;
  page(page: PluginPageDefinition): void;
  pages(pages: PluginPageDefinition[]): void;
  static(urlPath: string, localPath: string): void;
  staticOnMem(urlPath: string, files: MemoryStaticFile[]): void;
}

// ==================== 插件配置 Schema 构建器 ====================

export interface INapCatConfigStatic {
  text(key: string, label: string, defaultValue?: string, description?: string, reactive?: boolean): PluginConfigItem;
  number(key: string, label: string, defaultValue?: number, description?: string, reactive?: boolean): PluginConfigItem;
  boolean(key: string, label: string, defaultValue?: boolean, description?: string, reactive?: boolean): PluginConfigItem;
  select(key: string, label: string, options: { label: string; value: string | number }[], defaultValue?: string | number, description?: string, reactive?: boolean): PluginConfigItem;
  multiSelect(key: string, label: string, options: { label: string; value: string | number }[], defaultValue?: (string | number)[], description?: string, reactive?: boolean): PluginConfigItem;
  html(content: string): PluginConfigItem;
  plainText(content: string): PluginConfigItem;
  combine(...items: PluginConfigItem[]): PluginConfigSchema;
}

// ==================== 插件管理器接口 ====================

export interface IPluginManager {
  config: Record<string, unknown>;
  getPluginPath(): string;
  getPluginConfig(): Record<string, boolean>;
  getAllPlugins(): PluginEntry[];
  getLoadedPlugins(): PluginEntry[];
  getPluginInfo(pluginId: string): PluginEntry | undefined;
  setPluginStatus(pluginId: string, enable: boolean): Promise<void>;
  loadPluginById(pluginId: string): Promise<boolean>;
  rescanPlugins(): Promise<number>;
  unregisterPlugin(pluginId: string): Promise<void>;
  uninstallPlugin(pluginId: string, cleanData?: boolean): Promise<void>;
  reloadPlugin(pluginId: string): Promise<boolean>;
  getPluginDataPath(pluginId: string, accountKey?: string | null): string;
  getPluginConfigPath(pluginId: string): string;
}

// ==================== 插件上下文（MKbot 直接使用） ====================

/** 插件日志接口 */
export interface PluginLogger {
  log(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  logDebug?: (...args: unknown[]) => void;
  logWarn?: (...args: unknown[]) => void;
  logError?: (...args: unknown[]) => void;
}

export interface NapCatPluginContext {
  /** 宿主 core 兼容层 - 提供 pathWrapper 等 */
  core: KakakeCoreCompat;
  /** OneBot 上下文兼容层 */
  oneBot: KakakeOneBotCompat;
  actions: { call: ActionCaller };
  pluginName: string;
  pluginPath: string;
  dataPath: string;
  configPath: string;
  NapCatConfig: INapCatConfigStatic;
  adapterName: string;
  /** 当前事件来源的连接 ID（仅事件回调中有值） */
  connectionId?: string;
  pluginManager: IPluginManager;
  logger: PluginLogger;
  router: PluginRouterRegistry;
  getPluginExports: <T = PluginModule>(pluginId: string) => T | undefined;
  /** 可选：框架环境标识，MKbot 用于检测宿主 */
  frameworkEnv?: {
    frameworkId: string;
    frameworkVersion: string;
    projectRoot: string;
    adminHost: string;
    adminPort: number;
    adminAuthRequired?: boolean;
    ob11Mode: string;
    connectionId?: string;
  };
}

/** 最小 core 兼容层 */
export interface KakakeCoreCompat {
  context: {
    pathWrapper: {
      configPath: string;
      pluginPath: string;
      dataPath: string;
    };
  };
}

export interface KakakeOneBotCompat {
  networkManager?: unknown;
}

// ==================== 插件模块接口 ====================

export interface PluginModule {
  plugin_init: (ctx: NapCatPluginContext) => void | Promise<void>;
  plugin_onmessage?: (ctx: NapCatPluginContext, event: Record<string, unknown>) => void | Promise<void>;
  plugin_onevent?: (ctx: NapCatPluginContext, event: Record<string, unknown>) => void | Promise<void>;
  plugin_cleanup?: (ctx: NapCatPluginContext) => void | Promise<void>;
  plugin_config_schema?: PluginConfigSchema;
  plugin_config_ui?: PluginConfigSchema;
  plugin_get_config?: (ctx: NapCatPluginContext) => unknown | Promise<unknown>;
  plugin_set_config?: (ctx: NapCatPluginContext, config: unknown) => void | Promise<void>;
  plugin_config_controller?: (
    ctx: NapCatPluginContext,
    ui: PluginConfigUIController,
    initialConfig: Record<string, unknown>,
  ) => void | (() => void) | Promise<void | (() => void)>;
  plugin_on_config_change?: (
    ctx: NapCatPluginContext,
    ui: PluginConfigUIController,
    key: string,
    value: unknown,
    currentConfig: Record<string, unknown>,
  ) => void | Promise<void>;
  [key: string]: unknown;
}

// ==================== 插件条目 ====================

export type PluginRuntimeStatus = 'loaded' | 'error' | 'unloaded';

export interface PluginRuntime {
  status: PluginRuntimeStatus;
  error?: string;
  module?: PluginModule;
  context?: NapCatPluginContext;
}

export interface PluginEntry {
  id: string;
  fileId: string;
  name?: string;
  version?: string;
  description?: string;
  author?: string;
  pluginPath: string;
  entryPath?: string;
  packageJson?: PluginPackageJson;
  pluginJson?: KakakePluginManifest;
  enable: boolean;
  loaded: boolean;
  runtime: PluginRuntime;
}

export type PluginStatusConfig = Record<string, boolean>;
