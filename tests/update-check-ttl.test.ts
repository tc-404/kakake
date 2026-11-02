import { test } from 'node:test';
import assert from 'node:assert/strict';
// 先加载存储层再拉更新服务：logger ↔ atomic-file 存在循环依赖，入口顺序会影响初始化
import '../src/storage/atomic-file.js';
import { triggerAutoCheck, pingSession, getSessionUpdateView } from '../src/admin/update-check.service.js';

/**
 * 侧边栏版本号右上角的红色 NEW 依赖两件事，这里把两条都钉死（纯离线，stub 掉 fetch）：
 * 1. 自动检查按 10 分钟 TTL 节流，而不是「登录会话内只查一次」。
 * 2. 手动「一键 Ping / 测试访问」也会把 remoteVersion **向上**修正，
 *    即手动查到新版本时 NEW 立刻亮起；落后镜像的结果不会把已发现的新版本压回去。
 */

/** 当前假镜像返回的最新版本号（测试里随时改） */
let fakeVersion = '9.9.9';

type FakeResp = { ok: boolean; status: number; text: () => Promise<string> };

const realFetch = globalThis.fetch;

/** 造一个最小可用的 Response 替身：gh-api 分支只用到 ok / status / text() */
function fakeFetch(): Promise<FakeResp> {
  const body = JSON.stringify([
    { tag_name: `v${fakeVersion}`, name: `v${fakeVersion}`, html_url: 'https://example.invalid', published_at: new Date().toISOString() },
  ]);
  return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(body) });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).fetch = ((_url: unknown, _init?: unknown) => fakeFetch()) as typeof fetch;

/** 等待后台自动检查落定（triggerAutoCheck 是 fire-and-forget） */
async function waitSettled(key: string, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const v = getSessionUpdateView(key);
    if (v.status !== 'checking' && v.status !== 'idle') return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('自动检查发现新版本 → hasUpdate=true（侧边栏 NEW 的基础）', async () => {
  const key = 'test-auto-found';
  fakeVersion = '9.9.9';
  triggerAutoCheck(key);
  await waitSettled(key);

  const v = getSessionUpdateView(key);
  assert.equal(v.status, 'update');
  assert.equal(v.hasUpdate, true);
  assert.equal(v.remoteVersion, '9.9.9');
  assert.equal(v.checkedThisSession, true);
});

test('TTL 内重复进入后台不会重复访问镜像（节流生效）', async () => {
  const key = 'test-auto-ttl';
  fakeVersion = '9.9.9';
  triggerAutoCheck(key);
  await waitSettled(key);
  assert.equal(getSessionUpdateView(key).remoteVersion, '9.9.9');

  // 期间「发布了新版本」，但 TTL 未到 → 复用旧结果（不发请求，版本不变）
  fakeVersion = '9.9.99';
  triggerAutoCheck(key);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(getSessionUpdateView(key).remoteVersion, '9.9.9', 'TTL 内不应重新探测');
});

test('手动 Ping 查到更高版本 → 向上修正，NEW 立刻点亮', async () => {
  const key = 'test-ping-up';
  fakeVersion = '9.9.9';
  triggerAutoCheck(key);
  await waitSettled(key);
  assert.equal(getSessionUpdateView(key).remoteVersion, '9.9.9');

  fakeVersion = '9.9.10';
  await pingSession(key, ['github']);
  const v = getSessionUpdateView(key);
  assert.equal(v.remoteVersion, '9.9.10');
  assert.equal(v.hasUpdate, true);
  assert.equal(v.status, 'update');
});

test('手动 Ping 拿到更低版本 → 不降级，NEW 保持点亮', async () => {
  const key = 'test-ping-down';
  fakeVersion = '9.9.9';
  triggerAutoCheck(key);
  await waitSettled(key);
  assert.equal(getSessionUpdateView(key).remoteVersion, '9.9.9');

  // 落后镜像只给出更低版本：不能把已发现的新版本压回去
  fakeVersion = '0.0.1';
  await pingSession(key, ['gh_atom']);
  const v = getSessionUpdateView(key);
  assert.equal(v.remoteVersion, '9.9.9', '低版本不得覆盖已发现的新版本');
  assert.equal(v.hasUpdate, true);
});

test('全部镜像不可达时不会误报新版本', async () => {
  const key = 'test-unreachable';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = (() => Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve('') })) as unknown as typeof fetch;
  triggerAutoCheck(key);
  await waitSettled(key);
  const v = getSessionUpdateView(key);
  assert.equal(v.hasUpdate, false);
  assert.equal(v.status, 'unreachable');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = ((_url: unknown, _init?: unknown) => fakeFetch()) as typeof fetch;
});

test.after(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = realFetch;
});
