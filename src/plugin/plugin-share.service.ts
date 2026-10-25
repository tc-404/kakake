import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { c as tarCreate } from 'tar';
import { PATHS } from '../paths.js';
import { configService } from '../core/config.service.js';
import { rootLogger } from '../core/logger.js';
import { pluginAccountService } from './plugin-account.service.js';
import { extractArchive } from './archive.js';

/**
 * 插件分享：把插件本体（可选携带账号数据）打包成单个 zip，
 * 传到免注册的临时文件存储点，拿到公开下载链接；另一端凭链接下载并自动识别安装。
 *
 * 分享包结构（外层 zip）：
 *   plugin.zip   —— 插件本体（plugins/<id> 的目录内容打包，与「上传安装」的 zip 形态一致）
 *   data.zip     —— 可选；目录结构为 <账号Key>/<插件Id>/...，与 data/ 的账号隔离布局一致
 *   share.json   —— 清单：{ format, pluginId, name, version, kind, mode, hasData, accounts }
 *
 * 只收录有官方公开 API 的存储点；非官方接口（奶牛快传 / AirPortal 等）一律不接，
 * 无契约的接口随时会改，挂进功能里就是埋雷。
 */

const UPLOAD_TIMEOUT_MS = 300_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
/** 上传体积硬上限：插件本体 + 数据远用不到这么大，超过直接拒绝 */
export const SHARE_UPLOAD_MAX_BYTES = 200 * 1024 * 1024;
/** 下载体积上限：同上 */
const SHARE_DOWNLOAD_MAX_BYTES = 300 * 1024 * 1024;
const UA = 'kakake-plugin-share/1.0';

export type ShareProviderId = 'litterbox' | 'uguu' | 'tmpfiles';

export interface ShareProvider {
  id: ShareProviderId;
  name: string;
  host: string;
  maxBytesLabel: string;
  /** 双语文案：前端按当前语言取 */
  retention: { zh: string; en: string };
  maxBytes: number;
  /** 上传容器：zip（默认）或 targz。Uguu 的扩展名白名单单独拉黑了 zip，但放行 tar.gz */
  container?: 'zip' | 'targz';
  /**
   * 卡片上的补充说明（双语）：如实标注 2026-10-26 两轮实测状态
   * （境内直连 + 代理/海外环境各一轮）。
   */
  note?: { zh: string; en: string };
}

/**
 * 只收录实测通过的源。2026-10-26 两轮实测（境内直连 + 代理环境）后清理：
 * Catbox / BashUpload 两轮均不通，0x0.st 官方停用上传（503），File.io 匿名 API 已下线，全部移除。
 * 只收录有官方公开 API 的存储点；非官方接口（奶牛快传 / AirPortal 等）一律不接。
 */
export const SHARE_PROVIDERS: ShareProvider[] = [
  {
    id: 'litterbox',
    name: 'Litterbox',
    host: 'litterbox.catbox.moe',
    maxBytesLabel: '1 GB',
    retention: { zh: '72 小时', en: '72 hours' },
    maxBytes: 1024 * 1024 * 1024,
    note: {
      zh: '境内直连实测可用；个别代理出口 IP 可能被对端拒绝',
      en: 'Verified working on mainland direct connections; some proxy exit IPs may be rejected',
    },
  },
  {
    id: 'uguu',
    name: 'Uguu',
    host: 'uguu.se',
    maxBytesLabel: '128 MB',
    retention: { zh: '3 小时', en: '3 hours' },
    maxBytes: 128 * 1024 * 1024,
    container: 'targz',
  },
  {
    id: 'tmpfiles',
    name: 'TmpFiles',
    host: 'tmpfiles.org',
    maxBytesLabel: '100 MB',
    retention: { zh: '1 小时', en: '1 hour' },
    maxBytes: 100 * 1024 * 1024,
    note: {
      zh: '境内直连无法访问（实测被阻断），代理 / 海外环境实测可用',
      en: 'Blocked on mainland direct connections; verified working via proxy/overseas',
    },
  },
];

export interface ShareAccountInfo {
  key: string;
  label: string;
}

export interface SharePackageResult {
  ok: boolean;
  url?: string;
  provider?: ShareProviderId;
  size?: number;
  message: string;
}

/* ─────────────────────────── 账号清单 ─────────────────────────── */

