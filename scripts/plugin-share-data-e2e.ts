/**
 * 「插件+数据」分享回环实测（一次性脚本）：
 * 打包（含账号数据）→ 上传 → 下载 → 校验包内结构 → 暂存 → 还原 → 哈希比对。
 * 用法：node --import tsx scripts/plugin-share-data-e2e.ts [插件ID] [账号Key] [上传源]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PATHS } from '../src/paths.js';
import { extractArchive } from '../src/plugin/archive.js';
import {
  buildAndUploadSharePackage,
  downloadSharePackage,
  restoreStagedData,
  stageDataZip,
} from '../src/plugin/plugin-share.service.js';

const pluginId = process.argv[2] || 'GF-xiyuan-sign';
const account = process.argv[3] || '1905617227';
const providerId = (process.argv[4] || 'uguu') as 'uguu' | 'litterbox' | 'tmpfiles';

const dataDir = path.join(PATHS.data, account, pluginId);
const lines: string[] = [];
const log = (s: string) => { lines.push(s); console.log(s); };

const sha256 = (p: string) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

// 1. 还原前快照
const filesBefore: string[] = [];
{
  const walk = (dir: string, base = dir): void => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p, base);
      else filesBefore.push(`${path.relative(base, p).replace(/\\/g, '/')} sha=${sha256(p).slice(0, 12)}`);
    }
  };
  walk(dataDir);
}
log(`源数据目录：${dataDir}`);
log(`还原前文件：\n  ${filesBefore.join('\n  ')}`);

// 2. 打包上传（插件 + 该账号数据）
const r = await buildAndUploadSharePackage({
  pluginPath: path.join(PATHS.plugins, pluginId),
  meta: { pluginId, name: pluginId, kind: 'gf' },
  providerId,
  mode: 'plugin_data',
  accounts: [account],
});
if (!r.ok || !r.url) {
  log(`✗ 上传失败：${r.message}`);
  fs.writeFileSync('data/tmp/share-data-e2e.txt', lines.join('\n'), 'utf8');
  process.exit(1);
}
log(`✓ 上传成功（${((r.size ?? 0) / 1024).toFixed(0)}KB）：${r.url}`);

// 3. 下载识别
const d = await downloadSharePackage(r.url);
if (!d.isShare || !d.shareInfo?.hasData) {
  log('✗ 下载后未识别出带数据的分享包');
  fs.writeFileSync('data/tmp/share-data-e2e.txt', lines.join('\n'), 'utf8');
  process.exit(1);
}
log(`✓ 下载识别：pluginId=${d.shareInfo.pluginId} hasData=${d.shareInfo.hasData} accounts=${d.shareInfo.accounts.join(',')}`);

// 4. 看包内 data.zip 的真实结构
const stagingDir = path.join(PATHS.tmp, `share-e2e-verify-${Date.now().toString(36)}`);
fs.mkdirSync(stagingDir, { recursive: true });
// data.zip 与 share.json 同目录：根目录或单层子目录
const findDataZip = (): string => {
  for (const dir of [d.extractedDir, ...fs.readdirSync(d.extractedDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(d.extractedDir, e.name))]) {
    const p = path.join(dir, 'data.zip');
    if (fs.existsSync(p)) return p;
  }
  throw new Error('包内没有 data.zip');
};
const dataZipPath = findDataZip();
const checkDir = path.join(stagingDir, 'check');
await extractArchive(dataZipPath, checkDir);
const listZip: string[] = [];
{
  const walk = (dir: string, base = dir): void => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p, base);
      else listZip.push(path.relative(base, p).replace(/\\/g, '/'));
    }
  };
  walk(checkDir);
}
log(`data.zip 内结构：\n  ${listZip.join('\n  ')}`);

// 5. 暂存 + 还原
const rel = fs.existsSync(path.join(d.extractedDir, 'data.zip')) ? '' : fs.readdirSync(d.extractedDir).find((n) => fs.existsSync(path.join(d.extractedDir, n, 'data.zip'))) || '';
const token = stageDataZip(d.extractedDir, rel);
const { restored, failed } = await restoreStagedData(token);
log(`✓ 已还原到账号目录：${restored.join(', ')}${failed.length ? `（${failed.length} 个文件失败：${failed.join(', ')}）` : ''}`);

// 6. 还原后哈希比对
const filesAfter: string[] = [];
{
  const walk = (dir: string, base = dir): void => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p, base);
      else filesAfter.push(`${path.relative(base, p).replace(/\\/g, '/')} sha=${sha256(p).slice(0, 12)}`);
    }
  };
  walk(dataDir);
}
const same = filesBefore.length === filesAfter.length && filesBefore.every((f) => filesAfter.includes(f));
log(`还原后文件：\n  ${filesAfter.join('\n  ')}`);
log(same ? '✓ 还原前后内容一致（哈希比对通过）' : '✗ 还原前后内容不一致！');

// 清理探针临时目录
fs.rmSync(stagingDir, { recursive: true, force: true });
fs.rmSync(d.extractedDir, { recursive: true, force: true });
try { fs.unlinkSync(d.downloadedPath); } catch { /* ignore */ }

fs.writeFileSync('data/tmp/share-data-e2e.txt', lines.join('\n'), 'utf8');
process.exit(same ? 0 : 1);
