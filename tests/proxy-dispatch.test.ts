/**
 * 接口代理分发内核的行为契约。
 *
 * 覆盖四条最容易被改坏的铁律，每条都对应一个真实的用户需求：
 *
 *   1. **绝不空返回**。任何一步失败都要返回信封，而不是 throw / undefined / null。
 *      即：成功即成功、报错即报错、超时即超时。
 *   2. **报错即报错**。协议端回了失败信封，就原样透传，不修饰、不吞掉。
 *      HTTP 500 + 非 JSON 响应体这种「连信封都没有」的情况，也绝不许报成功。
 *   3. **参数键名一致**。插件永远写统一键名，改名/常量注入/路径占位全在代理层做。
 *   4. **钩子可用且不外溢**。before 能拦截能改写，after 能取值，error 能被通知；
 *      钩子自己抛异常不该把整条调用拖下水。
 *
 * 这个文件用注入的假寻址 + 假传输跑完整条 dispatch 链路，不碰真实连接，
 * 因此它锁的是逻辑本身，不是某个协议端的偶然行为。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dispatch,
  dispatchNative,
  type DispatchDeps,
  type ProxyTarget,
  type ProxyTargetResult,
  RawResponse,
} from '../src/proxy/runtime/dispatcher.js';
import { ProxyHookRegistry } from '../src/proxy/runtime/hooks.js';
import { createProxyTargetResolver } from '../src/proxy/resolve/target.js';
import { detectOnebotImpl, implFromVersionInfo, clearImplCache } from '../src/proxy/resolve/impl-detect.js';
import { pickVariant, resolveOfficialPath, stripPathKeys, extractPathKeys } from '../src/proxy/translate/params.js';
import { PROXY_RETCODE } from '../src/proxy/proxy.types.js';

/* ─────────────────────────── 测试替身 ─────────────────────────── */

interface Recorded {
  target: ProxyTarget;
  action?: string;
  path?: string;
  verb?: string;
  params: Record<string, unknown>;
  method: string;
}

/** 按脚本返回响应的假传输，并把每次调用记下来供断言 */
function stubTransport(script: Array<(call: Recorded) => RawResponse>) {
  const calls: Recorded[] = [];
  let i = 0;
  return {
    calls,
    async call(target: ProxyTarget, call: { action?: string; path?: string; verb?: string; params: Record<string, unknown>; method: string }): Promise<RawResponse> {
      const rec: Recorded = { target, action: call.action, path: call.path, verb: call.verb, params: call.params, method: call.method };
      calls.push(rec);
      const step = script[Math.min(i, script.length - 1)];
      i++;
      return step(rec);
    },
  };
}

function okEnv(data: unknown): RawResponse {
  return { ok: true, httpStatus: 200, payload: { status: 'ok', retcode: 0, data, message: '', echo: 'e1' } };
}

function failedEnv(): RawResponse {
  return { ok: true, httpStatus: 200, payload: { status: 'failed', retcode: 1200, data: null, message: '权限不足', wording: '权限不足', echo: 'e1' } };
}

function makeDeps(
  transport: ReturnType<typeof stubTransport>,
  target: ProxyTargetResult,
  hooks = new ProxyHookRegistry(),
): DispatchDeps {
  return {
    hooks,
    resolveTarget: async () => target,
    transport,
    defaultTimeoutMs: 30_000,
    scope: 'test',
  };
}

const NAPCAT: ProxyTargetResult = {
  ok: true,
  target: { protocol: 'napcat', connectionId: 'c1', onebotImpl: 'napcat' },
};
const OFFICIAL: ProxyTargetResult = {
  ok: true,
  target: { protocol: 'official', connectionId: 'c2' },
};

type Res = Awaited<ReturnType<typeof dispatch>>;

/* ─────────────────────────── 1. 绝不空返回 ─────────────────────────── */

