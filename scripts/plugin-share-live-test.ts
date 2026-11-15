/**
 * 插件分享实测脚本（一次性，不进测试套件）：
 * 用真实服务代码把插件打包上传到全部上传源，然后走完整下载链路——
 * downloadSharePackage 下载识别 → 解出 plugin.zip → 与源插件逐文件比对（路径 + 大小），
 * 验证的是「上传 → 存储点 → 下载 → 识别 → 解包」全链路，不只是回链能打开。
 *
 * 用法：node --import tsx scripts/plugin-share-live-test.ts [插件目录名]
 */
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../src/paths.js';
import { extractArchive } from '../src/plugin/archive.js';
import {
  SHARE_PROVIDERS,
  buildAndUploadSharePackage,
  downloadSharePackage,
} from '../src/plugin/plugin-share.service.js';

const pluginDirName = process.argv[2] || 'GF-AI聊天';
const pluginPath = path.join(PATHS.plugins, pluginDirName);

/** 递归收集「相对路径 → 字节大小」 */
function walkFiles(dir: string, base = dir, out = new Map<string, number>()): Map<string, number> {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(p, base, out);
    else out.set(path.relative(base, p).replace(/\\/g, '/'), fs.statSync(p).size);
  }
  return out;
}

function cleanup(p: string): void {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
}

if (!fs.existsSync(pluginPath)) {
  console.error(`插件目录不存在：${pluginPath}`);
  process.exit(1);
}

const meta = { pluginId: pluginDirName, name: pluginDirName, version: 'live-test', kind: 'gf' };
const sourceFiles = walkFiles(pluginPath);
console.log(`目标插件：${pluginPath}（${sourceFiles.size} 个文件）`);
console.log('开始并行上传到全部上传源…\n');

const results = await Promise.allSettled(
  SHARE_PROVIDERS.map(async (p) => {
    const t0 = Date.now();
    const r = await buildAndUploadSharePackage({
      pluginPath,
      meta,
      providerId: p.id,
      mode: 'plugin',
      accounts: [],
    });
    return { provider: p, r, elapsed: Date.now() - t0 };
  }),
);

let pass = 0;
let fail = 0;

for (const item of results) {
  if (item.status !== 'fulfilled') {
    fail += 1;
    console.log(`✗ ${item.reason instanceof Error ? item.reason.message : String(item.reason)}`);
    continue;
  }
  const { provider, r, elapsed } = item.value;
  const head = `[${provider.name.padEnd(10)}]`;
  if (!r.ok || !r.url) {
    fail += 1;
    console.log(`${head} 上传失败（${(elapsed / 1000).toFixed(1)}s）：${r.message}`);
    continue;
  }

  // ── 下载链路完整性验证 ──
  let verifyDir = '';
  try {
    const d = await downloadSharePackage(r.url);
    if (!d.isShare || !d.shareInfo) throw new Error('下载后未识别为分享包');
    if (d.shareInfo.pluginId !== pluginDirName) throw new Error(`share.json 插件 ID 不符：${d.shareInfo.pluginId}`);
    if (!fs.existsSync(d.pluginZipPath)) throw new Error('包内缺 plugin.zip');

    verifyDir = path.join(PATHS.tmp, `share-verify-${Date.now().toString(36)}`);
    fs.mkdirSync(verifyDir, { recursive: true });
    await extractArchive(d.pluginZipPath, verifyDir);

    const downloadedFiles = walkFiles(verifyDir);
    const total = [...downloadedFiles.values()].reduce((a, b) => a + b, 0);
    const srcTotal = [...sourceFiles.values()].reduce((a, b) => a + b, 0);

    const missing = [...sourceFiles.keys()].filter((k) => !downloadedFiles.has(k));
    const extra = [...downloadedFiles.keys()].filter((k) => !sourceFiles.has(k));
    const sizeMismatch = [...sourceFiles.keys()].filter((k) => downloadedFiles.has(k) && downloadedFiles.get(k) !== sourceFiles.get(k));

    if (missing.length || extra.length || sizeMismatch.length) {
      throw new Error(`文件树不一致：缺 ${missing.length} / 多 ${extra.length} / 大小不符 ${sizeMismatch.length}`
        + (missing[0] ? `，如缺 ${missing[0]}` : '') + (extra[0] ? `，如多 ${extra[0]}` : ''));
    }

    pass += 1;
    console.log(`${head} ✓ 上传 ${(r.size! / 1024).toFixed(0)}KB（${(elapsed / 1000).toFixed(1)}s）· 下载解包 ${downloadedFiles.size} 个文件 / ${total}B · 与源完全一致（源 ${srcTotal}B）`);

    cleanup(d.extractedDir);
    cleanup(d.downloadedPath);
  } catch (e) {
    fail += 1;
    console.log(`${head} ▲ 下载链路失败：${e instanceof Error ? e.message : e} · ${r.url}`);
  } finally {
    if (verifyDir) cleanup(verifyDir);
  }
}

console.log(`\n结果：${pass} 通 / ${fail} 不通（共 ${SHARE_PROVIDERS.length} 源）`);
