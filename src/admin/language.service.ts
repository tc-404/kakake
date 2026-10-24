/**
 * 控制台语言（实例级设置）。
 *
 * 存在 data/language.json，**不看浏览器**：换设备、清缓存、无痕窗口，乃至别人
 * 登录同一个实例，看到的都是这一份。谁在设置里改了语言，所有在线登录者一起变
 * （改完由 eventBus 广播，前端经 /api/events 收到后即时切换）。
 *
 * 出厂默认简体中文：文件不存在、内容损坏、值不合法，一律按 'zh'。
 * 「初始化 = 中文」这条必须稳定成立，所以任何读失败都不允许回落成英文。
 */

import { readJsonSafe, writeJsonAtomic } from '../storage/atomic-file.js';
import { PATHS } from '../paths.js';
import { eventBus } from '../event/event-bus.js';

export type Lang = 'zh' | 'en';

export const DEFAULT_LANG: Lang = 'zh';

/** 只有 'en' 被承认，其余（含 null / 乱码 / 'English'）统统按中文 */
export function normalizeLang(raw: unknown): Lang {
  return raw === 'en' ? 'en' : 'zh';
}

class LanguageService {
  private cache: Lang | null = null;

  getState(): Lang {
    if (this.cache) return this.cache;
    const raw = readJsonSafe<unknown>(PATHS.language, { lang: DEFAULT_LANG }, { label: 'language.json' });
    const src = (raw && typeof raw === 'object' ? raw : {}) as { lang?: unknown };
    this.cache = normalizeLang(src.lang);
    return this.cache;
  }

  save(raw: unknown): Lang {
    const src = (raw && typeof raw === 'object' ? raw : {}) as { lang?: unknown };
    const next = normalizeLang(src.lang);
    writeJsonAtomic(PATHS.language, { lang: next }, { trailingNewline: true });
    const changed = this.cache !== null && this.cache !== next;
    this.cache = next;
    // 广播给所有在线会话；/api/events 会把这条推给前端，前端即时切语言
    if (changed) void eventBus.emit('language', { lang: next });
    return next;
  }

  /** 恢复出厂语言（中文） */
  reset(): Lang {
    writeJsonAtomic(PATHS.language, { lang: DEFAULT_LANG }, { trailingNewline: true });
    this.cache = DEFAULT_LANG;
    void eventBus.emit('language', { lang: DEFAULT_LANG });
    return DEFAULT_LANG;
  }
}

export const languageService = new LanguageService();