test('未知短名 → unknown-api 信封，不是 throw 也不是 undefined', async () => {
  const t = stubTransport([() => okEnv(null)]);
  const r: Res = await dispatch(makeDeps(t, NAPCAT), { api: 'no_such_api', method: 'POST', params: {} });
  assert.equal(r.status, 'failed');
  assert.equal(r._proxy.failure, 'unknown-api');
  assert.equal(r.retcode, PROXY_RETCODE.unknownApi);
  assert.ok(r.message.includes('no_such_api'), '错误信息里要点名这个短名');
  assert.equal(t.calls.length, 0, '查不到接口就不该发请求');
});

test('连不上 → not-connected 信封，并说明原因', async () => {
  const t = stubTransport([() => okEnv(null)]);
  const r = await dispatch(
    makeDeps(t, { ok: false, reason: '连接「主号」当前未连接' }),
    { api: 'send_text', method: 'POST', params: { scene: 'group', group_id: 123456 } },
  );
  assert.equal(r.status, 'failed');
  assert.equal(r._proxy.failure, 'not-connected');
  assert.equal(r.retcode, PROXY_RETCODE.notConnected);
  assert.ok(r.message.includes('未连接'));
  assert.equal(t.calls.length, 0);
});

test('超时 → timeout 信封（不是 reject，也不是空 data）', async () => {
  const t = stubTransport([() => ({ ok: false, timedOut: true, error: 'x' })]);
  const r = await dispatch(makeDeps(t, NAPCAT), {
    api: 'send_text', method: 'POST', params: { scene: 'group', group_id: 123456, message: 'hi' },
  });
  assert.equal(r.status, 'failed');
  assert.equal(r._proxy.failure, 'timeout');
  assert.equal(r.retcode, PROXY_RETCODE.timeout);
  assert.ok(r.message.includes('超时'));
});

test('网络错误 → network 信封', async () => {
  const t = stubTransport([() => ({ ok: false, error: 'ECONNREFUSED' })]);
  const r = await dispatch(makeDeps(t, NAPCAT), {
    api: 'send_text', method: 'POST', params: { scene: 'group', group_id: 123456, message: 'hi' },
  });
  assert.equal(r._proxy.failure, 'network');
  assert.equal(r.retcode, PROXY_RETCODE.network);
  assert.ok(r.message.includes('ECONNREFUSED'), '上游错误原因要带出来');
});

test('协议不支持 → unsupported 信封，并列出该接口支持哪些协议', async () => {
  const t = stubTransport([() => okEnv(null)]);
  // send_markdown 是官方专属，喂一个 napcat 目标
  const r = await dispatch(makeDeps(t, NAPCAT), { api: 'send_markdown', method: 'POST', params: { scene: 'group', group_openid: '9A0B0C1D2E3F4A5B6C7D8E9F0A1B2C3D', markdown: { content: '**hi**' } } });
  assert.equal(r.status, 'failed');
  assert.equal(r._proxy.failure, 'unsupported');
  assert.equal(r.retcode, PROXY_RETCODE.unsupported);
  assert.ok(r.message.includes('NapCat'), '要说明当前连接是什么');
  assert.ok(r.message.includes('官方'), '要说明该接口支持什么');
});

test('缺 scene → missing-param（少传参数，不是协议不支持）', async () => {
  const t = stubTransport([() => okEnv(null)]);
  const r = await dispatch(makeDeps(t, NAPCAT), { api: 'send_text', method: 'POST', params: { message: 'hi' } });
  assert.equal(r._proxy.failure, 'missing-param');
  assert.equal(r.retcode, PROXY_RETCODE.missingParam);
  assert.ok(r.message.includes('scene'));
  assert.equal(t.calls.length, 0, '选不出变体就不该发请求');
});

/* ─────────────────────────── 2. 报错即报错 ─────────────────────────── */

test('OneBot 失败信封：ok=true 但 status=failed → 原样透传，一个字段不改', async () => {
  const t = stubTransport([() => failedEnv()]);
  const r = await dispatch(makeDeps(t, NAPCAT), {
    api: 'send_text', method: 'POST', params: { scene: 'group', group_id: 123456, message: 'hi' },
  });
  assert.equal(r.status, 'failed');
  assert.equal(r.retcode, 1200, 'retcode 用协议端的，不是代理层自己编的');
  assert.equal(r.message, '权限不足');
  assert.equal(r.data, null);
  assert.equal(r._proxy.httpStatus, 200, 'HTTP 200 也可能是一次失败调用');
});

