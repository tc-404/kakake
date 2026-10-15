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
