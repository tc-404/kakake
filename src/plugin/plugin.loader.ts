import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { Logger } from '../core/logger.js';
import type {
  PluginEntry,
  PluginModule,
  PluginPackageJson,
  PluginStatusConfig,
  KakakePluginManifest,
} from './plugin.types.js';
import { mergePluginMetadata, readPluginManifest } from './plugin-meta.js';
import {
  isKakakePluginDir,
  KAKAKE_BUILTIN_PLUGIN_ID,
  resolveKakakePluginId,
  toKakakePluginDirName,
} from './plugin-id.js';

const require = createRequire(import.meta.url);

/**
 * CJS 兼容层：这个错误是不是「CJS 源码被当成 ESM 求值」导致的。
 *
 * Node 把 `"type": "module"` 作用域里的 `.js` 当 ESM，里面的 `module.exports` /
 * `exports.x` / `require(...)` 会在求值时报 ReferenceError。命中才退回 CommonJS 求值，
 * 这样正常工作的 ESM 插件不会被误伤。
 */
function isCjsSyntaxInEsmError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : '';
  return /\b(?:module|exports|require) is not defined\b/.test(msg);
}

/**
 * CJS 兼容层：这个报错是不是「ESM 那条路撞上 CJS 写法的 `.js`」的症状。
 *
 * 两种表现：包内 `.js` 被当成 ESM 求值时报 `module is not defined`（ReferenceError），
 * 或者 ESM 静态 import 去要一个具名/默认导出、而那个文件被当 ESM 解析时给不出来
 * （链接期的 `does not provide an export named …`）。
 * 只有加载已经失败、且入口确实 import 了这样一个文件时才会用到（见 findCjsFileImportedAsEsm），
 * 因此不会误伤正常插件。
 */
function isCjsInEsmSymptom(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : '';
  return isCjsSyntaxInEsmError(error) || /does not provide an export named/.test(msg);
}

/**
 * CJS 兼容层：已经给过「可照做」提示的错误。
 *
 * 这些提示串里本身就会带上原始报错，而原始报错又常常长得像「CJS 被当成 ESM 求值」，
 * 因此用类型标一下，避免 `describeModuleError` 再包一次。
 */
class PluginLoadHintError extends Error {}

/**
 * CJS 兼容层：「CJS 与 ESM 混装」的统一提示。
 *
 * 入口与包内 `.js` 都已被兼容层接管，会走到这里的只剩这种情况：
 * 入口用 `import` 引了一个 CJS 写法的 `.js`（ESM 那条路不走 CJS 钩子）。
 * 这时改名成 `.cjs` 才能稳定加载。`fileName` 为 null 时退回不点名的通用说法。
 */
function describeCjsInEsm(fileName: string | null, detail?: string): string {
  const where = fileName ? `问题文件：${fileName}。` : '';
  const origin = detail ? `（原始报错：${detail}）` : '';
  return `插件把 CommonJS 写法的 .js 当成 ES module 引了：${where}把这个文件改名成 .cjs 再 import，或改用 require()；也可以在这个插件目录放一个不带 "type": "module" 的 package.json。${origin}`;
}

/** CJS 兼容层：把「CommonJS 源码被当成 ESM 求值」的原始报错，换成能直接照做的提示 */
function describeModuleError(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error ?? '未知错误');
  if (error instanceof PluginLoadHintError) return msg;
  if (!isCjsSyntaxInEsmError(error)) return msg;
  return describeCjsInEsm(null, msg.split('\n')[0]);
}

/** CJS 兼容层：救回一个插件时统一打的那行日志（入口判定、兜底两条路共用） */
const CJS_COMPAT_LOAD_REASON = '用的是 CommonJS 写法，却会被 Node 当成 ESM 解析，已按 CJS 兼容模式加载';

/** 取报错文案的第一行（多行报错里通常就是结论那句），用于拼进给用户看的提示 */
function firstLineOf(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error ?? '未知错误');
  return msg.split('\n')[0];
}

/**
 * CJS 兼容层：这个报错是不是「模块格式」导致的。
 *
 * 用于区分「源码两套写法混装」（格式问题，要改写法）与「CJS 求值时的普通运行错误」
 * （例如 `require('./helper.js')` 文件不存在，报 MODULE_NOT_FOUND）——后者要原样抛出去，
 * 不能被格式提示盖掉。
 */
function isModuleFormatError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : '';
  return isCjsSyntaxInEsmError(error)
    || /Cannot use import statement outside a module/.test(msg)
    || /Cannot use export statement outside a module/.test(msg);
}