/** 枚举「用过这个插件」的账号：以 data/<账号>/<插件Id> 的存在为痕迹 */
export function listShareAccounts(pluginId: string): {
  accounts: ShareAccountInfo[];
  single: boolean;
  hasAny: boolean;
} {
  const id = String(pluginId || '').trim();
  const seen = new Map<string, string>();
  if (id) {
    for (const conn of configService.getConnections().connections) {
      const key = pluginAccountService.resolveAccountKey(conn);
      if (!key || seen.has(key)) continue;
      seen.set(key, conn.name ? `${conn.name}（${key}）` : key);
    }
  }
  const accounts: ShareAccountInfo[] = [];
  for (const [key, label] of seen) {
    if (hasDataDir(key, id)) accounts.push({ key, label });
  }
  // 未绑定账号时期写入的数据（data/tmp/<插件Id>）也算一份痕迹
  if (id && hasDataDir('tmp', id)) {
    accounts.push({ key: 'tmp', label: '未绑定账号（临时数据）' });
  }
  return { accounts, single: accounts.length === 1, hasAny: accounts.length > 0 };
}

function hasDataDir(accountKey: string, pluginId: string): boolean {
  const dir = path.join(PATHS.data, accountKey, pluginId);
  return fs.existsSync(dir) && fs.statSync(dir).isDirectory();
}

/* ─────────────────────────── 打包上传 ─────────────────────────── */

interface ShareMeta {
  pluginId: string;
  name: string;
  version?: string;
  kind: string;
}

/**
 * 打包并上传：外层 zip = plugin.zip + data.zip（可选）+ share.json。
 * staging 全部放在 data/tmp 里，用完即删，任何一步失败都不留垃圾。
 */
