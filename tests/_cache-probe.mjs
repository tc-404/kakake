/**
 * 【分析工具，不是测试】前缀缓存命中率探针 —— `node tests/_cache-probe.mjs <会话文件名>`
 *
 * 用真实会话还原「每一次上游请求的 prompt」，按最长公共前缀（LCP）算**理论**命中，
 * 再和会话里落库的实际 usage（input / cached）对照，定位命中率塌陷发生在第几次请求。
 *
 * 请求边界的推导：每个步骤都是「先落一条 note（思考完成/重试），再落 assistant 正文」，
 * 所以 **note 消息的下标 = 该次请求发出时的消息条数**。同一步里的第二条 note（自动续跑）
 * 紧跟在思考 note 之后，要剔除，否则会多算一次请求。
 */
import fs from 'node:fs';

const file = process.argv[2] || '77deb642-8750-4b0d-92ec-67e8883ed327';
const S = JSON.parse(fs.readFileSync(`data/ai/sessions/${file}.json`, 'utf8'));
const M = S.messages;

const src = fs.readFileSync('src/ai/ai-agent.ts', 'utf8');
const grab = (from, to) => {
  const a = src.indexOf(from);
  return [...src.slice(a, src.indexOf(to, a)).matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]).join('\n');
};
const PREFIX = grab('function baseSystemPrompt()', '\n}') + '\n' + grab('const TOOL_DEFS', '\n];');

/** 按 buildHistory 规则渲染 [0,end)：note / thinking 不进模型上下文 */
function render(end) {
  const out = [];
  for (let i = 0; i < end; i++) {
    const m = M[i];
    if (m.note || m.thinking) continue;
    out.push(`<${m.role}>${m.content || ''}` + (m.toolCalls ? `<calls>${JSON.stringify(m.toolCalls)}>` : ''));
  }
  return out.join('\n');
}

// 请求边界：note 消息下标；同一请求内的连续 note 只取第一条
const reqLens = [];
M.forEach((m, i) => {
  if (!m.note) return;
  if (reqLens.length && reqLens[reqLens.length - 1] === i - 1 && !M[i - 1].content) {
    const prev = M[i - 1];
    if (prev.note) return; // 上一条也是 note → 同一步
  }
  reqLens.push(i);
});

const lcp = (a, b) => {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
};

const prompts = reqLens.map((L) => PREFIX + '\n' + render(L));
const rows = prompts.map((p, k) => ({
  req: k + 1,
  msgs: reqLens[k],
  chars: p.length,
  hit: k ? Math.max(...prompts.slice(0, k).map((q) => lcp(q, p))) : 0,
  withPrev: k ? lcp(prompts[k - 1], p) : 0,
}));

const totChar = rows.reduce((s, r) => s + r.chars, 0);
const totHit = rows.reduce((s, r) => s + r.hit, 0);

console.log(`会话 ${file} · ${S.title}`);
console.log(`固定前缀 ${PREFIX.length} 字符 · 还原 ${rows.length} 次请求\n`);
console.log('请求 | 消息数 | prompt字符 | 理论命中 | 命中率 | 与上次公共前缀 | 损失');
console.log('-'.repeat(78));
for (const r of rows) {
  const loss = r.withPrev ? r.chars - r.withPrev : r.chars;
  console.log(
    `${String(r.req).padStart(4)} | ${String(r.msgs).padStart(6)} | ${String(r.chars).padStart(10)} | `
    + `${String(r.hit).padStart(8)} | ${(((r.hit / r.chars) * 100).toFixed(1) + '%').padStart(6)} | `
    + `${String(r.withPrev).padStart(14)} | ${String(loss).padStart(8)}`,
  );
}
console.log(`\n理论命中率（字符口径）：${((totHit / totChar) * 100).toFixed(1)}%`);

// 实际：每轮最后一条 assistant 消息上落着本轮汇总 usage
const turns = M.filter((m) => m.usage && (m.usage.input || m.usage.output));
let inTok = 0, hitTok = 0;
turns.forEach((m, i) => {
  inTok += m.usage.input; hitTok += m.usage.cached || 0;
  console.log(
    `实际 第${i + 1}轮：输入 ${m.usage.input} / 命中 ${m.usage.cached || 0} `
    + `→ ${((m.usage.cached || 0) / m.usage.input * 100).toFixed(1)}%`,
  );
});
console.log(`实际命中率（整会话，token 口径）：${((hitTok / inTok) * 100).toFixed(1)}%（输入 ${inTok} / 命中 ${hitTok}）`);
console.log(`字符→token 换算：${(inTok / totChar).toFixed(3)} token/字符`);