/** CJS 兼容层：入口同一个文件里既有 ESM 语法、又只能按 CJS 编译时的提示 */
function describeMixedSyntax(esmError: string, cjsError: string): string {
  return `插件入口把两套写法混在同一个文件里了：既有 import / export，又有 require / module.exports。同一个文件只能选一套——整份用 import / export（ESM 版写法），或整份用 require / module.exports（CJS 版写法）。（被当 ESM 时的报错：${esmError}；被当 CommonJS 时的报错：${cjsError}）`;
}

/** CJS 兼容层：源码里的**静态** import 说明符（`import x from '…'` / `export … from '…'` / `import '…'`） */
function staticImportSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const re = /\b(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(re)) {
    const spec = match[1] ?? match[2];
    // 只看相对路径：裸名字（npm 包）与动态 import()（CJS / ESM 都能用）都不在此列
    if (spec && (spec.startsWith('./') || spec.startsWith('../'))) specs.push(spec);
  }
  return specs;
}

/** CJS 兼容层：Node 内部 `Module` 实例里我们用到的那部分（`_compile` 未公开，但一直是 CJS 的实际编译入口） */
type CjsModule = {
  exports: unknown;
  filename: string | null;
  paths: string[];
  loaded: boolean;
  _compile(source: string, filename: string): void;
};

type JsExtensionHandler = (module: CjsModule, filename: string) => void;

type CjsModuleCtor = {
  new (id: string, parent?: unknown): CjsModule;
  prototype: CjsModule;
  _nodeModulePaths(from: string): string[];
  /** `.js` / `.json` / `.node` 各自的加载方式；我们只接管 `.js` */
  _extensions: Record<string, JsExtensionHandler | undefined>;
};

/**
 * CJS 兼容层：已判定按 CommonJS 求值的插件目录（绝对路径）。
 *
 * 入口自己可以交给 `Module._compile` 求值，但入口里 `require('./helper.js')` 进来的**包内文件**
 * 仍然会被 Node 按「最近一层 package.json」判成 ESM（宿主根是 `"type": "module"`），
 * 报 `exports is not defined in ES module scope`——也就是插件只要拆成多个文件就还是跑不起来。
 * 所以每认定一个 CJS 插件，就把它的目录登记进来，由下面的 `.js` 钩子接管包内文件的编译方式。
 */
const cjsScopeDirs = new Set<string>();

/** CJS 兼容层：`.js` 钩子是否已挂（全局只挂一次，替换的兜底实现也只为这一处服务） */
let cjsJsExtensionHooked = false;

