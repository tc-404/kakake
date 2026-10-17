/**
 * 文本编码安全：净化 + 对齐码位的截断。
 *
 * 本模块**不依赖任何其它模块**（也不 import ai-provider / ai-session），
 * 谁都能安全引入，不会形成循环依赖。
 */

// ---------- 半截代理项（lone surrogate）----------
// UTF-16 里 emoji、部分汉字扩展区用两个 code unit 表示一个字符（代理对）。
// 一旦被 `String.prototype.slice`（按 code unit 计数）从中间劈开，
// 剩下的高代理 D800-DBFF 就成了孤儿。JavaScript 内部容忍，
// 但 JSON.stringify 会把它写成 `\ud83d` 这类**不完整的 Unicode 转义**，
// 上游严格解析时整条请求被 400 拒掉：
//   - Rust serde_json：`unexpected end of hex escape`（后面不是 \u 开头）
//                    / `lone leading surrogate in hex escape`（后面是别的转义，如 \n）
//   - Go / Python：不报错，静默吞成 U+FFFD —— 更难发现，表现为「掉字」
// 两条报错是同一个根因，只是切点后面跟的字符不同。

const isHigh = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;

/**
 * 把字符串里未成对的代理项换成 U+FFFD，使其成为「well-formed」串。
 * 已经是规整串时 toWellFormed 直接返回原串，无额外开销。
 */
export function wellFormed(s: string): string {
  // Node 20+：toWellFormed 正是为此设计。
  // 必须这样取：本工程的 tsconfig lib 还没到 es2024，`s.toWellFormed()` 直接编译不过，
  // 而运行期（engines 要求 Node ≥ 20）是一定有的。
  const fn = (s as unknown as { toWellFormed?: () => string }).toWellFormed;
  if (typeof fn === 'function') return fn.call(s);
  // 兜底（Node 18）：手工替换未成对的高/低代理
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
}

/** 递归净化：工具参数这类嵌套结构里同样可能藏着半截代理项 */
export function deepWellFormed(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return wellFormed(v);
  // 深度上限只是防御性措施：正常工具参数不会嵌套十几层
  if (depth > 12 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => deepWellFormed(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    out[wellFormed(k)] = deepWellFormed(val, depth + 1);
  }
  return out;
}

/**
 * 按**码位边界**截断：切点撞上代理对时整体回退一个 code unit，
 * 而不是留半个字。与 `slice(0, n)` 后再 `wellFormed` 的区别是——
 * 后者会多出一个 U+FFFD 占位，前者干脆不收这个字，文本更干净。
 */
export function truncSafe(s: string, max: number): string {
  if (max <= 0) return '';
  if (s.length <= max) return s;
  let n = max;
  if (n < s.length && isHigh(s.charCodeAt(n - 1)) && isLow(s.charCodeAt(n))) n -= 1;
  return s.slice(0, n);
}

/** 区间版：起点、终点都对齐到码位边界（用于流式切段这类需要取中间片段的场景） */
export function sliceSafe(s: string, from: number, to: number): string {
  const len = s.length;
  let a = Math.max(0, Math.min(from, len));
  let b = Math.max(a, Math.min(to, len));
  // 起点落在低代理上：把它并回前面的高代理
  if (a > 0 && isLow(s.charCodeAt(a)) && isHigh(s.charCodeAt(a - 1))) a += 1;
  // 终点切在高代理与其低代理之间：丢掉这个高代理
  if (b < len && isHigh(s.charCodeAt(b - 1)) && isLow(s.charCodeAt(b))) b -= 1;
  return s.slice(a, Math.max(a, b));
}
