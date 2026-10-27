/**
 * 构建「接口代理」的三份协议源快照。
 *
 *   node scripts/build-proxy-sources.mjs
 *
 * 产物落在 src/proxy/registry/_sources/ 下：
 *   - napcat-actions.json        NapCat OneBot11 action 清单（含入参/返回/中文描述）
 *   - snowluma-openapi.json      SnowLuma OpenAPI 3.1 规范原文（由 --fetch 时下载）
 *   - qq-official-openapi.json   QQ 官方 API v2 清单（从 bot-docs 源码解析）
 *
 * 三份快照是「覆盖率门禁」的唯一依据：注册表里每一条 impl 都必须回溯到快照中的某个原始
 * 接口，反之亦然。因此解析务必宁缺毋滥——拿不稳的字段留空并在 stderr 报警，不要猜。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(ROOT, 'src', 'proxy', 'registry', '_sources');

/* ─────────────────────────── 通用小工具 ─────────────────────────── */

/** 从 `startIdx` 处（须正好是开括号）返回与之配对的闭括号下标，跳过字符串与注释。 */
function matchBracket(text, startIdx) {
  const pairs = { '(': ')', '[': ']', '{': '}' };
  const open = text[startIdx];
  const close = pairs[open];
  if (!close) return -1;
  let depth = 0;
  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i++;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 抽取第一个 `Type.Object({...})` 的大括号内容原文。 */
function extractTypeObjectBody(src) {
  const at = src.indexOf('Type.Object(');
  if (at < 0) return null;
  const openIdx = src.indexOf('{', at);
  if (openIdx < 0) return null;
  const closeIdx = matchBracket(src, openIdx);
  if (closeIdx < 0) return null;
  return src.slice(openIdx + 1, closeIdx);
}

/** 在 body 中切出深度为 1 的顶层字段：`fieldName: <expr>`。 */
function splitTopLevelFields(body) {
  const fields = [];
  let depth = 0;
  let tokenStart = 0;
  const flush = (endExclusive) => {
    const raw = body.slice(tokenStart, endExclusive).trim();
    if (raw) fields.push(raw);
  };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i++;
      while (i < body.length && body[i] !== quote) {
        if (body[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (ch === ',' && depth === 0) {
      flush(i);
      tokenStart = i + 1;
    }
  }
  flush(body.length);
  return fields;
}

/** 从单值表达式推断统一的字段类型名。 */
function inferType(expr) {
  let bare = expr.trim();
  let optional = false;
  if (/^Type\.Optional\s*\(/.test(bare)) {
    optional = true;
    bare = bare.replace(/^Type\.Optional\s*\(/, '').replace(/\)$/, '').trim();
  }
  const typeName = /^Type\.([A-Za-z]+)/.exec(bare)?.[1] ?? null;
  return { optional, typeName, raw: expr.trim() };
}

/** 取 Type.X({ description: 'xxx' }) 里的说明文案（可能是中文，含转义引号）。 */
function readDescription(expr) {
  // 只取最外层那次 Type.Xxx(...) 的实参，避免嵌套 Type 里的 description 被误取
  const paren = expr.indexOf('(');
  if (paren < 0) return null;
  const close = matchBracket(expr, paren);
  const args = close < 0 ? expr.slice(paren + 1) : expr.slice(paren + 1, close);
  const m = /(?:^|,)\s*description\s*:\s*(['"`])([\s\S]*?)\1\s*(?:,|$)/.exec(args);
  if (!m) return null;
  return m[2].replace(/\\(['"`])/g, '$1').trim();
}

/** 解析 Type.Object 里的字段列表。 */
function parseSchemaFields(schemaSrc) {
  const body = extractTypeObjectBody(schemaSrc);
  if (body == null) return null;
  const out = [];
  for (const field of splitTopLevelFields(body)) {
    // 跳过展开写法：`...SomeSchema.properties`
    if (field.startsWith('...')) continue;
    const colon = field.indexOf(':');
    if (colon < 0) continue;
    const rawKey = field.slice(0, colon).trim();
    const key = rawKey.replace(/^['"`]|['"`]$/g, '');
    const expr = field.slice(colon + 1).trim();
    if (!expr) continue;
    const { optional, typeName, raw } = inferType(expr);
    out.push({
      key,
      type: typeName,
      optional,
      desc: readDescription(expr),
      required: !optional && typeName !== 'Null',
      raw: raw.length > 160 ? `${raw.slice(0, 160)}…` : raw,
    });
  }
  return out;
}

const warn = (msg) => process.stderr.write(`  ! ${msg}\n`);

/* ──────────────────────── 1. NapCat OneBot11 ──────────────────────── */

function readActionNameMap(routerSrc) {
  const at = routerSrc.indexOf('export const ActionName = {');
  if (at < 0) throw new Error('router.ts 中找不到 ActionName 定义');
  const openIdx = routerSrc.indexOf('{', at);
  const closeIdx = matchBracket(routerSrc, openIdx);
  // 必须先剥掉行注释：router.ts 里有 6 条是被注释掉的废弃声明
  // （如 `// UploadForwardMsg : "upload_forward_msg",`），不处理会把它们当成真实接口，
  // 凭空多出一堆永远调不通的条目。
  const body = stripLineComments(routerSrc.slice(openIdx + 1, closeIdx));
  const map = new Map();
  const re = /([A-Za-z0-9_]+)\s*:\s*['"`]([a-zA-Z0-9_.]+)['"`]/g;
  let m;
  while ((m = re.exec(body)) !== null) map.set(m[1], m[2]);
  return map;
}

/** 去掉 `//` 行注释，保留字符串字面量内的 `//`（如 URL）。 */
function stripLineComments(src) {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out += ch;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') {
          out += src[i] + (src[i + 1] ?? '');
          i += 2;
          continue;
        }
        out += src[i];
        i++;
      }
      out += quote;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * 按 class 声明切分文件，得到若干 handler 区块。
 *
 * NapCat 的类层级比看上去复杂，按生态环境一共四种写法，必须全认：
 *   A. `export default class GetLoginInfo extends OneBotAction<...>`          最常见
 *   B. `class DeleteMsg extends OneBotAction<...>` + 末尾 `export default DeleteMsg;`
 *   C. `export default class SendMsg extends SendMsgBase`                     继承中间件基类
 *   D. `export class GetRkey extends GetPacketStatusDepends<...>`             包一层依赖检查基类
 * 因此判据不能是「extends 了谁」，只能是**类体内是否声明了 actionName**——
 * 没有 actionName 的都是给别人继承的基类（SendMsgBase / OCRImageBase 等），天然被过滤掉。
 */
/**
 * 找到 class 体的起始花括号下标。
 *
 * 不能直接取 `extends` 之后的第一个 `{`：返回类型的泛型里常常自带花括号，
 * 例如 `OneBotAction<GetFilesetIdPayload, { fileset_id: string }>`——
 * 那样会把 close 提到了泛型内部，整个类体读错，
 * get_fileset_id / test_download_stream 正是因此整条丢失。
 * 正确做法是跳过 `<>` 内的一切，取尖括号深度回到 0 之后的第一个 `{`。
 */
function findClassBodyStart(src, from) {
  let angle = 0;
  for (let i = from; i < src.length; i++) {
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (ch === '<') angle++;
    else if (ch === '>') angle = Math.max(0, angle - 1);
    else if (ch === '{' && angle === 0) return i;
  }
  return -1;
}

function splitHandlers(src) {
  const clean = stripBlockComments(stripLineComments(src));
  const marks = [];
  const re = /\bclass\s+(\w+)\s+extends\s+/g;
  let m;
  while ((m = re.exec(clean)) !== null) {
    const bodyStart = findClassBodyStart(clean, re.lastIndex);
    if (bodyStart < 0) continue;
    marks.push({ name: m[1], bodyStart });
    re.lastIndex = bodyStart;
  }
  // preceding 只取「上一个类结束 ~ 本类开始」之间的文本：多 handler 文件里若把前一个类体
  // 也算进来，兜底查找会错认前一个类的 returnSchema 当作本类的 payloadSchema。
  const result = [];
  let floor = 0;
  for (const mark of marks) {
    const close = matchBracket(clean, mark.bodyStart);
    const bodyEnd = close > 0 ? close + 1 : clean.length;
    const chunk = { className: mark.name, text: clean.slice(mark.bodyStart, bodyEnd) };
    if (/actionName\s*=\s*ActionName\./.test(chunk.text)) {
      result.push({ ...chunk, preceding: clean.slice(floor, mark.bodyStart) });
    }
    floor = bodyEnd;
  }
  return result;
}

/** 去掉 /* *\/ 块注释，避免注释里的伪代码被当成 class 声明。 */
function stripBlockComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/**
 * 取出某个 handler 的 PayloadSchema 声明源码。
 * 优先区内联写法 `override payloadSchema = Type.Object({...})`；
 * 退化为 `override payloadSchema = PayloadSchema` 时，回溯到最近的 `const PayloadSchema = ...;`。
 */
function resolvePayloadSchemaSrc(classChunk, precedingSrc) {
  const assign = /payloadSchema\s*=\s*([^;\n]+);/.exec(classChunk.text);
  if (!assign) return null;
  const value = assign[1].trim();

  if (/^Type\./.test(value)) {
    // 内联写法：从 class 区块里把整段 Type.Object(...)/Type.Composite(...) 抠出来
    const semi = classChunk.text.indexOf(';', classChunk.text.indexOf(assign[0]));
    return semi > 0
      ? classChunk.text.slice(classChunk.text.indexOf(assign[1], classChunk.text.indexOf(assign[0])), semi)
      : value;
  }

  // 变量引用写法：回溯最近的 `const <value> = ...;`
  const declAt = precedingSrc.lastIndexOf(`const ${value} =`);
  if (declAt >= 0) {
    const semi = precedingSrc.indexOf(';', declAt);
    return semi > 0 ? precedingSrc.slice(declAt, semi) : precedingSrc.slice(declAt);
  }

  // 兜底：子类自身没写 payloadSchema（继承自基类，如 SendMsg extends SendMsgBase），
  // 取该文件内本类之前最后一段 `const X = Type.Object({...})`——命名未必叫 PayloadSchema。
  let best = -1;
  let at = 0;
  for (;;) {
    const hit = precedingSrc.indexOf('Type.Object(', at);
    if (hit < 0) break;
    const close = matchBracket(precedingSrc, precedingSrc.indexOf('{', hit));
    if (close < 0) break;
    best = hit;
    at = close + 1;
  }
  if (best < 0) return null;
  const lineStart = precedingSrc.lastIndexOf('\n', best) + 1;
  const semi = precedingSrc.indexOf(';', best);
  return precedingSrc.slice(lineStart, semi > 0 ? semi + 1 : undefined);
}

function pickStringLiteral(text, prop) {
  const re = new RegExp(`${prop}\\s*=\\s*(['"\`])([\\s\\S]*?)\\1`);
  const m = re.exec(text);
  if (!m) return null;
  return m[2].replace(/\\(['"`])/g, '$1').trim();
}

function buildNapcat() {
  const actionRoot = path.join(SRC_DIR, '_napcat', 'packages', 'napcat-onebot', 'action');
  if (!fs.existsSync(actionRoot)) {
    warn(`跳过 NapCat：缺少 ${actionRoot}（先跑 extract-subtree.py）`);
    return null;
  }
  const actionNames = readActionNameMap(fs.readFileSync(path.join(actionRoot, 'router.ts'), 'utf8'));

  const skip = new Set(['index.ts', 'router.ts', 'schemas.ts', 'OneBotAction.ts', 'auto-register.ts']);
  const files = [];
  (function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name !== 'example') walk(full); // example/ 只有样例常量，不是 handler
      } else if (ent.name.endsWith('.ts') && !skip.has(ent.name)) {
        files.push(full);
      }
    }
  })(actionRoot);

  const actions = [];
  const seen = new Set();

  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const rel = path.relative(actionRoot, file).replace(/\\/g, '/');

    for (const chunk of splitHandlers(src)) {
      const keyRef = /actionName\s*=\s*ActionName\.(\w+)/.exec(chunk.text)?.[1];
      if (!keyRef) continue;
      const action = actionNames.get(keyRef);
      if (!action) {
        warn(`${rel}: ActionName.${keyRef} 未在 router.ts 中定义`);
        continue;
      }
      const tagsRaw = /actionTags\s*=\s*\[([\s\S]*?)\]/.exec(chunk.text)?.[1] ?? '';
      const tags = [...tagsRaw.matchAll(/['"`]([^'"`]+)['"`]/g)].map((x) => x[1]);

      const params = (() => {
        const payloadSrc = resolvePayloadSchemaSrc(chunk, chunk.preceding ?? '');
        return payloadSrc ? parseSchemaFields(payloadSrc) : null;
      })();

      if (seen.has(action)) {
        warn(`${rel}: 重复 action ${action}，保留先出现的那条`);
        continue;
      }
      seen.add(action);
      actions.push({
        action,
        className: chunk.className,
        file: rel,
        tags,
        summary: pickStringLiteral(chunk.text, 'actionSummary'),
        description: pickStringLiteral(chunk.text, 'actionDescription'),
        params,
      });
    }
  }

  actions.sort((a, b) => a.action.localeCompare(b.action));

  // 枚举里有、但没有任何 handler 实现的 action —— 明确记账，别让用户以为能调
  const unimplemented = [...actionNames.values()].filter((n) => !seen.has(n)).sort();

  return {
    source: 'NapCatQQ/packages/napcat-onebot/action (router.ts ActionName + handler payloadSchema)',
    fetchedAt: new Date().toISOString().slice(0, 10),
    actionCount: actions.length,
    unimplementedActions: unimplemented,
    actions,
  };
}

/* ───────────────────── 2. SnowLuma OpenAPI ───────────────────── */

function buildSnowluma() {
  // 原始规范固定放在 _raw/ —— 绝不能和本脚本的输出同名，否则第二次跑会读到自己吐出的
  // 归一化结果，paths 直接为空（这条踩过一次）。
  const file = path.join(SRC_DIR, '_raw', 'snowluma-spec.json');
  if (!fs.existsSync(file)) {
    warn('跳过 SnowLuma：缺少 snowluma-openapi.json');
    return null;
  }
  const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
  const paths = Object.keys(spec.paths ?? {});
  const verbs = new Set();
  for (const p of paths) {
    for (const v of Object.keys(spec.paths[p] ?? {})) verbs.add(v.toUpperCase());
  }
  return {
    source: 'https://snowluma.github.io/openapi/snowluma.json',
    fetchedAt: new Date().toISOString().slice(0, 10),
    // 全文太大（570KB+）不适合进仓库 participated 目录，只保留必要信息 + 原始指针
    actionCount: paths.length,
    verbs: [...verbs].sort(),
    specVersion: spec.openapi,
    title: spec.info?.title,
    actions: paths.map((p) => ({
      action: p.replace(/^\//, ''),
      ops: Object.fromEntries(
        Object.entries(spec.paths[p]).map(([verb, op]) => [
          verb.toUpperCase(),
          {
            summary: op.summary ?? null,
            description: op.description ?? null,
            tags: op.tags ?? [],
            requestBody: flattenRequestBody(op.requestBody),
            responses: flattenResponses(op.responses),
          },
        ]),
      ),
    })).sort((a, b) => a.action.localeCompare(b.action)),
  };
}

function flattenRequestBody(reqBody) {
  if (!reqBody?.content) return null;
  const json = reqBody.content['application/json'];
  if (!json?.schema) return null;
  const schema = json.schema;
  const props = {};
  for (const [k, v] of Object.entries(schema.properties ?? {})) {
    props[k] = { type: normalizeOpenApiType(v), desc: v.description ?? null };
  }
  return { required: schema.required ?? [], properties: props, requiredBody: !!reqBody.required };
}

function flattenResponses(responses) {
  const out = {};
  for (const [status, resp] of Object.entries(responses ?? {})) {
    const schema = resp?.content?.['application/json']?.schema;
    out[status] = {
      description: resp?.description ?? null,
      schemaRef: schema?.$ref ?? null,
      properties: schema?.properties
        ? Object.fromEntries(
          Object.entries(schema.properties).map(([k, v]) => [k, normalizeOpenApiType(v)]),
        )
        : null,
      enumValues: schema?.enum ?? null,
    };
  }
  return out;
}

function normalizeOpenApiType(schema) {
  if (!schema) return 'unknown';
  if (schema.anyOf || schema.oneOf) return `union(${schema.anyOf ?? schema.oneOf.map((s) => normalizeOpenApiType(s)).join('|')})`;
  if (schema.$ref) return schema.$ref.replace('#/components/schemas/', '');
  if (schema.type === 'array') return `array<${normalizeOpenApiType(schema.items) ?? 'unknown'}>`;
  if (Array.isArray(schema.type)) return schema.type.join('|');
  return schema.type ?? (schema.enum ? 'enum' : 'unknown');
}

/* ────────────────── 3. QQ 官方 API v2（bot-docs 源码） ────────────────── */

/**
 * 匹配文档里声明 HTTP 方法的那一行。
 *
 * 同一份文档至少有三种包裹风格，必须都认：
 *   `POST /channels/{channel_id}/messages`        ← 单个反引号
 *   `**POST** /v2/users/{openid}/messages`        ← 反引号里再套粗体
 *   - DELETE /channels/{channel_id}               ← 列表项
 * 只处理「反引号+粗体」会把第一种整条漏掉，而发送消息类核心接口恰好全用它。
 */
const OFFICIAL_METHOD_LINE =
  /^\s*(?:-\s*)?[`*_]{0,3}(GET|POST|PUT|PATCH|DELETE)[`*_]{0,3}\s+(\S+)/i;

/**
 * 把路径里的「具体 ID」段换成占位符，用于识别同一接口的模板写法与示例写法。
 *
 * 文档正文里到处是示例 URL（`/channels/123456/messages/112233`），和真正的路径模板
 * （`/channels/{channel_id}/messages/{message_id}`）其实是同一条接口，必须归并：
 * 否则 65 条会被放大到 84 条，平白多出 19 个永不存在的重复条目。
 */
function canonicalizePath(rawPath) {
  return rawPath
    .replace(/\{[^}]*\}/g, '{}')
    .split('/')
    .map((seg) => (/^(\d+|[0-9a-f]{8,}|[0-9A-Fa-f]{20,})$/.test(seg) ? '{}' : seg))
    .join('/');
}

/**
 * 第二路解析：HTML 表格里声明的接口。
 *
 * v2 的发送消息、富媒体上传等一批核心接口不用独立的方法行，而是写在表格里：
 *   <td>HTTP URL</td>     <td>/v2/users/{openid}/messages</td>
 *   <td>HTTP Method</td>  <td>POST</td>
 * 只 parse 方法行会把这一整批漏掉——而它们恰恰是最常用的接口。
 *
 * 还有一种：整张表被 `<!-- -->` 注释掉了（群成员列表标注「内邀开放」）。
 * 那不是幻觉条目，是文档里真实写着但暂不放开的接口，必须保留并打 `disabled` 标记——
 * 默默丢掉的话，日后做覆盖率比对时会误以为解析有遗漏。
 */
const TABLE_URL_ROW = /<td>\s*HTTP\s*URL\s*<\/td>\s*<td>\s*([^<]+?)\s*<\/td>/gi;
const TABLE_METHOD_TOP = /<td>\s*HTTP\s*Method\s*<\/td>\s*<td>\s*([A-Za-z]+)\s*<\/td>/i;

/** 算出所有 <!-- --> 注释覆盖的字符区间。 */
function htmlCommentSpans(src) {
  const spans = [];
  const re = /<!--[\s\S]*?-->/g;
  let m;
  while ((m = re.exec(src)) !== null) spans.push([m.index, re.lastIndex]);
  return spans;
}

function extractTableApis(src, file, root, sink) {
  // 注释内的匹配照常提取，但不洗掉注释内容：靠区间判断打标记，保留可追溯性
  const spans = htmlCommentSpans(src);
  const inComment = (idx) => spans.some(([a, b]) => idx >= a && idx < b);
  let m;
  TABLE_URL_ROW.lastIndex = 0;
  while ((m = TABLE_URL_ROW.exec(src)) !== null) {
    const url = m[1].trim();
    if (!url.startsWith('/')) continue;
    // 方法行在 URL 行前后 200 字符内的可能性最高
    const windowStart = Math.max(0, m.index - 200);
    const windowEnd = Math.min(src.length, TABLE_URL_ROW.lastIndex + 200);
    const window = src.slice(windowStart, windowEnd);
    const methodTop = TABLE_METHOD_TOP.exec(window);
    if (!methodTop) continue;
    const method = methodTop[1].toUpperCase();
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) continue;
    const line = src.slice(0, m.index).split('\n').length;
    let title = null;
    const lines = src.split(/\r?\n/);
    for (let j = line - 1; j >= 0; j--) {
      const h = /^#{1,6}\s+(.+)$/.exec(lines[j]);
      if (h) {
        title = h[1].replace(/[`#*]/g, '').trim();
        break;
      }
    }
    sink({
      method,
      path: url,
      title,
      disabled: inComment(m.index),
      group: path.relative(root, path.dirname(file)).replace(/\\/g, '/'),
      file: path.relative(root, file).replace(/\\/g, '/'),
      line,
      via: 'table',
    });
  }
}

function buildQqOfficial() {
  const root = path.join(SRC_DIR, '_botdocs', 'docs', 'develop', 'api-v2');
  if (!fs.existsSync(root)) {
    warn(`跳过 QQ 官方：缺少 ${root}（先跑 extract-subtree.py）`);
    return null;
  }
  const files = [];
  (function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.name.endsWith('.md')) files.push(full);
    }
  })(root);

  // 同一条接口的模板写法与示例写法按 canonical key 归并，保留占位符更多的那个（模板写法）
  const entries = [];
  const byKey = new Map();

  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const lines = src.split(/\r?\n/);

    const push = (entry) => {
      // 查询串属于 Sample 的一部分，必须在归并前剥掉：
      // `DELETE /x/messages/{id}?hidetip=false` 与示例 `DELETE /channels/123456/messages/112233`
      // 若不先去掉 ? 之后的内容，canonical key 不同，会被当成两条接口。
      const cleanPath = entry.path.split('?')[0];
      if (!cleanPath.startsWith('/')) return;
      const key = `${entry.method} ${canonicalizePath(cleanPath)}`;
      const prior = byKey.get(key);
      // 模板写法（占位符多）优先于示例写法（全是具体 ID）；
      // 未注释的正式接口优先于「内邀开放」这类被注释掉的同路径条目。
      const score = (e) => (e.disabled ? 0 : 100) + (e.path.match(/\{/g) ?? []).length;
      if (!prior || score({ ...entry, path: cleanPath }) > score(prior)) {
        byKey.set(key, { ...entry, path: cleanPath });
      }
    };

    for (let i = 0; i < lines.length; i++) {
      const m = OFFICIAL_METHOD_LINE.exec(lines[i]);
      if (!m) continue;
      const method = m[1].toUpperCase();
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) continue;
      const rawPath = m[2].replace(/[`*]/g, '');

      let title = null;
      for (let j = i; j >= 0; j--) {
        const h = /^#{1,6}\s+(.+)$/.exec(lines[j]);
        if (h) {
          title = h[1].replace(/[`#*]/g, '').trim();
          break;
        }
      }
      push({
        method,
        path: rawPath,
        title,
        group: path.relative(root, path.dirname(file)).replace(/\\/g, '/'),
        file: path.relative(root, file).replace(/\\/g, '/'),
        line: i + 1,
        via: 'method-line',
      });
    }

    // 表格里声明的接口同一 tabindex 走第二路解析
    extractTableApis(src, file, root, push);
  }


  const list = [...byKey.values()].sort((a, b) => (a.method + a.path).localeCompare(b.method + b.path));
  const disabled = list.filter((e) => e.disabled).map((e) => `${e.method} ${e.path}`);
  return {
    source: 'tencent-connect/bot-docs: docs/develop/api-v2',
    fetchedAt: new Date().toISOString().slice(0, 10),
    actionCount: list.length,
    disabledCount: disabled.length,
    // 文档里真实写着、但整段被注释掉（标注「内邀开放」）尚未放开的接口
    disabledEntries: disabled,
    entries: list,
  };
}

/* ─────────────────────────── 主流程 ─────────────────────────── */

function main() {
  fs.mkdirSync(SRC_DIR, { recursive: true });

  const napcat = buildNapcat();
  const snowluma = buildSnowluma();
  const official = buildQqOfficial();

  const write = (name, data) => {
    if (!data) return;
    fs.writeFileSync(path.join(SRC_DIR, name), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    process.stdout.write(`  写入 ${name}  (${data.actionCount ?? 0} 条)\n`);
  };

  write('napcat-actions.json', napcat);
  write('snowluma-openapi.json', snowluma);
  write('qq-official-openapi.json', official);

  process.stdout.write(
    `\n快照合计: ${(napcat?.actionCount ?? 0) + (snowluma?.actionCount ?? 0) + (official?.actionCount ?? 0)}\n`,
  );
  if (napcat?.unimplementedActions?.length) {
    process.stdout.write(`NapCat 枚举中存在但无 handler 实现: ${napcat.unimplementedActions.join(', ')}\n`);
  }
}

main();