export async function buildAndUploadSharePackage(opts: {
  pluginPath: string;
  meta: ShareMeta;
  providerId: ShareProviderId;
  mode: 'plugin' | 'plugin_data';
  accounts: string[];
}): Promise<SharePackageResult> {
  const provider = SHARE_PROVIDERS.find((p) => p.id === opts.providerId);
  if (!provider) return { ok: false, message: '未知的上传源' };
  const container = provider.container ?? 'zip';

  const stamp = Date.now().toString(36);
  const workDir = path.join(PATHS.tmp, `share-${stamp}`);
  const outZipPath = path.join(PATHS.tmp, `share-${stamp}${container === 'targz' ? '.tar.gz' : '.zip'}`);
  const pluginZipPath = path.join(workDir, 'plugin.zip');
  const dataZipPath = path.join(workDir, 'data.zip');

  try {
    fs.mkdirSync(workDir, { recursive: true });

    // 1. 插件本体：目录内容打到 zip 根（与上传安装的包形态一致，导入端不用特判）
    const pluginZip = new AdmZip();
    pluginZip.addLocalFolder(opts.pluginPath);
    pluginZip.writeZip(pluginZipPath);

    // 2. 数据包（可选）：<账号Key>/<插件Id>/...，还原时按顶层目录对号入座
    const wantedAccounts = opts.mode === 'plugin_data'
      ? (opts.accounts || []).filter((k) => k && hasDataDir(k, opts.meta.pluginId))
      : [];
    const hasData = wantedAccounts.length > 0;
    if (opts.mode === 'plugin_data' && !hasData) {
      return { ok: false, message: '选了「插件+数据」，但所选账号下没有该插件的数据目录' };
    }
    if (hasData) {
      const dataZip = new AdmZip();
      for (const key of wantedAccounts) {
        // 包内必须保留 <账号>/<插件Id>/ 两级结构：
        // 源数据在 data/<账号>/<插件Id>/，还原时按顶层账号目录对拷回 data/，
        // 丢了插件层文件就会落到 data/<账号>/ 根下，插件自己找不到
        dataZip.addLocalFolder(
          path.join(PATHS.data, key, opts.meta.pluginId),
          `${key}/${opts.meta.pluginId}`,
        );
      }
      dataZip.writeZip(dataZipPath);
    }

    // 3. 外层容器：share.json 一并写进 staging，zip 走 AdmZip，tar.gz 走 tar
    const shareInfo = {
      format: 1,
      pluginId: opts.meta.pluginId,
      name: opts.meta.name,
      version: opts.meta.version ?? '',
      kind: opts.meta.kind,
      mode: opts.mode,
      hasData,
      accounts: wantedAccounts,
      sharedAt: new Date().toISOString(),
    };
    fs.writeFileSync(
      path.join(workDir, 'share.json'),
      JSON.stringify(shareInfo, null, 2),
      'utf8',
    );
    if (container === 'targz') {
      await tarCreate({ gzip: true, file: outZipPath, cwd: workDir }, [
        'plugin.zip',
        ...(hasData ? ['data.zip'] : []),
        'share.json',
      ]);
    } else {
      const outer = new AdmZip();
      outer.addLocalFile(pluginZipPath);
      if (hasData) outer.addLocalFile(dataZipPath);
      outer.addFile('share.json', Buffer.from(JSON.stringify(shareInfo, null, 2), 'utf8'));
      outer.writeZip(outZipPath);
    }

    const size = fs.statSync(outZipPath).size;
    if (size > Math.min(provider.maxBytes, SHARE_UPLOAD_MAX_BYTES)) {
      return { ok: false, message: `打包后 ${(size / 1024 / 1024).toFixed(1)} MB，超出 ${provider.name} 的上限（${provider.maxBytesLabel}）` };
    }

    // 4. 上传
    // 上传文件名的扩展名必须跟随容器——Uguu 等按 multipart 文件名扩展名做类型判定
    const url = await uploadToProvider(
      provider,
      outZipPath,
      `${opts.meta.pluginId}-share${container === 'targz' ? '.tar.gz' : '.zip'}`,
    );
    rootLogger.info(`[插件分享] ${opts.meta.pluginId} → ${provider.name}: ${url}`);
    return { ok: true, url, provider: provider.id, size, message: 'ok' };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    rootLogger.warn(`[插件分享] 上传失败（${provider.name}）: ${msg}`);
    return { ok: false, provider: provider.id, message: `上传失败：${msg}` };
  } finally {
    for (const p of [workDir, outZipPath]) {
      if (fs.existsSync(p)) {
        try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
  }
}

async function uploadToProvider(provider: ShareProvider, filePath: string, fileName: string): Promise<string> {
  const buf = await fs.promises.readFile(filePath);
  // MIME 必须与实际容器一致：Uguu 按声明的 Content-Type 校验类型，
  // tar.gz 配 application/zip 会被 415「Filetype not allowed」拒掉
  const mime = provider.container === 'targz' ? 'application/gzip' : 'application/zip';
  const blob = new Blob([buf], { type: mime });
  const signal = AbortSignal.timeout(UPLOAD_TIMEOUT_MS);

  const fd = new FormData();
  switch (provider.id) {
    case 'uguu':
      // 注意字段名是 files[]（带方括号），响应为 { success, files: [{ url }] }
      fd.append('files[]', blob, fileName);
      return await postJsonLink('https://uguu.se/upload?output=json', fd, signal, (j) => {
        if (!j.success) throw new Error('uguu 拒绝了上传');
        const files = (Array.isArray(j.files) ? j.files : []) as Array<Record<string, unknown>>;
        const u = String(files[0]?.url || '');
        if (!u || !/^https:\/\//.test(u)) throw new Error('uguu 响应里没有有效的下载链接');
        return u;
      });
    case 'tmpfiles': {
      fd.append('file', blob, fileName);
      const viewer = await postJsonLink('https://tmpfiles.org/api/v1/upload', fd, signal, (j) => {
        const data = (j.data && typeof j.data === 'object' ? j.data : {}) as Record<string, unknown>;
        const u = String(data.url || '');
        if (!u) throw new Error('tmpfiles.org 响应里没有链接');
        return u;
      });
      return await resolveTmpfilesDirectLink(viewer, signal);
    }
    case 'litterbox':
      fd.append('reqtype', 'fileupload');
      fd.append('time', '72h');
      fd.append('fileToUpload', blob, fileName);
      return await postTextLink('https://litterbox.catbox.moe/resources/internals/api.php', fd, signal);
    default:
      throw new Error('未知的上传源');
  }
}

async function postJsonLink(
  url: string,
  fd: FormData,
  signal: AbortSignal,
  pick: (j: Record<string, unknown>) => string,
): Promise<string> {
  const res = await fetch(url, { method: 'POST', body: fd, headers: { 'User-Agent': UA }, signal });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`响应不是 JSON：${text.slice(0, 120)}`);
  }
  const link = pick(j);
  if (!link || !/^https:\/\//.test(link)) throw new Error('响应里没有有效的下载链接');
  return link;
}

async function postTextLink(url: string, fd: FormData, signal: AbortSignal): Promise<string> {
  const res = await fetch(url, { method: 'POST', body: fd, headers: { 'User-Agent': UA }, signal });
  const text = (await res.text()).trim();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  if (!/^https:\/\//.test(text)) throw new Error(`响应不是链接：${text.slice(0, 120)}`);
  return text.split(/\s+/)[0]!;
}

const UA_BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

/**
 * tmpfiles.org 改版后直链带签名 token（/dl/<token>/<id>/<名>），
 * 老式 /dl/<id>/<名> 只会 302 回查看页。token 藏在查看页的 href 里，
 * 抓一次页面提取出来；页面抓不到就退回老式转换（部分部署仍可用）。
 */
async function resolveTmpfilesDirectLink(viewerUrl: string, signal: AbortSignal): Promise<string> {
  const fallback = viewerUrl.replace('tmpfiles.org/', 'tmpfiles.org/dl/');
  try {
    const res = await fetch(viewerUrl, { headers: { 'User-Agent': UA_BROWSER }, signal });
    if (res.ok) {
      const html = await res.text();
      const m = /href="(https:\/\/tmpfiles\.org\/dl\/[^"]+)"/.exec(html);
      if (m) return m[1]!;
    }
  } catch { /* 抓不到就用兜底 */ }
  return fallback;
}

/* ─────────────────────────── 下载导入 ─────────────────────────── */

export interface DownloadedShare {
  /** 是否为「插件+数据」分享包（含 share.json）；否则按普通插件 zip 处理 */
  isShare: boolean;
  shareInfo?: {
    pluginId: string;
    name: string;
    version?: string;
    kind?: string;
    hasData: boolean;
    accounts: string[];
  };
  /** 交给 importFromZip 的插件包路径（分享包时是内层 plugin.zip） */
  pluginZipPath: string;
  /** 下载的原始压缩包（importFromZip 会把它删掉） */
  extractedDir: string;
  downloadedPath: string;
}

/** 从用户粘贴的文本里取第一个 http(s) 链接 */
export function extractFirstUrl(text: string): string | null {
  const m = /https?:\/\/[^\s"'<>)\]]+/i.exec(String(text || ''));
  return m ? m[0] : null;
}

/**
 * SSRF 防护：链接导入会让后端发起请求，必须把目标限定在公网 http(s)。
 * 拒绝回环 / 内网 / 链路本地 / 本地域名——否则一条「帮我装这个链接」的社工
 * 就能让服务器去抓内网服务。
 *
 * 残余风险（已知并接受）：DNS rebinding（域名解析到内网 IP）此处拦不住，
 * 需要自定义 DNS 解析与连接钉扎才能根治；本端点仅登录用户可调，风险可接受。
 */
export function assertPublicHttpUrl(rawUrl: string): URL {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error('链接格式无效');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('只支持 http(s) 链接');
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) throw new Error('链接缺少主机名');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('不允许指向内网地址的链接');
  }
  if (isPrivateIpLiteral(host)) {
    throw new Error('不允许指向内网地址的链接');
  }
  return u;
}

