/**
 * 参数翻译：把统一参数按 `ProxyVariant.map` 变成协议端真正的请求参数。
 *
 * 三条纪律：
 *   1. 未列出的键原样透传，map 只写需要改名的；
 *   2. 只改键名与值，不重构结构（构造请求体是协议端的事）；
 *   3. 派发字段（variantBy 指向的键，如 scene）由这里统一剔除，不进上游请求。
 */
import type {
  ProxyApiEntry,
  ProxyIdSpace,
  ProxyProtocol,
  ProxyVariant,
} from '../proxy.types';
import fs from 'node:fs';

/* ─────────────────────────── 值转换器 ─────────────────────────── */

/**
 * 具名值转换器。entries 里用 `transforms: { 键: '转换器名' }` 引用。
 *
 * 为什么需要它而不只是改键名：有些差异不是「改名」而是「改语义」。
 * 例如禁言时长野生用「秒」、官方频道用 `mute_seconds` / `end_time` 两种互斥形态，
 * 光靠 map 表达不了。
 */
export type Transform = (value: unknown, params: Record<string, unknown>) => unknown;

/** 统一 file 值的三种合法形态：本地绝对路径 / http(s) URL / base64 载荷 */
function classifyFileSource(v: unknown): { kind: 'local' | 'remote' | 'base64'; raw: string } | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (s.startsWith('base64://')) return { kind: 'base64', raw: s.slice('base64://'.length) };
  if (/^https?:\/\//i.test(s)) return { kind: 'remote', raw: s };
  return { kind: 'local', raw: s.replace(/^file:\/\//i, '') };
}

export const TRANSFORMS: Record<string, Transform> = {
  /**
   * 把 `file`（本地路径 / URL / base64）转成 OneBot 的 image 消息段数组。
   * 野生侧图片是消息段，不是独立参数，所以必须整体替换 `message`。
   */
  imageSegment: (value) => ([{ type: 'image', data: { file: String(value ?? '') } }]),

  /**
   * 统一发消息的内容形态收敛（send_msg 野生侧用）。
   *
   * 规则：
   *   - `file` 存在 → 生成一条媒体段（类型取 `media_type`：image / record / video，默认 image）
   *     挂在消息段数组最前；`message` 若同时是字符串则追加为一条 text 段 —— 这就是「图文一起发」。
   *   - `file` 不存在 → `message` 原样透传：字符串就是纯文本，数组就是 OneBot 消息段
   *     （纯文本、单图、单语音、单视频、图文混发都由数组表达，协议端原生支持）。
   *
   * 也就是说本转换器只在「file 便捷单发」时动手，其余情况不做任何重构。
   */
  unifiedSegments: (value, params) => {
    const src = classifyFileSource(params.file);
    if (!src) return value; // 纯文本或段数组：原样透传
    const segs: Array<Record<string, unknown>> = [];
    const mediaType = String(params.media_type ?? 'image');
    const fileRef = src.kind === 'base64' ? `base64://${src.raw}` : src.raw;
    segs.push({ type: mediaType, data: { file: fileRef } });
    if (typeof value === 'string' && value) {
      segs.push({ type: 'text', data: { text: value } });
    } else if (Array.isArray(value)) {
      for (const s of value) {
        if (s && typeof s === 'object' && 'type' in (s as Record<string, unknown>)) {
          segs.push(s as Record<string, unknown>);
        }
      }
    }
    return segs;
  },

  /**
   * 官方 msg_type 动态判定（send_msg 官方侧用）：带 file → 7（富媒体），否则 0（纯文本）。
   * 转换器拿到的是调用方完整参数，所以能看 file 而不是只看本键的旧值。
   */
  officialMsgType: (_value, params) => {
    const src = classifyFileSource(params.file);
    return src ? 7 : 0;
  },

  /**
   * 官方 content 收敛：message 是字符串就原样用；是段数组就抽出全部 text 段拼接
   * （官方 msg_type=7 允许 media + content 同时带文字说明）；都没传就保持
   * 调用方直接给的 content 键不动。
   */
  officialContentFromMessage: (value, params) => {
    const m = params.message;
    if (typeof m === 'string') return m;
    if (Array.isArray(m)) {
      const texts = m
        .filter((s) => s && typeof s === 'object' && (s as Record<string, unknown>).type === 'text')
        .map((s) => String((s as { data?: { text?: unknown } })?.data?.text ?? ''))
        .join('');
      return texts || undefined;
    }
    return typeof value === 'string' || value === undefined ? value : String(value);
  },

  /** 官方上传 file_type：image→1 / video→2 / record(voice)→3，跟随统一参数 media_type */
  officialFileType: (_value, params) => {
    const t = String(params.media_type ?? 'image');
    return t === 'video' ? 2 : t === 'record' || t === 'voice' ? 3 : 1;
  },

  /**
   * 官方上传的 file_data（base64 载荷）：
   *   - base64:// 前缀 → 去前缀
   *   - 本地路径 → 服务端读文件转 base64（本地资源与远程资源都要有照应）
   *   - http(s) URL → 不适用（走 url 字段），返回 undefined 删除本键
   */
  officialFileData: (_value, params) => {
    const src = classifyFileSource(params.file);
    if (!src) return undefined;
    if (src.kind === 'base64') return src.raw;
    if (src.kind === 'remote') return undefined;
    try {
      return fs.readFileSync(src.raw).toString('base64');
    } catch {
      return undefined;
    }
  },

  /** 官方上传的 url 字段：只有远程 http(s) 资源才适用，其余删除本键 */
  officialFileUrl: (_value, params) => {
    const src = classifyFileSource(params.file);
    return src?.kind === 'remote' ? src.raw : undefined;
  },

  /**
   * 禁言时长 → 官方频道禁言体。
   * 官方是 `mute_seconds`（相对）与 `end_time`（绝对）二选一，
   * 这里统一按相对时长换算，绝对时间让调用方直接传 `end_time` 覆盖。
   */
  officialMute: (value, params) => {
    if (params.end_time !== undefined) return undefined;
    const sec = Number(value ?? 0);
    return { mute_seconds: String(Math.max(0, Math.floor(sec))) };
  },
};

/* ─────────────────────────── 变体选择 ─────────────────────────── */

export interface VariantPick {
  key: string;
  variant: ProxyVariant;
}

/**
 * 选出本次要用的变体。
 *
 * `variantBy` 指向的参数缺失时返回 `'*'` 变体（单变体条目）；
 * 若条目既有 variantBy 又取不到 '*'，说明调用方漏了必填的场景参数 ——
 * 这属于 missing-param，不是 unsupported，两者要区分开：
 * 前者是「你少传了东西」，后者是「这条路根本不通」。
 */
export function pickVariant(
  impl: { variantBy?: string; variants: Record<string, ProxyVariant> },
  params: Record<string, unknown>,
): VariantPick | null {
  const hasSingle = '*' in impl.variants;
  if (!impl.variantBy) {
    return hasSingle ? { key: '*', variant: impl.variants['*'] } : null;
  }
  const raw = params[impl.variantBy];
  if (raw === undefined || raw === null || raw === '') {
    return hasSingle ? { key: '*', variant: impl.variants['*'] } : null;
  }
  const key = String(raw);
  const hit = impl.variants[key];
  if (hit) return { key, variant: hit };
  return hasSingle ? { key: '*', variant: impl.variants['*'] } : null;
}

/* ─────────────────────────── 参数翻译 ─────────────────────────── */

/**
 * 按变体翻译参数。
 * @param dropVariantKey 需要额外剔除的派发字段（通常是 entry.impl.variantBy 的值）
 */
export function translateParams(
  variant: ProxyVariant,
  params: Record<string, unknown>,
  dropVariantKey?: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const drop = new Set(variant.drop ?? []);
  if (dropVariantKey) drop.add(dropVariantKey);

  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    if (drop.has(k)) continue;
    const mapped = variant.map?.[k] ?? k;
    out[mapped] = v;
  }

  // 常量注入：协议端必带但统一参数里不该出现的字段（如官方 msg_type）
  for (const [k, v] of Object.entries(variant.const ?? {})) {
    if (out[k] === undefined) out[k] = v;
  }

  // 值转换：注意 transform 可能返回 undefined（表示「不适用，删掉」）
  for (const [k, name] of Object.entries(variant.transforms ?? {})) {
    const fn = TRANSFORMS[name];
    if (!fn) continue;
    const target = variant.map?.[k] ?? k;
    const converted = fn(out[k], params);
    if (converted === undefined) delete out[target];
    else out[target] = converted;
  }

  return out;
}

/* ─────────────────────── 官方路径占位替换 ─────────────────────── */

export interface PathResolve {
  path: string;
  /** 缺失的路径参数键名 */
  missing: string[];
}

/**
 * 把 `/channels/{channel_id}/messages` 里的占位换成实际值。
 *
 * 官方接口大量使用路径参数，而野生只有 action 名——这是两套协议在调用形态上
 * 最大的差异之一。占位名必须与 params 里的键同名，否则视为缺失。
 *
 * 为什么要有 `fallbackParams`：路径模板是协议侧的文本，占位名按理应该写协议侧的键名，
 * 也就是翻译后的参数（`translateParams` 的结果）。但 entries 里也常直接写统一键名
 * （例如把 `group_id` 映射成 `group_openid`、路径里却仍写 `{group_openid}` 之外的情形）。
 * 两边都可能对，所以这里做成「先查翻译后的参数，查不到再回退到原始参数」——
 * 宁可多一次回退，也不要因为约定不一致就让一条本该能调通的接口报 missing-param。
 */
export function resolveOfficialPath(
  template: string,
  params: Record<string, unknown>,
  fallbackParams?: Record<string, unknown>,
): PathResolve {
  const missing: string[] = [];
  const path = template.replace(/\{([^}]+)\}/g, (_m, name: string) => {
    let v = params[name];
    if ((v === undefined || v === null || v === '') && fallbackParams) {
      v = fallbackParams[name];
    }
    if (v === undefined || v === null || v === '') {
      missing.push(name);
      return `{${name}}`;
    }
    return encodeURIComponent(String(v));
  });
  return { path, missing };
}

