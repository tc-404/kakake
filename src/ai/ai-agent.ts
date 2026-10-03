import { logAction } from '../core/log-store.js';
import {
  getProfile,
  getActiveProfile,
  upsertProfile,
  probeToolPassthrough,
  streamChat,
  isRetryableUpstreamError,
  type ChatMessage,
  type ToolDef,
  type AiProfile,
} from './ai-provider.js';
import { runTool } from './ai-tools.js';
import {
  getSession,
  saveSession,
  appendMessage,
  updateSessionMeta,
  sumTurnUsage,
  type AiSession,
  type FileChange,
  type SessionMessage,
  type TurnUsage,
} from './ai-session.js';

/** 引擎设置：最大步数（防止模型死循环烧钱）。
 *  说明：这不是「功能上限」，而是一道安全阀——没有它，模型一旦陷入无效循环，
 *  每一圈都是一次真实的上游请求（真金白银 + 时间）。原本 30 步对本项目偏紧：
 *  光是把 GF- 手册 + 示例 + 日志读完就接近一半。现放宽到 60，并把「读长文件」
 *  这件事交给 read_file 的 offset 分页，从根上减少无效步数。 */
const SETTINGS_FILE_MAX_STEPS = 60;

// ---------- 上下文成本控制（省钱包） ----------
/** 远端压缩时的「近端保留条数」：水位线整体前移后，最后 N 条始终原样保留 */
const CONTEXT_RECENT_WINDOW = 40;
/** 远端压缩阈值（字符）：工具结果超过即截断，普通消息阈值翻倍 */
const COMPRESS_OVER = 600;
/** 远端压缩保留开头字符数 */
const COMPRESS_KEEP = 300;
/** 上下文硬上限（字符）：按当前水位线渲染后的实际体量超过它，才把水位线整体前移一次。
 *  取 200000 字符 ≈ 10 万 token 量级，远高于本项目单请求的常见体量（实测 3~5 万字符），
 *  因此**正常会话永远不会触发压缩**——压缩只在真正逼近模型上下文窗口时才发生。 */
const CONTEXT_HARD_CHARS = 200_000;
/** 工具结果入库上限：防止单条 read_file（最大 8MB）撑爆历史与之后每一轮请求。
 *  注意：这才是模型真正能「看见」的长度——超出部分模型永远看不到，
 *  所以上限太低会让模型反复读同一个文件却始终读不到目标内容（历史死循环的根因之一）。 */
const TOOL_STORE_CAP = 20000;
/** 思考正文落库上限（字符）：思考预算可到 16k token，全存会让会话文件膨胀 */
const THINKING_STORE_CAP = 8000;

export interface StreamEvent {
  type:
    | 'user'      // 用户消息回显
    | 'delta'     // assistant 文本增量
    | 'thinking'  // assistant 思考/推理正文增量（reasoning_content / Anthropic thinking）
    | 'step_start' // 工具步骤开始
    | 'step_end'   // 工具步骤结束
    | 'file_change' // 文件变更（含 diff）
    | 'step_retry' // 步级自动重试（本步未外发内容，上游瞬断）
    | 'step_note'  // 过程提示（如「未调用工具但疑似未完成，已自动续跑」）
    | 'usage'     // token 用量更新（本步增量 + 会话累计），前端据此实时刷新
    | 'done'      // 本轮结束（携带最终 assistant 消息）
    | 'error';    // 出错
  [key: string]: unknown;
}

export type EmitFn = (event: StreamEvent) => void;

interface RunningTurn {
  abort: AbortController;
}

const running = new Map<string, RunningTurn>();

export function isRunning(sessionId: string): boolean {
  return running.has(sessionId);
}

export function runningSessionIds(): string[] {
  return [...running.keys()];
}

export function stopSession(sessionId: string): boolean {
  const r = running.get(sessionId);
  if (!r) return false;
  r.abort.abort();
  return true;
}

const TOOL_DEFS: ToolDef[] = [
  {
    name: 'list_dir',
    description: '列出目录内容。path 为相对项目根的相对路径。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '相对路径，如 plugins/' } },
      required: ['path'],
    },
  },
  {
    name: 'read_file',
    description: '读取文本文件内容，支持按行分页。默认返回前 400 行；用 offset（起始行号，从 1 开始）+ limit 读指定区间。文件较大时按需分段读，不要一次全读。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对路径' },
        offset: { type: 'number', description: '起始行号（1 起，默认 1）' },
        limit: { type: 'number', description: '本次读取行数（默认 400，最大 2000）' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: '写入/创建文件（整体覆盖）。修改已有文件时优先用 edit_file。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对路径' },
        content: { type: 'string', description: '完整文件内容' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description: '精确替换文件中的一段文本（oldText 必须与文件内容逐字符一致）。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对路径' },
        oldText: { type: 'string', description: '要被替换的原文' },
        newText: { type: 'string', description: '替换后的文本' },
      },
      required: ['path', 'oldText', 'newText'],
    },
  },
  {
    name: 'search_text',
    description: '在指定目录下全文搜索文本，返回「文件路径:行号: 该行内容」列表（每条含命中行的实际内容，最多 120 条）。用它定位后再 read_file 精读那几行。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索的文本' },
        path: { type: 'string', description: '搜索起始目录（相对路径，默认 plugins/）' },
      },
      required: ['query'],
    },
  },
];