test('成功信封的 data / message / wording / echo 全部保留', async () => {
  const t = stubTransport([() => ({
    ok: true, httpStatus: 200,
    payload: { status: 'ok', retcode: 0, data: { message_id: 42 }, message: '', wording: '', echo: 'e1' },
  })]);
  const r = await dispatch(makeDeps(t, NAPCAT), {
    api: 'send_text', method: 'POST', params: { scene: 'group', group_id: 123456, message: 'hi' },
  });
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.data, { message_id: 42 });
});

test('非信封响应体 + HTTP 500 → 必须报失败（回归防线）', async () => {
  // 这个 case 曾经被写成「非信封形态按成功处理」：协议端返回 HTML 错误页时
  // 代理层会谎报 status:'ok'。宁可信息少，不可撒谎。
  const t = stubTransport([() => ({ ok: true, httpStatus: 500, payload: '<html>Bad Gateway</html>' })]);
  const r = await dispatch(makeDeps(t, NAPCAT), {
    api: 'send_text', method: 'POST', params: { scene: 'group', group_id: 123456, message: 'hi' },
  });
  assert.equal(r.status, 'failed');
  assert.equal(r.retcode, 500);
  assert.equal(r._proxy.httpStatus, 500);
  assert.equal(r.data, '<html>Bad Gateway</html>', '原文照样放进 data，绝不丢');
});

test('官方失败响应（HTTP 400 + {code,message}）→ failed 信封，retcode 用官方的', async () => {
  const t = stubTransport([() => ({
    ok: true, httpStatus: 400,
    payload: { code: 10003, message: 'UnknownChannel 子频道异常' },
  })]);
  const r = await dispatch(makeDeps(t, OFFICIAL), { api: 'send_markdown', method: 'POST',     params: { scene: 'group', group_openid: '9A0B0C1D2E3F4A5B6C7D8E9F0A1B2C3D', markdown: { content: '**hi**' } }, });
  assert.equal(r.status, 'failed');
  assert.equal(r.retcode, 10003, 'retcode 要取官方 body 里的 code');
  assert.equal(r.message, 'UnknownChannel 子频道异常');
  assert.deepEqual(r.data, { code: 10003, message: 'UnknownChannel 子频道异常' });
});

test('官方成功响应（裸业务对象）→ data 原样落进信封', async () => {
  const t = stubTransport([() => ({ ok: true, httpStatus: 200, payload: { message_id: 'abc' } })]);
  const r = await dispatch(makeDeps(t, OFFICIAL), { api: 'send_markdown', method: 'POST',     params: { scene: 'group', group_openid: '9A0B0C1D2E3F4A5B6C7D8E9F0A1B2C3D', markdown: { content: '**hi**' } }, });
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.data, { message_id: 'abc' });
});

/* ─────────────────────── 3. 参数键名一致 ─────────────────────── */

test('scene 派发 + 派发字段不透传', async () => {
  const t = stubTransport([() => okEnv({ message_id: 1 })]);
  const r = await dispatch(makeDeps(t, NAPCAT), {
    api: 'send_text', method: 'POST', params: { scene: 'group', group_id: 123456, message: '你好' },
  });
  assert.equal(r.status, 'ok');
  assert.equal(t.calls[0].action, 'send_group_msg');
  assert.equal(t.calls[0].method, 'POST');
  assert.deepEqual(t.calls[0].params, { group_id: 123456, message: '你好' }, 'scene 是派发字段，不能发给协议端');
});

