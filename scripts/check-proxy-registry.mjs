/**
 * 注册表覆盖率与一致性门禁。
 *
 * 这是「445 个原始接口一个都不能漏」这条硬要求唯一的自动保障手段——靠人眼抽查 250 条
 * 注册表是不可靠的。做法是把注册表里每条 impl 引用的原生标识收集起来，和三份源快照做
 * 双向差分：
 *
 *   MISSING  源里有、注册表没引用  → 必须清零（先阶段允许临时豁免，但必须显式列出）
 *   ORPHAN   注册表引用了、源里没有 → 需人工确认（可能是源过期，也可能是拼写错误）
 *
 * 用法：
 *   node scripts/check-proxy-registry.mjs            # 常规校验
 *   node scripts/check-proxy-registry.mjs --stats    # 额外打印分类/协议分布
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(ROOT, 'src', 'proxy', 'registry', '_sources');
const ENTRIES_DIR = path.join(ROOT, 'src', 'proxy', 'registry', 'entries');

const NAME_RE = /^[a-z][a-z0-9_]{1,39}$/;

function loadJson(name) {
  const file = path.join(SRC_DIR, name);
  if (!fs.existsSync(file)) {
    fail(`缺少源快照 ${name}。先跑 node scripts/build-proxy-sources.mjs`);
    return null;
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/* ───────────────────── 收集源侧的原始接口全集 ───────────────────── */

function collectNapcat(data) {
  const set = new Set();
  for (const a of data.actions ?? []) set.add(a.action);
  // 枚举里存在但无 handler 实现的（如 .get_word_slices）也算「源里有」，
  // 注册表必须显式处理它们（哪怕只标 stub），否则对账时才发现漏了。
  for (const a of data.unimplementedActions ?? []) set.add(a);
  return set;
}

function collectSnowluma(data) {
  const set = new Set();
  for (const a of data.actions ?? []) set.add(a.action);
  return set;
}

function collectOfficial(data) {
  const set = new Set();
  for (const e of data.entries ?? []) set.add(`${e.method} ${e.path}`);
  return set;
}

/* ───────────── 收集注册表侧引用的原生标识 ───────────── */

/**
 * 直接对源文件做静态扫描，避免为了校验去 import TS 模块（那需要一个 ts-node 运行时）。
 * 约定：variant.action 是 OneBot action 名，variant.path + variant.verb 组成官方标识。
 */