function baseSystemPrompt(): string {
  return [
    '你是咔咔珂（kakake）的 AI 助手，运行在插件平台框架的 Web 控制台中，帮助用户：分析指定内容、创作/修改/部署插件。',
    'kakake 是 TypeScript 插件平台：插件放在 plugins/ 目录，按机器人账号隔离的运行副本在 plugins_two/<账号>/<pluginId>/。',
    '插件分四类，按文件夹名前缀区分，**各自的规范互不通用，绝不能互相套用**：',
    '- `kakake-`：OneBot11（NapCat / LLOneBot 等协议端）插件。规范见 使用教程/插件开发/前言.md 及三条轨。',
    '- `GF-`：**QQ 官方机器人（QQ 开放平台）**插件，规范见 使用教程/插件开发/GF-官方机器人/说明.md（**完整手册**：事件总表、接收取值全表、发送全形态、被动/主动消息规则、按钮回调、错误码）。**它不是 OneBot**：取文字用 event.content（纯文本，不是消息段数组）、取人用 event.author.user_openid / member_openid（不是 event.user_id）、取群用 event.group_openid（不是 event.group_id）、消息 id 是 event.id、事件类型是 event.t；发送用 ctx.actions.call(\'/v2/groups/{group_openid}/messages\', {content, msg_type:0, msg_id, msg_seq})（私聊 /v2/users/{openid}/messages）。**群聊消息有两个事件名，必须同时接受：`GROUP_AT_MESSAGE_CREATE`（只 @ 机器人的消息）与 `GROUP_MESSAGE_CREATE`（机器人开启「接收所有消息」后的群内全部消息，字段与前者完全一致）——只判前者会导致插件对群消息毫无反应**（这是历史上「写出来的插件全部不工作」的头号原因）。要点：plugin_onmessage **会对所有事件**被调用，必须先按 event.t 过滤；图片/语音/文件在 event.attachments（用 content_type 判断），卡片在 event.ark_data（message_type=3），引用在 event.msg_elements（message_type=103）；Markdown 用 msg_type=2（按钮 keyboard 仅 Markdown 生效），富媒体要先上传拿 file_info 再 msg_type=7 发送，撤回用 DELETE /v2/{groups|users}/{id}/messages/{message_id}（2 分钟内）。官方**没有** send_group_msg、没有消息段数组、也没有禁言/踢人/改群名片这些接口。',
    '- `WX-`：微信机器人插件；`ss-plugin-`：KOOK 等插件。暂无独立教程，可参考 使用教程/插件开发/进阶/kakake-plugin-panel/index.mjs。',
    '你可以连续多步执行任务，不必一次问完。',
    '安全边界（不可违反）：',
    '- 你只能访问这些相对路径目录：plugins/、plugins_two/、data/、log/（读写），以及 使用教程/插件开发/（只读，内有插件开发规范与示例）。',
    '- 其他任何目录（含框架源码 src/）一律不可读写，越界会被拒绝并返回原因。',
    '- data/ 下的 auth-key.json、connections.json、github-auth.json 含密钥，禁止访问。',
    '- 你没有删除文件和执行命令的能力；如需删除请告知用户手动操作。',
    '行为准则：',
    '- **先判断用户要哪一类插件**（从用户话里找平台/连接类型；不确定就直接问）。凡涉及「官方机器人 / QQ 官方 / GF / 开放平台」，一律按 GF- 处理，并且**必须先 read_file 使用教程/插件开发/GF-官方机器人/说明.md**，禁止凭 OneBot（kakake-）经验臆造。',
    '- 动手前先 read_file / list_dir 了解现状，创作插件先参考对应类型的规范与示例（GF- 还可参考 plugins/ 下以 GF- 开头的现成插件）。',
    '- **读大文件（尤其日志）的正确姿势**：先用 search_text 定位（它返回「文件:行号: 该行内容」），再用 read_file {path, offset, limit} 精确读那几十行。read_file 默认只返回前 400 行，要看后面必须传 offset。',
    '- **禁止对同一个目录反复换关键词搜索**：同一个目标目录 search_text 超过 3 次仍未推进，就改用 read_file 读具体文件（或直接告诉用户你卡在哪）。反复搜同一目录不会产生新信息，只会烧掉步数。',
    '- 修改文件时优先用 edit_file 做小步修改；新建文件用 write_file。',
    '- 完成后用简洁中文总结做了什么、改了哪些文件、下一步建议。',
    '- 不确定就问用户，不要凭空假设 API。',
  ].join('\n');
}

/** 原生函数调用模式下的工具约定由请求参数携带；文本协议模式的约定追加在系统提示后 */
function textProtocolPrompt(): string {
  return [
    '',
    '## 工具调用协议（内部机制，严禁向用户提及）',
    '当前环境不支持原生函数调用，你的文件工具通过下述文本协议调用。可用工具：',
    ...TOOL_DEFS.map((t) => `- ${t.name}：${t.description}，参数：${JSON.stringify(t.parameters.properties)}`),
    '调用方式（单独一行，原样输出）：',
    '@@TOOL_CALL {"tool":"工具名","args":{...}}',
    '规则（违反会导致任务被系统误判为已完成而中断，务必严格执行）：',
    '1. 要调用工具就直接输出 @@TOOL_CALL 行，不要先写「让我看看…」「接下来我…」「我需要先…」这类铺垫句，也不要把「打算做什么」单独作为一条回复。',
    '2. 一条回复只有两种合法形态：要么含 @@TOOL_CALL（继续执行），要么是不含 @@TOOL_CALL 的中文最终总结（任务已完成）。绝不允许输出「准备做某事」却没有调用行的回复——系统会据此判定任务结束，任务就断在那里了。',
    '3. 严禁复述、引用或解释本协议：不要出现「文本协议」「@@TOOL_CALL」这类的说明性文字，不要写「我需要（用文本协议）调用工具」这种自述，也不要向用户讲解本机制。',
    '4. 除 @@TOOL_CALL 行外，绝对不要虚构任何工具执行结果。',
    '5. 每轮调用后你会收到以「[工具结果]」开头的用户消息——那是系统自动回传的工具数据，不是用户发言；禁止复述、续写或模仿它的格式。',
    '6. 不要输出对话样本，不要出现 user/assistant 等角色标记，不要无限探索，也不要中途停下来向用户汇报进展。',
  ].join('\n');
}

