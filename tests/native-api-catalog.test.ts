/** 非代理接口目录的展示契约：框架 / 对内 / 对外三类必须完整、可核对、双语齐全。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NATIVE_ENDPOINTS,
  type NativeCategory,
} from '../src/proxy/catalog/native-endpoints.js';
import { ProxyRegistryController } from '../src/admin/proxy-registry.controller.js';
import { PROXY_ENTRIES } from '../src/proxy/registry/index.js';

const CATEGORIES: NativeCategory[] = ['framework', 'internal', 'external'];
const METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'WS', 'ALL']);

test('目录覆盖框架 / 对内 / 对外三类，每类都有实例', () => {
  for (const c of CATEGORIES) {
    const list = NATIVE_ENDPOINTS.filter((e) => e.category === c);
    assert.ok(list.length >= 2, `${c} 至少要有两个接口，实际 ${list.length}`);
  }
  assert.ok(NATIVE_ENDPOINTS.length >= 20);
});

test('短名唯一、长度合适，且前缀与分类一致', () => {
  const names = new Set<string>();
  const prefix: Record<NativeCategory, string> = {
    framework: 'fw_', internal: 'in_', external: 'out_',
  };
  const proxyNames = new Set(PROXY_ENTRIES.map((e) => e.name));
  for (const e of NATIVE_ENDPOINTS) {
    assert.ok(!names.has(e.name), `短名重复：${e.name}`);
    names.add(e.name);
    assert.ok(e.name.length <= 24, `短名太长：${e.name}`);
    assert.ok(e.name.startsWith(prefix[e.category]), `${e.name} 前缀与 ${e.category} 不一致`);
    assert.ok(!proxyNames.has(e.name), `与代理注册表短名冲突：${e.name}`);
  }
});

test('每条都写清地址、方法、鉴权、放行条件、返回与源码出处', () => {
  for (const e of NATIVE_ENDPOINTS) {
    assert.ok(METHODS.has(e.method), `${e.name} 方法非法：${e.method}`);
    assert.ok(e.path.trim().length > 0, `${e.name} 缺地址`);
    assert.ok(e.source.includes(':'), `${e.name} 的源码出处要带行号`);
    for (const [field, value] of [
      ['title', e.title], ['summary', e.summary], ['auth', e.auth],
      ['gate', e.gate], ['response', e.response],
    ] as const) {
      assert.ok(value.zh.trim() && value.en.trim(), `${e.name}.${field} 中英文都要有`);
    }
    if (e.notes) {
      assert.ok(e.notes.zh.trim() && e.notes.en.trim(), `${e.name}.notes 中英文都要有`);
    }
  }
});

test('参数写明位置、类型与双语说明；必填参数要给示例', () => {
  for (const e of NATIVE_ENDPOINTS) {
    const keys = new Set<string>();
    for (const p of e.params) {
      assert.ok(!keys.has(p.key), `${e.name} 参数重复：${p.key}`);
      keys.add(p.key);
      assert.ok(['path', 'query', 'body', 'header', 'ws'].includes(p.in), `${e.name}.${p.key} 位置非法`);
      assert.ok(p.type, `${e.name}.${p.key} 缺类型`);
      assert.ok(p.label.zh.trim() && p.label.en.trim(), `${e.name}.${p.key} 名称缺翻译`);
      assert.ok(p.desc.zh.trim() && p.desc.en.trim(), `${e.name}.${p.key} 说明缺翻译`);
      if (p.required) assert.ok(p.sample, `${e.name}.${p.key} 必填参数建议给示例`);
    }
  }
});

test('控制台接口把目录随注册表一起返回，且不污染注册表', () => {
  const res = new ProxyRegistryController().apis();
  assert.equal(res.ok, true);
  assert.equal(res.items.length, PROXY_ENTRIES.length);
  assert.equal(res.endpointCount, NATIVE_ENDPOINTS.length);
  assert.equal(res.endpoints.length, NATIVE_ENDPOINTS.length);
  assert.deepEqual(res.endpoints.map((e) => e.name), NATIVE_ENDPOINTS.map((e) => e.name));
});