/* ─────────────────────── 路径占位键的剥离 ─────────────────────── */

/** 取出路径模板里的占位名：`/v2/users/{openid}/messages/{message_id}` → ['openid','message_id'] */
export function extractPathKeys(template?: string): string[] {
  if (!template) return [];
  return [...template.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
}

/**
 * 把已经写进路径的键从请求体里剔除。
 *
 * 官方大量 DELETE / PATCH 把 ID 放在路径上（`/.../messages/{message_id}`），
 * 若这些键同时还留在请求体里，协议端会把它们当成未知字段。entries 里靠手写
 * `drop: ['message_id']` 既容易漏也难维护，所以在这里按路径模板统一剥离——
 * 路径拿走的值就不再进 body，一条规则覆盖所有官方条目。
 */
export function stripPathKeys(
  params: Record<string, unknown>,
  pathKeys: string[],
): Record<string, unknown> {
  if (pathKeys.length === 0) return params;
  const drop = new Set(pathKeys);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (drop.has(k)) continue;
    out[k] = v;
  }
  return out;
}

/* ─────────────────────────── ID 空间校验 ─────────────────────────── */

/** 看起来像 QQ 号：纯数字（5~11 位） */
function looksLikeQqNumber(v: unknown): boolean {
  const s = String(v ?? '').trim();
  return /^\d{5,11}$/.test(s);
}

