/**
 * 轻量 i18n：双语（简体中文 / English）切换。
 *
 * 设计要点（沿用 device-tier 的模块级外部存储模式，无需在根部包 Provider）：
 * - 本模块只管「当前这一页用的是哪门语言」：初始恒为简体中文，切换后广播给订阅者。
 *   真正存盘的是实例级设置 data/language.json，由 lib/language.ts 负责读写与同步，
 *   它拿到服务端的值后再回调 setLang()。两层分开是为了避免 i18n ↔ api 的循环依赖。
 * - 任意组件用 useLang() 订阅、t(key) 取文案；不要用裸 setLang()，改语言走
 *   saveLanguage()（写服务端 + 广播所有在线会话），否则只有自己这一页变了。
 * - 文案字典由各业务模块调用 registerMessages() 注册（见 i18n-dict/*），
 *   缺失 key 时回退中文、再缺失则原样返回 key，翻译可逐步补全。
 * - 模块加载即把 <html lang> 设好，首帧前生效，避免闪烁。
 */

import { useSyncExternalStore } from 'react';

export type Lang = 'zh' | 'en';

/**
 * 历史遗留的键名，只用于清理、不再读写。
 *
 * 以前语言偏好各存各的浏览器（localStorage），于是在某次切到英文之后，重装 kakake、
 * 重启进程、换端口实例…… 只要还是同一个 origin，打开就还是英文，表现为
 * 「初始化语言被改坏了」。现在语言统一记在服务端的 data/language.json 里，
 * 老记录清掉，免得留着误导。
 */
const LEGACY_LANG_KEY = 'kakake-lang';

try {
  localStorage.removeItem(LEGACY_LANG_KEY);
} catch { /* localStorage 不可用（隐私模式等）忽略 */ }

/** 单条文案：必须同时提供中英文；zh 为源语言（缺失时的回退）。 */
export interface MessageEntry {
  zh: string;
  en: string;
}

export type MessageDict = Record<string, MessageEntry>;

// 各模块注册进来后合并成的全局字典
const registry: MessageDict = {};

export function registerMessages(mod: MessageDict): void {
  Object.assign(registry, mod);
}

/**
 * 当前语言。**初值恒为中文**：首帧（含登录页）必定是中文，
 * 服务端那份实例级设置取回来后由 language.ts 调 setLang() 覆盖。
 */
let currentLang: Lang = 'zh';
const listeners = new Set<() => void>();

function applyHtmlLang(): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = currentLang === 'en' ? 'en' : 'zh-CN';
}

function emit(): void {
  applyHtmlLang();
  for (const fn of listeners) fn();
}

export function getLang(): Lang {
  return currentLang;
}

/**
 * 切到某门语言（只改当前页面）。
 *
 * 正常流程不要直接调它——改语言要落库并同步给其他人，用 language.ts 的
 * saveLanguage()。这里保留导出，是给「服务端推来了新语言」「启动时对齐」这类
 * 已经确定要切的场景用的。
 */
export function setLang(lang: Lang): void {
  if (lang === currentLang) return;
  currentLang = lang;
  emit();
}

export function subscribeLang(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** 订阅当前语言（响应式）。 */
export function useLang(): Lang {
  return useSyncExternalStore(subscribeLang, getLang, getLang);
}

/**
 * 组件内取文案的便捷 hook：先订阅语言变化（保证切换时重渲染），再返回 t()。
 * 在 React 组件里统一用 const t = useT(); 而不是裸用 t()。
 */
export function useT(): typeof t {
  useLang();
  return t;
}

/**
 * 取文案。支持 {name} 形式的占位符替换。
 * 回退顺序：当前语言 → 中文 → key 本身（便于发现漏翻）。
 */
export function t(key: string, params?: Record<string, string | number | undefined>): string {
  const entry = registry[key];
  const text = entry ? (entry[currentLang] ?? entry.zh) : key;
  if (params) {
    return text.replace(/\{(\w+)\}/g, (_, name: string) => {
      if (!(name in params)) return `{${name}}`;
      const v = params[name];
      return v == null ? `{${name}}` : String(v);
    });
  }
  return text;
}

// 模块加载即生效：首帧渲染前挂好 <html lang>，避免语言闪烁
applyHtmlLang();

// 业务字典由各模块调用 registerMessages() 自行注册；统一触发注册见 i18n-dict/register.ts，
// 由 main.tsx 在首帧前 import，避免 i18n ↔ 字典模块形成循环依赖（会导致部分打包器
// 在模块求值阶段把未初始化对象传给 registerMessages 而直接抛错、整页白屏）。
