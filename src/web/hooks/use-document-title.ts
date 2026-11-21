import { useEffect, useSyncExternalStore } from 'react';
import { getAppearanceSnapshot, subscribeAppearance } from '@/lib/appearance';
import { t, useLang } from '@/lib/i18n';

/**
 * 全站浏览器标签标题：自定义标题名优先，没设置过则跟随语言（中文「咔咔珂」、英文「Kakake」）。
 *
 * 必须挂在**路由根部**（App）而不是控制台外壳：
 * 插件后台（/plugins/:pluginId/pages/*）、登录页、公告页都是与控制台**平级**的独立路由，
 * 且插件后台是用 window.open 新开标签页打开的 —— 新标签页会重新加载 index.html，
 * 标题退回里面硬编码的「咔咔珂」；只有外壳里挂 hook 的写法管不到这些页面。
 *
 * 语言要单独订阅：t 是模块级函数、引用永远不变，只依赖它的话切语言时 effect 不会重跑。
 */
export function useDocumentTitle(): void {
  const customTitle = useSyncExternalStore(subscribeAppearance, getAppearanceSnapshot, getAppearanceSnapshot).customTitle;
  const lang = useLang();
  useEffect(() => {
    document.title = customTitle?.trim() || t('brand.kakake');
  }, [customTitle, lang]);
}
