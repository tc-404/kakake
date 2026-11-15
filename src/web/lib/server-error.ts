/**
 * 服务端错误文案本地化：EXACT → RULES（$1 回填）→ SYS → CODES，未命中则原样返回。
 * 纯函数核心在 server-error-core（零依赖）；这里只封装「默认语言取当前 i18n 语言」，
 * 组件内用 useSvcText()，组件外用 svcText() / errText()。
 */

import { getLang, useLang } from '@/lib/i18n';
import { errText as coreErrText, resText as coreResText, svcText as coreSvcText } from './server-error-core';
import type { SvcErrorLang } from './server-error-core';

export type SvcTextFn = (raw?: string | null) => string;
export type { SvcErrorLang };

export function svcText(raw?: string | null, code?: string | null, lang: SvcErrorLang = getLang()): string {
  return coreSvcText(raw, code, lang);
}

/** 组件内使用：随语言切换重渲染。用法 `const svc = useSvcText();` */
export function useSvcText(): SvcTextFn {
  const lang = useLang();
  return (raw?: string | null) => coreSvcText(raw, undefined, lang);
}

/** 任意异常 → 当前语言的错误文案（拿不到就空串，交给调用方的兜底 key）。 */
export function errText(e: unknown, lang: SvcErrorLang = getLang()): string {
  return coreErrText(e, lang);
}

/**
 * 后端响应 → 文案：优先用结构化 code，其次 message，都没有返回空串
 * （调用方再 `|| t('xxx.failed')` 兜底）。
 */
export function resText(
  res: { ok?: boolean; message?: string | null; code?: unknown } | null | undefined,
  lang: SvcErrorLang = getLang(),
): string {
  return coreResText(res, lang);
}
