/**
 * v0.6.5 安全加固回归测试。
 *
 * 这个文件锁的是五处「修完很容易被改回去」的边界。每一条都对应一个已核实的
 * 风险编号（见项目安全评定）：
 *
 *   V1  反代部署下「无 Access Token 只信内网」失效 → 未认证事件注入
 *   V4  `/api/status` 匿名回传运行数据（已移出免鉴权白名单）
 *   V8  模拟消息卡片链接无协议白名单 → `javascript:` 同源执行
 *   V9  敏感文件按 umask 生成（Linux 上 0644）→ 同机他人可读登录密钥
 *   V5  OneBot 监听端口无 payload 上限 → 单帧/单体打爆进程堆
 *
 * 判定规则：这个文件任何一条挂了，先怀疑是不是有人把加固改回了原样，
 * **不要改断言迁就实现**。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import {
  proxyHeadersPresent,
  tokenlessSourceVerdict,
} from '../src/core/net-address.js';
import {
  BodyTooLargeError,
  MAX_EVENT_BODY_BYTES,
  readRawBody,
} from '../src/connection/onebot-http.shared.js';
import {
  hardenSensitiveFilePermissions,
  writeFileAtomic,
} from '../src/storage/atomic-file.js';
import { verifyUpdateSignatureDigest, UPDATE_SIGNING_KEYS, type SigningKeyRing } from '../src/update/verify-keys.js';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { safeHref } from '../src/web/lib/safe-link.js';
import { OneBotWsServer } from '../src/connection/onebot-ws.server.js';
import WebSocket from 'ws';
import net from 'node:net';

const IS_WINDOWS = process.platform === 'win32';

/* ─────────────────────── V1：反代痕迹探测 ─────────────────────── */

test('V1：代理头存在即判定为「前方有代理」', () => {
  assert.deepEqual(proxyHeadersPresent({}), []);
  assert.deepEqual(proxyHeadersPresent(undefined), []);
  assert.deepEqual(proxyHeadersPresent({ 'user-agent': 'NapCat' }), []);

  assert.deepEqual(proxyHeadersPresent({ 'x-forwarded-for': '1.2.3.4' }), ['x-forwarded-for']);
  assert.deepEqual(proxyHeadersPresent({ forwarded: 'for=1.2.3.4' }), ['forwarded']);
  assert.deepEqual(proxyHeadersPresent({ 'x-real-ip': '1.2.3.4' }), ['x-real-ip']);

  // 多个头同时出现时全部列出，便于报错时说明白
  const many = proxyHeadersPresent({
    'x-forwarded-for': '1.2.3.4',
    'x-forwarded-proto': 'https',
    'x-real-ip': '1.2.3.4',
  });
  assert.deepEqual(many, ['x-forwarded-for', 'x-forwarded-proto', 'x-real-ip']);
});

test('V1：空值的代理头不算出现（代理偶尔会带空 X-Forwarded-For）', () => {
  assert.deepEqual(proxyHeadersPresent({ 'x-forwarded-for': '' }), []);
  assert.deepEqual(proxyHeadersPresent({ 'x-forwarded-for': '   ' }), []);
  assert.deepEqual(proxyHeadersPresent({ 'x-forwarded-for': [] }), []);
});

test('V1：直连内网来源 + 无代理头 → 放行（传统部署形态不能被误杀）', () => {
  const v = tokenlessSourceVerdict({}, '192.168.1.10');
  assert.equal(v.ok, true);
});

test('V1：直连本机 → 放行', () => {
  assert.equal(tokenlessSourceVerdict({}, '127.0.0.1').ok, true);
  assert.equal(tokenlessSourceVerdict({}, '::1').ok, true);
});

test('V1：有代理头时一律拒绝，即使来源看着像本机（反代后的 127.0.0.1）', () => {
  // 这正是漏洞本体：反代后 TCP 对端必然是 127.0.0.1，只看地址会全放行
  const v = tokenlessSourceVerdict({ 'x-forwarded-for': '8.8.8.8' }, '127.0.0.1');
  assert.equal(v.ok, false);
  if (!v.ok) {
    assert.ok(v.reason.includes('反向代理'), '报错要说明白是代理导致的');
    assert.ok(v.reason.includes('Access Token'), '报错要给出去');
  }
});

