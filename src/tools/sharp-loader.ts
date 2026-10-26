import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { PATHS } from '../paths.js';

/**
 * sharp 的按需加载 + 环境探测 + 安装位置约定。
 *
 * ## 装在哪里（与 MKbot 共用同一份）
 * 统一装在 **`<项目>/data/runtime-deps/node_modules/sharp`**：
 * MKbot 插件也是把 sharp 装在 `data/runtime-deps`（它从数据目录
 * `data/<账号>/kakake-plugin-mkbot` 往上两级），所以宿主与插件共享同一个副本，
 * 不会各装一份（几十 MB，含 @img 预编译二进制）。查找顺序：
 *   1. `data/runtime-deps`（共享目录，一键安装的目标）
 *   2. 项目根 `node_modules`（便携包内置的副本 / 手动 npm install 的副本）
 *   3. 以项目根为基准的兜底解析（可能命中被提升到别处的副本）
 * 逐个尝试、谁能真的加载成功就用谁 —— 装了包但缺本平台预编译二进制的那一份会被跳过。
 *
 * ## 为什么不用顶层 `import sharp from 'sharp'`
 * build-server 用 esbuild 以 `--packages=external` 打包，顶层静态 import 会被原样留在
 * packages/server/main.mjs 里，sharp 就从「图片混淆服务端引擎的依赖」变成「整个框架的
 * 启动前提」；而在线更新只替换源码与 package.json（apply-update.mjs 保留 node_modules），
 * 新版新增的依赖不会随更新装上——表现就是 bundle 打包成功、一启动却
 *   Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'sharp'
 * 框架整个起不来。改成按需加载后：缺依赖只有本功能不可用，框架照常启动，
 * 设置页「图片引擎环境」给出一键安装。
 *
 * 成功结果常驻缓存，**失败不缓存**：安装完下一次调用就能直接用上，无需重启框架。
 */

/**
 * sharp 的结构类型。
 *
 * 刻意**不用** `typeof import('sharp')`：sharp 已不再声明在主 package.json 里（源码版按需
 * 装到 data/runtime-deps，便携版打包时才注入），编译期机器上完全可能没有这个包，
 * 那种写法会直接 `TS2307 Cannot find module 'sharp'`。这里只声明本项目真正用到的 API，
 * 既保持类型检查，又与「装在哪、装没装」解耦。
 */
export type SharpInstance = {
  metadata(): Promise<{ width?: number; height?: number }>;
  ensureAlpha(): SharpInstance;
  raw(): SharpInstance;
  toBuffer(
    options: { resolveWithObject: true },
  ): Promise<{ data: Buffer; info: { width: number; height: number } }>;
  toBuffer(): Promise<Buffer>;
  png(options?: { compressionLevel?: number }): SharpInstance;
};

export type SharpFactory = ((
  input: Buffer | Uint8Array,
  options?: {
    failOn?: string;
    raw?: { width: number; height: number; channels: number };
  },
) => SharpInstance) & {
  versions?: { sharp?: string; vips?: string };
};

export type SharpLoadResult =
  | { ok: true; sharp: SharpFactory; version: string; vips: string; from: string }
  | { ok: false; error: string; /** 所有候选位置都没有 sharp 包 */ missing: boolean };

/** 共享依赖目录名（装在 data/ 下，与 MKbot 插件共用） */
export const SHARP_DEPS_DIR_NAME = 'runtime-deps';
/** 一键安装时写入共享目录 package.json 的版本范围（sharp 不在主 package.json 里） */
export const SHARP_DEPENDENCY_RANGE = '^0.35.5';

/** `data/runtime-deps`：npm install 的目标，也是首选加载位置 */
export function sharedSharpDepsDir(): string {
  return path.join(PATHS.data, SHARP_DEPS_DIR_NAME);
}

/** 项目根 node_modules 所在目录（便携包内置副本 / 手动 npm install 的副本） */
export function projectSharpDepsDir(): string {
  return PATHS.root;
}

/** 按优先级排列的候选位置：共享目录 → 项目根 → 由 Node 自行解析（返回 null 表示裸 import） */
export function sharpSearchDirs(): string[] {
  return [sharedSharpDepsDir(), projectSharpDepsDir()];
}

/** 只缓存成功结果；失败立即释放，装好即生效 */
let cached: Promise<SharpLoadResult> | null = null;

function fileExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/** 某个候选目录下有没有安装 sharp 包（不加载原生模块） */
export function hasSharpPackageAt(dir: string): boolean {
  return fileExists(path.join(dir, 'node_modules', 'sharp', 'package.json'));
}

/** 任一候选位置（含裸解析可见的位置）有 sharp 包即可 */
export function hasSharpPackage(): boolean {
  return sharpSearchDirs().some((d) => hasSharpPackageAt(d));
}