function isPrivateIpLiteral(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (host.includes(':')) {
    const h = host.toLowerCase();
    if (h === '::' || h === '::1') return true;
    if (/^f[cd]/.test(h)) return true;      // fc00::/7 唯一本地地址
    if (/^fe[89ab]/.test(h)) return true;   // fe80::/10 链路本地
    // IPv4 映射形态 ::ffff:10.0.0.1 也要拦
    const v4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
    if (v4) return isPrivateIpLiteral(v4[1]!);
  }
  return false;
}

/**
 * 下载 + 解压 + 识别。插件本体的导入与注册由控制器做（要用 kakakeApp），
 * 这里只负责把包拿到手、认出是不是分享包。
 */
export async function downloadSharePackage(text: string): Promise<DownloadedShare> {
  const raw = extractFirstUrl(text);
  if (!raw) throw new Error('没有识别到链接：请粘贴分享链接或插件包的直链');
  const url = assertPublicHttpUrl(raw);

  const stamp = Date.now().toString(36);
  const extractedDir = path.join(PATHS.tmp, `share-ex-${stamp}`);

  // 下载（带体积上限：超限直接拒绝，不把内存吃穿）
  const res = await fetch(url, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    redirect: 'follow',
  });
  // 重定向的最终落点也要过一遍内网检查，防止「公网链接 302 到内网」绕过
  if (res.url && res.url !== url.toString()) assertPublicHttpUrl(res.url);
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length') || '0');
  if (len > SHARE_DOWNLOAD_MAX_BYTES) throw new Error(`文件过大（${(len / 1024 / 1024).toFixed(1)} MB），超出分享导入上限`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > SHARE_DOWNLOAD_MAX_BYTES) throw new Error('文件过大，超出分享导入上限');
  if (!buf.length) throw new Error('下载到的文件是空的');

  // 扩展名跟随魔数：gzip 家族必须落成 .tar.gz（detectArchiveType 靠扩展名区分
  // targz 与普通 gz），否则下载一个 .tar.gz 插件包会被当成单文件 gz 解错
  const isGzip = buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
  const downloadedPath = path.join(PATHS.tmp, `share-dl-${stamp}${isGzip ? '.tar.gz' : '.zip'}`);
  fs.writeFileSync(downloadedPath, buf);

  try {
    fs.mkdirSync(extractedDir, { recursive: true });
    await extractArchive(downloadedPath, extractedDir);
  } catch (e) {
    cleanup(extractedDir);
    try { fs.unlinkSync(downloadedPath); } catch { /* ignore */ }
    throw e instanceof Error ? e : new Error(String(e));
  }

  // 识别分享包：share.json 在根目录或单层子目录里
  const info = readShareInfo(extractedDir);
  if (info) {
    const pluginZip = path.join(info.dir, 'plugin.zip');
    if (!fs.existsSync(pluginZip)) {
      cleanup(extractedDir);
      try { fs.unlinkSync(downloadedPath); } catch { /* ignore */ }
      throw new Error('分享包缺 plugin.zip，结构无效');
    }
    return {
      isShare: true,
      shareInfo: {
        pluginId: String(info.json.pluginId || ''),
        name: String(info.json.name || info.json.pluginId || ''),
        version: info.json.version ? String(info.json.version) : undefined,
        kind: info.json.kind ? String(info.json.kind) : undefined,
        hasData: info.json.hasData === true && fs.existsSync(path.join(info.dir, 'data.zip')),
        accounts: Array.isArray(info.json.accounts) ? info.json.accounts.map(String) : [],
      },
      pluginZipPath: pluginZip,
      extractedDir,
      downloadedPath,
    };
  }

  // 普通插件 zip：直接交给 importFromZip
  return { isShare: false, pluginZipPath: downloadedPath, extractedDir, downloadedPath };
}

