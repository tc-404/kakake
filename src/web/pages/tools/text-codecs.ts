/**
 * HTML 实体与进制转换：纯文本处理，不依赖任何浏览器 API，便于单独验证。
 */

/** 常用命名实体（解码用；未知命名实体原样保留，不会破坏内容） */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  shy: '\u00ad',
  ensp: '\u2002',
  emsp: '\u2003',
  thinsp: '\u2009',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  minus: '−',
  times: '×',
  divide: '÷',
  plusmn: '±',
  frac12: '½',
  frac14: '¼',
  frac34: '¾',
  laquo: '«',
  raquo: '»',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  bull: '•',
  middot: '·',
  sect: '§',
  para: '¶',
  deg: '°',
  micro: 'µ',
  permil: '‰',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  curren: '¤',
  infin: '∞',
  ne: '≠',
  le: '≤',
  ge: '≥',
  larr: '←',
  rarr: '→',
  uarr: '↑',
  darr: '↓',
  harr: '↔',
  spades: '♠',
  clubs: '♣',
  hearts: '♥',
  diams: '♦',
  loz: '◊',
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  epsilon: 'ε',
  pi: 'π',
  lambda: 'λ',
  mu: 'μ',
  sigma: 'σ',
  omega: 'ω',
};

/**
 * 文本 → HTML 实体：
 * 非 ASCII 字符按所选进制转成数字实体；ASCII 里的 & < > " ' 一并转义（可直接放进 HTML）。
 */
export function encodeHtmlEntities(text: string, useHex: boolean): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 128) {
      if (ch === '&') out += '&amp;';
      else if (ch === '<') out += '&lt;';
      else if (ch === '>') out += '&gt;';
      else if (ch === '"') out += '&quot;';
      else if (ch === "'") out += '&#39;';
      else out += ch;
    } else {
      out += useHex ? `&#x${cp.toString(16).toUpperCase()};` : `&#${cp};`;
    }
  }
  return out;
}

function fromCodePointSafe(cp: number, fallback: string): string {
  if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) return fallback;
  try {
    return String.fromCodePoint(cp);
  } catch {
    return fallback;
  }
}

/** HTML 实体 → 文本：同时支持命名实体、&#十进制;、&#x十六进制; */
export function decodeHtmlEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]{0,31});/g,
    (whole, body: string) => {
      if (body.startsWith('#x') || body.startsWith('#X')) {
        return fromCodePointSafe(parseInt(body.slice(2), 16), whole);
      }
      if (body.startsWith('#')) {
        return fromCodePointSafe(parseInt(body.slice(1), 10), whole);
      }
      const named = NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()];
      return named ?? whole;
    },
  );
}

export type Radix = 2 | 8 | 16 | 36;

export const RADIX_VALUES: Radix[] = [2, 8, 16, 36];

const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';

/** 去掉数字里常见的分隔符（空格 / 下划线 / 逗号） */
function stripNumberText(text: string): string {
  return text.trim().replace(/[\s_,]/g, '');
}

/**
 * 按给定进制解析成十进制字符串（内部通用实现，base 可为 2~36 任意值）。
 * 支持正负号、分隔符，以及 0x / 0b / 0o 前缀（此时以前缀为准）；
 * 用 BigInt 计算，位数不受限。
 */
function parseInBase(input: string, baseInput: number): string {
  let body = stripNumberText(input);
  if (!body) throw new Error('请输入要转换的数字');

  let sign = '';
  if (body.startsWith('-')) {
    sign = '-';
    body = body.slice(1);
  } else if (body.startsWith('+')) {
    body = body.slice(1);
  }

  const lower = body.toLowerCase();
  let base = baseInput;
  if (lower.startsWith('0x')) {
    base = 16;
    body = body.slice(2);
  } else if (lower.startsWith('0b')) {
    base = 2;
    body = body.slice(2);
  } else if (lower.startsWith('0o')) {
    base = 8;
    body = body.slice(2);
  }
  if (!body) throw new Error('请输入要转换的数字');

  const digits = DIGITS.slice(0, base);
  let value = 0n;
  const radixBig = BigInt(base);

  for (const ch of body.toLowerCase()) {
    const d = digits.indexOf(ch);
    if (d < 0) throw new Error(`「${ch}」不是 ${base} 进制的有效数字`);
    value = value * radixBig + BigInt(d);
  }
  return `${sign}${value.toString(10)}`;
}

/** 按给定进制解析成十进制字符串 */
export function radixToDecimal(input: string, radix: Radix): string {
  return parseInBase(input, radix);
}

/** 十进制 → 指定进制（十六进制大写输出，便于阅读） */
export function decimalToRadix(input: string, radix: Radix): string {
  const out = BigInt(parseInBase(input, 10)).toString(radix);
  return radix === 16 ? out.toUpperCase() : out;
}
