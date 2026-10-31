/**
 * 产品导览的命令式 DOM 驱动助手：用 querySelector + 模拟点击开合各类弹窗/面板，
 * 供 product-tour-steps 的 enter/skipIf 回调与组件本体复用。
 */
export const hasConnCards = () => !!document.querySelector('.kk-conn-card');
export const hasPluginCards = () => !!document.querySelector('.kk-plugin-card');

/** 连接管理弹窗是否已打开（以里面的「插件」按钮为标志） */
export const connDialogOpen = () => !!document.querySelector('[data-tour="conn-dialog-plugins"]');
/** 打开第一张连接卡片的管理弹窗 */
export function openConnDialog(): void {
  if (connDialogOpen()) return;
  document.querySelector<HTMLElement>('.kk-conn-card')?.click();
}
/** 关闭连接管理弹窗（若开着） */
export function closeConnDialog(): void {
  if (!connDialogOpen()) return;
  document.querySelector<HTMLElement>('[data-tour="conn-dialog-close"]')?.click();
}

/* —— 添加连接流程：类型选择弹窗 → 反向 WS 表单 —— */
/** 程序触发 Esc（关弹窗）时置真，让导览的 Esc 键监听跳过、不误关整个引导 */
export let suppressTourEscape = false;
/** 类型选择弹窗是否已打开 */
export const connTypeModalOpen = () => !!document.querySelector('[data-tour="conn-type-list"]');
/** 添加连接表单是否已打开（以名称字段为标志） */
export const connFormOpen = () => !!document.querySelector('[data-tour="conn-form-name"]');
/** 打开「选择连接类型」弹窗 */
export function openConnTypeModal(): void {
  if (connTypeModalOpen()) return;
  // 从表单「上一步」回来时：先关掉表单，下一轮幂等重跑再开类型弹窗
  if (connFormOpen()) {
    closeConnAdd();
    return;
  }
  closeConnDialog();
  document.querySelector<HTMLElement>('[data-tour="connections-add"]')?.click();
}
/** 打开「反向 WS」添加表单（必要时先开类型弹窗，靠幂等重跑推进） */
export function openConnForm(): void {
  if (connFormOpen()) return;
  if (!connTypeModalOpen()) {
    openConnTypeModal();
    return;
  }
  document.querySelector<HTMLElement>('[data-tour="conn-type-reverse"]')?.click();
}
/** 关闭添加连接的两个弹窗（优先点关闭控件，兜底用受控 Esc） */
export function closeConnAdd(): void {
  // 表单：直接点它的「取消」，最可靠
  if (connFormOpen()) {
    document.querySelector<HTMLElement>('[data-tour="conn-form-cancel"]')?.click();
    return;
  }
  if (!connTypeModalOpen()) return;
  // 类型弹窗没有取消按钮：用受控 Esc，并屏蔽导览自身的 Esc 监听，避免连引导一起关掉
  suppressTourEscape = true;
  try {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  } finally {
    suppressTourEscape = false;
  }
}

/** 模拟页「模拟设置」面板是否已打开 */
export const simConfigOpen = () => !!document.querySelector('[data-tour="sim-config-account"]');
/** 打开模拟设置面板（长按发送键的效果，导览里用事件触发） */
export function openSimConfig(): void {
  if (simConfigOpen()) return;
  window.dispatchEvent(new CustomEvent('kk:sim-config-open'));
}
/** 关闭模拟设置面板 */
export function closeSimConfig(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('kk:sim-config-close'));
}

/* —— 配色方案：Ant Design ColorPicker 弹出面板 —— */
/**
 * 拾色面板是否**真的在显示**。
 * antd 关闭后弹层 DOM 会留在页面里（只是隐藏），只判存在会把「已关闭」当「开着」，
 * 后续步骤的 closeColorDialog 就会反手把面板重新点开——用户看到的就是「一直显示」。
 */