test('官方路径占位替换 + 路径键不进请求体', async () => {
  const t = stubTransport([() => ({ ok: true, httpStatus: 200, payload: null })]);
  // recall_msg 官方私聊变体：DELETE /v2/users/{openid}/messages/{message_id}
  await dispatch(makeDeps(t, OFFICIAL), {
    api: 'recall_msg', method: 'POST',
    params: {
      scene: 'private',
      openid: 'AF4C2B8D1E5F4A6B8C0D2E4F6A8B0C2D',
      message_id: '08c0e0b0f1a2b3c4d5e6f708192a3b4c',
    },
  });
  assert.equal(t.calls[0].verb, 'DELETE');
  assert.equal(
    t.calls[0].path,
    '/v2/users/AF4C2B8D1E5F4A6B8C0D2E4F6A8B0C2D/messages/08c0e0b0f1a2b3c4d5e6f708192a3b4c',
  );
  assert.deepEqual(t.calls[0].params, {}, '已经写进路径的键不该再出现在 body 里');
});

test('常量注入：官方 msg_type 由代理层补，插件不用写', async () => {
  const t = stubTransport([() => okEnv({ message_id: 'x' })]);
  await dispatch(makeDeps(t, OFFICIAL), {
    api: 'send_text', method: 'POST',
    params: { scene: 'group', group_openid: '9A0B0C1D2E3F4A5B6C7D8E9F0A1B2C3D', content: 'hi' },
  });
  assert.equal(t.calls[0].params.msg_type, 0);
  assert.equal(t.calls[0].path, '/v2/groups/9A0B0C1D2E3F4A5B6C7D8E9F0A1B2C3D/messages');
});

test('野生侧 transforms：file → OneBot image 消息段', async () => {
  const t = stubTransport([() => okEnv({ message_id: 1 })]);
  await dispatch(makeDeps(t, NAPCAT), {
    api: 'send_image', method: 'POST', params: { scene: 'private', user_id: 10001, file: 'https://x/pic.jpg' },
  });
  assert.equal(t.calls[0].action, 'send_private_msg');
  assert.deepEqual(t.calls[0].params.message, [{ type: 'image', data: { file: 'https://x/pic.jpg' } }]);
});

test('官方富媒体两步上传：先拿 file_info，再以 media 发出，且 file 不重复进 body', async () => {
  const t = stubTransport([
    () => ({ ok: true, httpStatus: 200, payload: { file_info: 'fi-123' } }),
    () => ({ ok: true, httpStatus: 200, payload: { message_id: 'm1' } }),
  ]);
  const r = await dispatch(makeDeps(t, OFFICIAL), {
    api: 'send_image', method: 'POST',
    params: { scene: 'group', group_openid: '9A0B0C1D2E3F4A5B6C7D8E9F0A1B2C3D', file: 'https://x/pic.jpg' },
  });
  assert.equal(r.status, 'ok');
  assert.equal(t.calls.length, 2, '必须是两次请求');
  // 第一次：上传
  assert.equal(t.calls[0].path, '/v2/groups/9A0B0C1D2E3F4A5B6C7D8E9F0A1B2C3D/files');
  assert.deepEqual(
    t.calls[0].params,
    { url: 'https://x/pic.jpg', file_type: 1, srv_send_msg: false },
    '前置上传请求只该带它自己要的字段，主变体的 msg_type 不该漏过去',
  );
  // 第二次：发消息，带上了 media，且不再带已经被消费掉的 file
  assert.equal(t.calls[1].path, '/v2/groups/9A0B0C1D2E3F4A5B6C7D8E9F0A1B2C3D/messages');
  assert.equal(t.calls[1].params.media, 'fi-123');
  assert.equal(t.calls[1].params.msg_type, 7);
  assert.equal('file' in t.calls[1].params, false, 'file 已换成 file_info，不该再原样透传');
});

test('前置上传失败 → 整条按失败透传，主请求根本不该发出', async () => {
  const t = stubTransport([
    () => ({ ok: true, httpStatus: 400, payload: { code: 40005, message: '图片过大' } }),
    () => okEnv({ message_id: 'm1' }),
  ]);
  const r = await dispatch(makeDeps(t, OFFICIAL), {
    api: 'send_image', method: 'POST',
    params: { scene: 'group', group_openid: '9A0B0C1D2E3F4A5B6C7D8E9F0A1B2C3D', file: 'https://x/pic.jpg' },
  });
  assert.equal(r.status, 'failed');
  assert.equal(r.retcode, 40005, '上传阶段的错误码要原样透传');
  assert.equal(t.calls.length, 1, '上传就失败了，发消息那一步不许发生');
});

