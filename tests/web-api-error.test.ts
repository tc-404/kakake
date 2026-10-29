/**
 * src/web/lib/server-error.ts 纯函数回归：errText / svcText / resText 的分支覆盖
 * （结构化 code → EXACT 精确表 → RULES 变量回填 → SYS 底层英文 → 原样返回）。
 * 模块内部用 @/ 别名导入，node 下需经 tsx/esm api 以 src/web 的 tsconfig 动态加载；
 * 不用 typeof import 做类型引用，避免把 src/web 文件牵进根 tsconfig 的类型检查。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';

const svc: any = await tsImport(new URL('../src/web/lib/server-error.js', import.meta.url).href, {
  tsconfig: fileURLToPath(new URL('../src/web/tsconfig.json', import.meta.url)),
  parentURL: import.meta.url,
});

test('errText：null / undefined → 空串（交给调用方兜底 key）', () => {
  assert.equal(svc.errText(null), '');
  assert.equal(svc.errText(undefined), '');
});

test('errText：Error 实例走精确表，zh 默认 / en 可选', () => {
  assert.equal(svc.errText(new Error('插件不存在')), '插件不存在');
  assert.equal(svc.errText(new Error('资源不存在或不在咔咔插件分区')), '资源不存在或不在咔咔插件分区');
  assert.equal(svc.errText(new Error('插件不存在'), 'en'), 'Plugin not found');
  assert.equal(svc.errText(new Error('登录密钥错误'), 'en'), 'Incorrect login key');
});

test('errText：字符串走规则表，$1 回填捕获组', () => {
  assert.equal(svc.errText('商城接口 HTTP 502'), '商城接口 HTTP 502');
  assert.equal(svc.errText('下载失败 4: zip 损坏'), '下载失败（4）');
  assert.equal(svc.errText('上游返回 HTTP 403：Forbidden'), '上游返回 HTTP 403');
  assert.equal(svc.errText('未找到分类「热门」'), '未找到分类「热门」');
});

test('errText：未知对象经 String() 后原样返回', () => {
  assert.equal(svc.errText({}), '[object Object]');
  assert.equal(svc.errText(42), '42');
  assert.equal(svc.errText(['a']), 'a');
});

test('errText：底层英文错误（SYS 表，顺序敏感）', () => {
  assert.equal(svc.errText(new Error('request to https://x failed with ETIMEDOUT')), '请求超时，请检查网络后重试');
  assert.equal(svc.errText(new Error('fetch failed')), '网络请求失败，请检查网络后重试');
  assert.equal(svc.errText(new Error('getaddrinfo ENOTFOUND example.com')), '域名解析失败，请检查网络或镜像地址');
  assert.equal(svc.errText(new Error('connect ECONNREFUSED 127.0.0.1:8787')), '连接被拒绝（服务未启动或端口不对）');
  assert.equal(svc.errText(new Error('Unexpected token < in JSON')), '响应不是合法 JSON（可能是代理页或错误页）');
  assert.equal(svc.errText(new Error('The operation was aborted')), '请求已取消');
  assert.equal(svc.errText(new Error('HTTP 503')), '服务端返回 HTTP 503');
  assert.equal(svc.errText(new Error('unable to verify the first certificate')), 'HTTPS 证书校验失败，请检查系统时间或网络环境');
  // 超时报文里也含 "aborted"：timeout 规则必须排在 abort 之前
  assert.equal(svc.errText(new Error('request aborted: timed out')), '请求超时，请检查网络后重试');
});

test('svcText：结构化错误码优先于原文匹配', () => {
  assert.equal(svc.svcText('whatever', 'timeout'), '请求超时，请检查网络后重试');
  assert.equal(svc.svcText('whatever', 'network'), '网络连接失败，请检查网络后重试');
  assert.equal(svc.svcText('插件不存在', 'timeout'), '请求超时，请检查网络后重试');
  // 未登记的 code 不劫持：继续走原文匹配，未命中原样返回
  assert.equal(svc.svcText('zzz', 'made-up-code'), 'zzz');
});

test('svcText：空串与纯空白返回空串', () => {
  assert.equal(svc.svcText(''), '');
  assert.equal(svc.svcText('   '), '');
  assert.equal(svc.svcText(undefined), '');
});

test('resText：code 为字符串才走错误码，number 业务码忽略', () => {
  assert.equal(svc.resText(null), '');
  assert.equal(svc.resText(undefined), '');
  assert.equal(svc.resText({ ok: false, message: '插件不存在' }), '插件不存在');
  assert.equal(svc.resText({ code: 'timeout', message: 'x' }), '请求超时，请检查网络后重试');
  assert.equal(svc.resText({}), '');
  assert.equal(svc.resText({ code: 0, message: '操作成功' }), '操作成功');
});
