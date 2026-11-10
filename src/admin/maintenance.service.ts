import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../paths.js';
import { kakakeApp } from '../kakake-app.js';
import { getFrameworkVersion } from './agreement.service.js';

/**
 * 维护与重启：清理缓存（临时文件等）+ 全方面自检 + 交由启动器重启。
 *
 * 清理红线（绝不触碰，写死在这里而不是靠调用方传参）：
 *   data/connections.json、data/appearance*.json、data/plugins.json、data/kz-plugins.json、
 *   data/<账号>/**、plugins/、plugins_two/、log/、各插件数据目录——这些是用户数据与配置。
 * 可清理的只有真正的缓存与临时产物：
 *   data/tmp/**（运行期临时文件）、dist/.cache/**（打包机缓存的 Node 运行时与生产依赖，存在才清）。
 * 服务端进程内的内存缓存不需要单独清：重启本身就会让新进程从零开始。
 */

export interface MaintenanceCheck {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface MaintenanceReport {
  at: number;
  version: string;
  ok: boolean;
  checks: MaintenanceCheck[];
}

const REPORT_FILE = path.join(PATHS.data, 'maintenance-last-report.json');
const PROBE_FILE = path.join(PATHS.data, 'maintenance-probe.tmp');

/** 递归删除目录内容（保留目录本身）；目录不存在返回 0 */
function cleanDirContents(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    try {
      fs.rmSync(p, { recursive: true, force: true });
      n++;
    } catch {
      /* 单个删不掉就跳过，不影响整体 */
    }
  }
  return n;
}

/** 探针：data/ 必须可写 */
function checkDiskWritable(): MaintenanceCheck {
  try {
    fs.writeFileSync(PROBE_FILE, String(Date.now()), 'utf8');
    fs.rmSync(PROBE_FILE, { force: true });
    return { key: 'disk', label: '数据目录可写', ok: true, detail: PATHS.data };
  } catch (e) {
    return { key: 'disk', label: '数据目录可写', ok: false, detail: String((e as Error).message || e) };
  }
}

/** 配置与外观 JSON 必须能正常解析（损坏会导致启动后功能异常） */
function checkJsonReadable(): MaintenanceCheck {
  const files: [string, string][] = [
    ['connections', path.join(PATHS.data, 'connections.json')],
    ['appearance', PATHS.appearance],
  ];
  for (const [name, file] of files) {
    try {
      if (fs.existsSync(file)) JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      return { key: 'config', label: '配置文件解析', ok: false, detail: `${name}: ${(e as Error).message}` };
    }
  }
  return { key: 'config', label: '配置文件解析', ok: true, detail: 'connections / appearance 均可解析' };
}

/** Web 入口完整：index.html 存在（重启后浏览器才能拿到新入口） */
function checkWebDist(): MaintenanceCheck {
  const indexHtml = path.join(PATHS.webSpaDist, 'index.html');
  const ok = fs.existsSync(indexHtml);
  return { key: 'web', label: 'Web 控制台产物', ok, detail: ok ? PATHS.webSpaDist : '缺少 index.html' };
}

/** 插件登记情况：各管理器的已登记数量汇总（个别未接线就跳过，不让单点炸掉自检） */
function checkPlugins(): MaintenanceCheck {
  try {
    const managers = [
      kakakeApp.pluginManager,
      kakakeApp.gfPluginManager,
      kakakeApp.wxPluginManager,
      kakakeApp.ssPluginManager,
      kakakeApp.sssxPluginManager,
      kakakeApp.kzPluginManager,
      kakakeApp.tgPluginManager,
    ].filter((m) => !!m);
    if (managers.length === 0) {
      return { key: 'plugins', label: '插件扫描', ok: false, detail: '插件管理器尚未初始化' };
    }
    const total = managers.reduce((sum, m) => sum + m.getAllPlugins().length, 0);
    return {
      key: 'plugins',
      label: '插件扫描',
      ok: true,
      detail: `共 ${total} 个已登记插件（${managers.length}/7 个管理器）`,
    };
  } catch (e) {
    return { key: 'plugins', label: '插件扫描', ok: false, detail: String((e as Error).message || e) };
  }
}

export function runMaintenance(opts: { cleanTemp?: boolean } = {}): MaintenanceReport {
  const checks: MaintenanceCheck[] = [];

  if (opts.cleanTemp === true) {
    const a = cleanDirContents(PATHS.tmp);
    checks.push({ key: 'temp', label: '清理运行期临时文件', ok: true, detail: `data/tmp 清理 ${a} 项` });
    const cacheDir = path.join(PATHS.root, 'dist', '.cache');
    if (fs.existsSync(cacheDir)) {
      const b = cleanDirContents(cacheDir);
      checks.push({ key: 'packcache', label: '清理打包缓存', ok: true, detail: `dist/.cache 清理 ${b} 项` });
    }
  }

  checks.push(checkDiskWritable());
  checks.push(checkJsonReadable());
  checks.push(checkWebDist());
  checks.push(checkPlugins());
  checks.push({ key: 'node', label: 'Node 版本', ok: true, detail: process.version });
  checks.push({ key: 'version', label: '框架版本', ok: true, detail: getFrameworkVersion() });

  const report: MaintenanceReport = {
    at: Date.now(),
    version: getFrameworkVersion(),
    ok: checks.every((c) => c.ok),
    checks,
  };

  try {
    fs.mkdirSync(PATHS.data, { recursive: true });
    fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2), 'utf8');
  } catch {
    /* 报告写不下去也要继续重启，别让收尾卡住主流程 */
  }

  for (const c of checks) {
    const line = `[maintenance] ${c.label}: ${c.ok ? '✓' : '✗'} ${c.detail}`;
    if (c.ok) console.log(line);
    else console.error(line);
  }
  return report;
}

export function readLastReport(): MaintenanceReport | null {
  try {
    if (!fs.existsSync(REPORT_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8')) as MaintenanceReport;
    return raw && Array.isArray(raw.checks) ? raw : null;
  } catch {
    return null;
  }
}
