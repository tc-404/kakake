/**
 * 回归：多连接插件后台的账号寻址。
 *
 * 曾出现的现象：同一个插件在 A / B 两个连接上启用，同时打开两个后台，
 * 在 A 操作后 B 必须刷新，刷新 B 后回到 A 又得刷新。根因是
 * `kk_pa_<插件ID>` 这个浏览器级单例 Cookie 被两个标签页轮流覆盖，
 * 而「不带账号」的插件 API 请求会静默采用 Cookie 指向的账号。
 *
 * 本测试锁住两件事：
 * 1. 带 /a/<账号>/ 的后台地址能让请求稳定解析到自己的连接（不受 Cookie 影响）；
 * 2. 多账号时不再允许仅凭 Cookie 猜测账号，必须显式报错而不是串数据。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import {
  extractAccountKeyFromRequestDetailed,
  pluginAccountCookieName,
  selectPluginAccount,
  setPluginAccountCookie,
} from '../src/plugin/plugin-account-http.js';
import { pluginLegacyHtmlUrl as serverLegacyHtmlUrl } from '../src/plugin/plugin-host-paths.js';
import { pluginLegacyHtmlUrl as webLegacyHtmlUrl } from '../src/web/lib/plugin-host-paths.js';

const PID = 'sssx-plugin-qr-guard';
const A = '1905617227';
const B = '3858833831';
const ORIGIN = 'http://127.0.0.1:8787';
const API = `/api/Plugin/ext/${PID}/groups/config`;
const LEGACY_NO_ACCOUNT = `/plugin/${PID}/page/admin`;

function fakeReq(
  path: string,
  opts: { referer?: string; cookie?: string; query?: Record<string, unknown> } = {},
): Request {
  return {
    path,
    headers: {
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(opts.referer ? { referer: ORIGIN + opts.referer } : {}),
    },
    query: opts.query ?? {},
  } as unknown as Request;
}

/** 模拟浏览器里同源、跨标签共享的单个 Cookie */
function cookieJar() {
  let value = '';
  const res = {
    append(_name: string, raw: string) {
      value = raw.split(';')[0]!;
    },
  } as unknown as Response;
  return {
    get value() { return value; },
    write(account: string) { setPluginAccountCookie(res, PID, account); },
  };
}

test('账号 Cookie 是插件级单例：名字里没有账号、也没有标签页维度', () => {
  const name = pluginAccountCookieName(PID);
  assert.equal(name, 'kk_pa_sssx-plugin-qr-guard');
  assert.ok(!name.includes(A));
  assert.ok(!name.includes(B));
});

test('两个连接的后台先后打开，后一个覆盖同一个 Cookie', () => {
  const jar = cookieJar();
  jar.write(A);
  assert.equal(jar.value, `${pluginAccountCookieName(PID)}=${A}`);
  jar.write(B);
  assert.equal(jar.value, `${pluginAccountCookieName(PID)}=${B}`);
  assert.ok(!jar.value.includes(A));
});

test('旧链路：不带账号的 API 仅凭 Cookie 会被解析成另一个连接', () => {
  const jar = cookieJar();
  jar.write(A); // 打开 A 后台
  jar.write(B); // 打开 B 后台

  const d = extractAccountKeyFromRequestDetailed(
    fakeReq(API, { cookie: jar.value, referer: LEGACY_NO_ACCOUNT }),
    PID,
  );
  assert.equal(d.source, 'cookie');
  assert.equal(d.accountKey, B, 'A 标签页发出的请求拿到了 B 的账号');

  // 修复后：这种请求必须被拒绝，不能静默采用 Cookie 里的账号
  const r = selectPluginAccount({ accounts: [A, B], sources: [d] });
  if ('accountKey' in r) assert.fail('多账号 + 仅 Cookie 时不应返回账号');
  assert.match(r.error, /未携带账号/);
});

test('前后台路径工具一致，且带账号的 iframe 地址自带 /a/<账号>/', () => {
  for (const account of [A, B]) {
    const webUrl = webLegacyHtmlUrl(PID, 'admin', account);
    assert.equal(webUrl, serverLegacyHtmlUrl(PID, 'admin', account));
    assert.ok(webUrl.includes(`/a/${account}/`), webUrl);
  }
});

test('带账号的 iframe 地址让两个后台各自解析到自己的连接', () => {
  const jar = cookieJar();
  jar.write(A);
  jar.write(B); // 全局 Cookie 停在 B —— 最坏情况

  for (const account of [A, B]) {
    const iframeUrl = webLegacyHtmlUrl(PID, 'admin', account);
    const d = extractAccountKeyFromRequestDetailed(
      fakeReq(API, { cookie: jar.value, referer: iframeUrl }),
      PID,
    );
    assert.equal(d.source, 'referer');
    assert.equal(d.accountKey, account);
    const r = selectPluginAccount({ accounts: [A, B], sources: [d] });
    if ('error' in r) assert.fail(`${account}: ${r.error}`);
    assert.equal(r.accountKey, account);
  }
});