function collectRegistryRefs() {
  if (!fs.existsSync(ENTRIES_DIR)) return { napcat: new Set(), snowluma: new Set(), official: new Set() };
  const files = fs
    .readdirSync(ENTRIES_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => path.join(ENTRIES_DIR, f));

  const napcat = new Set();
  const snowluma = new Set();
  const official = new Set();

  // 直接扫源码文本，先把每个 `napcat:` / `snowluma:` / `official:` 块的字符区间算出来，
  // 再判断 `action:` / `path:` 命中归属于哪个协议。
  // 之所以不 import 这些 TS 模块，是因为校验脚本不该依赖 TS 运行时（见文件头说明）。
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const blocks = locateProtocolBlocks(src);

    const actionRe = /\baction\s*:\s*['"`]([a-zA-Z0-9_.]+)['"`]/g;
    const pathRe = /\bpath\s*:\s*['"`]([^'"`]+)['"`]/g;
    const verbRe = /\bverb\s*:\s*['"`]([A-Z]+)['"`]/g;

    const consume = (re, kind) => {
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(src)) !== null) {
        const proto = protocolAt(blocks, m.index);
        if (!proto) continue;
        if (kind === 'action') {
          (proto === 'official' ? official : proto === 'napcat' ? napcat : snowluma).add(m[1]);
        } else if (kind === 'path' && proto === 'official') {
          official.add(...lookupVerbs(src, blocks, m.index, m[1]));
        }
      }
    };
    consume(actionRe, 'action');
    consume(pathRe, 'path');

    // sameAs：协议端与 variants 等价的其它注册名（如 set_group_sign / send_group_sign）。
    // 功能上是同一个接口，不占独立 entry，但对账时必须算作已覆盖。
    const sameAsRe = /\bsameAs\s*:\s*\[([^\]]*)\]/g;
    let sm;
    while ((sm = sameAsRe.exec(src)) !== null) {
      const proto = protocolAt(blocks, sm.index);
      // 官方侧是「verb + path」成对，别名没法只用一个裸字符串表达，因此只处理 OneBot 系
      if (!proto || proto === 'official') continue;
      const names = [...sm[1].matchAll(/['"`]([a-zA-Z0-9_.]+)['"`]/g)].map((x) => x[1]);
      const bucket = proto === 'napcat' ? napcat : snowluma;
      for (const n of names) bucket.add(n);
    }
    // OneBot 侧没特殊处理，verb 只在官方块出现
    void verbRe;
  }
  return { napcat, snowluma, official };
}

/** 粗略算出每个 `napcat:` / `snowluma:` / `official:` 键在 impl 块中的区间。 */
function locateProtocolBlocks(src) {
  const blocks = [];
  const re = /\b(napcat|snowluma|official)\s*:\s*\{/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    let depth = 0;
    let end = m.index;
    for (let i = re.lastIndex - 1; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    blocks.push({ proto: m[1], start: m.index, end, depth: 0 });
  }
  blocks.sort((a, b) => a.start - b.start);
  return blocks;
}

function protocolAt(blocks, idx) {
  // 命中深处嵌套时取最内层的块
  let hit = null;
  for (const b of blocks) {
    if (idx >= b.start && idx <= b.end) {
      if (!hit || b.start >= hit.start) hit = b;
    }
  }
  return hit?.proto ?? null;
}

/** path 命中不一定紧跟 verb，需在其所属 variant 块里找 verb。 */
function lookupVerbs(src, blocks, pathIdx, pathValue) {
  const proto = 'official';
  const re = /\bverb\s*:\s*['"`]([A-Z]+)['"`]/g;
  let best = null;
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(src)) !== null) {
    if (Math.abs(m.index - pathIdx) > 400) continue;
    if (protocolAt(blocks, m.index) !== proto) continue;
    if (!best || Math.abs(m.index - pathIdx) < Math.abs(best.index - pathIdx)) {
      best = { index: m.index, verb: m[1] };
    }
  }
  return best ? [`${best.verb} ${pathValue}`] : [];
}

/* ─────────────────────────── 结果输出 ─────────────────────────── */

const problems = [];
function fail(msg) {
  problems.push(msg);
}
function diffSources(label, source, refs) {
  const missing = [...source].filter((s) => !refs.has(s)).sort();
  const orphan = [...refs].filter((r) => !source.has(r)).sort();
  process.stdout.write(
    `${label.padEnd(10)} 源 ${String(source.size).padStart(3)} / 注册表引用 ${String(refs.size).padStart(3)}`
    + `  未覆盖 ${missing.length}  孤立 ${orphan.length}\n`,
  );
  if (missing.length) {
    fail(`${label}: ${missing.length} 个源接口未被注册表覆盖`);
    missing.forEach((x) => process.stdout.write(`    MISSING  ${x}\n`));
  }
  if (orphan.length) {
    fail(`${label}: ${orphan.length} 个注册表引用在源里找不到（拼写错误或源已过期）`);
    orphan.forEach((x) => process.stdout.write(`    ORPHAN   ${x}\n`));
  }
  return { missing, orphan };
}

function main() {
  const napcat = loadJson('napcat-actions.json');
  const snowluma = loadJson('snowluma-openapi.json');
  const official = loadJson('qq-official-openapi.json');
  if (!napcat || !snowluma || !official) {
    report();
    return;
  }

  process.stdout.write('── 源快照 ────────────────────────────────────\n');
  process.stdout.write(`  napcat    ${napcat.actionCount} 条`);
  if (napcat.unimplementedActions?.length) {
    process.stdout.write(`（其中 ${napcat.unimplementedActions.length} 条无 handler 实现）`);
  }
  process.stdout.write('\n');
  process.stdout.write(`  snowluma  ${snowluma.actionCount} 条\n`);
  process.stdout.write(`  official  ${official.actionCount} 条`);
  if (official.disabledCount) process.stdout.write(`（含 ${official.disabledCount} 条「内邀开放」未放开）`);
  process.stdout.write('\n');
  const total = napcat.actionCount + snowluma.actionCount + official.actionCount;
  process.stdout.write(`  合计 ${total}\n\n`);

  process.stdout.write('── 覆盖率 ────────────────────────────────────\n');
  const refs = collectRegistryRefs();
  diffSources('napcat', collectNapcat(napcat), refs.napcat);
  diffSources('snowluma', collectSnowluma(snowluma), refs.snowluma);
  diffSources('official', collectOfficial(official), refs.official);

  checkEntryFiles();
  report();
}

/** 对已存在的条目文件做静态形状检查（短名唯一、必有 impl / examples 等）。 */
function checkEntryFiles() {
  if (!fs.existsSync(ENTRIES_DIR)) {
    process.stdout.write('\n── 条目 ──────────────────────────────────────\n  （entries/ 还不存在，跳过条目检查）\n');
    return;
  }
  const files = fs.readdirSync(ENTRIES_DIR).filter((f) => f.endsWith('.ts'));
  process.stdout.write('\n── 条目 ──────────────────────────────────────\n');
  const seenNames = new Set();
  let entryCount = 0;
  for (const file of files) {
    const src = fs.readFileSync(path.join(ENTRIES_DIR, file), 'utf8');
    // 缩进不固定（数组项里的对象首字段是 4 空格），用 `\s{2,}` 而不是写死两个
    const names = [...src.matchAll(/^\s{2,}name\s*:\s*'([a-z0-9_]+)'/gm)].map((m) => m[1]);
    for (const name of names) {
      entryCount++;
      if (!NAME_RE.test(name)) fail(`${file}: 短名 "${name}" 不符合 ${NAME_RE}`);
      if (seenNames.has(name)) fail(`${file}: 短名 "${name}" 重复`);
      seenNames.add(name);
    }
    checkEntryShape(file, src, seenNames);
  }
  process.stdout.write(`  条目文件 ${files.length} 个，注册表短名 ${entryCount} 个，去重后 ${seenNames.size} 个\n`);
}

/**
 * 逐条静态形状检查。
 *
 * 这里刻意不 import TS 模块（校验脚本不该依赖 TS 运行时），改用「按 name 切段 + 段内正则」。
 * 能查到绝大部分约定违规：support/impl 不一致、官方变体缺 verb、必填元字段缺失、
 * 危险等级没标、alias 没收全 —— 这些靠人眼审 250 条是审不出来的。
 */
function checkEntryShape(file, src, seenNames) {
  const blocks = splitEntryBlocks(src);
  for (const b of blocks) {
    const text = b.text;
    const name = (/\bname\s*:\s*'([a-z0-9_]+)'/.exec(text) ?? [])[1] ?? '?';

    // support 与 impl 的协议键必须完全一致（逃生舱 call_native 不做映射，豁免）
    const isNative = /\bscope\s*:\s*'native'/.test(text);
    const support = (/\bsupport\s*:\s*\[([^\]]*)\]/.exec(text)?.[1] ?? '')
      .split(',').map((s) => s.trim().replace(/['"`]/g, '')).filter(Boolean);
    const implProtos = isNative
      ? []
      : [...text.matchAll(/\b(napcat|snowluma|official)\s*:\s*\{/g)].map((m) => m[1]);
    // 逃生舱只要求声明 support，不要求 impl 块
    if (!isNative) {
      for (const p of support) {
        if (!implProtos.includes(p)) fail(`${file}: ${name} 的 support 含 "${p}" 但 impl 里没有对应块`);
      }
      for (const p of new Set(implProtos)) {
        if (!support.includes(p)) fail(`${file}: ${name} 的 impl 有 "${p}" 但 support 里没声明`);
      }
    }

    // 官方变体的 verb 与 path 必须成对（缺一就无法做覆盖率对账）
    const officialBlock = locateProtocolBlocks(text).filter((x) => x.proto === 'official');
    if (officialBlock.length) {
      const paths = [...text.matchAll(/\bpath\s*:\s*['"`]([^'"`]+)['"`]/g)];
      for (const pm of paths) {
        if (protocolAt(officialBlock, pm.index) !== 'official') continue;
        const hasVerb = lookupVerbs(text, officialBlock, pm.index, pm[1]).length > 0;
        if (!hasVerb) fail(`${file}: ${name} 的官方变体 "${pm[1]}" 缺少 verb（verb 与 path 必须成对）`);
      }
    }

    // 元字段
    for (const field of ['title', 'summary', 'category', 'scope', 'examples']) {
      if (!new RegExp(`\\b${field}\\s*:`).test(text)) {
        fail(`${file}: ${name} 缺少字段 ${field}`);
      }
    }
    if (!/\brisk\s*:\s*'(read|write|danger)'/.test(text)) {
      fail(`${file}: ${name} 的 risk 未标注（必须是 read / write / danger 之一）`);
    }
    // danger 级必须写 alias，否则插件作者搜不到旧接口名
    if (/\brisk\s*:\s*'danger'/.test(text) && !/\balias\s*:/.test(text)) {
      fail(`${file}: ${name} 是 danger 级但没有 alias`);
    }
    void seenNames;

    // impl 级字段误写进 variants 里：这是已经反复出现过的 TS2559 陷阱
    // （`variants: { group: {...}, notes: '...' }` —— variants 是 Record<string, ProxyVariant>，
    //   塞一个字符串进去直接类型报错）。tsc 能抓到，但每次都要等编译太慢，门禁里直接拦。
    for (const k of findMisplacedImplKeys(text)) {
      fail(`${file}: ${name} 把 "${k}" 写进了 variants 里（它是 impl 级字段，应与 variants 平级）`);
    }
  }
}

const IMPL_LEVEL_KEYS = ['variantBy', 'notes', 'stub', 'requires', 'sameAs'];

/** 找出被误写进 `variants: { ... }` 直接子级的 impl 级字段 */
function findMisplacedImplKeys(text) {
  const out = [];
  const re = /\bvariants\s*:\s*\{/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    let depth = 0;
    for (let i = m.index + m[0].length - 1; i < text.length; i++) {
      const c = text[i];
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) break;
      } else if (c === '\n' && depth === 1) {
        const km = new RegExp(`^\\s*(${IMPL_LEVEL_KEYS.join('|')})\\s*:`).exec(text.slice(i + 1));
        if (km) out.push(km[1]);
      }
    }
  }
  return out;
}

/** 按数组元素切分 entry：以 `  {` 开头、缩进回到 2 空格的 `  }` 结束。 */
function splitEntryBlocks(src) {
  const lines = src.split(/\r?\n/);
  const blocks = [];
  let buf = null;
  for (const line of lines) {
    const isObjStart = /^\s{2}\{$/.test(line);
    const isObjEnd = /^\s{2}\},?$/.test(line);
    if (isObjStart) {
      buf = [line];
    } else if (buf !== null) {
      buf.push(line);
      if (isObjEnd) {
        blocks.push({ text: buf.join('\n') });
        buf = null;
      }
    }
  }
  return blocks;
}

function report() {
  process.stdout.write('\n');
  if (problems.length === 0) {
    process.stdout.write('✅ 全部通过\n');
    process.exit(0);
  }
  process.stdout.write(`❌ ${problems.length} 项未通过：\n`);
  problems.forEach((p) => process.stdout.write(`   - ${p}\n`));
  process.exit(1);
}

main();