test('ID 空间不匹配：官方接口收到 QQ 号 → id-space 报错，不发请求', async () => {
  const t = stubTransport([() => okEnv(null)]);
  const r = await dispatch(makeDeps(t, OFFICIAL), {
    api: 'send_text', method: 'POST',
    params: { scene: 'group', group_openid: '123456', content: 'hi' },
  });
  assert.equal(r._proxy.failure, 'id-space');
  assert.equal(r.retcode, PROXY_RETCODE.idSpace);
  assert.ok(r.message.includes('openid'), '要告诉调用方该传什么');
  assert.equal(t.calls.length, 0);
});

/* ─────────────────── 统一发消息（send_msg） ─────────────────── */

test('统一发消息：官方纯文本不触发上传前置（skipWhenMissing=file）', async () => {
  const t = stubTransport([() => ({ ok: true, httpStatus: 200, payload: { id: 'm1' } })]);
  const r = await dispatch(makeDeps(t, OFFICIAL), {
    api: 'send_msg', method: 'POST',
    params: { scene: 'group', group_openid: '9A0B0C1D2E3F4A5B6C7D8E9F0A1B2C3D', message: 'hi' },
  });
  assert.equal(r.status, 'ok');
  assert.equal(t.calls.length, 1, '纯文本只发主请求，不走 /files 上传');
  assert.equal(t.calls[0].params.msg_type, 0);
  assert.equal(t.calls[0].params.content, 'hi');
  assert.equal('media' in t.calls[0].params, false);
  assert.equal('file' in t.calls[0].params, false, '便捷键 file 不许漏进官方请求体');
});

test('统一发消息：官方单发图片 URL → 上传走 url 字段，msg_type=7', async () => {
  const t = stubTransport([
    () => ({ ok: true, httpStatus: 200, payload: { file_info: 'fi-9' } }),
    () => ({ ok: true, httpStatus: 200, payload: { message_id: 'm2' } }),
  ]);
  const r = await dispatch(makeDeps(t, OFFICIAL), {
    api: 'send_msg', method: 'POST',
    params: { scene: 'group', group_openid: '9A0B0C1D2E3F4A5B6C7D8E9F0A1B2C3D', file: 'https://x/pic.jpg' },
  });
  assert.equal(r.status, 'ok');
  assert.deepEqual(
    t.calls[0].params,
    { url: 'https://x/pic.jpg', file_type: 1, srv_send_msg: false },
    '上传体只含 url / file_type / srv_send_msg，原始 file 已被 drop',
  );
  assert.equal(t.calls[1].params.msg_type, 7);
  assert.equal(t.calls[1].params.media, 'fi-9');
});

test('统一发消息：官方 base64 资源 → 走 file_data 而不是 url', async () => {
  const t = stubTransport([
    () => ({ ok: true, httpStatus: 200, payload: { file_info: 'fi-b64' } }),
    () => ({ ok: true, httpStatus: 200, payload: { message_id: 'm3' } }),
  ]);
  await dispatch(makeDeps(t, OFFICIAL), {
    api: 'send_msg', method: 'POST',
    params: { scene: 'private', openid: 'AF4C2B8D1E5F4A6B8C0D2E4F6A8B0C2D', file: 'base64://QUJD', media_type: 'record' },
  });
  assert.equal(t.calls[0].path, '/v2/users/AF4C2B8D1E5F4A6B8C0D2E4F6A8B0C2D/files');
  assert.deepEqual(t.calls[0].params, { file_data: 'QUJD', file_type: 3, srv_send_msg: false });
  assert.equal(t.calls[1].params.msg_type, 7);
});

test('统一发消息：野生 file+media_type=record → 单发语音消息段', async () => {
  const t = stubTransport([() => okEnv({ message_id: 1 })]);
  await dispatch(makeDeps(t, NAPCAT), {
    api: 'send_msg', method: 'POST',
    params: { scene: 'private', user_id: 10001, file: 'base64://QUJD', media_type: 'record' },
  });
  assert.equal(t.calls[0].action, 'send_private_msg');
  assert.deepEqual(t.calls[0].params.message, [{ type: 'record', data: { file: 'base64://QUJD' } }]);
  assert.equal('file' in t.calls[0].params, false);
  assert.equal('media_type' in t.calls[0].params, false);
});

