/**
 * 【分析工具，不是测试】前缀缓存命中率模拟器 —— `node tests/_cache-sim.mjs`
 *
 * 用真实会话数据还原「每一次上游请求的 prompt」，再按「最长公共前缀」算理论命中率
 * （OpenAI 兼容 / DeepSeek 的前缀缓存就是这个算法）。用来：
 *   1) 判断某次改动的缓存效果（对比「现状重建」与「反事实」）；
 *   2) 定位命中率塌陷发生在第几次请求、由哪条消息被改写引起。
 *
 * 依赖 `data/ai/sessions/75d7c705-….json`（真实会话，单轮 23 步 / 70 条消息 / DeepSeek）。
 * 该会话被删掉后本脚本会直接报错 —— 届时换一个会话文件、并按需调整 reqLens 的推导即可。
 * 校验方式：模型算出的「现状重建命中率」应与日志里的
 * `本轮 token 用量：输入 … 命中缓存 …` 对得上（实测 78.6% vs 74.8%）。
 */
import fs from 'node:fs';

const WIN = 40, OVER_TOOL = 600, OVER_OTHER = 1200, KEEP = 300;
const squeezeNote = (n) => `\n【已压缩：原文 ${n} 字符，仅保留开头，如需详情可重新 read_file】`;

const src = fs.readFileSync('src/ai/ai-agent.ts', 'utf8');
const grab = (from, to) => {
  const a = src.indexOf(from);
  return [...src.slice(a, src.indexOf(to, a)).matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]).join('\n');
};
const systemText = grab('function baseSystemPrompt()', '\n}');
const toolsText = grab('const TOOL_DEFS', '\n];');
const systemChars = systemText.length;
const toolsChars = toolsText.length;
// 固定前缀必须是真实文本：它每次都完全一致，永远整段命中（OpenAI 系把 tools 也计入缓存前缀）
const PREFIX = systemText + '\n' + toolsText;

const EMPTY_NUDGE = '[系统] 你上一条回复只产出了思考内容，既没有正文、也没有调用任何工具，用户那边完全看不到东西。'
  + '请立刻行动，不要再长篇推演：若任务尚未完成，直接调用工具继续执行；'
  + '若任务确实已完成，输出简洁的中文最终总结。';

const S = JSON.parse(fs.readFileSync('data/ai/sessions/75d7c705-e273-420e-9a3d-5b4822ca61d4.json', 'utf8'));
const M = S.messages;

/** 按 buildHistory 规则渲染 [0,end)：跳过 note/thinking，窗口外的长消息压缩 */
function render(end, frozenFrom = -1) {
  const from = frozenFrom >= 0 ? frozenFrom : Math.max(0, end - WIN);
  const out = [];
  for (let i = 0; i < end; i++) {
    const m = M[i];
    if (m.note || m.thinking) continue;
    let c = m.content || '';
    if (i < from) {
      const over = m.role === 'tool' ? OVER_TOOL : OVER_OTHER;
      if (c.length > over) c = c.slice(0, KEEP) + squeezeNote(c.length);
    }
    out.push(`<${m.role}>${c}` + (m.toolCalls ? `<calls>${JSON.stringify(m.toolCalls)}>` : ''));
  }
  return out.join('\n');
}

// 请求长度 = 该步第一条消息的下标。连续相邻的 tool 属于同一步的多个调用 → 合并成一批。
const toolIdx = M.map((m, i) => (m.role === 'tool' ? i : -1)).filter((i) => i >= 0);
const batches = [];
for (const ti of toolIdx) {
  const cur = batches[batches.length - 1];
  if (cur && ti - cur[cur.length - 1] === 1) cur.push(ti); else batches.push([ti]);
}
const reqLens = [];
let prevEnd = 1;
for (const b of batches) { reqLens.push(prevEnd); prevEnd = b[b.length - 1] + 1; }
// 第 7、8 步是「只思考不产出」（idx21-24 连出 4 条 note、无 tool），它们不产生 tool 批次，
// 但确实各发了一次上游请求 —— 按消息下标 21 / 23 补回请求序列
reqLens.splice(6, 0, 21, 23);

const lcp = (a, b) => {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
};

function run({ frozen = false, nudges = true } = {}) {
  const frozenFrom = frozen ? Math.max(0, reqLens[0] - WIN) : -1;
  const prompts = reqLens.map((L, k) => PREFIX + '\n' + render(L, frozenFrom)
    + (nudges && (k === 7 || k === 8) ? '\n' + EMPTY_NUDGE : '')); // 第 8、9 次请求带续跑提示
  const rows = [];
  let tot = 0, hit = 0;
  for (let k = 0; k < prompts.length; k++) {
    let best = 0;
    for (let j = 0; j < k; j++) best = Math.max(best, lcp(prompts[j], prompts[k]));
    tot += prompts[k].length; hit += best;
    rows.push({ k: k + 1, L: reqLens[k], len: prompts[k].length, best, prev: k ? lcp(prompts[k - 1], prompts[k]) : 0 });
  }
  return { tot, hit, rows, pct: (hit / tot) * 100 };
}

console.log(`固定前缀（系统提示 ${systemChars} + 工具定义 ${toolsChars}）${PREFIX} 字符`);
console.log(`重建 ${reqLens.length} 次请求，请求时消息总数：${reqLens.join(', ')}\n`);

const base = run();
console.log(`[debug] PREFIX=${PREFIX} prompts[0].length=${base.rows[0].len} render(1).length=${render(1).length} M[0].content.length=${M[0].content.length}`);
console.log('请求 | 消息数 | prompt字符 | 命中字符 | 命中率 | 与上一次的公共前缀');
console.log('-'.repeat(80));
for (const r of base.rows) {
  console.log(
    `${String(r.k).padStart(4)} | ${String(r.L).padStart(6)} | ${String(r.len).padStart(10)} | `
    + `${String(r.best).padStart(8)} | ${(((r.best / r.len) * 100).toFixed(1) + '%').padStart(6)} | ${r.prev}`,
  );
}
const line = (label, r) => `\n${label}：命中率 ${r.pct.toFixed(1)}%（总 prompt ${r.tot} 字符）`;
console.log(line('现状重建', base));
console.log(`真实观测：输入 457253 token、命中 342016 → 74.8%。本模型 ${(457253 / base.tot).toFixed(2)} token/字符`);
console.log(line('反事实① 轮内冻结压缩窗口（＝修掉窗口滑动）', run({ frozen: true })));
console.log(line('反事实② 不注入临时续跑提示', run({ nudges: false })));
console.log(line('反事实①+②', run({ frozen: true, nudges: false })));