function readShareInfo(extractedDir: string): { dir: string; json: Record<string, unknown> } | null {
  for (const dir of [extractedDir, firstSubDir(extractedDir)]) {
    if (!dir) continue;
    const p = path.join(dir, 'share.json');
    if (!fs.existsSync(p)) continue;
    try {
      const json = JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>;
      if (json && json.format === 1 && json.pluginId) return { dir, json };
    } catch { /* ignore */ }
  }
  return null;
}

function firstSubDir(dir: string): string | null {
  try {
    const sub = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
    return sub.length === 1 ? path.join(dir, sub[0]!.name) : null;
  } catch {
    return null;
  }
}

/* ─────────────────────────── 数据暂存与还原 ─────────────────────────── */

const STAGING_ROOT = path.join(PATHS.tmp, 'share-import');
const STAGING_TTL_MS = 2 * 60 * 60 * 1000;

/** 把分享包里的 data.zip 暂存起来，返回 token；导入端确认后再真正落盘 */
export function stageDataZip(extractedDir: string, dataZipRelDir: string): string {
  const src = path.join(extractedDir, dataZipRelDir, 'data.zip');
  if (!fs.existsSync(src)) throw new Error('分享包里没有 data.zip');
  const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const dir = path.join(STAGING_ROOT, token);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(src, path.join(dir, 'data.zip'));
  pruneStaging();
  return token;
}