test('统一发消息：野生 message 段数组原样透传（图文混发由数组表达）', async () => {
  const t = stubTransport([() => okEnv({ message_id: 2 })]);
  const segments = [
    { type: 'text', data: { text: '看这张图 ' } },
    { type: 'image', data: { file: 'https://x/pic.jpg' } },
  ];
  await dispatch(makeDeps(t, NAPCAT), {
    api: 'send_msg', method: 'POST',
    params: { scene: 'group', group_id: 123456, message: segments },
  });
  assert.deepEqual(t.calls[0].params.message, segments, '无 file 时不重构，协议端原生支持');
});

test('统一发消息：file 与 message 字符串同传 → 媒体段在前、文字段在后', async () => {
  const t = stubTransport([() => okEnv({ message_id: 3 })]);
  await dispatch(makeDeps(t, NAPCAT), {
    api: 'send_msg', method: 'POST',
    params: { scene: 'group', group_id: 123456, file: 'https://x/pic.jpg', message: '看这张图' },
  });
  assert.deepEqual(t.calls[0].params.message, [
    { type: 'image', data: { file: 'https://x/pic.jpg' } },
    { type: 'text', data: { text: '看这张图' } },
  ]);
});

/* ─────────────────────────── 4. 钩子 ─────────────────────────── */

test('before 返回 false → intercepted，请求不发', async () => {
  const hooks = new ProxyHookRegistry();
  hooks.before('test', () => false);
  const t = stubTransport([() => okEnv(null)]);
  const r = await dispatch(makeDeps(t, NAPCAT, hooks), {
    api: 'send_text', method: 'POST', params: { scene: 'group', group_id: 123456, message: 'hi' },
  });
  assert.equal(r._proxy.failure, 'intercepted');
  assert.equal(r.retcode, PROXY_RETCODE.intercepted);
  assert.equal(t.calls.length, 0);
});

test('before 返回对象 → 用改写后的参数发', async () => {
  const hooks = new ProxyHookRegistry();
  hooks.before('test', (api, params) => ({ ...params, message: `[已审核] ${String(params.message)}` }));
  const t = stubTransport([() => okEnv(null)]);
  await dispatch(makeDeps(t, NAPCAT, hooks), {
    api: 'send_text', method: 'POST', params: { scene: 'group', group_id: 123456, message: 'hi' },
  });
  assert.equal(t.calls[0].params.message, '[已审核] hi');
});

test('after 钩子能拿到最终结果', async () => {
  const hooks = new ProxyHookRegistry();
  let seen: unknown = null;
  hooks.after('test', (_api, _p, result) => { seen = result; });
  const t = stubTransport([() => okEnv({ message_id: 7 })]);
  await dispatch(makeDeps(t, NAPCAT, hooks), {
    api: 'send_text', method: 'POST', params: { scene: 'group', group_id: 123456, message: 'hi' },
  });
  assert.ok(seen && typeof seen === 'object');
  assert.equal((seen as { data: { message_id: number } }).data.message_id, 7);
});

test('error 钩子在失败时被通知', async () => {
  const hooks = new ProxyHookRegistry();
  let failure: string | undefined;
  hooks.error('test', (_api, _p, err) => { failure = err.failure; });
  const t = stubTransport([() => ({ ok: false, timedOut: true })]);
  await dispatch(makeDeps(t, NAPCAT, hooks), {
    api: 'send_text', method: 'POST', params: { scene: 'group', group_id: 123456, message: 'hi' },
  });
  assert.equal(failure, 'timeout');
});