/** ESM 独有语法：`export` / 静态 `import`（`import('…')` 是动态导入，CommonJS 里也合法） */
function hasEsmSyntax(source: string): boolean {
  return /\bexport\b/.test(source) || /\bimport\b(?!\s*\()/.test(source);
}

function isInCjsScope(filename: string): boolean {
  if (cjsScopeDirs.size === 0) return false;
  const abs = path.resolve(filename);
  for (const dir of cjsScopeDirs) {
    if (abs.startsWith(dir + path.sep)) return true;
  }
  return false;
}

/**
 * CJS 兼容层：给 Node 的 `.js` 加载器挂一层钩子，让**已登记插件目录内**的 `.js` 按 CommonJS 编译。
 *
 * 只做加法：目录没登记、文件不在插件包内、或文件自己写着 ESM 语法时，一律原样交回上一层实现，
 * 因此宿主自身、node_modules 依赖、正常 ESM 插件都不受影响。
 * 返回 false 表示当前 Node 的 `_extensions` 不可用，此时静默跳过（入口本身仍能加载）。
 */
function installCjsJsExtensionHook(): boolean {
  if (cjsJsExtensionHooked) return true;
  const ModuleCtor = require('node:module') as CjsModuleCtor;
  const previous = ModuleCtor._extensions?.['.js'];
  if (!ModuleCtor._extensions || typeof previous !== 'function') return false;

  const delegate = previous;
  ModuleCtor._extensions['.js'] = function cjsCompatJsLoader(module: CjsModule, filename: string): void {
    if (!isInCjsScope(filename)) {
      delegate(module, filename);
      return;
    }
    let source: string;
    try {
      source = fs.readFileSync(filename, 'utf-8');
    } catch {
      delegate(module, filename);
      return;
    }
    // 包内这个 .js 自己就是 ESM 写法（CJS 与 ESM 混装）→ 交回 Node 按原规则处理
    if (hasEsmSyntax(source)) {
      delegate(module, filename);
      return;
    }
    module._compile(source, filename);
  };

  cjsJsExtensionHooked = true;
  return true;
}

/** 插件加载器：扫描、验证与动态 import 插件模块 */
export class PluginLoader {
  /** 入口绝对路径 → 最近一次成功 import 的 URL / mtime（用于稳定复用，避免 ?t= 堆积） */
  private readonly loadedMetaByEntry = new Map<string, { url: string; mtimeMs: number }>();

  /**
   * CJS 兼容层：需要按 CommonJS 求值的入口（绝对路径 → 判定时的 mtime）。
   * 带上 mtime 是为了插件改写成 ESM 之后能自动回到正常加载路径。
   */
  private readonly cjsEntriesByEntry = new Map<string, number>();

  constructor(
    private readonly pluginPath: string,
    private readonly statusConfigPath: string,
    private readonly logger: Logger,
    private readonly isAllowedDir: (dirName: string) => boolean = isKakakePluginDir,
  ) {}

  loadPluginStatusConfig(): PluginStatusConfig {
    if (fs.existsSync(this.statusConfigPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.statusConfigPath, 'utf-8')) as PluginStatusConfig;
        return this.migratePluginStatusConfig(raw);
      } catch (e) {
        this.logger.warn('[PluginLoader] 解析 plugins.json 失败', e);
      }
    }
    return {};
  }

  /** 将旧版插件 ID 启停配置迁移为 kakake-plugin-* 命名 */
  private migratePluginStatusConfig(config: PluginStatusConfig): PluginStatusConfig {
    let changed = false;
    const next: PluginStatusConfig = { ...config };

    for (const [key, enabled] of Object.entries(config)) {
      const migrated = toKakakePluginDirName(key);
      if (migrated === key || migrated in next) continue;
      next[migrated] = enabled;
      delete next[key];
      changed = true;
    }

    if (changed) {
      this.savePluginStatusConfig(next);
      this.logger.info('[PluginLoader] 已迁移 plugins.json 中的 NapCat 插件 ID');
    }

    return next;
  }

  savePluginStatusConfig(config: PluginStatusConfig): void {
    const dir = path.dirname(this.statusConfigPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.statusConfigPath, JSON.stringify(config, null, 2), 'utf-8');
  }

  /**
   * 插件总开关：plugins.json / gf-plugins.json
   * - 显式 false → 总关
   * - true 或缺失 → 总开（默认开启，由连接子开关决定是否真正跑）
   */
  isMasterEnabled(pluginId: string, aliases: string[] = []): boolean {
    const config = this.loadPluginStatusConfig();
    if (config[pluginId] === false) return false;
    for (const a of aliases) {
      if (a && config[a] === false) return false;
    }
    return true;
  }

  setMasterEnabled(pluginId: string, enable: boolean): void {
    const config = this.loadPluginStatusConfig();
    config[pluginId] = enable;
    this.savePluginStatusConfig(config);
  }

  /** 卸载插件时从总开关配置里删掉该键 */
  removeMasterStatus(pluginId: string): void {
    const config = this.loadPluginStatusConfig();
    if (!(pluginId in config)) return;
    delete config[pluginId];
    this.savePluginStatusConfig(config);
  }

  async scanPlugins(): Promise<PluginEntry[]> {
    const entries: PluginEntry[] = [];

    if (!fs.existsSync(this.pluginPath)) {
      this.logger.warn(`插件目录不存在: ${this.pluginPath}`);
      fs.mkdirSync(this.pluginPath, { recursive: true });
      return entries;
    }

    const items = fs.readdirSync(this.pluginPath, { withFileTypes: true });
    const statusConfig = this.loadPluginStatusConfig();

    for (const item of items) {
      if (!item.isDirectory()) continue;
      if (!this.isAllowedDir(item.name)) {
        this.logger.debug(`[PluginLoader] 跳过非插件目录: ${item.name}`);
        continue;
      }

      const entry = this.scanDirectoryPlugin(item.name, statusConfig);
      if (!entry?.entryPath) {
        if (entry) this.logger.warn(`跳过 ${item.name}: 无入口文件`);
        continue;
      }

      if (!entry.enable) {
        entries.push(entry);
        continue;
      }

      const validation = await this.validatePluginEntry(entry.entryPath, entry.pluginPath);
      if (!validation.valid) {
        this.logger.warn(`跳过 ${item.name}: ${validation.error}`);
        continue;
      }

      entries.push(entry);
    }

    return entries;
  }

  /** 全量扫描（刷新用）：包含损坏/无效插件，验证失败写入 runtime.error 而非跳过 */
  async scanAllPlugins(): Promise<PluginEntry[]> {
    const entries: PluginEntry[] = [];

    if (!fs.existsSync(this.pluginPath)) {
      this.logger.warn(`插件目录不存在: ${this.pluginPath}`);
      fs.mkdirSync(this.pluginPath, { recursive: true });
      return entries;
    }

    const items = fs.readdirSync(this.pluginPath, { withFileTypes: true });
    const statusConfig = this.loadPluginStatusConfig();

    for (const item of items) {
      if (!item.isDirectory()) continue;
      if (!this.isAllowedDir(item.name)) {
        this.logger.debug(`[PluginLoader] 跳过非插件目录: ${item.name}`);
        continue;
      }

      const entry = this.scanDirectoryPlugin(item.name, statusConfig);
      if (!entry) continue;

      if (!entry.entryPath) {
        this.logger.warn(`[PluginLoader] ${item.name}: ${entry.runtime.error ?? '无入口文件'}`);
        entries.push(entry);
        continue;
      }

      const validation = await this.validatePluginEntry(entry.entryPath, entry.pluginPath);
      if (!validation.valid) {
        entry.runtime = { status: 'error', error: validation.error ?? '插件验证失败' };
        this.logger.warn(`[PluginLoader] ${item.name} 验证失败: ${entry.runtime.error}`);
      } else {
        entry.runtime = { status: 'unloaded' };
      }

      entries.push(entry);
    }

    return entries;
  }

  private scanDirectoryPlugin(dirname: string, statusConfig: PluginStatusConfig): PluginEntry | null {
    const pluginDir = path.join(this.pluginPath, dirname);

    try {
      let packageJson: PluginPackageJson | undefined;
      const packageJsonPath = path.join(pluginDir, 'package.json');

      if (fs.existsSync(packageJsonPath)) {
        try {
          packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
        } catch (error) {
          this.logger.warn(`无效的 package.json: ${dirname}`, error);
        }
      }

      let pluginJson: KakakePluginManifest | undefined = readPluginManifest(pluginDir);

      const manifestId = packageJson?.name || pluginJson?.name;
      const pluginId = this.isAllowedDir(dirname) ? dirname : (manifestId || dirname);
      const entryFile = this.findEntryFile(pluginDir, packageJson, pluginJson);
      const entryPath = entryFile ? path.join(pluginDir, entryFile) : undefined;
      const enable = !(
        statusConfig[pluginId] === false
        || (manifestId ? statusConfig[manifestId] === false : false)
      );

      const meta = mergePluginMetadata(dirname, pluginDir, packageJson, pluginJson);

      const entry: PluginEntry = {
        id: meta.id,
        fileId: dirname,
        name: meta.name,
        version: meta.version,
        description: meta.description,
        author: meta.author,
        pluginPath: pluginDir,
        entryPath,
        packageJson,
        pluginJson,
        enable,
        loaded: false,
        runtime: { status: 'unloaded' },
      };

      if (!entryPath) {
        entry.runtime = { status: 'error', error: `无有效入口: ${dirname}` };
      }

      return entry;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return {
        id: dirname,
        fileId: dirname,
        pluginPath: pluginDir,
        enable: statusConfig[dirname] !== false,
        loaded: false,
        runtime: { status: 'error', error: msg },
      };
    }
  }

  private findEntryFile(
    pluginDir: string,
    packageJson?: PluginPackageJson,
    pluginJson?: KakakePluginManifest,
  ): string | null {
    const candidates = [
      pluginJson?.entry,
      packageJson?.main,
      'index.mjs',
      'index.js',
      'index.cjs',
      'main.mjs',
      'main.js',
      'main.cjs',
    ].filter(Boolean) as string[];
    for (const entry of candidates) {
      const p = path.join(pluginDir, entry);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return entry;
    }
    return null;
  }

  /**
   * 动态加载插件模块（ESM 或 CJS，见 CJS 兼容层说明）。
   * 使用 `?v=<mtimeMs>`（文件内容版本）而非 `?t=Date.now()`，
   * 同一文件未改时复用同一 URL，避免关开插件时 ESM 图线性堆积。
   * Node 仍无法真正驱逐已加载的 ESM；此策略只保证「同版本只占一份」。
   * CommonJS 入口不走 `?v=`，而是走 `require.cache`（见 `evaluateAsCjs`），
   * 因此 `clearCache()` 能真正让 CJS 插件热重载。
   *
   * @param scopeDir 插件包根目录（入口所在的插件夹）。判定为 CJS 时按它登记兼容范围，
   *   让包内 `require('./x.js')` 也按 CommonJS 编译；不传则退回入口所在目录。
   */
  async importModule(filePath: string, scopeDir?: string): Promise<PluginModule> {
    const abs = path.resolve(filePath);
    const mtimeMs = Math.round(fs.statSync(abs).mtimeMs);

    if (this.decideModuleKind(abs, mtimeMs) === 'cjs') {
      return this.normalizeModuleShape(this.evaluateAsCjs(abs, scopeDir)) as PluginModule;
    }

    const prev = this.loadedMetaByEntry.get(abs);
    const href = prev && prev.mtimeMs === mtimeMs
      ? prev.url
      : `${pathToFileURL(abs).href}?v=${mtimeMs}`;
    try {
      const mod = await import(href) as PluginModule;
      this.loadedMetaByEntry.set(abs, { url: href, mtimeMs });
      return this.normalizeModuleShape(mod) as PluginModule;
    } catch (error: unknown) {
      // CJS 兼容层：ESM 那条路撞上「CJS 写法的 .js」时，Node 的报错文案不一定好认
      // （链接期的 `does not provide an export named 'default'` 之类）。
      // 靠文案猜不可靠，这里直接看入口真正 import 进来的是谁，点名说清楚。
      const offender = isCjsInEsmSymptom(error)
        ? this.findCjsFileImportedAsEsm(abs, scopeDir)
        : null;
      if (offender) throw new PluginLoadHintError(describeCjsInEsm(offender, firstLineOf(error)));

      // CJS 兼容层兜底：源码里 CJS 与 ESM 语法混在一起（例如注释里写了 export）时，
      // 上面认不出是 CommonJS，会先按 ESM 试一次；失败再退回 CommonJS 求值。
      if (!isCjsSyntaxInEsmError(error)) throw error;
      let cjsExports: unknown;
      try {
        cjsExports = this.evaluateAsCjs(abs, scopeDir);
      } catch (cjsError: unknown) {
        // CJS 求值也栽在模块格式上 → 同一个文件里两套写法混装，说清楚该怎么改
        if (isModuleFormatError(cjsError)) {
          throw new PluginLoadHintError(describeMixedSyntax(firstLineOf(error), firstLineOf(cjsError)));
        }
        // 普通运行错误（例如 require 的文件不存在）：原样抛出，别被格式提示盖掉
        throw cjsError;
      }
      const normalized = this.normalizeModuleShape(cjsExports);
      if (!this.isValidPluginModule(normalized)) throw new Error('缺少 plugin_init');
      this.cjsEntriesByEntry.set(abs, mtimeMs);
      this.logger.warn(`[PluginLoader] ${path.basename(abs)} ${CJS_COMPAT_LOAD_REASON}`);
      return normalized as PluginModule;
    }
  }

  /**
   * CJS 兼容层：在入口的静态 import 图里，找出那个「会被 Node 当成 ESM 解析、源码却是 CommonJS」的 `.js`。
   *
   * 这类文件没法靠 `import` 稳定加载（见 `describeCjsInEsm`），兼容层也救不了 ESM 那条路。
   * 只在**加载已经失败**、且报错症状对得上时才调用，用来把「哪个文件要改名」说清楚——
   * 正常插件不会走到这里，因此不会误报。
   *
   * 只沿相对路径走，且不越出插件目录；因此 npm 依赖与宿主自身都不在扫描范围内。
   * 返回相对插件目录的展示名（不在目录内时返回文件名）。
   */
  private findCjsFileImportedAsEsm(entryAbs: string, scopeDir?: string): string | null {
    const scopeRoot = path.resolve(scopeDir || path.dirname(entryAbs));
    const inside = (p: string) => p.startsWith(scopeRoot + path.sep);
    const visited = new Set<string>();
    const queue: string[] = [path.resolve(entryAbs)];

    while (queue.length > 0 && visited.size < 64) {
      const current = queue.shift() as string;
      if (visited.has(current)) continue;
      visited.add(current);

      let source: string;
      try {
        source = fs.readFileSync(current, 'utf-8');
      } catch {
        continue;
      }

      for (const spec of staticImportSpecifiers(source)) {
        const target = this.resolveRelativeImport(path.dirname(current), spec);
        if (!target || visited.has(target) || !inside(target)) continue;
        // Node 自己就按 CommonJS 解析这个文件 → ESM 那边也能正常互通，不是问题所在
        if (this.resolveModuleFormat(target) !== 'esm') continue;

        let targetSource: string;
        try {
          targetSource = fs.readFileSync(target, 'utf-8');
        } catch {
          continue;
        }
        if (this.looksLikeCjsSource(targetSource)) {
          const relative = path.relative(scopeRoot, target);
          return relative && !relative.startsWith('..') ? relative : path.basename(target);
        }
        queue.push(target);
      }
    }
    return null;
  }

  /** CJS 兼容层：把相对路径说明符解析成真实文件；按 ESM 习惯补后缀与 `index.*` */
  private resolveRelativeImport(fromDir: string, spec: string): string | null {
    const base = path.resolve(fromDir, spec);
    const candidates = path.extname(base)
      ? [base]
      : [
        `${base}.js`,
        `${base}.mjs`,
        `${base}.cjs`,
        path.join(base, 'index.js'),
        path.join(base, 'index.mjs'),
        path.join(base, 'index.cjs'),
      ];
    for (const candidate of candidates) {
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // 不存在，试下一个
      }
    }
    return null;
  }

  /**
   * CJS 兼容层：这个入口该按 ESM 还是 CommonJS 求值。
   *
   * 1. 上次判定过且文件没改 → 沿用判定；
   * 2. Node 的格式规则本身就判为 CommonJS（`.cjs`，或 `.js` / 无后缀且最近的 package.json 不是 `type: module`）；
   * 3. 扩展名指向 ESM、源码却是明确的 CommonJS → 直接按 CJS 求值，并打一行日志说明是被兼容层救回来的。
   *    第 3 条不能省：先按 ESM 跑一遍再回退，会把顶层代码执行两次，副作用翻倍。
   */
  private decideModuleKind(abs: string, mtimeMs: number): 'esm' | 'cjs' {
    const remembered = this.cjsEntriesByEntry.get(abs);
    if (remembered !== undefined) {
      if (remembered === mtimeMs) return 'cjs';
      // 文件改了：作废旧判定，重新按扩展名 / package.json / 源码判断
      this.cjsEntriesByEntry.delete(abs);
    }
    if (this.resolveModuleFormat(abs) === 'cjs') return 'cjs';
    if (this.looksLikeCjsSource(fs.readFileSync(abs, 'utf-8'))) {
      this.cjsEntriesByEntry.set(abs, mtimeMs);
      this.logger.warn(`[PluginLoader] ${path.basename(abs)} ${CJS_COMPAT_LOAD_REASON}`);
      return 'cjs';
    }
    return 'esm';
  }

  /** 源码看起来是明确的 CommonJS：有 CJS 特征，且没有任何 ESM 语法 */
  private looksLikeCjsSource(source: string): boolean {
    if (!/\bmodule\.exports\b|\bexports\s*\.|\brequire\s*\(/.test(source)) return false;
    return !hasEsmSyntax(source);
  }

  /** Node 的模块格式解析规则：`.mjs` → ESM，`.cjs` → CJS，其余看最近一层 package.json 的 `type` */
  private resolveModuleFormat(abs: string): 'esm' | 'cjs' {
    const ext = path.extname(abs).toLowerCase();
    if (ext === '.mjs') return 'esm';
    if (ext === '.cjs') return 'cjs';
    return this.nearestPackageType(abs) === 'module' ? 'esm' : 'cjs';
  }

  /**
   * 从文件所在目录向上找**最近一层** package.json，读它的 `type`（与 Node 的解析规则一致：
   * 找到那一层就定案，里面没有 `type` 字段即视为 commonjs，不再继续向上找）。
   */
  private nearestPackageType(abs: string): string {
    let dir = path.dirname(abs);
    for (;;) {
      const pkgPath = path.join(dir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        try {
          const raw = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { type?: unknown };
          return typeof raw.type === 'string' ? raw.type : '';
        } catch {
          // package.json 坏了：按默认 CommonJS 处理，真有问题时 Node 自会报错
          return '';
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) return '';
      dir = parent;
    }
  }

  /**
   * CJS 兼容层：用 CommonJS 语义求值一个入口文件。
   *
   * 移植来的老插件大量使用 `require` / `module.exports`，而宿主根目录的 package.json 是
   * `"type": "module"`：插件包若没自带 `type: commonjs` 的 package.json，包内 `.js` 就会被
   * Node 当成 ESM，`module.exports` 那行直接报错、插件根本起不来。
   *
   * 这里走 Node 自己的 CommonJS 编译入口（`Module.prototype._compile`，`_load` 内部用的就是它），
   * 于是 `module` / `require` / `paths` / 相对路径解析 / 顶层 `this` / 动态 `import()` 全都与原生
   * CommonJS 一致；结果写进 `require.cache`，既支持循环依赖，也让 `clearCache()` 能真正卸载。
   *
   * 同时把插件包根目录登记进 CJS 兼容范围，让包内 `require('./helper.js')` 也按 CommonJS 编译
   * （见 `installCjsJsExtensionHook`）——否则多文件的老插件照样起不来。
   *
   * @param scopeDir 插件包根目录；不传则退回入口所在目录
   */
  private evaluateAsCjs(abs: string, scopeDir?: string): unknown {
    const scope = path.resolve(scopeDir || path.dirname(abs));
    if (scope !== path.parse(scope).root && installCjsJsExtensionHook()) {
      cjsScopeDirs.add(scope);
    }

    const cached = require.cache[abs];
    if (cached) return cached.exports;

    const ModuleCtor = require('node:module') as CjsModuleCtor;
    if (typeof ModuleCtor.prototype?._compile !== 'function') {
      throw new Error('当前 Node 不支持 CommonJS 兼容加载（缺少 Module._compile），请把插件入口改成 .mjs');
    }

    const moduleObject = new ModuleCtor(abs);
    moduleObject.filename = abs;
    moduleObject.paths = ModuleCtor._nodeModulePaths(path.dirname(abs));

    // 先入缓存再求值：循环 require 时能拿到同一个实例（loaded 仍是 false，与 Node 行为一致）
    require.cache[abs] = moduleObject as unknown as NodeModule;
    try {
      moduleObject._compile(fs.readFileSync(abs, 'utf-8'), abs);
    } catch (error) {
      delete require.cache[abs];
      throw error;
    }
    moduleObject.loaded = true;
    return moduleObject.exports;
  }

  /**
   * CJS 兼容层：归一化 `import()` / `require` 拿到的模块形态。
   *
   * 有些插件把钩子挂在默认导出上——ESM 的 `export default { plugin_init }`，
   * 或者老式 CJS 的 `module.exports = 运行时拼出来的对象`（Node 靠静态分析
   * cjs-module-lexer 提取具名导出，认不出拼装出来的名字，命名空间里就只剩一个 `default`）。
   * 这两种形态在这里被展平回顶层，钩子照常能被找到。
   */
  private normalizeModuleShape(mod: unknown): unknown {
    const asObject = (v: unknown): Record<string, unknown> | null =>
      v && typeof v === 'object' ? (v as Record<string, unknown>) : null;

    const top = asObject(mod);
    if (!top || typeof top.plugin_init === 'function') return mod;

    const merged: Record<string, unknown> = { ...top };
    let source = asObject(top.default);
    for (let depth = 0; source && depth < 3; depth++) {
      for (const [key, value] of Object.entries(source)) {
        if (!key.startsWith('plugin_') || merged[key] !== undefined) continue;
        merged[key] = value;
      }
      if (typeof merged.plugin_init === 'function') break;
      source = asObject(source.default);
    }

    if (typeof merged.plugin_init !== 'function') return mod;
    this.logger.warn(
      '[PluginLoader] 入口把插件钩子挂在默认导出上，已按兼容模式展平（建议直接导出 plugin_init / plugin_onmessage）',
    );
    return merged;
  }

  async loadPluginModule(entry: PluginEntry): Promise<PluginModule | null> {
    if (!entry.entryPath) {
      entry.runtime = { status: 'error', error: '无入口路径' };
      return null;
    }

    try {
      const module = await this.importModule(entry.entryPath, entry.pluginPath);
      if (!this.isValidPluginModule(module)) {
        entry.runtime = { status: 'error', error: '缺少 plugin_init' };
        return null;
      }
      return module;
    } catch (error: unknown) {
      entry.runtime = { status: 'error', error: describeModuleError(error) };
      return null;
    }
  }

  isValidPluginModule(module: unknown): module is PluginModule {
    return !!module && typeof (module as PluginModule).plugin_init === 'function';
  }

  /**
   * 文本启发式：入口是否像导出了 plugin_init（避免扫描期完整 import）。
   * 返回 `'unknown'` 表示形态不明，交给 import / CJS 求值兜底。
   */
  private looksLikePluginInitExport(source: string): boolean | 'unknown' {
    const s = source;
    if (
      /\bexport\s+(?:async\s+)?function\s+plugin_init\b/.test(s)
      || /\bexport\s*\{[^}]*\bplugin_init\b[^}]*\}/.test(s)
      || /\bexports\.plugin_init\s*=/.test(s)
      || /\bmodule\.exports\s*=\s*\{[^}]*\bplugin_init\b/.test(s)
      || /\bplugin_init\s*:\s*(?:async\s*)?(?:function|\()/.test(s)
    ) {
      return true;
    }
    // CJS 兼容层：有模块语法却没直接出现 plugin_init（钩子在 `require('./x')` 里、
    // 或者 `module.exports` 由运行时拼装）→ 不能凭文本判死，交给真正的加载兜底
    if (/\bmodule\.exports\b|\bexports\s*\.|\bexport\s|\bimport\s|\brequire\s*\(/.test(s)) {
      return 'unknown';
    }
    // 连模块语法都没有，显然不是插件入口
    return false;
  }

  async validatePluginEntry(entryPath: string, scopeDir?: string): Promise<{ valid: boolean; error?: string }> {
    try {
      if (!fs.existsSync(entryPath) || !fs.statSync(entryPath).isFile()) {
        return { valid: false, error: '入口文件不存在' };
      }
      // 启发式：读文件头+尾（打包入口的 export 常在末尾）。整文件未命中才可判定 false；
      // 大文件截断未命中则走 import 兜底，避免误报「缺少 plugin_init」。
      const st = fs.statSync(entryPath);
      const headSize = Math.min(512 * 1024, st.size);
      const tailSize = Math.min(128 * 1024, st.size);
      const fd = fs.openSync(entryPath, 'r');
      try {
        const headBuf = Buffer.alloc(headSize);
        const headN = fs.readSync(fd, headBuf, 0, headSize, 0);
        let text = headBuf.slice(0, headN).toString('utf-8');
        if (st.size > headSize) {
          const tailBuf = Buffer.alloc(tailSize);
          const tailPos = Math.max(0, st.size - tailSize);
          const tailN = fs.readSync(fd, tailBuf, 0, tailSize, tailPos);
          text += `\n${tailBuf.slice(0, tailN).toString('utf-8')}`;
        }
        const look = this.looksLikePluginInitExport(text);
        if (look === true) return { valid: true };
        // 已覆盖整文件且明确没有 → 直接失败；否则交给动态 import
        if (look === false && st.size <= headSize) {
          return { valid: false, error: '缺少 plugin_init' };
        }
      } finally {
        fs.closeSync(fd);
      }

      const module = await this.importModule(entryPath, scopeDir);
      if (this.isValidPluginModule(module)) return { valid: true };
      return { valid: false, error: '缺少 plugin_init' };
    } catch (error: unknown) {
      return { valid: false, error: describeModuleError(error) };
    }
  }

  rescanPlugin(dirname: string): PluginEntry | null {
    return this.scanDirectoryPlugin(dirname, this.loadPluginStatusConfig());
  }

  findPluginDirById(pluginId: string): string | null {
    if (!fs.existsSync(this.pluginPath)) return null;

    const candidates = new Set([
      pluginId,
      resolveKakakePluginId(pluginId),
    ]);

    for (const item of fs.readdirSync(this.pluginPath, { withFileTypes: true })) {
      if (!item.isDirectory() || !this.isAllowedDir(item.name)) continue;
      const pkgPath = path.join(this.pluginPath, item.name, 'package.json');
      if (fs.existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
          if (candidates.has(pkg.name)) return item.name;
        } catch { /* ignore */ }
      }
      const pluginJsonPath = path.join(this.pluginPath, item.name, 'plugin.json');
      if (fs.existsSync(pluginJsonPath)) {
        try {
          const manifest = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf-8')) as KakakePluginManifest;
          if (manifest.name && candidates.has(manifest.name)) return item.name;
        } catch { /* ignore */ }
      }
      if (candidates.has(item.name)) return item.name;
    }
    return null;
  }

  /**
   * 清理插件目录相关缓存。
   * - CJS：删除 require.cache 中落在 pluginPath 下的条目（CJS 入口真正靠这里热重载），
   *   并撤销该目录的 CJS 兼容登记——插件被改写成 ESM 后，包内 `.js` 要回到 Node 原本的判定
   * - ESM：Node 无法驱逐已 import 的模块图；此处仅清除 loadedMetaByEntry，
   *   以便下次按新 mtime 选择 URL（同 mtime 仍复用旧 URL，避免无意义堆积）
   */
  clearCache(pluginPath: string): void {
    try {
      const normalized = path.resolve(pluginPath);
      for (const id of Object.keys(require.cache)) {
        if (id.startsWith(normalized)) delete require.cache[id];
      }
      for (const abs of [...this.loadedMetaByEntry.keys()]) {
        if (abs === normalized || abs.startsWith(normalized + path.sep)) {
          this.loadedMetaByEntry.delete(abs);
        }
      }
      for (const abs of [...this.cjsEntriesByEntry.keys()]) {
        if (abs === normalized || abs.startsWith(normalized + path.sep)) {
          this.cjsEntriesByEntry.delete(abs);
        }
      }
      for (const dir of [...cjsScopeDirs]) {
        if (dir === normalized || dir.startsWith(normalized + path.sep)) {
          cjsScopeDirs.delete(dir);
        }
      }
    } catch (e) {
      this.logger.error('[PluginLoader] 清理缓存失败', e);
    }
  }
}
