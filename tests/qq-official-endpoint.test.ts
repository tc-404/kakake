/**
 * 官方 API 域名兼容 + 错误码数据回归测试。
 *
 * 重点锁住三条行为：
 *   1. 默认先旧域名、旧域名不通才换 api.bot.qq.com，且切换结果按环境缓存；
 *   2. 业务错误（带 code/message 的 JSON）绝不触发域名切换，避免写请求重复投递；
 *   3. 失败信封的 wording 只补充已知错误码的中文说明，message/data 保持上游原文。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  QQ_OFFICIAL_CURRENT_API_BASE,
  QQ_OFFICIAL_LEGACY_API_BASE,
  QQ_OFFICIAL_LEGACY_SANDBOX_API_BASE,
  isQqOfficialConnectFailure,
  isQqOfficialEndpointGone,
  markQqOfficialBaseUnavailable,
  resetQqOfficialApiBaseSelection,
  resolveQqOfficialApiBases,
} from '../src/connection/qq-official-endpoint.js';
import {
  describeQqOfficialApiError,
  lookupQqOfficialApiError,
} from '../src/proxy/qq-official-error-codes.js';
import { toEnvelope } from '../src/proxy/runtime/dispatcher.js';

const ENV_KEY = 'KAKAKE_GF_API_BASE';
const savedEnv = process.env[ENV_KEY];

function fresh(): void {
  delete process.env[ENV_KEY];
  resetQqOfficialApiBaseSelection();
}

test.after(() => {
  delete process.env[ENV_KEY];
  if (savedEnv !== undefined) process.env[ENV_KEY] = savedEnv;
  resetQqOfficialApiBaseSelection();
});

test('默认策略：正式环境先旧域名，再官方新域名', () => {
  fresh();
  assert.deepEqual(resolveQqOfficialApiBases(false), [
    QQ_OFFICIAL_LEGACY_API_BASE,
    QQ_OFFICIAL_CURRENT_API_BASE,
  ]);
});

test('默认策略：沙箱先旧沙箱域名，再官方新域名（新域名不再区分沙箱）', () => {
  fresh();
  assert.deepEqual(resolveQqOfficialApiBases(true), [
    QQ_OFFICIAL_LEGACY_SANDBOX_API_BASE,
    QQ_OFFICIAL_CURRENT_API_BASE,
  ]);
});

test('旧域名被判定不可用后，后续请求直接走已缓存的新域名', () => {
  fresh();
  const next = markQqOfficialBaseUnavailable(QQ_OFFICIAL_LEGACY_API_BASE, false);
  assert.equal(next, QQ_OFFICIAL_CURRENT_API_BASE);
  assert.deepEqual(resolveQqOfficialApiBases(false), [QQ_OFFICIAL_CURRENT_API_BASE]);
  // 正式环境的切换不影响沙箱环境
  assert.deepEqual(resolveQqOfficialApiBases(true), [
    QQ_OFFICIAL_LEGACY_SANDBOX_API_BASE,
    QQ_OFFICIAL_CURRENT_API_BASE,
  ]);
});

test('环境变量可强制固定域名', () => {
  fresh();
  process.env[ENV_KEY] = 'legacy';
  assert.deepEqual(resolveQqOfficialApiBases(false), [QQ_OFFICIAL_LEGACY_API_BASE]);
  assert.equal(markQqOfficialBaseUnavailable(QQ_OFFICIAL_LEGACY_API_BASE, false), null);

  process.env[ENV_KEY] = 'current';
  assert.deepEqual(resolveQqOfficialApiBases(false), [QQ_OFFICIAL_CURRENT_API_BASE]);

  process.env[ENV_KEY] = 'https://proxy.example.com/';
  assert.deepEqual(resolveQqOfficialApiBases(false), ['https://proxy.example.com']);
});

test('业务错误（带 code/message 的 JSON）不判定为域名停用', () => {
  assert.equal(isQqOfficialEndpointGone(404, '{"code":11253,"message":"应用无接口访问权限"}'), false);
  assert.equal(isQqOfficialEndpointGone(400, '{"code":40034005,"message":"msg_id 已过期"}'), false);
  assert.equal(isQqOfficialEndpointGone(401, '{"message":"unauthorized"}'), false);
});

test('网关返回的空正文 / HTML 错误页判定为域名停用', () => {
  assert.equal(isQqOfficialEndpointGone(404, ''), true);
  assert.equal(isQqOfficialEndpointGone(410, '<html>410 Gone</html>'), true);
  assert.equal(isQqOfficialEndpointGone(502, 'Bad Gateway'), true);
  assert.equal(isQqOfficialEndpointGone(503, '{"err":"upstream"}'), true);
  // 200/401 等正常或业务状态不参与判定
  assert.equal(isQqOfficialEndpointGone(200, ''), false);
  assert.equal(isQqOfficialEndpointGone(401, ''), false);
});

test('只有连接阶段失败才允许换域名重试', () => {
  const cause = Object.assign(
    new Error('getaddrinfo ENOTFOUND api.sgroup.qq.com'),
    { code: 'ENOTFOUND' },
  );
  assert.equal(isQqOfficialConnectFailure(new Error('fetch failed', { cause })), true);
  assert.equal(isQqOfficialConnectFailure(new Error('ECONNREFUSED 连接被拒绝')), true);
  // 单次请求超时不代表域名下线，不能拿写请求去重试
  assert.equal(isQqOfficialConnectFailure(new Error('请求超时 20000ms')), false);
  assert.equal(isQqOfficialConnectFailure(new Error('HTTP 400 业务错误')), false);
});

test('错误码表：已知码给出中文说明，未知码不编造', () => {
  const info = lookupQqOfficialApiError(40035007);
  assert.equal(info?.group, 'material');
  assert.equal(info?.since, '20261021');
  assert.match(describeQqOfficialApiError('40035007') ?? '', /100 张/);
  assert.equal(lookupQqOfficialApiError(99999999), undefined);
  assert.equal(describeQqOfficialApiError(undefined), undefined);
});

test('官方失败信封：wording 补中文说明，message/data 仍是上游原文', () => {
  const payload = { code: 40035007, message: '图片数量超过上限' };
  const env = toEnvelope(payload, 'official', 400);
  assert.equal(env.status, 'failed');
  assert.equal(env.retcode, 40035007);
  assert.equal(env.message, '图片数量超过上限');
  assert.deepEqual(env.data, payload);
  assert.match(env.wording ?? '', /100 张/);

  const unknown = toEnvelope({ code: 99999999, message: 'unknown' }, 'official', 400);
  assert.equal(unknown.wording, undefined);
});