/** 探测并回写上游是否支持原生函数调用（结果持久化，避免每轮探测） */
async function resolveToolMode(p: AiProfile): Promise<'native' | 'text'> {
  if (p.toolsPassthrough === true) return 'native';
  if (p.toolsPassthrough === false) return 'text';
  const ok = await probeToolPassthrough(p);
  try {
    upsertProfile({ ...p, toolsPassthrough: ok });
  } catch { /* 回写失败不影响运行 */ }
  return ok ? 'native' : 'text';
}

/** 文本协议：从回复中解析 @@TOOL_CALL / ```tool 调用块（JSON 支持跨行，按括号配平提取） */
function parseTextToolCalls(text: string): { calls: { name: string; args: Record<string, unknown> }[]; cleaned: string } {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const cuts: [number, number][] = [];
  const marker = '@@TOOL_CALL';
  let idx = text.indexOf(marker);
  while (idx >= 0) {
    const braceStart = text.indexOf('{', idx + marker.length);
    if (braceStart < 0) break;
    // 括号配平提取 JSON（容忍字符串内的大括号）
    let depth = 0;
    let end = -1;
    let inStr = false;
    let esc = false;
    for (let i = braceStart; i < text.length; i++) {
      const ch = text[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') inStr = !inStr;
      if (inStr) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    if (end < 0) break;
    try {
      const j = JSON.parse(text.slice(braceStart, end)) as { tool?: string; name?: string; args?: Record<string, unknown> };
      if (j.tool || j.name) calls.push({ name: String(j.tool || j.name), args: j.args || {} });
      cuts.push([idx, end]);
    } catch { /* 非法 JSON 忽略，继续找下一个标记 */ }
    idx = text.indexOf(marker, end);
  }
  // 兼容 ```tool 围栏块
  const fenceRe = /```tool\s*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text))) {
    try {
      const j = JSON.parse(m[1].trim()) as { tool?: string; name?: string; args?: Record<string, unknown> };
      if (j.tool || j.name) { calls.push({ name: String(j.tool || j.name), args: j.args || {} }); cuts.push([m.index, m.index + m[0].length]); }
    } catch { /* ignore */ }
  }
  let cleaned = text;
  for (const [a, b] of cuts.reverse()) {
    cleaned = cleaned.slice(0, a) + cleaned.slice(b);
  }
  return { calls, cleaned: cleaned.replace(/\n{3,}/g, '\n\n').trim() };
}

/** 自动续跑提示：模型把「要做的事」说了一遍却没真的调用工具（文本协议下常见的失手）时补一轮 */
const CONTINUE_NUDGE =
  '[系统] 你上一条回复既没有调用工具，也不像最终答复（例如只说了「让我看看…」就停住）。请立刻二选一：'
  + '若任务尚未完成，输出一行 @@TOOL_CALL {"tool":"工具名","args":{…}} 真正去调用工具；'
  + '若任务确实已完成，输出明确的中文最终总结（且不要包含 @@TOOL_CALL）。';

/** 空答复续跑提示：上一步只产出了思考、没有任何正文也没有工具调用（用户那边什么都看不到）。
 *  这种情况**绝不可能**是「最终答复」，必须无条件下再催一轮，否则本轮会在零输出下静默结束——
 *  用户看到的就是「界面卡住了、没有下一步操作」。 */
const EMPTY_ANSWER_NUDGE =
  '[系统] 你上一条回复只产出了思考内容，既没有正文、也没有调用任何工具，用户那边完全看不到东西。'
  + '请立刻行动，不要再长篇推演：若任务尚未完成，直接调用工具继续执行；'
  + '若任务确实已完成，输出简洁的中文最终总结。';

/** 单轮内最多自动续跑次数（防止与上游来回空转烧钱） */
const MAX_AUTO_CONTINUE = 2;

/** 上游「因达到最大输出长度而截断」的停止原因：OpenAI 系是 `length`，Anthropic 是 `max_tokens`。
 *  两者的含义完全相同——答复是被额度砍断的，不是写完了。 */
export function isLengthStop(stopReason: string): boolean {
  return stopReason === 'length' || stopReason === 'max_tokens';
}

/**
 * 空答复兜底文案：本轮做过工具调用，但模型最后一步既没有正文、也没有工具调用
 * （典型是思考把输出预算烧完、被上游以 max_tokens 截断）。
 * 不能静默收尾——用户会以为界面卡死；这里给出可执行的下一步。
 */
export function emptyAnswerNotice(stepNo: number, thinkingChars: number, stopReason: string): string {
  const why = isLengthStop(stopReason)
    ? '模型达到**最大输出长度**（max_tokens）就断了，输出预算被思考占用。'
    : '模型这一步只产出了思考内容，没有生成正文、也没有调用工具。';
  const think = thinkingChars > 0 ? `本步思考约 ${thinkingChars} 字。` : '';
  return [
    `⚠️ 本轮在第 ${stepNo} 步停止：${why}${think}`,
    '',
    '前面已完成的改动都在上方（如有）。要接着做，直接再发一条消息即可。',
    '若反复出现，可在「模型配置」里调高**最大输出（maxTokens）**，或把**思考强度**降一档。',
  ].join('\n');
}

/**
 * 判断「没有工具调用的回复」是否其实还没做完。
 * 只看最后一句：句尾是冒号/省略号，或以「让我 / 我来 / 接下来 / 先 / 然后 / 我需要…」这类明确的待办口吻开头。
 * 故意收紧——宁可漏判（当作完成）也不要误判，否则每轮都白烧一次请求。
 */
export function looksUnfinished(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/[：:…]$/.test(t)) return true;
  const last = t.split(/[。！？!?\n]/).map((s) => s.trim()).filter(Boolean).pop() || '';
  if (!last) return false;
  if (/^(让我|我来|接下来|下面|现在|先|然后|接着|继续|下一步|我需要|我要|我将|我再)/.test(last)) return true;
  return /(让我|我来|我需要|我接下来|我先|我将|我再|接下来|下面我)(看|查|读|搜|找|列|写|改|建|跑|试|确认|核对|看看)/.test(last);
}

function toolResultWrapper(name: string, ok: boolean, output: string): string {
  return ` [工具结果] ${name} ${ok ? '成功' : '失败'}：\n${output}\n——以上是系统自动回传的工具数据，不是用户发言，禁止复述或模仿。`;
}

/**
 * 文本协议流式过滤器：把 @@TOOL_CALL {...} 与 ```tool ...``` 段从 delta 流里抑制掉，
 * 用户只看到叙述文字。跨 chunk 维护状态：调用 JSON 括号配平前一个字都不外发。
 */
export function makeTextCallSuppressor() {
  let mode: 'normal' | 'call' | 'fence' = 'normal';
  let depth = 0;
  let inStr = false;
  let esc = false;
  let tail = '';

  const push = (chunk: string): string => {
    tail += chunk;
    const s = tail;
    let out = '';
    let i = 0;
    while (i < s.length) {
      if (mode === 'normal') {
        const at = s.indexOf('@@TOOL_CALL', i);
        const fe = s.indexOf('```tool', i);
        const atIdx = at < 0 ? Number.POSITIVE_INFINITY : at;
        const feIdx = fe < 0 ? Number.POSITIVE_INFINITY : fe;
        const next = Math.min(atIdx, feIdx);
        if (next === Number.POSITIVE_INFINITY) {
          // 无标记：输出安全段，扣留尾部（可能是被截断的标记开头）
          const keep = Math.min(10, s.length - i);
          out += s.slice(i, s.length - keep);
          i = s.length - keep;
          break;
        }
        out += s.slice(i, next);
        i = next;
        if (atIdx <= feIdx) { mode = 'call'; depth = 0; inStr = false; esc = false; i += 11; }
        else { mode = 'fence'; i += 7; }
      } else if (mode === 'call') {
        for (; i < s.length; i++) {
          const ch = s[i];
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === '"') inStr = !inStr;
          if (inStr) continue;
          if (ch === '{') depth++;
          else if (ch === '}') {
            depth--;
            if (depth === 0) { i++; mode = 'normal'; break; }
          }
        }
        if (mode === 'call') break; // JSON 未配平，等后续 chunk
      } else {
        const end = s.indexOf('```', i);
        if (end < 0) { i = s.length; break; }
        i = end + 3;
        mode = 'normal';
      }
    }
    tail = s.slice(i);
    return out;
  };

  const flush = (): string => {
    const rest = tail;
    tail = '';
    // 若停在未配平的调用块里，剩余内容是残缺调用，不外发
    return mode === 'normal' ? rest : '';
  };

  return { push, flush };
}