test('钩子自己抛异常不该拖垮调用', async () => {
  const hooks = new ProxyHookRegistry();
  hooks.before('test', () => { throw new Error('钩子炸了'); });
  const t = stubTransport([() => okEnv({ message_id: 1 })]);
  const r = await dispatch(makeDeps(t, NAPCAT, hooks), {
    api: 'send_text', method: 'POST', params: { scene: 'group', group_id: 123456, message: 'hi' },
  });
  assert.equal(r.status, 'ok', '钩子异常按放行处理，调用继续');
  assert.equal(t.calls.length, 1);
});

test('clearScope 只摘掉自己作用域的钩子', async () => {
  const hooks = new ProxyHookRegistry();
  let a = 0;
  let b = 0;
  hooks.after('pluginA', () => { a++; });
  hooks.after('pluginB', () => { b++; });
  assert.equal(hooks.size(), 2);
  assert.equal(hooks.clearScope('pluginA'), 1);
  assert.equal(hooks.size(), 1);
  await hooks.runAfter('pluginB', 'send_text', {}, {}, { protocol: 'napcat', connectionId: 'c1', source: {} });
  assert.equal(a, 0, 'pluginA 的钩子已被摘掉');
  assert.equal(b, 1, 'pluginB 的钩子不受影响');
});

/* ─────────────────────── 逃生舱 call_native ─────────────────────── */

test('call_native 跳过变体选择与参数翻译，直连原生 action', async () => {
  const t = stubTransport([() => okEnv({ raw: true })]);
  const r = await dispatchNative(makeDeps(t, NAPCAT), {
    api: 'call_native', method: 'POST',
    params: { action: '_some_private_action', params: { foo: 1 } },
    target: NAPCAT.ok ? NAPCAT.target : ({} as ProxyTarget),
  });
  assert.equal(r.status, 'ok');
  assert.equal(t.calls[0].action, '_some_private_action');
  assert.deepEqual(t.calls[0].params, { foo: 1 });
  assert.equal(r._proxy.native, '_some_private_action');
});

/* ─────────────────────── 寻址层 ─────────────────────── */

function conn(id: string, name: string, extra: Partial<{ type: string; enable: boolean; isConnected: boolean; onebotImpl: 'auto' | 'napcat' | 'snowluma' }> = {}) {
  return { id, name, type: extra.type ?? 'onebot', enable: extra.enable ?? true, isConnected: extra.isConnected ?? true, onebotImpl: extra.onebotImpl };
}

function resolverWith(list: ReturnType<typeof conn>[], impl: 'napcat' | 'snowluma' | 'unknown' = 'napcat') {
  return createProxyTargetResolver({
    listConnections: () => list,
    detectOnebotImpl: async () => impl,
  });
}

test('寻址：conn 按 id 精确命中', async () => {
  const r = await resolverWith([conn('c1', '主号'), conn('c2', '小号')])('c2');
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.target.connectionId, 'c2');
});

test('寻址：conn 也认连接名', async () => {
  const r = await resolverWith([conn('c1', '主号')])('主号');
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.target.connectionId, 'c1');
});

test('寻址：conn 写错时明确报错并列出可用连接，不静默回落', async () => {
  const r = await resolverWith([conn('c1', '主号')])('不存在');
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.ok(r.reason.includes('不存在'));
    assert.ok(r.reason.includes('主号'), '要把可用连接列出来，便于排查');
  }
});

test('寻址：不传 conn 时优先已连接的 OneBot 连接', async () => {
  const r = await resolverWith([
    conn('c1', '官方', { type: 'qq_official', isConnected: true }),
    conn('c2', '主号', { isConnected: true }),
  ])();
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.target.protocol, 'napcat');
});

test('寻址：没有任何已连接 → not-connected', async () => {
  const r = await resolverWith([conn('c1', '主号', { isConnected: false })])();
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.reason.includes('没有已连接'));
});

test('寻址：停用的连接即使指定了也明确报错', async () => {
  const r = await resolverWith([conn('c1', '主号', { enable: false })])('c1');
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.reason.includes('停用'));
});

test('寻址：探测出 SnowLuma 时 protocol 为 snowluma', async () => {
  const r = await resolverWith([conn('c1', '主号')], 'snowluma')();
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.target.protocol, 'snowluma');
    assert.equal(r.target.onebotImpl, 'snowluma');
  }
});

