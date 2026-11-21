import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { PATHS } from '../src/paths.js';
import {
  listShareAccounts,
  restoreStagedData,
  stageDataZip,
} from '../src/plugin/plugin-share.service.js';

/**
 * 扩展插件（kz-plugin-*）没有账号层，数据在 data/<插件Id>。
 * 这里锁住两件事：
 *   1. 账号探测能认出扩展插件的数据（否则前端「插件+数据」永远灰着）；
 *   2. 分享包里的数据能还原回 data/<插件Id>，且白名单外的顶层目录一律不落盘。
 */

const ID = `kz-plugin-sharetest-${process.pid}`;
const EXT_DATA = path.join(PATHS.data, ID);
const EXT_PLUGIN_DIR = path.join(PATHS.plugins, ID);

function rm(p: string): void {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
}

test('扩展插件：data/<插件Id> 存在时账号探测返回占位账号', () => {
  try {
    assert.deepEqual(listShareAccounts(ID).accounts, []);
    assert.equal(listShareAccounts(ID).hasAny, false);

    fs.mkdirSync(EXT_DATA, { recursive: true });
    fs.writeFileSync(path.join(EXT_DATA, 'config.json'), '{"a":1}', 'utf8');

    const r = listShareAccounts(ID);
    assert.equal(r.hasAny, true);
    assert.equal(r.single, true);
    assert.deepEqual(r.accounts.map((a) => a.key), [ID]);
  } finally {
    rm(EXT_DATA);
  }
});

test('扩展插件：分享包数据还原到 data/<插件Id>，白名单外目录被跳过', async () => {
  const stagingDir = path.join(PATHS.tmp, `sharetest-${process.pid}`);
  try {
    // 模拟「插件已装好」：还原端要求 plugins/<插件Id> 真实存在
    fs.mkdirSync(EXT_PLUGIN_DIR, { recursive: true });
    fs.mkdirSync(stagingDir, { recursive: true });

    // 数据包：顶层是插件 ID（扩展插件无账号层），另附一个恶意顶层目录
    const zip = new AdmZip();
    zip.addFile(`${ID}/config.json`, Buffer.from('{"restored":true}', 'utf8'));
    zip.addFile('__evil__/pwn.txt', Buffer.from('x', 'utf8'));
    zip.writeZip(path.join(stagingDir, 'data.zip'));

    const token = stageDataZip(stagingDir, '', { kind: 'kz', pluginId: ID });
    const r = await restoreStagedData(token);

    assert.ok(r.restored.includes(ID), '应还原扩展插件数据目录');
    assert.equal(
      fs.readFileSync(path.join(EXT_DATA, 'config.json'), 'utf8'),
      '{"restored":true}',
    );
    assert.equal(fs.existsSync(path.join(PATHS.data, '__evil__')), false, '白名单外目录不得落盘');
  } finally {
    rm(EXT_DATA);
    rm(EXT_PLUGIN_DIR);
    rm(stagingDir);
  }
});

test('扩展插件：非 kz 声明的暂存包不会获得 data 根目录写权限', async () => {
  const stagingDir = path.join(PATHS.tmp, `sharetest2-${process.pid}`);
  try {
    fs.mkdirSync(EXT_PLUGIN_DIR, { recursive: true });
    fs.mkdirSync(stagingDir, { recursive: true });

    const zip = new AdmZip();
    zip.addFile(`${ID}/config.json`, Buffer.from('{"should":"skip"}', 'utf8'));
    zip.writeZip(path.join(stagingDir, 'data.zip'));

    // kind 不是 kz：即便目录名像扩展插件，也不能落盘
    const token = stageDataZip(stagingDir, '', { kind: 'kakake', pluginId: ID });
    const r = await restoreStagedData(token);

    assert.equal(r.restored.includes(ID), false);
    assert.equal(fs.existsSync(EXT_DATA), false);
  } finally {
    rm(EXT_DATA);
    rm(EXT_PLUGIN_DIR);
    rm(stagingDir);
  }
});