export const colorDialogOpen = () => {
  const panel = document.querySelector<HTMLElement>('[data-tour="color-panel"]');
  if (!panel) return false;
  const r = panel.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  const cs = getComputedStyle(panel);
  return cs.visibility !== 'hidden' && cs.display !== 'none';
};
/** 打开「组件及按钮」配色的拾色面板 */
export function openColorDialog(): void {
  if (colorDialogOpen()) return;
  clickToggleOnce('color-swatch', '[data-tour="color-swatch"]');
}
/** 关闭拾色面板（再点一次触发色块，antd 气泡会收起） */
export function closeColorDialog(): void {
  if (!colorDialogOpen()) return;
  document.querySelector<HTMLElement>('[data-tour="color-swatch"]')?.click();
}

/* —— 更新中心：版本号徽标呼出的悬浮窗 —— */
/** 点击第一个「可见」的匹配元素（品牌字在侧栏与顶栏各有一个，需挑当前可见的那个） */
export function clickVisible(selector: string): void {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    el.click();
    return;
  }
}
/** 更新中心悬浮窗是否已打开（以头部区为标志） */
export const updateCenterOpen = () => !!document.querySelector('[data-tour="uc-header"]');
/** 打开更新中心悬浮窗（点当前可见的版本号徽标） */
export function openUpdateCenter(): void {
  if (updateCenterOpen()) return;
  clickToggleOnce('update-center', '[data-tour="update-center"]');
}
/** 关闭更新中心悬浮窗（再点一次徽标即收起） */
export function closeUpdateCenter(): void {
  if (!updateCenterOpen()) return;
  clickVisible('[data-tour="update-center"]');
}

/* —— 资源商城：分类筛选下拉 —— */
/** 分类下拉是否已展开（以菜单项为标志） */
export const storeCategoryMenuOpen = () => !!document.querySelector('[data-tour="store-category-item"]');
/**
 * 气泡 / 下拉类触发器是「点一下开、再点一下关」：enter 每 16ms 重跑，
 * 连点会在菜单还没渲染进 DOM 时又把它点关——永远打不开。记下点击时间，
 * 260ms 内不重复点，等它渲染完。
 */
export const toggleClickAt = new Map<string, number>();
export function clickToggleOnce(key: string, selector: string): void {
  const at = toggleClickAt.get(key) ?? 0;
  if (Date.now() - at < 260) return;
  toggleClickAt.set(key, Date.now());
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) return;
  // Radix 的下拉只认 pointerdown（纯 click() 打不开），click 再补上照顾纯 click 型气泡
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1 }));
  el.click();
}
/** 展开分类下拉 */
export function openStoreCategoryMenu(): void {
  if (storeCategoryMenuOpen()) return;
  clickToggleOnce('store-category', '[data-tour="store-category"]');
}
/** 关掉分类下拉（Radix 菜单没有取消按钮，用受控 Esc + 屏蔽导览自身的 Esc） */
export function closeStoreCategoryMenu(): void {
  if (!storeCategoryMenuOpen()) return;
  suppressTourEscape = true;
  try {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  } finally {
    suppressTourEscape = false;
  }
}
/** 当前选中的分类 id（按钮上带着）；空串 = 未筛选 */
export const currentStoreCategory = () =>
  document.querySelector<HTMLElement>('[data-tour="store-category"]')?.dataset.tourCat ?? '';
/** 在展开的菜单里点某一档（按 data-tour-cat 匹配，不认文字） */
export function clickStoreCategoryItem(id: string): boolean {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-tour="store-category-item"]'))) {
    if (el.dataset.tourCat === id) {
      el.click();
      return true;
    }
  }
  return false;
}
/**
 * 在展开的分类菜单里选一档（幂等：已经选上了就不动）。
 *
 * 认 id（official / wild / twin…）而不是显示的分类名：名字随语言变，
 * 英文模式下写死的中文「官方」永远匹配不上，菜单就一直开着关不掉。
 */
export function pickStoreCategory(id: string): void {
  if (currentStoreCategory() === id) return;
  if (!storeCategoryMenuOpen()) {
    openStoreCategoryMenu();
    return;
  }
  if (clickStoreCategoryItem(id)) closeStoreCategoryMenu();
}
/**
 * 取消分类筛选（回到全部）。
 *
 * ⚠️ 必须分两轮走：先点按钮展开菜单，等 React 把菜单渲染出来（下一次 tick）再点已选
 * 的那一项。写成「click 完立刻找菜单项」是行不通的——同步这一刻菜单还没进 DOM，
 * 下一轮又会把刚打开的菜单给点上关掉，来回抖。enter 每轮都会幂等重跑，正好够用。
 */