/** 确认后落盘：data.zip 的顶层目录是账号 Key，逐个还原到 data/<账号>/ 下 */
export async function restoreStagedData(token: string): Promise<{ restored: string[]; failed: string[] }> {
  const safe = String(token || '').replace(/[^a-zA-Z0-9]/g, '');
  const zipPath = path.join(STAGING_ROOT, safe, 'data.zip');
  if (!safe || !fs.existsSync(zipPath)) throw new Error('暂存的数据不存在或已过期，请重新导入');

  // 白名单：只允许还原进「本机连接对应的账号目录」或 tmp。
  // 分享包是别人构造的，顶层目录名不可信任——放行任意目录等于允许
  // 覆盖 data/skills、data/appearance 等框架自有目录（skills 注入尤其危险）。
  const allowed = new Set<string>(['tmp']);
  for (const conn of configService.getConnections().connections) {
    const key = pluginAccountService.resolveAccountKey(conn);
    if (key) allowed.add(key);
  }

  const workDir = path.join(PATHS.tmp, `share-restore-${Date.now().toString(36)}`);
  const restored: string[] = [];
  const failed: string[] = [];
  try {
    fs.mkdirSync(workDir, { recursive: true });
    extractArchive(zipPath, workDir);
    for (const ent of fs.readdirSync(workDir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      // 防御性检查：正常解压不该出现这些，但白名单之外一律不落盘
      if (ent.name.startsWith('.') || ent.name.includes('/') || ent.name.includes('\\')) continue;
      if (!allowed.has(ent.name)) {
        rootLogger.warn(`[插件分享] 数据包里的目录「${ent.name}」不在本机账号白名单内，已跳过还原`);
        continue;
      }
      // 逐文件合并复制而不是整目录 cpSync：目标账号目录常被运行中的框架进程
      // 占用，整目录操作会整批 EIO/EPERM；逐文件 + 重试能把能还原的都还原掉
      const copied = await copyTreeInto(path.join(workDir, ent.name), path.join(PATHS.data, ent.name));
      if (copied.failed.length) {
        failed.push(...copied.failed.map((f) => `${ent.name}/${f}`));
        rootLogger.warn(`[插件分享] 账号 ${ent.name} 有 ${copied.failed.length} 个文件还原失败（可能被进程占用）`);
      }
      if (copied.count > 0) restored.push(ent.name);
    }
    rootLogger.info(`[插件分享] 数据还原完成：${restored.join(', ')}${failed.length ? `（${failed.length} 个文件失败）` : ''}`);
  } finally {
    cleanup(workDir);
    cleanup(path.join(STAGING_ROOT, safe));
  }
  return { restored, failed };
}

/** 把 srcDir 的内容合并进 destDir（逐文件 + 失败重试），返回成功/失败清单 */
async function copyTreeInto(
  srcDir: string,
  destDir: string,
): Promise<{ count: number; failed: string[] }> {
  let count = 0;
  const failed: string[] = [];
  for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, ent.name);
    const dest = path.join(destDir, ent.name);
    if (ent.isDirectory()) {
      fs.mkdirSync(dest, { recursive: true });
      const sub = await copyTreeInto(src, dest);
      count += sub.count;
      failed.push(...sub.failed.map((f) => `${ent.name}/${f}`));
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    let done = false;
    for (let attempt = 0; attempt < 6 && !done; attempt++) {
      try {
        fs.copyFileSync(src, dest);
        done = true;
        count += 1;
      } catch (e) {
        const code = e && typeof e === 'object' && 'code' in e ? String((e as { code?: string }).code) : '';
        if (attempt === 5 || !['EPERM', 'EACCES', 'EBUSY', 'EIO'].includes(code)) {
          failed.push(ent.name);
          rootLogger.warn(`[插件分享] 文件还原失败 ${dest}: ${e instanceof Error ? e.message : e}`);
        } else {
          await new Promise<void>((r) => setTimeout(r, 120 * (attempt + 1)));
        }
      }
    }
  }
  return { count, failed };
}

/** 清掉超过 2 小时没人认领的暂存数据 */
function pruneStaging(): void {
  if (!fs.existsSync(STAGING_ROOT)) return;
  const now = Date.now();
  for (const ent of fs.readdirSync(STAGING_ROOT, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const dir = path.join(STAGING_ROOT, ent.name);
    try {
      if (now - fs.statSync(dir).mtimeMs > STAGING_TTL_MS) cleanup(dir);
    } catch { /* ignore */ }
  }
}

function cleanup(dir: string): void {
  if (dir && fs.existsSync(dir)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