/** 看起来像官方 openid：32 位十六进制或 16~64 位带字母的标识 */
function looksLikeOpenid(v: unknown): boolean {
  const s = String(v ?? '').trim();
  if (!s) return false;
  if (/^\d+$/.test(s)) return false; // 纯数字更像 QQ 号
  return /^[0-9A-Fa-f]{16,64}$/.test(s) || /^[A-Za-z0-9_-]{16,64}$/.test(s);
}

export interface IdSpaceIssue {
  key: string;
  expect: ProxyIdSpace;
  got: string;
}

/**
 * 校验参数是否落在正确的 ID 空间。
 *
 * 野生（QQ 号）与官方（openid）之间没有官方互转通道，这是硬限制。
 * 与其假装能转换，不如在发请求前拦下来并明确告知——
 * 「你传的 123456 看着像 QQ 群号，但这条连接是官方机器人，需要群 openid」。
 * 虚假的智能比明确的报错更坑人。
 */
export function checkIdSpaces(
  entry: ProxyApiEntry,
  protocol: ProxyProtocol,
  params: Record<string, unknown>,
): IdSpaceIssue[] {
  const issues: IdSpaceIssue[] = [];
  for (const spec of entry.params) {
    if (!spec.idSpace || spec.idSpace === 'auto') continue;
    if (spec.only && !spec.only.includes(protocol)) continue;
    const v = params[spec.key];
    if (v === undefined || v === null || v === '') continue;

    if (spec.idSpace === 'qq_number' && !looksLikeQqNumber(v)) {
      issues.push({ key: spec.key, expect: spec.idSpace, got: String(v) });
      continue;
    }
    const openidish: ProxyIdSpace[] = ['openid', 'group_openid', 'guild_user_id'];
    if (openidish.includes(spec.idSpace) && looksLikeQqNumber(v)) {
      issues.push({ key: spec.key, expect: spec.idSpace, got: String(v) });
      continue;
    }
    if (spec.idSpace === 'guild_id' || spec.idSpace === 'channel_id') {
      // 频道/子频道 ID 是纯数字，但不能是 QQ 号那种量级的随机串；
      // 这里只拦明显填反的情况：把 32 位 openid 填进了 guild_id
      if (looksLikeOpenid(v) && !looksLikeQqNumber(v)) {
        issues.push({ key: spec.key, expect: spec.idSpace, got: String(v) });
      }
    }
  }
  return issues;
}

/** 生成「需要什么 / 传入的像什么 / 为什么不能转 / 去哪拿」四段式提示 */
export function describeIdSpaceIssue(
  specLabel: string,
  expect: ProxyIdSpace,
  protocol: ProxyProtocol,
): string {
  const isWild = protocol === 'napcat' || protocol === 'snowluma';
  const want = {
    qq_number: 'QQ 号（纯数字）',
    openid: '用户 openid',
    group_openid: '群 openid',
    guild_id: '频道 ID',
    channel_id: '子频道 ID',
    guild_user_id: '频道内用户标识',
    role_id: '身份组 ID',
    message_id: '消息 ID',
    auto: '由场景决定',
  }[expect];

  const where = isWild
    ? '野生机器人的账号体系就是 QQ 号，从消息事件的 user_id / group_id 字段直接取'
    : '官方 ID 只能从官方事件里取（如群消息的 group_openid、成员事件的 user_id），'
      + 'QQ 号与 openid 之间没有官方互转接口，kakake 无法帮你换算';

  return `参数「${specLabel}」需要 ${want}（当前连接是${isWild ? '野生' : '官方'}机器人）。${where}。`;
}