test('寻址：认不出实现时按 napcat 走，但 onebotImpl 记为 unknown（不假装确定）', async () => {
  const r = await resolverWith([conn('c1', '主号')], 'unknown')();
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.target.protocol, 'napcat');
    assert.equal(r.target.onebotImpl, 'unknown');
  }
});

/* ─────────────────────── 实现识别 ─────────────────────── */

test('实现识别：显式指定优先于探测，不发探测请求', async () => {
  let probed = 0;
  const impl = await detectOnebotImpl('snowluma', 'c1', async () => { probed++; return { ok: true }; });
  assert.equal(impl, 'snowluma');
  assert.equal(probed, 0);
});

test('实现识别：auto 时按 app_name 认实现', async () => {
  clearImplCache('c-detect');
  const impl = await detectOnebotImpl('auto', 'c-detect', async () => ({
    ok: true,
    envelope: { data: { app_name: 'SnowLuma', app_version: '1.2.3' } },
  }));
  assert.equal(impl, 'snowluma');
  clearImplCache('c-detect');
});

test('实现识别：认不出来返回 unknown，不猜', async () => {
  assert.equal(implFromVersionInfo({ data: { app_name: 'SomeOtherBot' } }), 'unknown');
  assert.equal(implFromVersionInfo(null), 'unknown');
  assert.equal(implFromVersionInfo({ data: {} }), 'unknown');
  assert.equal(implFromVersionInfo({ data: { app_name: 'NapCat' } }), 'napcat');
});

test('实现识别：探测失败不该炸，按 unknown 继续', async () => {
  clearImplCache('c-detect-2');
  const impl = await detectOnebotImpl('auto', 'c-detect-2', async () => { throw new Error('网络炸了'); });
  assert.equal(impl, 'unknown');
  clearImplCache('c-detect-2');
});

/* ─────────────────────── 纯函数 ─────────────────────── */

test('pickVariant：scene 命中变体；取不到且有 * 时回落；两者皆无返回 null', () => {
  const impl = { variantBy: 'scene', variants: { group: { action: 'g' }, private: { action: 'p' } } };
  assert.equal(pickVariant(impl, { scene: 'group' })?.key, 'group');
  assert.equal(pickVariant(impl, { scene: 'channel' }), null, '没有 * 兜底时不猜');
  assert.equal(pickVariant(impl, {})?.key, undefined);
  const withStar = { variantBy: 'scene', variants: { group: { action: 'g' }, '*': { action: 'any' } } };
  assert.equal(pickVariant(withStar, { scene: 'channel' })?.key, '*');
  assert.equal(pickVariant(withStar, {})?.key, '*', 'scene 缺失时走 * 兜底');
});

test('resolveOfficialPath：占位替换、缺失收集、URL 编码', () => {
  const r = resolveOfficialPath('/v2/groups/{gid}/messages', { gid: 'a b/c' });
  assert.equal(r.path, '/v2/groups/a%20b%2Fc/messages');
  assert.deepEqual(r.missing, []);

  const miss = resolveOfficialPath('/v2/groups/{gid}/messages/{mid}', { gid: 'x' });
  assert.deepEqual(miss.missing, ['mid']);
  assert.ok(miss.path.includes('{mid}'), '缺失的占位原样留着，便于报错时指出');
});

test('resolveOfficialPath：主参数取不到时回退到原始统一键名', () => {
  // 条目把 group_id 映射成 group_openid，但路径里写的是统一键名——两种写法都要能通
  const r = resolveOfficialPath('/v2/groups/{group_id}/messages', { group_openid: 'X' }, { group_id: '123' });
  assert.equal(r.path, '/v2/groups/123/messages');
  assert.deepEqual(r.missing, []);
});

test('stripPathKeys：只摘路径键，其余原样保留', () => {
  assert.deepEqual(
    stripPathKeys({ a: 1, b: 2, message_id: 'm' }, extractPathKeys('/x/{message_id}')),
    { a: 1, b: 2 },
  );
  assert.deepEqual(stripPathKeys({ a: 1 }, []), { a: 1 }, '没有路径键时原样返回');
});