test('显式账号（path / referer / query）一律优先于 Cookie', () => {
  const jar = cookieJar();
  jar.write(B);
  const cookie = jar.value;

  const fromPath = extractAccountKeyFromRequestDetailed(
    fakeReq(`/api/Plugin/ext/${PID}/a/${A}/groups/config`, { cookie }),
    PID,
  );
  assert.equal(fromPath.source, 'path');
  assert.equal(fromPath.accountKey, A);

  const fromReferer = extractAccountKeyFromRequestDetailed(
    fakeReq(API, { cookie, referer: `/plugins/${PID}/a/${A}/pages/admin` }),
    PID,
  );
  assert.equal(fromReferer.source, 'referer');
  assert.equal(fromReferer.accountKey, A);

  const fromQuery = extractAccountKeyFromRequestDetailed(
    fakeReq(API, { query: { account: A } }),
    PID,
  );
  assert.equal(fromQuery.source, 'query');
  assert.equal(fromQuery.accountKey, A);

  for (const d of [fromPath, fromReferer, fromQuery]) {
    const r = selectPluginAccount({ accounts: [A, B], sources: [d] });
    if ('error' in r) assert.fail(r.error);
    assert.equal(r.accountKey, A);
  }
});

test('一个来源只命中 Cookie、另一个命中 path 时，以显式来源为准', () => {
  const cookieOnly = extractAccountKeyFromRequestDetailed(
    fakeReq(API, { cookie: `${pluginAccountCookieName(PID)}=${B}` }),
    PID,
  );
  const fromPath = extractAccountKeyFromRequestDetailed(
    fakeReq(`/api/Plugin/ext/${PID}/a/${A}/groups/config`),
    PID,
  );
  assert.equal(cookieOnly.source, 'cookie');
  assert.equal(fromPath.source, 'path');

  const r = selectPluginAccount({ accounts: [A, B], sources: [cookieOnly, fromPath] });
  if ('error' in r) assert.fail(r.error);
  assert.equal(r.accountKey, A);
});

test('单账号插件保持兼容，忽略切换连接后残留的旧 Cookie', () => {
  const jar = cookieJar();
  jar.write('OLD_ACCOUNT');
  const d = extractAccountKeyFromRequestDetailed(
    fakeReq(API, { cookie: jar.value, referer: LEGACY_NO_ACCOUNT }),
    PID,
  );
  assert.equal(d.source, 'cookie');
  const r = selectPluginAccount({ accounts: [A], sources: [d] });
  if ('error' in r) assert.fail(r.error);
  assert.equal(r.accountKey, A);
});

test('显式账号或 Referer 指向未加载账号时明确报错', () => {
  const none = extractAccountKeyFromRequestDetailed(
    fakeReq(API, { referer: LEGACY_NO_ACCOUNT }),
    PID,
  );
  const explicit = selectPluginAccount({
    accounts: [A, B],
    explicitAccount: 'NOT_LOADED',
    sources: [none],
  });
  if ('accountKey' in explicit) assert.fail('不应返回账号');
  assert.match(explicit.error, /未加载此插件/);

  const gone = extractAccountKeyFromRequestDetailed(
    fakeReq(API, { referer: `/plugins/${PID}/a/GONE/pages/admin` }),
    PID,
  );
  const fromReferer = selectPluginAccount({ accounts: [A, B], sources: [gone] });
  if ('accountKey' in fromReferer) assert.fail('不应返回账号');
  assert.match(fromReferer.error, /未加载此插件/);
});

test('回归主场景：两个后台交替操作，每个请求都落到自己的连接', () => {
  const accounts = [A, B];
  const jar = cookieJar();
  jar.write(A); // 打开 A 宿主页
  jar.write(B); // 打开 B 宿主页，共享 Cookie 停在 B

  for (const account of accounts) {
    // 修复后 iframe 的地址带账号，页面内绝对路径 API 的 Referer 也带账号
    const iframeUrl = webLegacyHtmlUrl(PID, 'admin', account);
    for (const action of ['/groups', '/status', '/groups/config']) {
      const d = extractAccountKeyFromRequestDetailed(
        fakeReq(`/api/Plugin/ext/${PID}${action}`, { cookie: jar.value, referer: iframeUrl }),
        PID,
      );
      const r = selectPluginAccount({ accounts, sources: [d] });
      if ('error' in r) assert.fail(`${account} ${action}: ${r.error}`);
      assert.equal(r.accountKey, account, `${account} ${action} 被路由到了别的连接`);
    }
  }

  // 旧的无账号地址不再静默落到 Cookie 指向的账号，而是明确拒绝
  const legacy = extractAccountKeyFromRequestDetailed(
    fakeReq(API, { cookie: jar.value, referer: LEGACY_NO_ACCOUNT }),
    PID,
  );
  assert.equal(legacy.source, 'cookie');
  const legacyResult = selectPluginAccount({ accounts, sources: [legacy] });
  assert.equal('accountKey' in legacyResult, false);
});

test('中文插件 ID 的 Referer（百分号编码形态）也能解析出账号', () => {
  const cnId = 'GF-AI聊天';
  const encodedId = encodeURIComponent(cnId);
  const iframeUrl = webLegacyHtmlUrl(cnId, 'admin', A);
  assert.ok(iframeUrl.includes(`/a/${A}/`), iframeUrl);

  // 服务端先 decodeURIComponent 得到真实 ID，再拿它去匹配 Referer
  const d = extractAccountKeyFromRequestDetailed(
    fakeReq(`/api/Plugin/ext/${encodedId}/status`, { referer: iframeUrl }),
    cnId,
  );
  assert.equal(d.source, 'referer');
  assert.equal(d.accountKey, A);

  const r = selectPluginAccount({ accounts: [A, B], sources: [d] });
  if ('error' in r) assert.fail(r.error);
  assert.equal(r.accountKey, A);
});
