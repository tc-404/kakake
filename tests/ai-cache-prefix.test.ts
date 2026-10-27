/**
 * 前缀缓存稳定性回归锁：**已经发出去的消息，绝不允许在后续请求里被改写。**
 *
 * 背景（真实数据）：会话 75d7c705（单轮 23 步、70 条消息、DeepSeek）的缓存命中率被压在 74.8%，
 * 且中途出现 9.6% / 11.6% / 14.9% / 15.6% 四次塌陷。根因是「远端压缩水位线」跟着消息数逐条滑动
 * （`messages.length - 40`），每前进一格就把一条已经发出去的长消息截断改写，
 * 上游前缀缓存自该位置起整段失效。
 *
 * 上游前缀缓存的唯一前提是「前缀字节级不变」。所以本测试直接锁这个不变量：
 * 把每一步真实发出去的请求体都抓下来，要求第 k+1 步的 messages 数组以第 k 步的 messages 数组为前缀。
 * 这条一旦被破坏，命中率必然塌陷 —— 与本轮修复前完全一致。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runTurn } from '../src/ai/ai-agent.js';
import { createSession, deleteSession } from '../src/ai/ai-session.js';
import { upsertProfile, deleteProfile } from '../src/ai/ai-provider.js';

// ── 造一个够长的夹具文件（能触发「远端压缩」阈值，但总量远低于上下文硬上限）──
const FIXTURE = 'data/tmp/cache-prefix-fixture.txt';
const fixtureAbs = path.resolve(FIXTURE);
fs.mkdirSync(path.dirname(fixtureAbs), { recursive: true });
fs.writeFileSync(
  fixtureAbs,
  Array.from({ length: 200 }, (_, i) => `第 ${i + 1} 行：${'填充内容'.repeat(12)}标记 ${i + 1}`).join('\n'),
  'utf8',
);

const TEXT_SSE = (text: string) =>
  `data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 100, output_tokens: 10 } } })}\n\n`
  + `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text } })}\n\n`
  + `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } })}\n\n`;

const TOOL_STEPS = 24;
const bodies: Array<Record<string, any>> = [];
const originFetch = globalThis.fetch;
let profileId = '';
let sessionId = '';

try {
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const raw = String(init?.body || '');
    if (raw.includes('kk_probe_tool')) {
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'no tools' }] }), { status: 200 });
    }
    bodies.push(JSON.parse(raw));
    const text = bodies.length <= TOOL_STEPS
      ? `读一段夹具文件。\n@@TOOL_CALL {"tool":"read_file","args":{"path":"${FIXTURE}","offset":1,"limit":60}}`
      : '读完了，任务完成。';
    return new Response(TEXT_SSE(text), { status: 200 });
  }) as typeof fetch;

  const prof = upsertProfile({
    name: '__test_cache_prefix__', protocol: 'anthropic', baseUrl: 'https://upstream.invalid',
    apiPath: '', apiKey: 'k', model: 'm', retryCount: 0, maxTokens: 4096,
  });
  profileId = prof.id;
  // toolsPassthrough 只能在「已存在的档案」上回写（新建时不拷贝该字段）→ 显式两步
  upsertProfile({ ...prof, toolsPassthrough: false });

  const sess = createSession('t-cache-prefix', prof.id);
  sessionId = sess.id;
  await runTurn(sess.id, '看一遍夹具文件', () => { /* noop */ });

  assert.equal(bodies.length, TOOL_STEPS + 1, `每步一次上游请求：${TOOL_STEPS} 次工具步骤 + 1 次收尾`);
  const last = bodies[bodies.length - 1].messages as Array<Record<string, unknown>>;
  assert.ok(last.length > 40, `收尾时消息数应超过近端窗口（实为 ${last.length}），否则本测试测不到压缩逻辑`);

  // ① 系统提示必须每一步都完全一致（它也是被缓存的前缀的一部分）
  const sys = JSON.stringify(bodies[0].system);
  for (let k = 1; k < bodies.length; k++) {
    assert.equal(JSON.stringify(bodies[k].system), sys, `第 ${k + 1} 次请求的系统提示发生了变化`);
  }

  // ② 核心不变量：后一次请求必须以「前一次请求的全部消息」为前缀（内容逐字符相同）
  //    比较前要归一化掉两种「不影响缓存键、只影响序列化外形」的差异：
  //      · cache_control —— Anthropic 的缓存断点标记，跟着最后一条消息走，属请求参数不属提示内容；
  //      · content 写成字符串 还是 单个 text 块 —— 模型看到的 token 完全相同（最后一条会被
  //        包成块以承载断点，下一条请求里它又变回字符串）。
  //    真正影响缓存的是**文本本身**，所以只比文本。
  const textOf = (content: unknown): string => {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map((b) => {
        const blk = b as Record<string, unknown>;
        if (typeof blk.text === 'string') return blk.text;
        if (typeof blk.content === 'string') return blk.content;
        const rest = { ...blk };
        delete rest.cache_control;
        return JSON.stringify(rest);
      }).join('\u0000');
    }
    return JSON.stringify(content ?? null);
  };
  const canon = (msgs: Array<Record<string, unknown>>) => JSON.stringify(msgs.map((m) => [m.role, textOf(m.content)]));

  const violations: string[] = [];
  for (let k = 1; k < bodies.length; k++) {
    const prev = bodies[k - 1].messages as Array<Record<string, unknown>>;
    const cur = bodies[k].messages as Array<Record<string, unknown>>;
    if (canon(cur.slice(0, prev.length)) !== canon(prev)) {
      const at = prev.findIndex((m, i) => canon([m]) !== canon([cur[i]]));
      violations.push(`第 ${k} → ${k + 1} 次请求：第 ${at} 条消息（role=${prev[at]?.role}）被改写`);
    }
  }
  assert.deepEqual(
    violations, [],
    '已发出的消息被改写 → 上游前缀缓存自该位置起整段失效。\n' + violations.join('\n'),
  );

  // ③ 确认本测试确实覆盖到了「会发生压缩」的场景（否则是个空测试）
  const longest = Math.max(...last.map((m) => String(m.content || '').length));
  assert.ok(longest > 600, `应存在超过压缩阈值（600 字符）的消息，实际最长 ${longest} 字符`);

  // ④ 反向自证不放在这里 —— 由「临时改回旧算法跑一次、确认本测试变红」在提交前人工验过（见记忆日志）。
  console.log(`前缀缓存稳定性 ${TOOL_STEPS} 步全部通过（最大消息 ${longest} 字符，收尾时 ${last.length} 条消息）`);
} finally {
  if (sessionId) deleteSession(sessionId);
  if (profileId) deleteProfile(profileId);
  globalThis.fetch = originFetch;
  try { fs.unlinkSync(fixtureAbs); } catch { /* ignore */ }
}