test('V1：Docker bridge 网段（172.17.x）无代理头时仍放行——同网段是正常部署', () => {
  assert.equal(tokenlessSourceVerdict({}, '172.17.0.2').ok, true);
});

test('V1：公网来源 + 无代理头 → 拒绝', () => {
  const v = tokenlessSourceVerdict({}, '8.8.8.8');
  assert.equal(v.ok, false);
  if (!v.ok) assert.ok(v.reason.includes('内网'));
});

/* ─────────────────────── V5：payload 上限 ─────────────────────── */

/** 造一个会吐出指定字节数的可迭代流，模拟 IncomingMessage */
function fakeReq(chunks: string[]): IncomingMessage {
  const s = new PassThrough();
  for (const c of chunks) s.write(c);
  s.end();
  return s as unknown as IncomingMessage;
}

test('V5：正常大小的上报体照常读完', async () => {
  const raw = await readRawBody(fakeReq(['{"a":', '1}']));
  assert.equal(raw, '{"a":1}');
});

test('V5：超出上限抛 BodyTooLargeError，且不等流结束就中止', async () => {
  // 3 MiB，超过 2 MiB 上限；关键是**不能**把整个身体验完再判断
  const big = 'x'.repeat(3 * 1024 * 1024);
  await assert.rejects(
    () => readRawBody(fakeReq([big])),
    (err: unknown) => {
      assert.ok(err instanceof BodyTooLargeError, '错误类型要可被 instanceof 识别');
      assert.equal(err.statusCode, 413, '要带 HTTP 状态码供调用方统一处理');
      assert.equal(err.limitBytes, MAX_EVENT_BODY_BYTES);
      return true;
    },
  );
});

test('V5：上限本身是 2 MiB（OneBot 事件到不了这个量级）', () => {
  assert.equal(MAX_EVENT_BODY_BYTES, 2 * 1024 * 1024);
});

/* ─────────────────────── V9：文件权限 ─────────────────────── */

