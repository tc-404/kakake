/**
 * OneBot 双通道契约：旧 callOneBotHttpAction 失败必须 throw、成功只回 data；
 * 新 raw 通道不剥信封、不抛异常。A 部分挂了先回滚；B 部分挂了改新通道。
 */
import test, { afterEach, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { configService } from '../src/core/config.service.js';
import { DEFAULT_CONFIG } from '../src/core/types.js';
import { Logger } from '../src/core/logger.js';
import {
  callOneBotHttpAction,
  callOneBotHttpActionRaw,
} from '../src/connection/onebot-http.shared.js';
import type { OB11ApiResponse } from '../src/connection/onebot.types.js';

const BASE = 'http://127.0.0.1:3000';
const ACTION = 'send_msg';

/** 级别设成 error，debug 会被 LEVEL_ORDER 挡掉，测试期间不刷屏也不写日志存储 */
const logger = new Logger('[test] ', 'error', 'system');

/** 把信封对象当 loose 结构用，方便逐字段断言 */
type Env = { status?: string; retcode?: number; data?: unknown; message?: string; echo?: string };

const envOf = (r: { envelope?: unknown }): Env => r.envelope as Env;

function okEnvelope(data: unknown): string {
  return JSON.stringify({
    status: 'ok', retcode: 0, data, message: '', echo: 'echo-1',
  } satisfies OB11ApiResponse);
}

function failedEnvelope(): string {
  return JSON.stringify({
    status: 'failed', retcode: 1200, data: null, message: '权限不足', wording: '权限不足', echo: 'echo-1',
  } as OB11ApiResponse & { wording: string });
}

/**
 * 打桩 fetch。每次调用都现造一个 Response —— Response 的 body 是一次性流，
 * 同一个实例喂给两次调用会在第二次 `.text()` 时炸「body disturbed」。
 * 「对偶」那条用例要在同一份响应上跑两个函数，所以必须每次新鲜。
 *
 * body 传 null 表示无包体：204/304 这类状态按 HTTP 规范禁止带 body，
 * `new Response('', { status: 204 })` 本身就会抛，所以这儿得分开构造。
 */
function stubFetch(body: string | null, status = 200): void {
  mock.method(globalThis, 'fetch', async () => (
    body === null ? new Response(null, { status }) : new Response(body, { status })
  ));
}

function stubFetchThrows(err: unknown): void {
  mock.method(globalThis, 'fetch', async () => {
    throw err;
  });
}

/** AbortController.abort() 抛的就是这个形态的错，不是 Error 的子类 */
function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

beforeEach(() => {
  // 隔离真实配置：既避免测试期读盘，也让 apiTimeoutMs 是确定值
  mock.method(configService, 'getConfig', () => ({ ...DEFAULT_CONFIG, apiTimeoutMs: 50_000 }));
});

afterEach(() => {
  mock.restoreAll();
});

/* ═════════ A. 旧通道 callOneBotHttpAction：一条都不能变 ═════════ */

test('A1 成功：只 resolve data，信封字段一律不透出', async () => {
  stubFetch(okEnvelope({ message_id: 12345 }));
  const r = await callOneBotHttpAction(BASE, ACTION, { x: 1 }, undefined, logger);

  assert.deepEqual(r, { message_id: 12345 }, '返回的必须只是 data');
  const asAny = r as Record<string, unknown>;
  assert.equal(asAny.status, undefined, 'status 不该出现在返回值上');
  assert.equal(asAny.retcode, undefined, 'retcode 不该出现在返回值上');
  assert.equal(asAny.echo, undefined, 'echo 不该出现在返回值上');
});

test('A2 status=failed 抛异常，message 取 json.message', async () => {
  stubFetch(failedEnvelope());
  await assert.rejects(
    () => callOneBotHttpAction(BASE, ACTION, {}, undefined, logger),
    (err: unknown) => err instanceof Error && err.message === '权限不足',
    '抛出的 message 必须是协议端给的 message',
  );
});

test('A2b status=failed 且协议端没给 message：回退成 retcode 文案', async () => {
  stubFetch(JSON.stringify({ status: 'failed', retcode: 1200 }));
  await assert.rejects(
    () => callOneBotHttpAction(BASE, ACTION, {}, undefined, logger),
    (err: unknown) => err instanceof Error && err.message === 'API 失败 retcode=1200',
  );
});

test('A3 status=ok 但 retcode 非 0：照样抛（status 不是判据）', async () => {
  stubFetch(JSON.stringify({ status: 'ok', retcode: 1400, data: null, message: '群不存在' }));
  await assert.rejects(
    () => callOneBotHttpAction(BASE, ACTION, {}, undefined, logger),
    (err: unknown) => err instanceof Error && err.message === '群不存在',
  );
});

test('A3b status=ok、retcode 非 0 且无 message：回退成 retcode 文案', async () => {
  stubFetch(JSON.stringify({ status: 'ok', retcode: 1400 }));
  await assert.rejects(
    () => callOneBotHttpAction(BASE, ACTION, {}, undefined, logger),
    (err: unknown) => err instanceof Error && err.message === 'API 失败 retcode=1400',
  );
});

test('A4 HTTP 非 2xx 抛：优先取 json.message', async () => {
  stubFetch(failedEnvelope(), 500);
  await assert.rejects(
    () => callOneBotHttpAction(BASE, ACTION, {}, undefined, logger),
    (err: unknown) => err instanceof Error && err.message === '权限不足',
    '有 message 时以 message 为准，不暴露 HTTP 状态码',
  );
});

test('A4b HTTP 非 2xx 且 body 无 message：回退成 HTTP API {status}', async () => {
  stubFetch(JSON.stringify({ status: 'failed', retcode: 1200 }), 500);
  await assert.rejects(
    () => callOneBotHttpAction(BASE, ACTION, {}, undefined, logger),
    (err: unknown) => err instanceof Error && err.message === 'HTTP API 500',
  );
});

test('A4c HTTP 非 2xx 且 body 不是 JSON：报的是解析失败，不是 HTTP API 500', async () => {
  // 实现顺序是「先 JSON.parse，再判 res.ok」，所以两者同时成立时解析错误先抛。
  // 这条记录的是**当前实际顺序**，不是期望顺序 —— 改动顺序会让这条挂，届时先确认是有意调整。
  stubFetch('<html>502 Bad Gateway</html>', 500);
  await assert.rejects(
    () => callOneBotHttpAction(BASE, ACTION, {}, undefined, logger),
    (err: unknown) => err instanceof Error && err.message.includes('响应非 JSON'),
  );
});

test('A5 响应非 JSON 抛，message 含「响应非 JSON」', async () => {
  stubFetch('gateway timeout', 200);
  await assert.rejects(
    () => callOneBotHttpAction(BASE, ACTION, {}, undefined, logger),
    (err: unknown) => err instanceof Error && err.message.includes('响应非 JSON'),
  );
});

test('A6 空响应体抛「HTTP API 空响应」（仅在 HTTP 2xx 时成立）', async () => {
  // 「空响应」的判定在 res.ok 之后，所以 2xx + 空体才是这条语义
  stubFetch('', 200);
  await assert.rejects(
    () => callOneBotHttpAction(BASE, ACTION, {}, undefined, logger),
    (err: unknown) => err instanceof Error && err.message === 'HTTP API 空响应',
  );
});

test('A7 超时（AbortError）抛「API 超时: {action}」', async () => {
  stubFetchThrows(abortError());
  await assert.rejects(
    () => callOneBotHttpAction(BASE, ACTION, {}, undefined, logger),
    (err: unknown) => err instanceof Error && err.message === `API 超时: ${ACTION}`,
    '旧通道超时必须抛，且文案带 action 名便于定位',
  );
});

/* ═════════ B. 新通道 callOneBotHttpActionRaw：与 A 逐条对偶 ═════════ */

test('B1 成功：ok=true，envelope 是完整信封（retcode/message/echo 都在）', async () => {
  stubFetch(okEnvelope({ message_id: 12345 }));
  const r = await callOneBotHttpActionRaw(BASE, ACTION, { x: 1 }, undefined, logger);

  assert.equal(r.ok, true);
  assert.equal(r.httpStatus, 200);
  const env = envOf(r);
  assert.equal(env.retcode, 0, 'retcode 必须保留');
  assert.equal(env.status, 'ok');
  assert.equal(env.echo, 'echo-1', 'echo 必须保留——旧通道会丢掉它');
  assert.ok('message' in env, 'message 字段必须保留（哪怕值是空串）');
  assert.deepEqual(env.data, { message_id: 12345 });
});

test('B2 status=failed 仍是 ok=true：ok 表示「拿到响应」不是「调用成功」', async () => {
  stubFetch(failedEnvelope(), 200);
  const r = await callOneBotHttpActionRaw(BASE, ACTION, {}, undefined, logger);

  assert.equal(r.ok, true, '拿到协议端响应就算 ok，业务失败不是传输失败');
  assert.equal(r.httpStatus, 200);
  const env = envOf(r);
  assert.equal(env.status, 'failed');
  assert.equal(env.retcode, 1200);
  assert.equal(env.message, '权限不足', '失败原因要原样透出，不能丢');
});

test('B3 HTTP 500：ok=true 且 httpStatus=500', async () => {
  stubFetch(failedEnvelope(), 500);
  const r = await callOneBotHttpActionRaw(BASE, ACTION, {}, undefined, logger);

  assert.equal(r.ok, true, '4xx/5xx 也是协议端给的响应，属于「拿到结果」');
  assert.equal(r.httpStatus, 500);
  assert.equal(envOf(r).status, 'failed');
});

test('B4 超时：ok=false + timedOut=true，不抛异常', async () => {
  stubFetchThrows(abortError());
  const r = await callOneBotHttpActionRaw(BASE, ACTION, {}, undefined, logger);

  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
  assert.equal(r.error, `API 超时: ${ACTION}`);
  assert.equal(r.envelope, undefined, '超时了自然没有 envelope');
});

test('B5 响应非 JSON：ok=false + error', async () => {
  stubFetch('gateway timeout', 200);
  const r = await callOneBotHttpActionRaw(BASE, ACTION, {}, undefined, logger);

  assert.equal(r.ok, false);
  assert.ok(r.error?.includes('响应非 JSON'), `error 应说明原因，实际：${r.error}`);
  assert.equal(r.rawText, 'gateway timeout', '非 JSON 的原文要留着给调用方诊断');
});

test('B6 204 空包体：算「拿到响应」，envelope 为 null', async () => {
  stubFetch(null, 204);
  const r = await callOneBotHttpActionRaw(BASE, ACTION, {}, undefined, logger);

  assert.equal(r.ok, true, '204 空包体是正常响应，不是错误');
  assert.equal(r.httpStatus, 204);
  assert.equal(r.envelope, null);
  assert.equal(r.error, undefined, '既然算拿到响应就不该带 error');
});

/* ═════════ 对偶：两条通道必须在同一份响应上分道扬镳 ═════════ */

test('对偶：同一份 failed 信封，旧通道抛、raw 通道照原样返回', async () => {
  stubFetch(failedEnvelope(), 200);

  await assert.rejects(
    () => callOneBotHttpAction(BASE, ACTION, {}, undefined, logger),
    (err: unknown) => err instanceof Error && err.message === '权限不足',
    '旧通道：业务失败 = 抛异常',
  );

  const r = await callOneBotHttpActionRaw(BASE, ACTION, {}, undefined, logger);
  assert.equal(r.ok, true, 'raw 通道：同一份响应，拿到就算 ok');
  assert.equal(envOf(r).status, 'failed');
  assert.equal(envOf(r).retcode, 1200);
  assert.equal(envOf(r).message, '权限不足');
});

test('对偶：同一份成功信封，旧通道只给 data、raw 通道给全信封', async () => {
  stubFetch(okEnvelope({ message_id: 12345 }));

  const oldResult = await callOneBotHttpAction(BASE, ACTION, {}, undefined, logger);
  assert.deepEqual(oldResult, { message_id: 12345 });

  const r = await callOneBotHttpActionRaw(BASE, ACTION, {}, undefined, logger);
  assert.equal(r.ok, true);
  assert.equal(envOf(r).echo, 'echo-1', 'echo 只有 raw 通道拿得到');
  assert.deepEqual(envOf(r).data, oldResult, '两边的 data 必须是同一份');
});

test('对偶：超时时旧通道抛、raw 通道返回值', async () => {
  stubFetchThrows(abortError());

  await assert.rejects(
    () => callOneBotHttpAction(BASE, ACTION, {}, undefined, logger),
    (err: unknown) => err instanceof Error && err.message === `API 超时: ${ACTION}`,
  );

  const r = await callOneBotHttpActionRaw(BASE, ACTION, {}, undefined, logger);
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
});
