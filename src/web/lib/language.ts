/**
 * 控制台语言：实例级设置，存在后端 data/language.json。
 *
 * 与浏览器无关——换设备、清缓存、别人登录同一个实例，看到的都是这一份：
 * 谁在「设置 → 语言」里切了，所有在线会话一起变（服务端走 /api/events 广播）。
 *
 * 这里只做一层薄薄的外部 store：拿到服务端的值后回调 i18n 的 setLang()，
 * 并让语言切换按钮知道「保存中 / 保存失败」。
 */

import { api } from './api';
import { setLang, type Lang } from './i18n';

export type { Lang };

/** 出厂默认：中文。任何取不到值的场景都按它，保证「初始化 = 中文」 */
export const DEFAULT_LANG: Lang = 'zh';

/* ─────────── 轻量外部 store ─────────── */

/** 快照同时带 lang 与 saving：只含 lang 时「保存结束」不会触发重渲染，按钮会卡在 disabled */
export interface LanguageState {
  lang: Lang;
  saving: boolean;
}

let state: LanguageState = { lang: DEFAULT_LANG, saving: false };
/** 是否已经拿到过服务端的值（没拿到前不该拿默认值去写库） */
let loaded = false;
let loading = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

function setState(patch: Partial<LanguageState>): void {
  const next = { ...state, ...patch };
  if (next.lang === state.lang && next.saving === state.saving) return;
  state = next;
  emit();
}

export function getLanguageState(): LanguageState {
  return state;
}

export function getLanguageSnapshot(): Lang {
  return state.lang;
}

export function isLanguageLoaded(): boolean {
  return loaded;
}

export function isLanguageSaving(): boolean {
  return state.saving;
}

export function subscribeLanguage(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function apply(lang: Lang): void {
  setState({ lang });
  setLang(lang);
}

/**
 * 启动时拉一次。
 *
 * 读的是免鉴权端点，所以登录页也能对齐；失败（后端没这个接口、没网、进程在重启）
 * 就保持中文，不让界面崩在英文或空白上。
 */
export async function loadLanguage(): Promise<Lang> {
  if (loaded) return state.lang;
  if (loading) return state.lang;
  loading = true;
  try {
    const r = await api.language.get();
    const lang: Lang = r?.lang === 'en' ? 'en' : 'zh';
    loaded = true;
    apply(lang);
  } catch {
    // 拉不到：按中文显示，但 loaded 仍置位，避免页面反复重试
    loaded = true;
  } finally {
    loading = false;
  }
  return state.lang;
}

/** 别人改了语言、服务端推过来了：直接生效，不再回写 */
export function setLanguageLocal(lang: Lang): void {
  loaded = true;
  apply(lang);
}

/**
 * 改语言：先本地生效（点了要马上有反应），再落库。
 * 失败回滚并如实返回 null，调用方据此提示。
 */
export async function saveLanguage(lang: Lang): Promise<Lang | null> {
  const prev = state.lang;
  apply(lang);
  setState({ saving: true });
  try {
    const r = await api.language.save(lang);
    const saved: Lang = r?.lang === 'en' ? 'en' : 'zh';
    setState({ lang: saved });
    setLang(saved);
    return saved;
  } catch {
    setState({ lang: prev });
    setLang(prev);
    return null;
  } finally {
    setState({ saving: false });
  }
}

/** 恢复出厂语言（中文） */
export async function resetLanguage(): Promise<Lang | null> {
  const prev = state.lang;
  try {
    const r = await api.language.reset();
    const lang: Lang = r?.lang === 'en' ? 'en' : 'zh';
    apply(lang);
    return lang;
  } catch {
    setState({ lang: prev });
    setLang(prev);
    return null;
  }
}