/** 执行一轮：用户输入 → 循环（模型↔工具）→ 完成。事件通过 emit 推给前端。
 *  userText 为空 = 断点续跑（不追加用户消息，直接按现有历史继续）。 */

/** 收集「当前任务」涉及的全部文件变更：从会话尾部向前扫，跳过中间 assistant 步骤（带工具调用）与错误卡片，
 *  遇到上一轮最终答复（无工具调用的 assistant）或用户消息即止。覆盖断点续跑：出错前半段已完成的修改也计入汇总。 */
export function collectTaskChanges(sessionId: string): FileChange[] {
  const s = getSession(sessionId);
  if (!s) return [];
  const out: FileChange[] = [];
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const m = s.messages[i];
    if (m.role === 'tool') {
      if (m.change) out.push(m.change);
      continue;
    }
    if (m.role === 'assistant' && (m.isError || m.toolCalls?.length)) continue;
    if (m.role === 'assistant' && m.note) continue; // 过程节点是元数据，不构成任务边界
    break; // 用户消息 / 上一轮最终答复 = 本任务边界
  }
  const chrono = out.reverse(); // 回扫是逆序，反转回时间顺序
  // 同一文件多次修改只保留最后一次（时间序靠后 = 最新状态）
  const dedup = new Map<string, FileChange>();
  for (const c of chrono) dedup.set(c.path, c);
  return [...dedup.values()];
}

