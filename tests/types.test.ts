import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeApiTimeoutMs } from '../src/core/types.js';

test('normalizeApiTimeoutMs：合法值向下取整', () => {
  assert.equal(normalizeApiTimeoutMs(12345.9), 12345);
  assert.equal(normalizeApiTimeoutMs('30000'), 30000);
});

test('normalizeApiTimeoutMs：越界钳制到 [5000, 600000]', () => {
  assert.equal(normalizeApiTimeoutMs(-1), 5000);
  assert.equal(normalizeApiTimeoutMs(0), 5000);
  assert.equal(normalizeApiTimeoutMs(999_999_999), 600_000);
});

test('normalizeApiTimeoutMs：非有限值回默认（与 undefined 一致）', () => {
  assert.equal(normalizeApiTimeoutMs('abc'), normalizeApiTimeoutMs(undefined));
  assert.equal(normalizeApiTimeoutMs(NaN), normalizeApiTimeoutMs(undefined));
});
