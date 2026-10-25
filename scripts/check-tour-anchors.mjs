/**
 * 导览锚点体检。src/web 不在主 tsconfig、vite build 也不做类型检查，故「组件加了 data-tour 却不透传 props」
 * 这类错误编译/构建都过，只有运行时导览找不到目标（QuietExternal 踩过）。脚本把每个锚点回源码定位其 JSX 标签，
 * 若是自定义组件（大写开头）就点名要求确认是否 spread ...props。用法：node scripts/check-tour-anchors.mjs
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const WEB = path.join(ROOT, 'src', 'web');
const TOUR = path.join(WEB, 'components', 'product-tour.tsx');

/**
 * 白名单只放「源码里没有本地定义」的组件（Radix 直接导入的那些），
 * 它们的透传行为没法靠搜源码判断，只能手工确认一次。
 * 项目里有定义的组件一律交给 componentCarriesProps 实测——写死白名单的话，
 * 哪天有人把 spread 删了脚本也不会报，等于白写。
 */
const PASSTHROUGH_OK = new Set([
  'DropdownMenuContent', // Radix：spread
  'DropdownMenuItem',    // Radix：spread
  'DropdownMenuTrigger', // Radix（asChild 时透传给子元素）
  'DialogContent',       // Radix：spread
  'SelectTrigger',       // Radix：spread
  'SelectContent',
  'SelectItem',
]);

/**
 * 判断自定义组件能不能把 data-tour 送进 DOM。
 * 两种正当写法：spread `...props`，或专门开一个 `tourId` prop 自己挂
 * （StatCard / SettingsCard / FormRow 就是后者）。
 */
function componentCarriesProps(tag, files) {
  if (PASSTHROUGH_OK.has(tag)) return true;
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const i = src.search(new RegExp(`(function|const)\\s+${tag}\\b`));
    if (i < 0) continue;
    const body = src.slice(i, i + 1200);
    if (body.includes('...props') || /\btourId\b/.test(body)) return true;
  }
  return false;
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = walk(WEB).filter((f) => f !== TOUR);

/** 动态锚点的模板前缀：data-tour={`tool-${tool.id}`} → 'tool-' */
const TEMPLATE_PREFIXES = [];
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(/data-tour=\{\s*[`'"]([^`'$"]*)\$\{/g)) {
    TEMPLATE_PREFIXES.push(m[1]);
  }
}
const fromTemplate = (anchor) =>
  TEMPLATE_PREFIXES.some((p) => p && anchor.startsWith(p));

// 1) 收集导览用到的锚点
const tourSrc = fs.readFileSync(TOUR, 'utf8');
const used = new Map(); // 锚点 -> 步骤 id
const stepRe = /id: '([^']+)'[\s\S]{0,400}?target: '\[data-tour="([^"]+)"\]'/g;
for (const m of tourSrc.matchAll(stepRe)) used.set(m[2], m[1]);

// 2) 回源码里找每个锚点挂在哪个标签上
const report = [];
for (const [anchor, stepId] of used) {
  let found = null;
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const idx = src.indexOf(`"${anchor}"`);
    if (idx < 0) continue;
    // 从这个位置往前找一个最近的 JSX 开标签 <Xxx
    const before = src.slice(Math.max(0, idx - 1200), idx);
    const openTags = [...before.matchAll(/<([A-Za-z][A-Za-z0-9.]*)(?=[\s>])/g)];
    const tag = openTags.length ? openTags[openTags.length - 1][1] : '?';
    found = { file: path.relative(ROOT, file), tag };
    break;
  }
  if (!found) {
    // 没找到 `data-tour="xxx"` 字面量，可能是动态生成的（tool-${id} / ap-row-${key}）
    // 或来自映射表（nav-* 出自 console-shell 的 NAV_TOUR_ID）。宽松扫一遍确认它至少出现过。
    const anywhere = files.some((f) => fs.readFileSync(f, 'utf8').includes(anchor));
    report.push({
      anchor,
      stepId,
      kind: anywhere || fromTemplate(anchor) ? 'dynamic' : 'missing',
      detail: fromTemplate(anchor) ? '模板字符串动态生成' : '映射表 / 变量间接定义',
    });
    continue;
  }
  const isNative = /^[a-z][a-z0-9]*$/.test(found.tag);
  if (isNative) continue; // 原生标签，一定进 DOM
  if (componentCarriesProps(found.tag, files)) continue;
  report.push({
    anchor,
    stepId,
    kind: 'component',
    detail: `挂在组件 <${found.tag}> 上（${found.file}）`,
  });
}

const missing = report.filter((r) => r.kind === 'missing');
const needCheck = report.filter((r) => r.kind === 'component');
const dynamic = report.filter((r) => r.kind === 'dynamic');

console.log(`导览用到 ${used.size} 个锚点（动态生成 / 映射表间接定义 ${dynamic.length} 个）`);
if (missing.length) {
  console.log(`\n❌ 源码里根本不存在（${missing.length}）：`);
  for (const r of missing) console.log(`   ${r.anchor}  ← 步骤 ${r.stepId}`);
}
if (needCheck.length) {
  console.log(`\n❌ 挂在自定义组件上，且该组件既不 spread ...props 也没有 tourId（${needCheck.length}）：`);
  for (const r of needCheck) console.log(`   ${r.anchor}  ← ${r.detail}（步骤 ${r.stepId}）`);
  console.log('   这类 data-tour 会被 React 直接丢掉、不进 DOM——导览永远找不到它。');
}
if (!missing.length && !needCheck.length) {
  console.log('\n✅ 全部锚点都能进 DOM：原生标签 / 已知透传组件 / 动态生成');
}
process.exit(missing.length || needCheck.length ? 1 : 0);