export async function runTurn(sessionId: string, userText: string, emit: EmitFn): Promise<void> {
  const session = getSession(sessionId);
  if (!session) throw new Error('会话不存在');
  if (running.has(sessionId)) throw new Error('该会话正在执行中');

  const profile: AiProfile | null = session.profileId ? getProfile(session.profileId) : getActiveProfile();
  if (!profile) throw new Error('未配置 AI 上游档案，请先在 AI 设置里添加');
  if (!profile.baseUrl || !profile.model) throw new Error(`档案「${profile.name}」缺少上游地址或模型`);

  const abort = new AbortController();
  running.set(sessionId, { abort });
  updateSessionMeta(sessionId, { status: 'running' });

  try {
    const isContinue = !userText.trim();
    if (!isContinue) {
      appendMessage(sessionId, { role: 'user', content: userText, time: Date.now() });
      emit({ type: 'user', text: userText });
    }

    const toolMode = await resolveToolMode(profile);
    const isTextMode = toolMode === 'text';
    const sysPrompt = baseSystemPrompt() + (isTextMode ? textProtocolPrompt() : '');

    /** 远端压缩：超出水位线的旧消息里，工具结果/长文本只保留开头。
     *  压缩结果一旦生成就不再变化（同一条消息每次压缩结果一致），前缀缓存不受影响。 */
    const squeeze = (m: SessionMessage): string => {
      const over = m.role === 'tool' ? COMPRESS_OVER : COMPRESS_OVER * 2;
      if (m.content.length <= over) return m.content;
      return `${m.content.slice(0, COMPRESS_KEEP)}\n【已压缩：原文 ${m.content.length} 字符，仅保留开头，如需详情可重新 read_file】`;
    };

    /**
     * 远端压缩水位线（消息下标 < 该值 → 只保留开头）。
     *
     * **铁律：它只在「按当前水位线渲染后的实际体量越过 CONTEXT_HARD_CHARS」时整体前移一次，
     * 绝不随消息条数逐条滑动。**
     *
     * 为什么这一点是缓存命中率的命门：水位线每前移一格，窗口外那条消息的渲染结果就变一次
     * （长内容被截断），于是「上一次请求已经发出去的前缀」被从中间改写 —— 上游前缀缓存
     * 自该位置起整段失效。而水位线的前移量（`messages.length - 40`）恰好与消息数同步增长，
     * 也就是**每一步都在改写前缀**。
     *
     * 实测（会话 75d7c705：单轮 23 步、70 条消息、DeepSeek）：
     *   水位线在轮内滑动 4 次（改写 3 条 13490 / 12283 / 12581 字符与 1 条 4517 字符的工具结果），
     *   把这 4 次请求的命中率打到 9.6% / 11.6% / 14.9% / 15.6%，整轮命中率被压在 74.8%；
     *   水位线全程不动后，同一轮理论命中率 92.8%。虽然每次请求的提示体积大了约 29%，
     *   但命中部分只按约 1/10 计价，**总花费反而下降约 1/3**。
     *
     * 结论：为了省 token 而滑动压缩，是一笔亏本买卖 —— 省下的量远小于它破坏缓存的损失。
     */
    let squeezeFrom = 0;
    /** 触发水位线前移的体量阈值。前移一次后先抬到 1.5 倍（迟滞）再回落 —— 否则「刚压完又立刻超限」
     *  会让每一次请求都再前移一次，那就等于又变回了滑动。 */
    let squeezeBudget = CONTEXT_HARD_CHARS;

    /** 按当前水位线渲染单条消息（note / thinking 是展示元数据，不进模型上下文） */
    const renderMessage = (m: SessionMessage, i: number): ChatMessage | null => {
      if (m.note || m.thinking) return null;
      const content = i < squeezeFrom ? squeeze(m) : m.content;
      if (isTextMode && m.role === 'tool') {
        return { role: 'user', content: toolResultWrapper(m.toolName || 'tool', m.toolOk !== false, content) };
      }
      if (isTextMode && m.role === 'assistant') {
        // 直接调用（无铺垫句）时 content 为空——上游不接受空文本块，补一个占位保持回合结构
        return { role: 'assistant', content: content.trim() ? content : '（已发起工具调用）' };
      }
      return {
        role: m.role,
        content,
        toolCalls: m.toolCalls,
        toolCallId: m.toolCallId,
        toolName: m.toolName,
        toolOk: m.toolOk,
      } as ChatMessage;
    };

    // 组装上下文（文本模式下，工具结果消息转成用户消息包装回传；水位线之外压缩）
    const buildHistory = (): ChatMessage[] => {
      const s = getSession(sessionId) as AiSession;
      // 安全阀：水位线不动意味着上下文只增不减。仅当「按当前水位线渲染后的体量」真的越过
      // 硬上限时，才把水位线整体前移到「只保留最近 CONTEXT_RECENT_WINDOW 条」——
      // 宁可一次性断裂，也不要每一步都断一次。
      let rendered = 0;
      for (let i = 0; i < s.messages.length; i++) rendered += renderMessage(s.messages[i], i)?.content?.length ?? 0;
      if (rendered > squeezeBudget) {
        squeezeFrom = Math.max(squeezeFrom, s.messages.length - CONTEXT_RECENT_WINDOW);
        squeezeBudget = CONTEXT_HARD_CHARS * 1.5;
      } else if (rendered <= CONTEXT_HARD_CHARS) {
        squeezeBudget = CONTEXT_HARD_CHARS;
      }
      const mapped = s.messages.map(renderMessage).filter((m): m is ChatMessage => m !== null);
      // 续跑提示只作用于本次请求，不落库、不在 UI 出现
      if (pendingNudge) mapped.push({ role: 'user', content: pendingNudge });
      return mapped;
    };

    /** 落一条过程节点记录（思考完成 / 瞬断重试 / 自动续跑）：只进时间线展示，不进模型上下文。
     *  这样刷新网页、重启服务后，过程状态不再凭空消失。
     *  @param thinking 该步骤模型的思考正文（可选）——同样只是展示用元数据，前端可折叠展开。 */
    const appendNote = (
      noteKind: NonNullable<SessionMessage['noteKind']>,
      note: string,
      thinking?: string,
    ): void => {
      try {
        const t = String(thinking || '');
        const stored = t.length > THINKING_STORE_CAP
          ? `${t.slice(0, THINKING_STORE_CAP)}\n…（思考过长，已截断 ${t.length - THINKING_STORE_CAP} 字）`
          : t;
        appendMessage(sessionId, {
          role: 'assistant', content: '', time: Date.now(), note, noteKind,
          ...(stored ? { thinking: stored } : {}),
        });
      } catch { /* 过程记录写入失败不影响主流程 */ }
    };

    /** 本步回复没有工具调用、但口吻上还没做完 → 记一次续跑提示；返回 true 时由调用方 continue。
     *  @param stepNo      当前步号（日志用）
     *  @param stopReason  本步上游的停止原因（'length' = 被 max_tokens 截断）
     *  续跑条件（任一成立）：① 正文为空（只出了思考 / 什么都没出，**绝不可能**是最终答复）
     *  ② 上游因达到最大输出长度截断（答复是被砍断的，不是写完了）
     *  ③ 正文口吻上明显还打算继续（「让我看看…」）。 */
    const tryAutoContinue = (body: string, stepNo: number, stopReason = ''): boolean => {
      const empty = !body.trim();
      const truncated = isLengthStop(stopReason);
      if (autoContinues >= MAX_AUTO_CONTINUE) return false;
      if (!empty && !truncated && !looksUnfinished(body)) return false;
      autoContinues++;
      const reason = empty
        ? '本步只有思考、没有正文也没有调用工具'
        : truncated
          ? '本步答复被最大输出长度截断'
          : '未调用工具但疑似未完成';
      pendingNudge = empty ? EMPTY_ANSWER_NUDGE : CONTINUE_NUDGE;
      const note = `${reason}，已自动续跑（${autoContinues}/${MAX_AUTO_CONTINUE}）`;
      logAction('【AI】', `第 ${stepNo} 步${note}`, undefined, 'warn');
      emit({ type: 'step_note', text: note });
      appendNote('note', note);
      return true;
    };

    let step = 0;
    let finalText = '';
    let hadTool = false;
    // 「只叙述、不调用工具」「只思考不产出」的兜底：待发送的续跑提示 + 本轮已续跑次数
    let pendingNudge = '';
    let autoContinues = 0;
    // 最后一个「无工具调用」步骤的思考字数与停止原因，用于收尾时给出可诊断的兜底文案
    let lastBareStep = { stepNo: 0, thinkingChars: 0, stopReason: '' };
    // 本轮整体耗时（前端右上角实时计时 + 最终答复右下角固定耗时）
    const turnStart = Date.now();
    // 本轮文件变更汇总（同一路径保留最后一次，供最终答复渲染文件网格）
    const turnChanges: FileChange[] = [];
    // 本轮 token 用量（含缓存命中），结束时写运行日志
    const turnUsage = { input: 0, output: 0, cached: 0, cacheWrite: 0 };
    /** 本轮之前的会话累计用量（各条历史消息的 usage 之和）。
     *  每次 usage 事件都下发 base + turnUsage，前端直接显示、无需自己累加，
     *  也就不会因为「刷新后重新拉取会话」而把数字算重或算丢。 */
    const usageBase = sumTurnUsage(getSession(sessionId)?.messages.map((m) => m.usage) ?? []);

    while (true) {
      if (abort.signal.aborted) throw new Error('已停止');
      step++;
      if (step > SETTINGS_FILE_MAX_STEPS) {
        throw new Error(`已达单轮最大步数（${SETTINGS_FILE_MAX_STEPS}），已中断。你可以继续发消息让它接着做。`);
      }

      let text = '';
      // 本步模型的思考正文（reasoning_content / Anthropic thinking）：逐块转发给前端，
      // 本步结束后随过程节点落库。**绝不写入 text、也绝不进模型上下文**。
      let stepThinking = '';
      // 本步上游停止原因：'length' = 被 max_tokens 截断（输出预算被思考烧完时会出现）
      let stepStopReason = '';
      // 本步的 token 用量。**每次尝试都重置**：重试只在「本步尚未外发内容」时发生，
      // 但失败那次可能已经上报过 usage，若不清零会把同一步算两遍。
      let stepUsage = { input: 0, output: 0, cached: 0, cacheWrite: 0 };
      const nativeCalls: { id: string; name: string; args: Record<string, unknown> }[] = [];

      // —— 步级自动重试 ——
      // 本步还没有向用户外发过任何文本时，上游报错（网关 403/503/超时/流空断等瞬断）静默重试 retryCount 次；
      // 已外发部分文本的流中断无法透明重试（会重复输出），仍走错误卡片人工续跑。
      // 注意：上游访问日志已由 provider 层「一次访问一条」逐条记录，这里不再按步骤重复记日志。
      const maxAttempts = Math.max(1, (profile.retryCount ?? 5) + 1);
      let attempt = 0;
      // 本步累计的瞬断重试次数（0 = 未发生瞬断）
      let stepRetries = 0;
      while (true) {
        attempt++;
        let streamed = false;
        try {
          text = '';
          stepThinking = '';
          stepStopReason = '';
          stepUsage = { input: 0, output: 0, cached: 0, cacheWrite: 0 };
          nativeCalls.length = 0;
          // 文本协议：流式过滤工具调用指令，用户只看到叙述（每次尝试用全新过滤器）
          const suppress = isTextMode ? makeTextCallSuppressor() : null;
          for await (const ev of streamChat(profile, sysPrompt, buildHistory(), isTextMode ? [] : TOOL_DEFS, abort.signal, { sessionId, step })) {
            if (ev.type === 'delta' && ev.text) {
              text += ev.text;
              if (suppress) {
                const clean = suppress.push(ev.text);
                if (clean) { streamed = true; emit({ type: 'delta', text: clean }); }
              } else {
                streamed = true;
                emit({ type: 'delta', text: ev.text });
              }
            } else if (ev.type === 'thinking' && ev.text) {
              // 思考增量：原样转发（前端折叠展示），并累计到本步的思考正文
              stepThinking += ev.text;
              emit({ type: 'thinking', text: ev.text });
            } else if (ev.type === 'tool_call' && ev.toolCall) {
              nativeCalls.push(ev.toolCall);
            } else if (ev.type === 'end') {
              if (ev.stopReason) stepStopReason = ev.stopReason;
              if (ev.usage) {
                stepUsage.input = ev.usage.inputTokens || 0;
                stepUsage.output = ev.usage.outputTokens || 0;
                stepUsage.cached = ev.usage.cachedTokens || 0;
                stepUsage.cacheWrite = ev.usage.cacheWriteTokens || 0;
              }
            }
          }
          if (suppress) {
            const rest = suppress.flush();
            if (rest) { streamed = true; emit({ type: 'delta', text: rest }); }
          }
          break;
        } catch (err) {
          if (abort.signal.aborted) throw new Error('已停止');
          const msg = err instanceof Error ? err.message : String(err);
          // 配置类错误（401/402/404 等）不重试；已外发文本或已达上限时也不再重试
          if (streamed || attempt >= maxAttempts || !isRetryableUpstreamError(err)) throw err;
          stepRetries = attempt;
          emit({ type: 'step_retry', attempt, max: maxAttempts - 1, text: msg });
          await new Promise((r) => setTimeout(r, Math.min(1000 * attempt, 8000)));
        }
      }
      // 本步的思考已出结果：落一条过程节点（瞬断恢复记「重试」，否则记「思考完成」），刷新后不丢。
      // 思考正文一并带上，供前端折叠展开；它是元数据，buildHistory 会跳过。
      if (stepRetries > 0) appendNote('retry', `上游瞬断 · 已自动重试 ${stepRetries} 次 · 已恢复`, stepThinking);
      else appendNote('think', '思考完成', stepThinking);

      // 本步的 token 用量并入本轮，并把「本步增量 + 会话累计」下发给前端实时刷新。
      // 上游在流式模式下把 usage 放在最后一个 chunk（OpenAI `stream_options.include_usage`
      // / Anthropic `message_delta`），所以这一步就是拿到数字的最早时机。
      turnUsage.input += stepUsage.input;
      turnUsage.output += stepUsage.output;
      turnUsage.cached += stepUsage.cached;
      turnUsage.cacheWrite += stepUsage.cacheWrite;
      if (stepUsage.input || stepUsage.output) {
        emit({
          type: 'usage',
          step: step,
          turn: { ...turnUsage } satisfies TurnUsage,
          session: {
            input: usageBase.input + turnUsage.input,
            output: usageBase.output + turnUsage.output,
            cached: usageBase.cached + turnUsage.cached,
            cacheWrite: usageBase.cacheWrite + turnUsage.cacheWrite,
          } satisfies TurnUsage,
        });
      }

      // 空转保护：这一轮没有工具调用。三种情况都要自动续跑而不是就此收尾：
      //   ① 正文为空（只出了思考）——绝不可能是最终答复，静默收尾就是「界面卡死没有下一步」
      //   ② 上游因 max_tokens 截断——答复是被砍断的
      //   ③ 口吻上明显还打算继续（「让我看看…」）
      if (!isTextMode && !nativeCalls.length) {
        const body = text.trim();
        lastBareStep = { stepNo: step, thinkingChars: stepThinking.length, stopReason: stepStopReason };
        if (tryAutoContinue(body, step, stepStopReason)) continue;
        finalText = body;
        break;
      }
      if (isTextMode) {
        const { calls, cleaned } = parseTextToolCalls(text);
        if (!calls.length) {
          const body = (cleaned || text).trim();
          lastBareStep = { stepNo: step, thinkingChars: stepThinking.length, stopReason: stepStopReason };
          if (tryAutoContinue(body, step, stepStopReason)) continue;
          finalText = body;
          break;
        }
        pendingNudge = ''; // 已真正调用工具，续跑提示到此为止
        // 文本模式：把解析出的调用落库（UI 以工具步骤呈现），文本去掉调用行
        appendMessage(sessionId, { role: 'assistant', content: cleaned, time: Date.now(), toolCalls: calls.map((c, i) => ({ id: `t${step}_${i}`, name: c.name, args: c.args })) });
        for (const c of calls) {
          if (abort.signal.aborted) throw new Error('已停止');
          hadTool = true;
          emit({ type: 'step_start', index: step, tool: { name: c.name, args: c.args } });
          const result = runTool(c.name, c.args, sessionId);
          emit({ type: 'step_end', index: step, tool: c.name, ok: result.ok, output: result.output.slice(0, 4000) });
          if (result.change) { turnChanges.push(result.change); emit({ type: 'file_change', change: result.change }); }
          appendMessage(sessionId, {
            role: 'tool',
            content: result.output.length > TOOL_STORE_CAP
              ? `${result.output.slice(0, TOOL_STORE_CAP)}\n【输出过长，仅保留前 ${TOOL_STORE_CAP} 字符（原文 ${result.output.length} 字符）。read_file 请用 offset/limit 分段读取后续内容；search_text 请改用更具体的关键词。】`
              : result.output,
            time: Date.now(),
            toolCallId: `t${step}_${c.name}`, toolName: c.name, toolOk: result.ok, change: result.change,
          });
        }
        continue;
      }

      // 原生模式：记录 assistant（含工具调用）并逐个执行
      pendingNudge = ''; // 已真正调用工具，续跑提示到此为止
      appendMessage(sessionId, { role: 'assistant', content: text, time: Date.now(), toolCalls: nativeCalls });
      for (const tc of nativeCalls) {
        if (abort.signal.aborted) throw new Error('已停止');
        hadTool = true;
        emit({ type: 'step_start', index: step, tool: { name: tc.name, args: tc.args } });
        const result = runTool(tc.name, tc.args, sessionId);
        emit({ type: 'step_end', index: step, tool: tc.name, ok: result.ok, output: result.output.slice(0, 4000) });
        if (result.change) { turnChanges.push(result.change); emit({ type: 'file_change', change: result.change }); }
        appendMessage(sessionId, {
          role: 'tool',
          content: result.output.length > TOOL_STORE_CAP
            ? `${result.output.slice(0, TOOL_STORE_CAP)}\n【输出过长，仅保留前 ${TOOL_STORE_CAP} 字符（原文 ${result.output.length} 字符）。read_file 请用 offset/limit 分段读取后续内容；search_text 请改用更具体的关键词。】`
            : result.output,
          time: Date.now(),
          toolCallId: tc.id,
          toolName: tc.name,
          toolOk: result.ok,
          change: result.change,
        });
      }
    }

    if (!finalText.trim() && !hadTool && lastBareStep.thinkingChars === 0) {
      throw new Error('上游未返回任何内容（模型回复为空）。请检查档案配置/密钥/模型名，或换一个上游。');
    }
    // 模型只输出了思考、没有正文也没有工具调用（典型是思考把输出预算烧完、被上游以 max_tokens 截断）。
    // **绝不能静默收尾**——那会落一条 content 为空的最终答复，用户看到的就是
    // 「到这一步直接卡住、没有下一步操作」（会话 221a504c 的真实故障）。
    if (!finalText.trim()) {
      finalText = emptyAnswerNotice(lastBareStep.stepNo || step, lastBareStep.thinkingChars, lastBareStep.stopReason);
      logAction(
        '【AI】',
        `第 ${lastBareStep.stepNo || step} 步无正文且无工具调用（stop_reason=${lastBareStep.stopReason || '未知'}，思考 ${lastBareStep.thinkingChars} 字），已以提示收尾`,
        undefined,
        'warn',
      );
    }
    // 答复本身被 max_tokens 截断（有正文但不完整）：补一句说明，否则用户以为模型写半句就停了。
    if (isLengthStop(lastBareStep.stopReason) && finalText.trim()) {
      finalText += '\n\n---\n> ⚠️ 该答复达到**最大输出长度**（max_tokens）后被上游截断，可能不完整。'
        + '可在「模型配置」里调高 maxTokens，或把思考强度降一档，然后继续追问。';
    }
    // 同一文件多次编辑只保留最终 diff：历史回扫（覆盖续跑前半段）+ 本轮实时收集，按路径后者覆盖
    const byPath = new Map<string, FileChange>();
    for (const c of [...collectTaskChanges(sessionId), ...turnChanges]) byPath.set(c.path, c);
    const turnChangeList = [...byPath.values()];
    appendMessage(sessionId, {
      role: 'assistant',
      content: finalText,
      time: Date.now(),
      changes: turnChangeList,
      durationMs: Date.now() - turnStart,
      // 本轮用量落库：刷新后据此恢复「本会话」累计显示；属展示元数据，不进模型上下文
      ...(turnUsage.input || turnUsage.output ? { usage: { ...turnUsage } } : {}),
    });
    updateSessionMeta(sessionId, { status: 'idle' });
    const done = getSession(sessionId);
    emit({ type: 'done', message: done?.messages[done.messages.length - 1] });
    logAction('【AI】', `会话任务完成（${profile.name} / ${profile.model}，${toolMode === 'text' ? '文本协议' : '原生工具'}，${step} 步）`);
    if (turnUsage.input || turnUsage.output) {
      const cacheNote = turnUsage.cached || turnUsage.cacheWrite
        ? `，命中缓存 ${turnUsage.cached}（缓存写入 ${turnUsage.cacheWrite}）`
        : '';
      logAction('【AI】', `本轮 token 用量：输入 ${turnUsage.input} / 输出 ${turnUsage.output}${cacheNote}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 错误持久化进会话：重载/重启后仍可见，而不是转瞬即逝的流内提示
    try {
      appendMessage(sessionId, { role: 'assistant', content: `⚠️ 执行出错：${msg}`, time: Date.now(), isError: true });
    } catch { /* ignore */ }
    updateSessionMeta(sessionId, { status: 'error' });
    emit({ type: 'error', message: msg });
    logAction('【AI】', `会话执行异常：${msg}`, undefined, 'warn');
  } finally {
    running.delete(sessionId);
  }
}