/** 读某个目录里 sharp 声明的版本号（不加载原生模块） */
export function installedSharpVersionAt(dir: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(dir, 'node_modules', 'sharp', 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { version?: string };
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

/** 任一处已安装的 sharp 版本（共享目录优先） */
export function installedSharpVersion(): string | null {
  for (const dir of sharpSearchDirs()) {
    const v = installedSharpVersionAt(dir);
    if (v) return v;
  }
  return null;
}

/** 命中 sharp 包的位置（用于界面展示「装在哪」） */
export function installedSharpDir(): string | null {
  for (const dir of sharpSearchDirs()) {
    if (hasSharpPackageAt(dir)) return dir;
  }
  return null;
}

/** 用该目录下的 node_modules 解析 sharp 的入口文件；解析不到返回 null */
function resolveSharpEntry(dir: string): string | null {
  try {
    const req = createRequire(path.join(dir, 'package.json'));
    return req.resolve('sharp');
  } catch {
    return null;
  }
}

/**
 * 真正 import 一次。返回：
 * - `ok`    ：能用（附版本信息）
 * - `error` ：那个位置有包但加载失败（典型是缺本平台预编译二进制，例如 Windows 上装的
 *             node_modules 被整体拷到 Linux）——所以「包在不在」不能当作「能用」，必须实测
 * - `absent`：那个位置没有包 / 解析不到入口
 */
type LoadAttempt =
  | { kind: 'ok'; result: Extract<SharpLoadResult, { ok: true }> }
  | { kind: 'error'; message: string }
  | { kind: 'absent' };

/** 模块名（写成常量，方便将来换实现/加别名） */
const SHARP_MODULE_NAME = 'sharp';

/**
 * 用 CJS `require` 加载，而不是 ESM `import()`。
 *
 * 关键原因：**ESM 的模块作业会被缓存，失败也不例外**。用 `import()` 时，只要有一次在
 * 「sharp 装了一半（比如 detect-libc 还没落地）」或「依赖不完整」的状态下加载失败，
 * 之后即使装好了，同一个 file URL 仍然直接返回那次缓存的失败，表现为
 * 「点了重新安装还是不可用，非得重启框架」。
 * CJS 的 require 在模块抛错时会把该模块从缓存里摘掉，所以再加载一次就是真加载，
 * 装好即生效（这也正是本功能承诺的「装完无需重启」）。
 */
function requireSharpFrom(dir: string | null): unknown {
  // dir 为 null 时以项目根为解析基准，等价于让 Node 沿 node_modules 链自己找
  const req = createRequire(path.join(dir ?? PATHS.root, 'package.json'));
  return req(SHARP_MODULE_NAME);
}

async function tryLoadFrom(dir: string | null): Promise<LoadAttempt> {
  try {
    // 先确认入口能解析出来（共享目录里可能只剩个空壳），再真正加载
    if (dir && !resolveSharpEntry(dir)) return { kind: 'absent' };
    const factory = requireSharpFrom(dir);
    if (typeof factory !== 'function') {
      return { kind: 'error', message: 'sharp 入口不是可调用的模块导出' };
    }
    // 版本号挂在导出对象上：sharp 的 ESM 入口只有 `export default Sharp`，
    // 类型声明里的具名 `versions` 在运行时并不存在（实测 m.versions === undefined）。
    const versions = (factory as { versions?: { sharp?: string; vips?: string } }).versions;
    return {
      kind: 'ok',
      result: {
        ok: true,
        sharp: factory as SharpFactory,
        version: versions?.sharp || (dir ? installedSharpVersionAt(dir) : null) || '未知',
        vips: versions?.vips || '未知',
        from: dir ?? 'node 解析',
      },
    };
  } catch (err) {
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

async function attempt(): Promise<SharpLoadResult> {
  let lastError = '';
  for (const dir of sharpSearchDirs()) {
    if (!hasSharpPackageAt(dir)) continue;
    const r = await tryLoadFrom(dir);
    if (r.kind === 'ok') return r.result;
    if (r.kind === 'error') lastError = r.message;
  }
  // 兜底：让 Node 自己解析（可能命中被提升到别处的副本）
  const bare = await tryLoadFrom(null);
  if (bare.kind === 'ok') return bare.result;
  if (bare.kind === 'error' && !lastError) lastError = bare.message;

  return {
    ok: false,
    error: lastError || '未找到可用的 sharp 包',
    missing: !hasSharpPackage(),
  };
}

/** 探测结果（带缓存）。失败不缓存，便于「装完即用」。 */
export function probeSharp(): Promise<SharpLoadResult> {
  if (!cached) {
    cached = attempt().then((res) => {
      if (!res.ok) cached = null;
      return res;
    });
  }
  return cached;
}

/** 安装 / 卸载 / 重装之后调用：让下一次探测重新加载 */
export function resetSharpCache(): void {
  cached = null;
}

/** 面向用户的一句话失败原因（界面直接展示这条） */
export function sharpUnavailableMessage(res: Extract<SharpLoadResult, { ok: false }>): string {
  return res.missing
    ? '服务端图片引擎缺少依赖 sharp。请在「设置 → 图片引擎环境」点击安装。'
    : '服务端图片引擎的 sharp 无法加载（当前平台可能没有对应的预编译包，或依赖不完整）。'
      + '请在「设置 → 图片引擎环境」重新安装。';
}

/** 供图片混淆引擎调用：拿到可用的 sharp，否则抛出可直接展示的错误 */
export async function requireSharp(): Promise<SharpFactory> {
  const res = await probeSharp();
  if (res.ok) return res.sharp;
  throw new Error(`${sharpUnavailableMessage(res)}（${res.error}）`);
}
