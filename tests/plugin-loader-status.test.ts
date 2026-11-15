import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PluginLoader } from '../src/plugin/plugin.loader.js';
import { Logger } from '../src/core/logger.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kakake-test-'));
}

function quietLoader(dir: string, statusFile: string): PluginLoader {
  return new PluginLoader(dir, statusFile, new Logger('[test] ', 'error'));
}

test('plugins.json 缓存：外部改动（mtime 变化）后能重新读到', () => {
  const dir = tmpDir();
  try {
    const statusFile = path.join(dir, 'plugins.json');
    fs.writeFileSync(statusFile, JSON.stringify({ 'kakake-plugin-mkai': false }));
    const loader = quietLoader(dir, statusFile);
    assert.equal(loader.isMasterEnabled('kakake-plugin-mkai'), false);

    // 外部直接改文件 → 指纹（mtime+size）变化 → 缓存失效重读；
    // 再用 utimesSync 显式推开 mtime，保证跨文件系统的确定性
    fs.writeFileSync(statusFile, JSON.stringify({ 'kakake-plugin-mkai': true }));
    const t = new Date(Date.now() + 5000);
    fs.utimesSync(statusFile, t, t);
    assert.equal(loader.isMasterEnabled('kakake-plugin-mkai'), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('savePluginStatusConfig 写盘后读取立即一致（缓存刷新）', () => {
  const dir = tmpDir();
  try {
    const statusFile = path.join(dir, 'plugins.json');
    const loader = quietLoader(dir, statusFile);

    loader.setMasterEnabled('kakake-plugin-mkai', false);
    assert.equal(loader.isMasterEnabled('kakake-plugin-mkai'), false);

    const onDisk = JSON.parse(fs.readFileSync(statusFile, 'utf-8')) as Record<string, boolean>;
    assert.equal(onDisk['kakake-plugin-mkai'], false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('文件缺失时总开关默认开启', () => {
  const dir = tmpDir();
  try {
    const loader = quietLoader(dir, path.join(dir, 'not-exist.json'));
    assert.equal(loader.isMasterEnabled('kakake-plugin-mkai'), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