export function clearStoreCategory(): void {
  const btn = document.querySelector<HTMLElement>('[data-tour="store-category"]');
  if (!btn) return;
  const cur = currentStoreCategory();
  // 空串 = 当前就是全部；此时只需确保菜单是关着的
  if (!cur) {
    if (storeCategoryMenuOpen()) closeStoreCategoryMenu();
    return;
  }
  if (!storeCategoryMenuOpen()) {
    btn.click();
    return;
  }
  clickStoreCategoryItem(cur);
}

/* —— 资源商城：资源详情弹窗 —— */
/**
 * 详情弹窗是否打开：认弹窗根节点本身。
 * 以前以「安装按钮」为标志——资源不可下载时那个按钮不渲染，
 * 判定就永远为假，导览会一遍遍去点卡片、步骤退化成没有弹窗可讲。
 */
export const storeDetailOpen = () => !!document.querySelector('[data-tour="store-detail"]');
/** 打开第一张资源卡片的详情 */
export function openStoreDetail(): void {
  if (storeDetailOpen()) return;
  document.querySelector<HTMLElement>('[data-tour="store-card"]')?.click();
}
/**
 * 关闭资源详情：点弹窗底部那个「关闭」按钮的锚点。
 * 以前按按钮文字「关闭」找——英文模式下它叫 "Close"，找不到就关不掉，
 * 弹窗一直盖在上面，后面所有步骤的高亮都被它挡住。
 */
export function closeStoreDetail(): void {
  if (!storeDetailOpen()) return;
  document.querySelector<HTMLElement>('[data-tour="store-detail-close"]')?.click();
}

/* —— 开放平台：账号详情弹窗 —— */
export const opDetailOpen = () => !!document.querySelector('[data-tour="op-detail-actions"]');
/** 打开第一张账号卡片的详情 */
export function openOpDetail(): void {
  if (opDetailOpen()) return;
  document.querySelector<HTMLElement>('[data-tour="op-card"]')?.click();
}
/** 关闭账号详情（Radix 弹窗：点右上角的关闭） */
export function closeOpDetail(): void {
  if (!opDetailOpen()) return;
  suppressTourEscape = true;
  try {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  } finally {
    suppressTourEscape = false;
  }
}

/* —— 智能助手：模型服务弹窗 + 进入会话 —— */
export const aiProfileOpen = () => !!document.querySelector('[data-tour="ai-profile"]');
/** 打开「AI 上游配置」（顶栏齿轮） */
export function openAiProfile(): void {
  if (aiProfileOpen()) return;
  clickToggleOnce('ai-config', '[data-tour="ai-config"]');
}
export function closeAiProfile(): void {
  if (!aiProfileOpen()) return;
  suppressTourEscape = true;
  try {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  } finally {
    suppressTourEscape = false;
  }
}
/** 是否已进入某个会话（对话视图以输入区为标志） */
export const aiChatOpen = () => !!document.querySelector('[data-tour="ai-composer"]');
/** 点第一条会话进入对话视图 */
export function openAiSession(): void {
  if (aiChatOpen()) return;
  document.querySelector<HTMLElement>('[data-tour="ai-session"]')?.click();
}

/** 是否已打开「添加 / 编辑模型」表单 */
export const aiProfileEditOpen = () => !!document.querySelector('[data-tour="ai-profile-edit"]');
/**
 * 打开添加模型表单。
 * 同样分两轮：先确保「模型服务」弹窗开了，下一轮再点里面的「添加模型」——
 * click() 的那一刻弹窗内容还没进 DOM，同步点是点不到的。
 */
export function openAiProfileEdit(): void {
  if (aiProfileEditOpen()) return;
  if (!aiProfileOpen()) {
    openAiProfile();
    return;
  }
  document.querySelector<HTMLElement>('[data-tour="ai-profile-add"]')?.click();
}

export const hasOpCards = () => !!document.querySelector('[data-tour="op-card"]');
export const hasAiSessions = () => !!document.querySelector('[data-tour="ai-session"]');
export const hasStoreCards = () => !!document.querySelector('[data-tour="store-card"]');