test('V9：writeFileAtomic 产出的文件权限为 0o600', {
  skip: IS_WINDOWS ? 'Windows 上 POSIX 位映射为 ACL，chmod 语义不同，跳过' : false,
}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kk-sec-'));
  try {
    const f = path.join(dir, 'auth-key.json');
    writeFileAtomic(f, '{"key":"x"}');
    const mode = fs.statSync(f).mode & 0o777;
    assert.equal(mode, 0o600, `期望 0o600，实际 ${mode.toString(8)}`);
    // 目录不该被放宽到人人可进
    assert.notEqual(fs.statSync(dir).mode & 0o077, 0o077);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('V9：hardenSensitiveFilePermissions 把过宽的旧文件修正为 0o600', {
  skip: IS_WINDOWS ? 'Windows 上 POSIX 位映射为 ACL，跳过' : false,
}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kk-sec-'));
  try {
    // 模拟历史遗留：按 umask 生成的 0644 文件
    for (const name of ['auth-key.json', 'connections.json', 'ai/providers.json']) {
      const f = path.join(dir, name);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, '{}', { mode: 0o644 });
    }
    // 一个不该被误伤的普通文件
    fs.writeFileSync(path.join(dir, 'tmp-note.txt'), 'hi', { mode: 0o644 });

    const r = hardenSensitiveFilePermissions(dir);
    assert.equal(fs.statSync(path.join(dir, 'auth-key.json')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(dir, 'connections.json')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(dir, 'ai', 'providers.json')).mode & 0o777, 0o600);
    assert.ok(r.fixed.length >= 3, `应报告修正了哪些：${r.fixed.join(',')}`);

    // 普通文件不在敏感清单里，权限不该被动
    assert.equal(fs.statSync(path.join(dir, 'tmp-note.txt')).mode & 0o777, 0o644);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('V9：不存在的敏感文件被静默跳过（首次启动时大部分还不存在）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kk-sec-'));
  try {
    const r = hardenSensitiveFilePermissions(dir);
    assert.deepEqual(r.failed, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ─────────────────────── V8：链接协议白名单 ─────────────────────── */

test('V8：http / https 可点', () => {
  assert.equal(safeHref('https://example.com/a'), 'https://example.com/a');
  assert.equal(safeHref('http://example.com'), 'http://example.com');
  assert.equal(safeHref('HTTPS://EXAMPLE.COM'), 'HTTPS://EXAMPLE.COM');
});

test('V8：mailto / tel 可点', () => {
  assert.equal(safeHref('mailto:a@b.com'), 'mailto:a@b.com');
  assert.equal(safeHref('tel:+8613800138000'), 'tel:+8613800138000');
});

test('V8：站内锚点与相对路径可点', () => {
  assert.equal(safeHref('#section'), '#section');
  assert.equal(safeHref('/local/path'), '/local/path');
});

test('V8：javascript: 一律不可点（这是漏洞本体）', () => {
  assert.equal(safeHref('javascript:alert(1)'), null);
  assert.equal(safeHref('JavaScript:alert(1)'), null);
  assert.equal(safeHref('  javascript:alert(1)'), null);
});

test('V8：控制字符绕过不了白名单', () => {
  // `java\tscript:` / `java\nscript:` 这类是经典绕过手法
  assert.equal(safeHref('java\tscript:alert(1)'), null);
  assert.equal(safeHref('java\nscript:alert(1)'), null);
  assert.equal(safeHref('\u0001javascript:alert(1)'), null);
  assert.equal(safeHref('javascript\u0000:alert(1)'), null);
});

test('V8：其它危险协议一律不可点', () => {
  assert.equal(safeHref('data:text/html,<script>alert(1)</script>'), null);
  assert.equal(safeHref('vbscript:msgbox(1)'), null);
  assert.equal(safeHref('file:///etc/passwd'), null);
  assert.equal(safeHref('blob:https://x/y'), null);
});

test('V8：空值 / 非字符串返回 null', () => {
  assert.equal(safeHref(''), null);
  assert.equal(safeHref('   '), null);
  assert.equal(safeHref(undefined), null);
  assert.equal(safeHref(null), null);
  assert.equal(safeHref(42), null);
  assert.equal(safeHref({ toString: () => 'javascript:x' }), null);
});

test('V8：协议相对 URL 原样放行（由浏览器继承当前页协议，内网 http 不被强行跳 https）', () => {
  assert.equal(safeHref('//example.com/a'), '//example.com/a');
});

/* ─────────── V1e：反向 WS 握手前鉴权（verifyClient，补 V1 的实时通道） ─────────── */

/** 借一个空闲端口给临时 WS 服务器用，避免与其它测试或真实服务抢端口 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close(() => resolve(addr.port));
    });
  });
}

// OneBotWsServer 只用到 info/warn/error，给个哑实现
const noopLogger = {
  info() {}, warn() {}, error() {}, debug() {}, verbose() {}, silly() {},
} as unknown as import('../src/core/logger.js').Logger;

function startWsServer(port: number, accessToken = ''): OneBotWsServer {
  const srv = new OneBotWsServer({
    connection: {
      id: 'v1e', name: 'V1e', type: 'onebot', mode: 'reverse',
      host: '127.0.0.1', port, accessToken, enable: true, createdAt: 1,
    } as unknown as import('../src/core/types.js').ConnectionConfig,
    logger: noopLogger,
  });
  srv.start();
  return srv;
}

/** 连反向 WS 服务器。返回是否握手成功，及失败时的 HTTP 状态码（被拒应为 401） */
function connect(
  port: number,
  headers: Record<string, string> = {},
  token?: string,
): Promise<{ ok: boolean; code?: number }> {
  return new Promise((resolve) => {
    if (token) headers.authorization = token;
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers });
    let settled = false;
    const done = (ok: boolean, code?: number) => {
      if (settled) return;
      settled = true;
      try { ws.terminate(); } catch { /* 已关闭 */ }
      resolve({ ok, code });
    };
    // 握手被 verifyClient 拒绝：服务端回 401（非 101），客户端走 unexpected-response
    ws.on('unexpected-response', (_req: unknown, res: import('node:http').IncomingMessage) => {
      done(false, res.statusCode);
    });
    ws.on('open', () => done(true));
    ws.on('error', () => done(false));
    // 兜底：任何异常都不该让测试挂死
    setTimeout(() => done(false), 3000);
  });
}

test('V1e：无 token + 带反向代理头 → 握手前被拒（401），不复现「先连上再被踢」', async () => {
  const port = await freePort();
  const srv = startWsServer(port);
  try {
    // 等 listening 完成，避免客户端抢在 listen 之前连导致 ECONNREFUSED 误判
    await new Promise((r) => setTimeout(r, 100));
    const r = await connect(port, { 'x-forwarded-for': '8.8.8.8' });
    assert.equal(r.ok, false, '带代理头的无 token 连接必须失败');
    assert.equal(r.code, 401, '握手前拒绝应回 401（而非完成 101 再 close）');
  } finally {
    srv.stop();
  }
});

test('V1e：无 token + 本机直连（无代理头）→ 握手成功，不能误杀传统本机部署', async () => {
  const port = await freePort();
  const srv = startWsServer(port);
  try {
    await new Promise((r) => setTimeout(r, 100));
    const r = await connect(port, {});
    assert.equal(r.ok, true, '本机直连无 token 应放行（NapCat 同机接入是默认形态）');
  } finally {
    srv.stop();
  }
});

test('V1e：配了正确 token → 握手成功（token 路径也走握手前校验，不依赖事后 close）', async () => {
  const port = await freePort();
  const srv = startWsServer(port, 'v1e-secret');
  try {
    await new Promise((r) => setTimeout(r, 100));
    const r = await connect(port, {}, 'v1e-secret');
    assert.equal(r.ok, true, '正确 token 应握手成功');
  } finally {
    srv.stop();
  }
});

test('V1e：配了错误 token → 握手前被拒（401）', async () => {
  const port = await freePort();
  const srv = startWsServer(port, 'v1e-secret');
  try {
    await new Promise((r) => setTimeout(r, 100));
    const r = await connect(port, {}, 'wrong-token');
    assert.equal(r.ok, false, '错误 token 必须失败');
    assert.equal(r.code, 401, '错误 token 应回 401');
  } finally {
    srv.stop();
  }
});

// ============================================================
// V2：更新链离线 Ed25519 签名验签（防镜像 / 中间人替换包体）
// ============================================================

test('V2：verifyUpdateSignatureDigest 对未知 keyId / 非法签名返回 false（fail-closed）', () => {
  // 未知 keyId → 直接拒绝
  assert.equal(verifyUpdateSignatureDigest('a'.repeat(64), 'AAAA', 'no-such-key'), false);
  // 真实 keyId 但签名内容随机 → 拒绝
  assert.equal(verifyUpdateSignatureDigest('a'.repeat(64), 'AAAA', 'kakake-2026'), false);
});

test('V2：端到端 Ed25519 签名→验签链路正确（临时密钥，验证算法本身）', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const payload = Buffer.from('kakake update package v9.9.9');
  const digest = createHash('sha256').update(payload).digest();
  const sig = sign(null, digest, privateKey);
  const sigB64 = sig.toString('base64');
  // 把临时公钥注入 key ring（测试内可变对象），验证后即删除
  const ring = UPDATE_SIGNING_KEYS as SigningKeyRing & Record<string, string>;
  const testKeyId = '__v2_test_key__';
  ring[testKeyId] = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  try {
    assert.equal(verifyUpdateSignatureDigest(digest.toString('hex'), sigB64, testKeyId), true);
    // 篡改摘要 → 验签必须失败
    const tampered = createHash('sha256').update(Buffer.from('evil')).digest();
    assert.equal(
      verifyUpdateSignatureDigest(tampered.toString('hex'), sigB64, testKeyId),
      false,
      '摘要被篡改后验签必须失败',
    );
    // 用错 keyId → 验签必须失败
    assert.equal(
      verifyUpdateSignatureDigest(digest.toString('hex'), sigB64, 'kakake-2026'),
      false,
      '用错 keyId 验签必须失败',
    );
    // 用错公钥（另一把私钥）签的也验不过
    const other = generateKeyPairSync('ed25519');
    const badSig = sign(null, digest, other.privateKey);
    assert.equal(
      verifyUpdateSignatureDigest(digest.toString('hex'), badSig.toString('base64'), testKeyId),
      false,
      '别人私钥签的验不过',
    );
  } finally {
    delete ring[testKeyId];
  }
});
