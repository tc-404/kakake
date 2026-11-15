import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readJsonSafe,
  writeJsonAtomic,
  writeTextAtomic,
  readTextSafe,
} from '../src/storage/atomic-file.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kakake-test-'));
}

test('原子写 JSON 往返一致', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'a.json');
    writeJsonAtomic(file, { hello: '世界', n: 1 });
    assert.deepEqual(readJsonSafe<Record<string, unknown>>(file, {}), { hello: '世界', n: 1 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('损坏 JSON 被隔离并返回兜底值', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'b.json');
    fs.writeFileSync(file, '{oops');
    assert.equal(readJsonSafe(file, 'fallback'), 'fallback');
    const entries = fs.readdirSync(dir);
    assert.ok(
      entries.some((e) => e.startsWith('b.json.corrupt-')),
      `应存在隔离文件，实际: ${entries.join(', ')}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('文件缺失返回兜底值', () => {
  const dir = tmpDir();
  try {
    assert.equal(readJsonSafe(path.join(dir, 'missing.json'), 7), 7);
    assert.equal(readTextSafe(path.join(dir, 'missing.txt'), 'dft'), 'dft');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('文本原子写读', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'c.txt');
    writeTextAtomic(file, '第一行\n第二行\n');
    assert.equal(readTextSafe(file), '第一行\n第二行\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rename 被占用时退避重试后成功', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'busy.json');
  fs.writeFileSync(file, 'old');
  // Windows 上持有目标句柄使 rename 覆盖报 EPERM；模拟首次失败后句柄释放
  const holder = fs.openSync(file, 'r+');
  const realRename = fs.renameSync;
  let calls = 0;
  fs.renameSync = (...args: Parameters<typeof fs.renameSync>) => {
    calls += 1;
    if (calls === 1) {
      fs.closeSync(holder);
      const err = new Error('EPERM: resource busy or locked') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    }
    return realRename(...args);
  };
  try {
    writeJsonAtomic(file, { ok: true });
    assert.deepEqual(readJsonSafe<Record<string, unknown>>(file, {}), { ok: true });
    assert.ok(calls >= 2, `应经过至少 2 次 rename，实际 ${calls} 次`);
  } finally {
    fs.renameSync = realRename;
    try {
      fs.closeSync(holder);
    } catch {
      /* 已关闭 */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
