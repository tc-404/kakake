import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { getPortalRoot } from '@/lib/portal-root';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  Compass,
  Lightbulb,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { getNavLayoutSnapshot } from '@/lib/nav-layout';
import { isEditableElement, setTourActive } from '@/lib/tour-state';

/* ------------------------------------------------------------------ *
 *  产品导览（Product Tour）
 *  - 首次设置密码后进入控制台强制弹出（刷新不消失，直到「跳过」或「完成」）
 *  - 逐步高亮目标、说明内容并显示进度，允许自动跳转页面
 *  - 同一套步骤兼容手机端与电脑端 UI（按 data-tour 选中当前可见的元素）
 * ------------------------------------------------------------------ */

/**
 * 看过标记。
 * 内容有较大更新时往上推一版，好让看过旧版的人也能看到新的。
 * v4：补「图片混淆 / 图片工具箱」两步（此前工具页只讲到三个工具）、
 *     侧边栏被用户隐藏的项对应步骤直接跳过、顶栏操作区不再被挤扁导致量不到高亮框、
 *     超高目标的高亮框裁进视口、日志刷满时按整屏框。
 */
const TOUR_KEY = 'kk-product-tour-v4';
/** 手动触发（设置页「重新查看」）用的自定义事件名 */
export const PRODUCT_TOUR_EVENT = 'kk:start-product-tour';

/** 是否看过（跳过或完成都算） */
export function isProductTourSeen(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return !!localStorage.getItem(TOUR_KEY);
  } catch {
    return false;
  }
}

function markProductTourSeen(value: 'done' | 'skipped'): void {
  try {
    localStorage.setItem(TOUR_KEY, value);
  } catch {
    /* 隐私模式写不进就算了，下次还会弹 */
  }
}

/** 从任意位置手动开启导览（设置页调用） */
export function startProductTour(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(PRODUCT_TOUR_EVENT));
}

type Callout = { tone: 'warn' | 'tip'; text: string };

type TourStep = {
  id: string;
  /** 进入该步骤前先跳转到此路由（已在该路由则不跳） */
  route?: string;
  /** 高亮目标的 CSS 选择器；省略或找不到则居中浮层展示 */
  target?: string;
  /** 强制居中浮层（不高亮） */
  center?: boolean;
  title: string;
  /** 正文，支持 **文字** 高亮 */
  body: string[];
  /** 醒目提示框 */
  callout?: Callout;
  /** 返回 true 时跳过该步骤（按当前页面实时判断） */
  skipIf?: () => boolean;
  /** 进入该步骤时的副作用（如打开/关闭连接管理弹窗），需幂等 */
  enter?: () => void;
  /**
   * 该步骤需要侧边栏处于什么状态。
   * 侧栏默认收起，而导航项 / 版本号徽标都在侧栏里——不展开就会高亮到被裁掉的位置。
   * 省略 = 收起（手机端侧栏是带遮罩的抽屉，展开会盖住内容区与顶栏）。
   */
  sidebar?: 'open' | 'close';
  /** 高亮描边的内边距（px） */
  padding?: number;
  /**
   * 高亮框的高度上限（px）。
   * 用于「容器铺满剩余空间、但内容只有一点点」的目标——比如日志区是 flex-1，
   * 高亮框会跟着撑到几百像素高、框住一大片空白。设了它，框就只从顶部往下量这么多。
   */
  maxHeight?: number;
};

const hasConnCards = () => !!document.querySelector('.kk-conn-card');
const hasPluginCards = () => !!document.querySelector('.kk-plugin-card');

/** 连接管理弹窗是否已打开（以里面的「插件」按钮为标志） */
const connDialogOpen = () => !!document.querySelector('[data-tour="conn-dialog-plugins"]');
/** 打开第一张连接卡片的管理弹窗 */
function openConnDialog(): void {
  if (connDialogOpen()) return;
  document.querySelector<HTMLElement>('.kk-conn-card')?.click();
}
/** 关闭连接管理弹窗（若开着） */
function closeConnDialog(): void {
  if (!connDialogOpen()) return;
  document.querySelector<HTMLElement>('[data-tour="conn-dialog-close"]')?.click();
}

/* —— 添加连接流程：类型选择弹窗 → 反向 WS 表单 —— */
/** 程序触发 Esc（关弹窗）时置真，让导览的 Esc 键监听跳过、不误关整个引导 */
let suppressTourEscape = false;
/** 类型选择弹窗是否已打开 */
const connTypeModalOpen = () => !!document.querySelector('[data-tour="conn-type-list"]');
/** 添加连接表单是否已打开（以名称字段为标志） */
const connFormOpen = () => !!document.querySelector('[data-tour="conn-form-name"]');
/** 打开「选择连接类型」弹窗 */
function openConnTypeModal(): void {
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
function openConnForm(): void {
  if (connFormOpen()) return;
  if (!connTypeModalOpen()) {
    openConnTypeModal();
    return;
  }
  document.querySelector<HTMLElement>('[data-tour="conn-type-reverse"]')?.click();
}
/** 关闭添加连接的两个弹窗（优先点关闭控件，兜底用受控 Esc） */
function closeConnAdd(): void {
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
const simConfigOpen = () => !!document.querySelector('[data-tour="sim-config-account"]');
/** 打开模拟设置面板（长按发送键的效果，导览里用事件触发） */
function openSimConfig(): void {
  if (simConfigOpen()) return;
  window.dispatchEvent(new CustomEvent('kk:sim-config-open'));
}
/** 关闭模拟设置面板 */
function closeSimConfig(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('kk:sim-config-close'));
}

/* —— 配色方案：Ant Design ColorPicker 弹出面板 —— */
/** 拾色面板是否已打开（以面板包装层为标志） */
const colorDialogOpen = () => !!document.querySelector('[data-tour="color-panel"]');
/** 打开「组件及按钮」配色的拾色面板 */
function openColorDialog(): void {
  if (colorDialogOpen()) return;
  document.querySelector<HTMLElement>('[data-tour="color-swatch"]')?.click();
}
/** 关闭拾色面板（再点一次触发色块，antd 气泡会收起） */
function closeColorDialog(): void {
  if (!colorDialogOpen()) return;
  document.querySelector<HTMLElement>('[data-tour="color-swatch"]')?.click();
}

/* —— 更新中心：版本号徽标呼出的悬浮窗 —— */
/** 点击第一个「可见」的匹配元素（品牌字在侧栏与顶栏各有一个，需挑当前可见的那个） */
function clickVisible(selector: string): void {
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
const updateCenterOpen = () => !!document.querySelector('[data-tour="uc-header"]');
/** 打开更新中心悬浮窗（点当前可见的版本号徽标） */
function openUpdateCenter(): void {
  if (updateCenterOpen()) return;
  clickVisible('[data-tour="update-center"]');
}
/** 关闭更新中心悬浮窗（再点一次徽标即收起） */
function closeUpdateCenter(): void {
  if (!updateCenterOpen()) return;
  clickVisible('[data-tour="update-center"]');
}

/* —— 资源商城：分类筛选下拉 —— */
/** 分类下拉是否已展开（以菜单项为标志） */
const storeCategoryMenuOpen = () => !!document.querySelector('[data-tour="store-category-item"]');
/** 展开分类下拉 */
function openStoreCategoryMenu(): void {
  if (storeCategoryMenuOpen()) return;
  document.querySelector<HTMLElement>('[data-tour="store-category"]')?.click();
}
/** 关掉分类下拉（Radix 菜单没有取消按钮，用受控 Esc + 屏蔽导览自身的 Esc） */
function closeStoreCategoryMenu(): void {
  if (!storeCategoryMenuOpen()) return;
  suppressTourEscape = true;
  try {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  } finally {
    suppressTourEscape = false;
  }
}
/** 当前选中的分类 id（按钮上带着）；空串 = 未筛选 */
const currentStoreCategory = () =>
  document.querySelector<HTMLElement>('[data-tour="store-category"]')?.dataset.tourCat ?? '';
/** 在展开的菜单里点某一档（按 data-tour-cat 匹配，不认文字） */
function clickStoreCategoryItem(id: string): boolean {
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
function pickStoreCategory(id: string): void {
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
function clearStoreCategory(): void {
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
const storeDetailOpen = () => !!document.querySelector('[data-tour="store-detail"]');
/** 打开第一张资源卡片的详情 */
function openStoreDetail(): void {
  if (storeDetailOpen()) return;
  document.querySelector<HTMLElement>('[data-tour="store-card"]')?.click();
}
/**
 * 关闭资源详情：点弹窗底部那个「关闭」按钮的锚点。
 * 以前按按钮文字「关闭」找——英文模式下它叫 "Close"，找不到就关不掉，
 * 弹窗一直盖在上面，后面所有步骤的高亮都被它挡住。
 */
function closeStoreDetail(): void {
  if (!storeDetailOpen()) return;
  document.querySelector<HTMLElement>('[data-tour="store-detail-close"]')?.click();
}

/* —— 开放平台：账号详情弹窗 —— */
const opDetailOpen = () => !!document.querySelector('[data-tour="op-detail-actions"]');
/** 打开第一张账号卡片的详情 */
function openOpDetail(): void {
  if (opDetailOpen()) return;
  document.querySelector<HTMLElement>('[data-tour="op-card"]')?.click();
}
/** 关闭账号详情（Radix 弹窗：点右上角的关闭） */
function closeOpDetail(): void {
  if (!opDetailOpen()) return;
  suppressTourEscape = true;
  try {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  } finally {
    suppressTourEscape = false;
  }
}

/* —— 智能助手：模型服务弹窗 + 进入会话 —— */
const aiProfileOpen = () => !!document.querySelector('[data-tour="ai-profile"]');
/** 打开「AI 上游配置」（顶栏齿轮） */
function openAiProfile(): void {
  if (aiProfileOpen()) return;
  document.querySelector<HTMLElement>('[data-tour="ai-config"]')?.click();
}
function closeAiProfile(): void {
  if (!aiProfileOpen()) return;
  suppressTourEscape = true;
  try {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  } finally {
    suppressTourEscape = false;
  }
}
/** 是否已进入某个会话（对话视图以输入区为标志） */
const aiChatOpen = () => !!document.querySelector('[data-tour="ai-composer"]');
/** 点第一条会话进入对话视图 */
function openAiSession(): void {
  if (aiChatOpen()) return;
  document.querySelector<HTMLElement>('[data-tour="ai-session"]')?.click();
}

/** 是否已打开「添加 / 编辑模型」表单 */
const aiProfileEditOpen = () => !!document.querySelector('[data-tour="ai-profile-edit"]');
/**
 * 打开添加模型表单。
 * 同样分两轮：先确保「模型服务」弹窗开了，下一轮再点里面的「添加模型」——
 * click() 的那一刻弹窗内容还没进 DOM，同步点是点不到的。
 */
function openAiProfileEdit(): void {
  if (aiProfileEditOpen()) return;
  if (!aiProfileOpen()) {
    openAiProfile();
    return;
  }
  document.querySelector<HTMLElement>('[data-tour="ai-profile-add"]')?.click();
}

const hasOpCards = () => !!document.querySelector('[data-tour="op-card"]');
const hasAiSessions = () => !!document.querySelector('[data-tour="ai-session"]');
const hasStoreCards = () => !!document.querySelector('[data-tour="store-card"]');

const STEPS: TourStep[] = [
  {
    id: 'dashboard',
    route: '/',
    target: '[data-tour="nav-dashboard"]',
    sidebar: 'open',
    title: 'tour.dashboardTitle',
    body: [
      'tour.dashboardBody1',
      'tour.dashboardBody2',
      'tour.dashboardBody3',
    ],
  },
  {
    id: 'nav-toggle',
    route: '/',
    target: '[data-tour="nav-toggle"]',
    sidebar: 'open',
    title: 'tour.navToggleTitle',
    body: [
      'tour.navToggleBody1',
      'tour.navToggleBody2',
      'tour.navToggleBody3',
    ],
    callout: { tone: 'tip', text: 'tour.navToggleCallout' },
  },
  {
    id: 'nav-edit',
    route: '/',
    target: '[data-tour="nav-edit"]',
    sidebar: 'open',
    padding: 6,
    title: 'tour.navEditTitle',
    body: [
      'tour.navEditBody1',
      'tour.navEditBody2',
      'tour.navEditBody3',
    ],
    callout: { tone: 'tip', text: 'tour.navEditCallout' },
  },
  {
    id: 'dashboard-stats',
    route: '/',
    target: '[data-tour="dashboard-stats"]',
    title: 'tour.dashboardStatsTitle',
    body: [
      'tour.dashboardStatsBody1',
      'tour.dashboardStatsBody2',
    ],
    callout: { tone: 'tip', text: 'tour.dashboardStatsCallout' },
  },
  {
    id: 'dash-stat-listen',
    route: '/',
    target: '[data-tour="dash-stat-listen"]',
    title: 'tour.dashStatListenTitle',
    body: [
      'tour.dashStatListenBody1',
      'tour.dashStatListenBody2',
    ],
  },
  {
    id: 'dash-stat-connected',
    route: '/',
    target: '[data-tour="dash-stat-connected"]',
    title: 'tour.dashStatConnectedTitle',
    body: [
      'tour.dashStatConnectedBody1',
      'tour.dashStatConnectedBody2',
    ],
  },
  {
    id: 'dash-stat-plugins',
    route: '/',
    target: '[data-tour="dash-stat-plugins"]',
    title: 'tour.dashStatPluginsTitle',
    body: [
      'tour.dashStatPluginsBody1',
      'tour.dashStatPluginsBody2',
    ],
  },
  {
    id: 'dash-stat-loaded',
    route: '/',
    target: '[data-tour="dash-stat-loaded"]',
    title: 'tour.dashStatLoadedTitle',
    body: [
      'tour.dashStatLoadedBody1',
      'tour.dashStatLoadedBody2',
    ],
  },
  {
    id: 'nav-connections',
    route: '/',
    target: '[data-tour="nav-connections"]',
    sidebar: 'open',
    // 用户在侧边栏里把它隐藏了：没有可高亮的入口，这一步整步跳过（编号不变）
    skipIf: () => navEntryHidden('nav-connections'),
    title: 'tour.navConnectionsTitle',
    body: [
      'tour.navConnectionsBody1',
      'tour.navConnectionsBody2',
    ],
  },
  {
    id: 'connections-add',
    route: '/connections',
    target: '[data-tour="connections-add"]',
    title: 'tour.connectionsAddTitle',
    body: [
      'tour.connectionsAddBody1',
      'tour.connectionsAddBody2',
    ],
    callout: { tone: 'warn', text: 'tour.connectionsAddCallout' },
    enter: () => {
      closeConnAdd();
      closeConnDialog();
    },
  },
  {
    id: 'conn-type-modal',
    route: '/connections',
    target: '[data-tour="conn-type-list"]',
    title: 'tour.connTypeModalTitle',
    body: [
      'tour.connTypeModalBody1',
      'tour.connTypeModalBody2',
    ],
    callout: { tone: 'tip', text: 'tour.connTypeModalCallout' },
    enter: openConnTypeModal,
  },
  {
    id: 'conn-form',
    route: '/connections',
    target: '[data-tour="conn-form"]',
    title: 'tour.connFormTitle',
    body: [
      'tour.connFormBody1',
      'tour.connFormBody2',
    ],
    enter: openConnForm,
  },
  {
    id: 'conn-form-name',
    route: '/connections',
    target: '[data-tour="conn-form-name"]',
    title: 'tour.connFormNameTitle',
    body: [
      'tour.connFormNameBody1',
      'tour.connFormNameBody2',
    ],
    enter: openConnForm,
  },
  {
    id: 'conn-form-host',
    route: '/connections',
    target: '[data-tour="conn-form-host"]',
    title: 'tour.connFormHostTitle',
    body: [
      'tour.connFormHostBody1',
      'tour.connFormHostBody2',
    ],
    enter: openConnForm,
  },
  {
    id: 'conn-form-port',
    route: '/connections',
    target: '[data-tour="conn-form-port"]',
    title: 'tour.connFormPortTitle',
    body: [
      'tour.connFormPortBody1',
      'tour.connFormPortBody2',
    ],
    callout: { tone: 'warn', text: 'tour.connFormPortCallout' },
    enter: openConnForm,
  },
  {
    id: 'conn-form-token',
    route: '/connections',
    target: '[data-tour="conn-form-token"]',
    title: 'tour.connFormTokenTitle',
    body: [
      'tour.connFormTokenBody1',
      'tour.connFormTokenBody2',
    ],
    enter: openConnForm,
  },
  {
    id: 'conn-form-submit',
    route: '/connections',
    target: '[data-tour="conn-form-submit"]',
    title: 'tour.connFormSubmitTitle',
    body: [
      'tour.connFormSubmitBody1',
      'tour.connFormSubmitBody2',
    ],
    callout: { tone: 'tip', text: 'tour.connFormSubmitCallout' },
    enter: openConnForm,
  },
  {
    // 有连接时：讲点开卡片能干嘛
    id: 'connections-card',
    route: '/connections',
    target: '.kk-conn-card',
    title: 'tour.connectionsCardTitle',
    body: [
      'tour.connectionsCardBody1',
      'tour.connectionsCardBody2',
    ],
    enter: () => {
      closeConnAdd();
      closeConnDialog();
    },
    skipIf: () => !hasConnCards(),
  },
  {
    id: 'conn-dialog-enable',
    route: '/connections',
    target: '[data-tour="conn-dialog-enable"]',
    title: 'tour.connDialogEnableTitle',
    body: [
      'tour.connDialogEnableBody1',
      'tour.connDialogEnableBody2',
    ],
    enter: openConnDialog,
    skipIf: () => !hasConnCards(),
  },
  {
    id: 'conn-dialog-plugins',
    route: '/connections',
    target: '[data-tour="conn-dialog-plugins"]',
    title: 'tour.connDialogPluginsTitle',
    body: [
      'tour.connDialogPluginsBody1',
      'tour.connDialogPluginsBody2',
    ],
    callout: { tone: 'warn', text: 'tour.connDialogPluginsCallout' },
    enter: openConnDialog,
    skipIf: () => !hasConnCards(),
  },
  {
    id: 'connections-export',
    route: '/connections',
    target: '[data-tour="connections-export"]',
    title: 'tour.connectionsExportTitle',
    body: [
      'tour.connectionsExportBody1',
      'tour.connectionsExportBody2',
    ],
    callout: { tone: 'tip', text: 'tour.connectionsExportCallout' },
    // 上一步把「连接管理」弹窗打开了，不先关掉就会高亮到弹窗背后的区域
    enter: () => {
      closeConnAdd();
      closeConnDialog();
    },
  },
  {
    id: 'connections-import',
    route: '/connections',
    target: '[data-tour="connections-import"]',
    title: 'tour.connectionsImportTitle',
    body: [
      'tour.connectionsImportBody1',
      'tour.connectionsImportBody2',
      'tour.connectionsImportBody3',
      'tour.connectionsImportBody4',
    ],
    callout: { tone: 'tip', text: 'tour.connectionsImportCallout' },
    enter: () => {
      closeConnAdd();
      closeConnDialog();
    },
  },
  {
    id: 'nav-plugins',
    route: '/connections',
    target: '[data-tour="nav-plugins"]',
    sidebar: 'open',
    // 用户在侧边栏里把它隐藏了：没有可高亮的入口，这一步整步跳过（编号不变）
    skipIf: () => navEntryHidden('nav-plugins'),
    title: 'tour.navPluginsTitle',
    body: [
      'tour.navPluginsBody1',
      'tour.navPluginsBody2',
    ],
    enter: () => {
      closeConnAdd();
      closeConnDialog();
    },
  },
  {
    id: 'plugins-stats',
    route: '/plugins',
    target: '[data-tour="plugins-stats"]',
    title: 'tour.pluginsStatsTitle',
    body: [
      'tour.pluginsStatsBody1',
      'tour.pluginsStatsBody2',
    ],
    callout: { tone: 'warn', text: 'tour.pluginsStatsCallout' },
  },
  {
    id: 'plugins-filter',
    route: '/plugins',
    target: '[data-tour="plugins-filter"]',
    title: 'tour.pluginsFilterTitle',
    body: [
      'tour.pluginsFilterBody1',
      'tour.pluginsFilterBody2',
      'tour.pluginsFilterBody3',
    ],
  },
  {
    id: 'plugins-toolbar',
    route: '/plugins',
    target: '[data-tour="plugins-toolbar"]',
    title: 'tour.pluginsToolbarTitle',
    body: [
      'tour.pluginsToolbarBody1',
      'tour.pluginsToolbarBody2',
      'tour.pluginsToolbarBody3',
    ],
  },
  {
    id: 'plugins-upload',
    route: '/plugins',
    target: '[data-tour="plugins-upload"]',
    title: 'tour.pluginsUploadTitle',
    body: [
      'tour.pluginsUploadBody1',
      'tour.pluginsUploadBody2',
    ],
  },
  {
    id: 'plugins-refresh',
    route: '/plugins',
    target: '[data-tour="plugins-refresh"]',
    title: 'tour.pluginsRefreshTitle',
    body: [
      'tour.pluginsRefreshBody1',
      'tour.pluginsRefreshBody2',
    ],
  },
  {
    id: 'plugins-card',
    route: '/plugins',
    target: '.kk-plugin-card',
    title: 'tour.pluginsCardTitle',
    body: [
      'tour.pluginsCardBody1',
      'tour.pluginsCardBody2',
    ],
    skipIf: () => !hasPluginCards(),
  },
  {
    id: 'plugin-master-switch',
    route: '/plugins',
    target: '[data-tour="plugin-master-switch"]',
    title: 'tour.pluginMasterSwitchTitle',
    body: [
      'tour.pluginMasterSwitchBody1',
      'tour.pluginMasterSwitchBody2',
    ],
    callout: { tone: 'warn', text: 'tour.pluginMasterSwitchCallout' },
    skipIf: () => !hasPluginCards(),
  },
  {
    id: 'plugins-card-actions',
    route: '/plugins',
    target: '.kk-plugin-card',
    title: 'tour.pluginsCardActionsTitle',
    body: [
      'tour.pluginsCardActionsBody1',
      'tour.pluginsCardActionsBody2',
    ],
    skipIf: () => !hasPluginCards(),
  },
  {
    id: 'nav-plugin-store',
    route: '/plugins',
    target: '[data-tour="nav-plugin-store"]',
    sidebar: 'open',
    // 用户在侧边栏里把它隐藏了：没有可高亮的入口，这一步整步跳过（编号不变）
    skipIf: () => navEntryHidden('nav-plugin-store'),
    title: 'tour.navPluginStoreTitle',
    body: [
      'tour.navPluginStoreBody1',
      'tour.navPluginStoreBody2',
    ],
  },
  {
    id: 'store-toolbar',
    route: '/plugin-store',
    target: '[data-tour="store-toolbar"]',
    title: 'tour.storeToolbarTitle',
    body: [
      'tour.storeToolbarBody1',
      'tour.storeToolbarBody2',
    ],
    enter: () => {
      closeStoreDetail();
      clearStoreCategory();
    },
  },
  {
    id: 'store-search',
    route: '/plugin-store',
    target: '[data-tour="store-search"]',
    title: 'tour.storeSearchTitle',
    body: [
      'tour.storeSearchBody1',
      'tour.storeSearchBody2',
    ],
    enter: () => {
      closeStoreDetail();
      clearStoreCategory();
    },
  },
  {
    id: 'store-origin',
    route: '/plugin-store',
    target: '[data-tour="store-origin"]',
    title: 'tour.storeOriginTitle',
    body: [
      'tour.storeOriginBody1',
      'tour.storeOriginBody2',
      'tour.storeOriginBody3',
    ],
    enter: () => {
      closeStoreDetail();
      clearStoreCategory();
    },
  },
  {
    id: 'store-category',
    route: '/plugin-store',
    target: '[data-tour="store-category"]',
    title: 'tour.storeCategoryTitle',
    body: [
      'tour.storeCategoryBody1',
      'tour.storeCategoryBody2',
      'tour.storeCategoryBody3',
    ],
    enter: () => {
      closeStoreDetail();
      clearStoreCategory();
    },
  },
  {
    id: 'store-category-menu',
    route: '/plugin-store',
    target: '[data-tour="store-category-menu"]',
    title: 'tour.storeCategoryMenuTitle',
    body: [
      'tour.storeCategoryMenuBody1',
      'tour.storeCategoryMenuBody2',
      'tour.storeCategoryMenuBody3',
      'tour.storeCategoryMenuBody4',
    ],
    callout: { tone: 'tip', text: 'tour.storeCategoryMenuCallout' },
    enter: () => {
      closeStoreDetail();
      openStoreCategoryMenu();
    },
    skipIf: () => !document.querySelector('[data-tour="store-category"]'),
  },
  {
    id: 'store-category-picked',
    route: '/plugin-store',
    target: '[data-tour="store-category"]',
    title: 'tour.storeCategoryPickedTitle',
    body: [
      'tour.storeCategoryPickedBody1',
      'tour.storeCategoryPickedBody2',
      'tour.storeCategoryPickedBody3',
    ],
    enter: () => {
      closeStoreDetail();
      pickStoreCategory('official');
    },
  },
  {
    id: 'store-grid',
    route: '/plugin-store',
    target: '[data-tour="store-grid"]',
    title: 'tour.storeGridTitle',
    body: [
      'tour.storeGridBody1',
      'tour.storeGridBody2',
    ],
    enter: () => {
      closeStoreDetail();
      clearStoreCategory();
    },
  },
  {
    id: 'store-card',
    route: '/plugin-store',
    target: '[data-tour="store-card"]',
    title: 'tour.storeCardTitle',
    body: [
      'tour.storeCardBody1',
      'tour.storeCardBody2',
    ],
    skipIf: () => !hasStoreCards(),
    /*
     * 也负责关详情弹窗：往回走（从「资源详情」那几步点上一步）时，
     * 必须有一个步骤把弹窗收掉，否则它就一直盖在卡片列表上，
     * 后面的步骤全都高亮不到——以前只有往前的路径上写了 closeStoreDetail，
     * 于是「上一步」永远关不掉它。
     */
    enter: closeStoreDetail,
  },
  {
    id: 'store-install',
    route: '/plugin-store',
    target: '[data-tour="store-install"]',
    title: 'tour.storeInstallTitle',
    body: [
      'tour.storeInstallBody1',
      'tour.storeInstallBody2',
      'tour.storeInstallBody3',
    ],
    callout: { tone: 'warn', text: 'tour.storeInstallCallout' },
    skipIf: () => !hasStoreCards(),
    // 同 store-card：这一步在详情弹窗之前，往回走时由它把弹窗收掉
    enter: closeStoreDetail,
  },
  {
    id: 'store-detail',
    route: '/plugin-store',
    target: '[data-tour="store-detail-head"]',
    title: 'tour.storeDetailTitle',
    body: [
      'tour.storeDetailBody1',
      'tour.storeDetailBody2',
    ],
    enter: openStoreDetail,
    skipIf: () => !hasStoreCards(),
  },
  {
    id: 'store-detail-intro',
    route: '/plugin-store',
    target: '[data-tour="store-detail-intro"]',
    title: 'tour.storeDetailIntroTitle',
    body: [
      'tour.storeDetailIntroBody1',
      'tour.storeDetailIntroBody2',
    ],
    enter: openStoreDetail,
    skipIf: () => !hasStoreCards(),
  },
  {
    id: 'store-detail-info',
    route: '/plugin-store',
    target: '[data-tour="store-detail"]',
    title: 'tour.storeDetailInfoTitle',
    body: [
      'tour.storeDetailInfoBody1',
      'tour.storeDetailInfoBody2',
    ],
    callout: { tone: 'warn', text: 'tour.storeDetailInfoCallout' },
    enter: openStoreDetail,
    skipIf: () => !hasStoreCards(),
  },
  {
    id: 'store-detail-install',
    route: '/plugin-store',
    target: '[data-tour="store-detail-install"]',
    title: 'tour.storeDetailInstallTitle',
    body: [
      'tour.storeDetailInstallBody1',
      'tour.storeDetailInstallBody2',
    ],
    enter: openStoreDetail,
    skipIf: () => !hasStoreCards(),
  },
  {
    id: 'store-pagination',
    route: '/plugin-store',
    target: '[data-tour="store-pagination"]',
    title: 'tour.storePaginationTitle',
    body: [
      'tour.storePaginationBody1',
      'tour.storePaginationBody2',
    ],
    callout: { tone: 'tip', text: 'tour.storePaginationCallout' },
    skipIf: () => !document.querySelector('[data-tour="store-pagination"]'),
    enter: closeStoreDetail,
  },
  {
    id: 'store-sort',
    route: '/plugin-store',
    target: '[data-tour="store-sort"]',
    title: 'tour.storeSortTitle',
    body: [
      'tour.storeSortBody1',
      'tour.storeSortBody2',
      'tour.storeSortBody3',
    ],
    callout: { tone: 'tip', text: 'tour.storeSortCallout' },
    enter: () => {
      closeStoreDetail();
      clearStoreCategory();
    },
  },
  {
    id: 'store-refresh',
    route: '/plugin-store',
    target: '[data-tour="store-refresh"]',
    title: 'tour.storeRefreshTitle',
    body: [
      'tour.storeRefreshBody1',
      'tour.storeRefreshBody2',
    ],
    callout: { tone: 'tip', text: 'tour.storeRefreshCallout' },
    enter: () => {
      closeStoreDetail();
      clearStoreCategory();
    },
  },
  {
    id: 'nav-tools',
    route: '/plugin-store',
    target: '[data-tour="nav-tools"]',
    sidebar: 'open',
    // 用户在侧边栏里把它隐藏了：没有可高亮的入口，这一步整步跳过（编号不变）
    skipIf: () => navEntryHidden('nav-tools'),
    title: 'tour.navToolsTitle',
    body: [
      'tour.navToolsBody1',
      'tour.navToolsBody2',
    ],
    enter: () => {
      closeStoreDetail();
      clearStoreCategory();
    },
  },
  {
    id: 'tools',
    route: '/tools',
    target: '[data-tour="tools-grid"]',
    title: 'tour.toolsTitle',
    body: [
      'tour.toolsBody1',
      'tour.toolsBody2',
    ],
  },
  {
    id: 'tool-encode',
    route: '/tools',
    target: '[data-tour="tool-encode"]',
    title: 'tour.toolEncodeTitle',
    body: [
      'tour.toolEncodeBody1',
      'tour.toolEncodeBody2',
    ],
  },
  {
    id: 'tool-media',
    route: '/tools',
    target: '[data-tour="tool-media"]',
    title: 'tour.toolMediaTitle',
    body: [
      'tour.toolMediaBody1',
      'tour.toolMediaBody2',
    ],
  },
  {
    id: 'tool-plugin-dev',
    route: '/tools',
    target: '[data-tour="tool-plugin-dev"]',
    title: 'tour.toolPluginDevTitle',
    body: [
      'tour.toolPluginDevBody1',
      'tour.toolPluginDevBody2',
    ],
  },
  {
    id: 'tool-image-obf',
    route: '/tools',
    target: '[data-tour="tool-image-obf"]',
    title: 'tour.toolImageObfTitle',
    body: [
      'tour.toolImageObfBody1',
      'tour.toolImageObfBody2',
    ],
    callout: { tone: 'warn', text: 'tour.toolImageObfCallout' },
  },
  {
    id: 'tool-image-edit',
    route: '/tools',
    target: '[data-tour="tool-image-edit"]',
    title: 'tour.toolImageEditTitle',
    body: [
      'tour.toolImageEditBody1',
      'tour.toolImageEditBody2',
    ],
  },
  {
    id: 'nav-open-platform',
    route: '/tools',
    target: '[data-tour="nav-open-platform"]',
    sidebar: 'open',
    // 用户在侧边栏里把它隐藏了：没有可高亮的入口，这一步整步跳过（编号不变）
    skipIf: () => navEntryHidden('nav-open-platform'),
    title: 'tour.navOpenPlatformTitle',
    body: [
      'tour.navOpenPlatformBody1',
      'tour.navOpenPlatformBody2',
      'tour.navOpenPlatformBody3',
    ],
  },
  {
    id: 'op-login',
    route: '/open-platform',
    target: '[data-tour="op-login"]',
    title: 'tour.opLoginTitle',
    body: [
      'tour.opLoginBody1',
      'tour.opLoginBody2',
      'tour.opLoginBody3',
      'tour.opLoginBody4',
    ],
    callout: { tone: 'warn', text: 'tour.opLoginCallout' },
  },
  {
    id: 'op-stats',
    route: '/open-platform',
    target: '[data-tour="op-stats"]',
    title: 'tour.opStatsTitle',
    body: [
      'tour.opStatsBody1',
      'tour.opStatsBody2',
    ],
  },
  {
    id: 'op-add',
    route: '/open-platform',
    target: '[data-tour="op-add"]',
    title: 'tour.opAddTitle',
    body: [
      'tour.opAddBody1',
      'tour.opAddBody2',
      'tour.opAddBody3',
    ],
  },
  {
    id: 'op-card',
    route: '/open-platform',
    target: '[data-tour="op-card"]',
    title: 'tour.opCardTitle',
    body: [
      'tour.opCardBody1',
      'tour.opCardBody2',
      'tour.opCardBody3',
    ],
    skipIf: () => !hasOpCards(),
    enter: closeOpDetail,
  },
  {
    id: 'op-detail',
    route: '/open-platform',
    target: '[data-tour="op-detail"]',
    title: 'tour.opDetailTitle',
    body: [
      'tour.opDetailBody1',
      'tour.opDetailBody2',
    ],
    skipIf: () => !hasOpCards(),
    enter: openOpDetail,
  },
  {
    id: 'op-detail-dau',
    route: '/open-platform',
    target: '[data-tour="op-detail-dau"]',
    title: 'tour.opDetailDauTitle',
    body: [
      'tour.opDetailDauBody1',
      'tour.opDetailDauBody2',
    ],
    skipIf: () => !document.querySelector('[data-tour="op-detail-dau"]'),
    enter: openOpDetail,
  },
  {
    id: 'op-detail-insight',
    route: '/open-platform',
    title: 'tour.opDetailInsightTitle',
    center: true,
    body: [
      'tour.opDetailInsightBody1',
      'tour.opDetailInsightBody2',
    ],
    callout: { tone: 'tip', text: 'tour.opDetailInsightCallout' },
    skipIf: () => !document.querySelector('[data-tour="op-detail-insight"]'),
    enter: openOpDetail,
  },
  {
    id: 'op-detail-actions',
    route: '/open-platform',
    target: '[data-tour="op-detail-actions"]',
    title: 'tour.opDetailActionsTitle',
    body: [
      'tour.opDetailActionsBody1',
      'tour.opDetailActionsBody2',
    ],
    skipIf: () => !hasOpCards(),
    enter: openOpDetail,
  },
  {
    id: 'nav-ai',
    route: '/open-platform',
    target: '[data-tour="nav-ai"]',
    sidebar: 'open',
    // 用户在侧边栏里把它隐藏了：没有可高亮的入口，这一步整步跳过（编号不变）
    skipIf: () => navEntryHidden('nav-ai'),
    title: 'tour.navAiTitle',
    body: [
      'tour.navAiBody1',
      'tour.navAiBody2',
      'tour.navAiBody3',
    ],
    enter: closeOpDetail,
  },
  {
    id: 'ai-new',
    route: '/ai',
    target: '[data-tour="ai-new"]',
    title: 'tour.aiNewTitle',
    body: [
      'tour.aiNewBody1',
      'tour.aiNewBody2',
    ],
    enter: () => {
      closeAiProfile();
    },
  },
  {
    id: 'ai-list',
    route: '/ai',
    target: '[data-tour="ai-list"]',
    title: 'tour.aiListTitle',
    body: [
      'tour.aiListBody1',
      'tour.aiListBody2',
    ],
    enter: closeAiProfile,
  },
  {
    id: 'ai-config',
    route: '/ai',
    target: '[data-tour="ai-config"]',
    title: 'tour.aiConfigTitle',
    body: [
      'tour.aiConfigBody1',
      'tour.aiConfigBody2',
    ],
    enter: closeAiProfile,
  },
  {
    id: 'ai-profile',
    route: '/ai',
    target: '[data-tour="ai-profile"]',
    title: 'tour.aiProfileTitle',
    body: [
      'tour.aiProfileBody1',
      'tour.aiProfileBody2',
    ],
    callout: { tone: 'warn', text: 'tour.aiProfileCallout' },
    enter: openAiProfile,
  },
  {
    id: 'ai-profile-edit',
    route: '/ai',
    target: '[data-tour="ai-profile-edit"]',
    title: 'tour.aiProfileEditTitle',
    body: [
      'tour.aiProfileEditBody1',
      'tour.aiProfileEditBody2',
      'tour.aiProfileEditBody3',
      'tour.aiProfileEditBody4',
    ],
    callout: { tone: 'warn', text: 'tour.aiProfileEditCallout' },
    enter: openAiProfileEdit,
  },
  {
    id: 'ai-profile-vision',
    route: '/ai',
    target: '[data-tour="ai-profile-vision"]',
    title: 'tour.aiProfileVisionTitle',
    body: [
      'tour.aiProfileVisionBody1',
      'tour.aiProfileVisionBody2',
    ],
    callout: { tone: 'tip', text: 'tour.aiProfileVisionCallout' },
    enter: openAiProfileEdit,
  },
  {
    id: 'ai-composer',
    route: '/ai',
    target: '[data-tour="ai-composer"]',
    title: 'tour.aiComposerTitle',
    body: [
      'tour.aiComposerBody1',
      'tour.aiComposerBody2',
      'tour.aiComposerBody3',
    ],
    skipIf: () => !hasAiSessions(),
    enter: () => {
      closeAiProfile();
      openAiSession();
    },
  },
  {
    id: 'ai-model',
    route: '/ai',
    target: '[data-tour="ai-model"]',
    title: 'tour.aiModelTitle',
    body: [
      'tour.aiModelBody1',
      'tour.aiModelBody2',
      'tour.aiModelBody3',
    ],
    skipIf: () => !hasAiSessions(),
    enter: () => {
      closeAiProfile();
      openAiSession();
    },
  },
  {
    id: 'ai-file',
    route: '/ai',
    target: '[data-tour="ai-file"]',
    title: 'tour.aiFileTitle',
    body: [
      'tour.aiFileBody1',
      'tour.aiFileBody2',
    ],
    callout: { tone: 'warn', text: 'tour.aiFileCallout' },
    skipIf: () => !hasAiSessions(),
    enter: () => {
      closeAiProfile();
      openAiSession();
    },
  },
  {
    id: 'ai-send',
    route: '/ai',
    target: '[data-tour="ai-send"]',
    title: 'tour.aiSendTitle',
    body: [
      'tour.aiSendBody1',
      'tour.aiSendBody2',
    ],
    skipIf: () => !hasAiSessions(),
    enter: () => {
      closeAiProfile();
      openAiSession();
    },
  },
  {
    id: 'nav-simulate',
    route: '/ai',
    target: '[data-tour="nav-simulate"]',
    sidebar: 'open',
    // 用户在侧边栏里把它隐藏了：没有可高亮的入口，这一步整步跳过（编号不变）
    skipIf: () => navEntryHidden('nav-simulate'),
    title: 'tour.navSimulateTitle',
    body: [
      'tour.navSimulateBody1',
      'tour.navSimulateBody2',
      'tour.navSimulateBody3',
    ],
    enter: closeAiProfile,
  },
  {
    id: 'simulate',
    route: '/simulate',
    target: '[data-tour="simulate-send"]',
    title: 'tour.simulateTitle',
    body: [
      'tour.simulateBody1',
      'tour.simulateBody2',
    ],
    callout: { tone: 'tip', text: 'tour.simulateCallout' },
    enter: closeSimConfig,
  },
  {
    id: 'sim-config-account',
    route: '/simulate',
    target: '[data-tour="sim-config-account"]',
    title: 'tour.simConfigAccountTitle',
    body: [
      'tour.simConfigAccountBody1',
      'tour.simConfigAccountBody2',
    ],
    enter: openSimConfig,
  },
  {
    id: 'sim-config-identity',
    route: '/simulate',
    target: '[data-tour="sim-config-identity"]',
    title: 'tour.simConfigIdentityTitle',
    body: [
      'tour.simConfigIdentityBody1',
      'tour.simConfigIdentityBody2',
    ],
    enter: openSimConfig,
  },
  {
    id: 'sim-config-event',
    route: '/simulate',
    target: '[data-tour="sim-config-event"]',
    title: 'tour.simConfigEventTitle',
    body: [
      'tour.simConfigEventBody1',
      'tour.simConfigEventBody2',
    ],
    callout: { tone: 'tip', text: 'tour.simConfigEventCallout' },
    enter: openSimConfig,
  },
  {
    id: 'nav-logs',
    route: '/simulate',
    target: '[data-tour="nav-logs"]',
    sidebar: 'open',
    // 用户在侧边栏里把它隐藏了：没有可高亮的入口，这一步整步跳过（编号不变）
    skipIf: () => navEntryHidden('nav-logs'),
    title: 'tour.navLogsTitle',
    body: [
      'tour.navLogsBody1',
      'tour.navLogsBody2',
    ],
    enter: closeSimConfig,
  },
  {
    id: 'logs-filters',
    route: '/logs',
    target: '[data-tour="logs-filters"]',
    title: 'tour.logsFiltersTitle',
    body: [
      'tour.logsFiltersBody1',
      'tour.logsFiltersBody2',
    ],
    enter: closeSimConfig,
  },
  {
    id: 'logs-search',
    route: '/logs',
    target: '[data-tour="logs-search"]',
    title: 'tour.logsSearchTitle',
    body: [
      'tour.logsSearchBody1',
    ],
  },
  {
    id: 'logs-cat',
    route: '/logs',
    target: '[data-tour="logs-cat"]',
    title: 'tour.logsCatTitle',
    body: [
      'tour.logsCatBody1',
      'tour.logsCatBody2',
      'tour.logsCatBody3',
    ],
  },
  {
    id: 'logs-level',
    route: '/logs',
    target: '[data-tour="logs-level"]',
    title: 'tour.logsLevelTitle',
    body: [
      'tour.logsLevelBody1',
      'tour.logsLevelBody2',
    ],
    callout: { tone: 'tip', text: 'tour.logsLevelCallout' },
  },
  {
    id: 'logs-file',
    route: '/logs',
    target: '[data-tour="logs-file"]',
    title: 'tour.logsFileTitle',
    body: [
      'tour.logsFileBody1',
      'tour.logsFileBody2',
      'tour.logsFileBody3',
    ],
  },
  {
    id: 'logs-stream',
    route: '/logs',
    target: '[data-tour="logs-stream"]',
    // 日志区是 flex-1，会一路撑到屏幕底部；不设上限的话高亮框比里面的日志行高出一大截，
    // 看着像框错了地方。这里只从日志区顶部往下框一段，正好盖住最前面几行。
    maxHeight: 240,
    title: 'tour.logsStreamTitle',
    body: [
      'tour.logsStreamBody1',
      'tour.logsStreamBody2',
      'tour.logsStreamBody3',
      'tour.logsStreamBody4',
      'tour.logsStreamBody5',
    ],
    callout: { tone: 'tip', text: 'tour.logsStreamCallout' },
  },
  {
    id: 'logs-toolbar',
    route: '/logs',
    target: '[data-tour="logs-toolbar"]',
    title: 'tour.logsToolbarTitle',
    body: [
      'tour.logsToolbarBody1',
      'tour.logsToolbarBody2',
    ],
  },
  {
    id: 'logs-refresh',
    route: '/logs',
    target: '[data-tour="logs-refresh"]',
    title: 'tour.logsRefreshTitle',
    body: [
      'tour.logsRefreshBody1',
      'tour.logsRefreshBody2',
    ],
  },
  {
    id: 'logs-copy',
    route: '/logs',
    target: '[data-tour="logs-copy"]',
    title: 'tour.logsCopyTitle',
    body: [
      'tour.logsCopyBody1',
      'tour.logsCopyBody2',
    ],
  },
  {
    id: 'logs-download',
    route: '/logs',
    target: '[data-tour="logs-download"]',
    title: 'tour.logsDownloadTitle',
    body: [
      'tour.logsDownloadBody1',
      'tour.logsDownloadBody2',
      'tour.logsDownloadBody3',
    ],
  },
  {
    id: 'logs-clear',
    route: '/logs',
    target: '[data-tour="logs-clear"]',
    title: 'tour.logsClearTitle',
    body: [
      'tour.logsClearBody1',
      'tour.logsClearBody2',
    ],
    callout: { tone: 'warn', text: 'tour.logsClearCallout' },
  },
  {
    id: 'logs-autoscroll',
    route: '/logs',
    target: '[data-tour="logs-autoscroll"]',
    title: 'tour.logsAutoscrollTitle',
    body: [
      'tour.logsAutoscrollBody1',
      'tour.logsAutoscrollBody2',
    ],
  },
  {
    id: 'nav-settings',
    route: '/logs',
    target: '[data-tour="nav-settings"]',
    sidebar: 'open',
    // 用户在侧边栏里把它隐藏了：没有可高亮的入口，这一步整步跳过（编号不变）
    skipIf: () => navEntryHidden('nav-settings'),
    title: 'tour.navSettingsTitle',
    body: [
      'tour.navSettingsBody1',
      'tour.navSettingsBody2',
    ],
  },
  {
    id: 'settings-listen',
    route: '/settings',
    target: '[data-tour="settings-listen"]',
    title: 'tour.settingsListenTitle',
    body: [
      'tour.settingsListenBody1',
      'tour.settingsListenBody2',
    ],
  },
  {
    id: 'row-host',
    route: '/settings',
    target: '[data-tour="row-host"]',
    title: 'tour.rowHostTitle',
    body: [
      'tour.rowHostBody1',
      'tour.rowHostBody2',
    ],
    callout: { tone: 'warn', text: 'tour.rowHostCallout' },
  },
  {
    id: 'row-port',
    route: '/settings',
    target: '[data-tour="row-port"]',
    title: 'tour.rowPortTitle',
    body: [
      'tour.rowPortBody1',
      'tour.rowPortBody2',
    ],
    callout: { tone: 'warn', text: 'tour.rowPortCallout' },
  },
  {
    id: 'settings-runtime',
    route: '/settings',
    target: '[data-tour="settings-runtime"]',
    title: 'tour.settingsRuntimeTitle',
    body: [
      'tour.settingsRuntimeBody1',
    ],
  },
  {
    id: 'row-loglevel',
    route: '/settings',
    target: '[data-tour="row-loglevel"]',
    title: 'tour.rowLoglevelTitle',
    body: [
      'tour.rowLoglevelBody1',
      'tour.rowLoglevelBody2',
    ],
  },
  {
    id: 'row-timeout',
    route: '/settings',
    target: '[data-tour="row-timeout"]',
    title: 'tour.rowTimeoutTitle',
    body: [
      'tour.rowTimeoutBody1',
      'tour.rowTimeoutBody2',
    ],
  },
  {
    id: 'settings-title',
    route: '/settings',
    target: '[data-tour="settings-title"]',
    title: 'tour.settingsTitleTitle',
    body: [
      'tour.settingsTitleBody1',
      'tour.settingsTitleBody2',
    ],
  },
  {
    id: 'row-title',
    route: '/settings',
    target: '[data-tour="row-title"]',
    title: 'tour.rowTitleTitle',
    body: [
      'tour.rowTitleBody1',
      'tour.rowTitleBody2',
    ],
  },
  {
    id: 'brand-title',
    route: '/settings',
    target: '[data-tour="brand-title"]',
    title: 'tour.brandTitleTitle',
    body: [
      'tour.brandTitleBody1',
      'tour.brandTitleBody2',
      'tour.brandTitleBody3',
    ],
    callout: { tone: 'tip', text: 'tour.brandTitleCallout' },
  },
  {
    id: 'settings-appearance',
    route: '/settings',
    target: '[data-tour="settings-appearance"]',
    title: 'tour.settingsAppearanceTitle',
    body: [
      'tour.settingsAppearanceBody1',
      'tour.settingsAppearanceBody2',
    ],
  },
  {
    id: 'ap-bg',
    route: '/settings',
    target: '[data-tour="ap-bg"]',
    title: 'tour.apBgTitle',
    body: [
      'tour.apBgBody1',
      'tour.apBgBody2',
    ],
  },
  {
    id: 'ap-uiSpeed',
    route: '/settings',
    target: '[data-tour="ap-row-uiSpeed"]',
    title: 'tour.apUiSpeedTitle',
    body: [
      'tour.apUiSpeedBody1',
    ],
  },
  {
    id: 'ap-cardOpacity',
    route: '/settings',
    target: '[data-tour="ap-row-cardOpacity"]',
    title: 'tour.apCardOpacityTitle',
    body: [
      'tour.apCardOpacityBody1',
    ],
  },
  {
    id: 'ap-cardBlur',
    route: '/settings',
    target: '[data-tour="ap-row-cardBlur"]',
    title: 'tour.apCardBlurTitle',
    body: [
      'tour.apCardBlurBody1',
    ],
  },
  {
    id: 'ap-card2Opacity',
    route: '/settings',
    target: '[data-tour="ap-row-card2Opacity"]',
    title: 'tour.apCard2OpacityTitle',
    body: [
      'tour.apCard2OpacityBody1',
      'tour.apCard2OpacityBody2',
    ],
  },
  {
    id: 'ap-card2Blur',
    route: '/settings',
    target: '[data-tour="ap-row-card2Blur"]',
    title: 'tour.apCard2BlurTitle',
    body: [
      'tour.apCard2BlurBody1',
    ],
  },
  {
    id: 'ap-backgroundBlur',
    route: '/settings',
    target: '[data-tour="ap-row-backgroundBlur"]',
    title: 'tour.apBackgroundBlurTitle',
    body: [
      'tour.apBackgroundBlurBody1',
      'tour.apBackgroundBlurBody2',
    ],
  },
  {
    id: 'ap-sidebarWidthPc',
    route: '/settings',
    target: '[data-tour="ap-row-sidebarWidthPc"]',
    title: 'tour.apSidebarWidthPcTitle',
    body: [
      'tour.apSidebarWidthPcBody1',
      'tour.apSidebarWidthPcBody2',
    ],
  },
  {
    id: 'ap-sidebarWidthMobile',
    route: '/settings',
    target: '[data-tour="ap-row-sidebarWidthMobile"]',
    title: 'tour.apSidebarWidthMobileTitle',
    body: [
      'tour.apSidebarWidthMobileBody1',
      'tour.apSidebarWidthMobileBody2',
    ],
  },
  {
    id: 'settings-color',
    route: '/settings',
    target: '[data-tour="settings-color"]',
    title: 'tour.settingsColorTitle',
    body: [
      'tour.settingsColorBody1',
      'tour.settingsColorBody2',
    ],
  },
  {
    id: 'color-panel',
    route: '/settings',
    target: '[data-tour="color-panel"]',
    title: 'tour.colorPanelTitle',
    body: [
      'tour.colorPanelBody1',
      'tour.colorPanelBody2',
    ],
    enter: openColorDialog,
  },
  {
    id: 'color-gradient',
    route: '/settings',
    target: '[data-tour="color-panel"]',
    title: 'tour.colorGradientTitle',
    body: [
      'tour.colorGradientBody1',
      'tour.colorGradientBody2',
    ],
    enter: openColorDialog,
  },
  {
    id: 'settings-performance',
    route: '/settings',
    target: '[data-tour="settings-performance"]',
    title: 'tour.settingsPerformanceTitle',
    body: [
      'tour.settingsPerformanceBody1',
      'tour.settingsPerformanceBody2',
    ],
    enter: closeColorDialog,
  },
  {
    id: 'perf-mode-toggle',
    route: '/settings',
    target: '[data-tour="perf-mode-toggle"]',
    title: 'tour.perfModeToggleTitle',
    body: [
      'tour.perfModeToggleBody1',
      'tour.perfModeToggleBody2',
      'tour.perfModeToggleBody3',
    ],
    callout: { tone: 'tip', text: 'tour.perfModeToggleCallout' },
  },
  {
    id: 'settings-store-origin',
    route: '/settings',
    target: '[data-tour="settings-store-origin"]',
    title: 'tour.settingsStoreOriginTitle',
    body: [
      'tour.settingsStoreOriginBody1',
      'tour.settingsStoreOriginBody2',
    ],
    callout: { tone: 'warn', text: 'tour.settingsStoreOriginCallout' },
    enter: closeColorDialog,
  },
  {
    id: 'update-center',
    route: '/settings',
    target: '[data-tour="update-center"]',
    sidebar: 'open',
    title: 'tour.updateCenterTitle',
    body: [
      'tour.updateCenterBody1',
      'tour.updateCenterBody2',
    ],
    enter: closeColorDialog,
  },
  {
    id: 'uc-header',
    route: '/settings',
    sidebar: 'open',
    target: '[data-tour="uc-header"]',
    title: 'tour.ucHeaderTitle',
    body: [
      'tour.ucHeaderBody1',
      'tour.ucHeaderBody2',
    ],
    enter: openUpdateCenter,
  },
  {
    id: 'uc-version',
    route: '/settings',
    sidebar: 'open',
    target: '[data-tour="uc-version"]',
    title: 'tour.ucVersionTitle',
    body: [
      'tour.ucVersionBody1',
    ],
    enter: openUpdateCenter,
  },
  {
    id: 'uc-actions',
    route: '/settings',
    sidebar: 'open',
    target: '[data-tour="uc-actions"]',
    title: 'tour.ucActionsTitle',
    body: [
      'tour.ucActionsBody1',
      'tour.ucActionsBody2',
    ],
    enter: openUpdateCenter,
  },
  {
    id: 'uc-mirror',
    route: '/settings',
    sidebar: 'open',
    target: '[data-tour="uc-mirror"]',
    title: 'tour.ucMirrorTitle',
    body: [
      'tour.ucMirrorBody1',
      'tour.ucMirrorBody2',
    ],
    callout: { tone: 'tip', text: 'tour.ucMirrorCallout' },
    enter: openUpdateCenter,
  },
  {
    id: 'settings-tour',
    route: '/settings',
    target: '[data-tour="settings-tour"]',
    title: 'tour.settingsTourTitle',
    body: [
      'tour.settingsTourBody1',
    ],
    enter: closeUpdateCenter,
  },
  {
    id: 'done',
    center: true,
    title: 'tour.doneTitle',
    body: [
      'tour.doneBody1',
      'tour.doneBody2',
      'tour.doneBody3',
    ],
  },
];

type Phase = 'idle' | 'welcome' | 'running';
type Rect = { top: number; left: number; width: number; height: number };

/* —— 侧边栏：默认收起，导览要按目标所在区域自动开合 —— */
const sidebarToggle = () => document.querySelector<HTMLElement>('[data-tour="nav-toggle"]');
const sidebarIsOpen = () => sidebarToggle()?.getAttribute('aria-expanded') === 'true';
/** 最近一次开合的时间戳：宽度过渡约 300ms，期间元素还在动，等高亮框定位稳定了再取 */
let sidebarTouchedAt = 0;
/** 展开侧边栏（导航项、版本号徽标都在侧栏里，收起时它们只是被裁掉、并非不存在） */
function openSidebar(): void {
  if (sidebarIsOpen()) return;
  sidebarToggle()?.click();
  sidebarTouchedAt = Date.now();
}
/** 桌面断点：与 console-shell / globals.css 的 768px 保持同一根线 */
const DESKTOP_QUERY = '(min-width: 768px)';
const isDesktopNow = () =>
  typeof window !== 'undefined' && window.matchMedia(DESKTOP_QUERY).matches;

/** 收起侧边栏：手机端侧栏是带遮罩的抽屉，展开会盖住内容区与顶栏 */
function closeSidebar(): void {
  if (typeof document === 'undefined') return;
  if (!sidebarIsOpen()) return;
  sidebarToggle()?.click();
  sidebarTouchedAt = Date.now();
}

/**
 * 导览开始时侧栏的原始状态。
 * 导览为了高亮导航项会去开合侧栏，那属于「导览自己借用的状态」，用完必须还回去。
 */
let sidebarOpenAtStart = false;

function rememberSidebarState(): void {
  sidebarOpenAtStart = sidebarIsOpen();
}

/**
 * 导览结束时还原侧栏。
 *
 * 以前这里无条件收起，于是电脑端用户本来展开着侧栏、点「跳过教程」后侧栏就被关掉；
 * 更糟的是 console-shell 会把开合状态写进 localStorage，重启也回不来——
 * 等于一次导览把用户的布局偏好改没了。
 *
 * 手机端例外：侧栏是覆盖式抽屉，留在展开态会盖住内容区，一律收起。
 */
function restoreSidebar(): void {
  if (isDesktopNow() && sidebarOpenAtStart) openSidebar();
  else closeSidebar();
}

/** 导览自己的浮层：命中测试必须排掉，否则整屏最上层都是它 */
const TOUR_ROOT = '.kk-tour-root';

/** 焦点兜底的命中计数：同一元素短时间被反复聚焦就不再硬顶（见组件内注释） */
const focusGuardHits = new WeakMap<HTMLElement, { at: number; n: number }>();

/** 视觉上真的看得见吗：排除被 overflow 裁掉、被 transform 移出屏幕、被上层盖住的元素 */
function isReallyVisible(el: HTMLElement, r: DOMRect): boolean {
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  if (cx < 1 || cy < 1 || cx > window.innerWidth - 1 || cy > window.innerHeight - 1) return false;
  for (const node of document.elementsFromPoint(cx, cy)) {
    if (!(node instanceof HTMLElement)) continue;
    if (node.closest(TOUR_ROOT)) continue;
    return el === node || el.contains(node) || node.contains(el);
  }
  return false;
}

function findVisibleTarget(selector: string): HTMLElement | null {
  const nodes = Array.from(document.querySelectorAll<HTMLElement>(selector));
  // 宽松判定（只看宽高与 visibility）留作兜底：宁可高亮一个位置不完美的元素，
  // 也不要把整步说明退化成居中浮层。有严格命中的时候优先用它。
  let loose: HTMLElement | null = null;
  for (const el of nodes) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    if (!loose) loose = el;
    // 侧栏收起时里面的元素依然有宽高（只是被裁掉 / 被移出屏幕），必须靠命中测试排除，
    // 否则「侧栏里一个、顶栏里一个」的同名锚点会选到看不见的那个。
    if (isReallyVisible(el, r)) return el;
  }
  return loose;
}

/**
 * 目标所在的最近一个可滚动祖先。
 *
 * 以前只认 `[data-kk-page-scroll]`（外壳那一层）。页面内部自己开了滚动区时
 * （AI 页的编辑表单就是），目标其实在里面那层里——却去滚外层，外层压根没溢出，
 * 于是「该滚的没滚」，高亮框直接框在用户看不见的位置上。
 * 从内往外找第一个真的能滚的，才对得上用户眼睛看到的那块区域。
 */
function findScrollParent(el: HTMLElement): HTMLElement | null {
  let node = el.parentElement;
  while (node && node !== document.body && node !== document.documentElement) {
    const cs = getComputedStyle(node);
    const canScroll = /(auto|scroll|overlay)/.test(cs.overflowY) || /(auto|scroll|overlay)/.test(cs.overflowX);
    if (canScroll && node.scrollHeight > node.clientHeight + 4) return node;
    node = node.parentElement;
  }
  /*
   * 兜底：设置页这类布局里，内容是从好几层「漫出去」的（页面根是 h-full，
   * 中间层被 flex-1 + min-h-0 封顶在视口高度），从内往外逐层问下来，
   * 每一层的 scrollHeight 都未必大于 clientHeight——只有最外面那一层真的能滚。
   * 没兜底时这里返回 null，导览就误判「不需要滚动」，高亮框留在屏幕外。
   */
  const shell = el.closest<HTMLElement>('[data-kk-page-scroll]');
  if (shell && shell.scrollHeight > shell.clientHeight + 4) return shell;
  return null;
}

/**
 * 把高亮框裁进视口。
 *
 * 目标是「一个比屏幕还高的容器」时（AI 模型编辑表单、整段日志区），
 * 直接按它的 rect 画框会画到屏幕外：上面看不见、下面也看不见，
 * 用户只看到一条贴边的边线。裁进视口后至少框住「这一屏里属于它的那部分」。
 */
function clampToViewport(r: Rect): Rect {
  const vw = typeof window === 'undefined' ? 1024 : window.innerWidth;
  const vh = typeof window === 'undefined' ? 768 : window.innerHeight;
  const EDGE = 8;
  const top = Math.max(r.top, EDGE);
  const left = Math.max(r.left, EDGE);
  const bottom = Math.min(r.top + r.height, vh - EDGE);
  const right = Math.min(r.left + r.width, vw - EDGE);
  return {
    top,
    left,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

/** 导航项被用户自己隐藏了：对应的导览步骤无从高亮，跳过（编号不变） */
const NAV_TOUR_HREF: Record<string, string> = {
  'nav-dashboard': '/',
  'nav-connections': '/connections',
  'nav-plugins': '/plugins',
  'nav-plugin-store': '/plugin-store',
  'nav-tools': '/tools',
  'nav-open-platform': '/open-platform',
  'nav-ai': '/ai',
  'nav-simulate': '/simulate',
  'nav-logs': '/logs',
  'nav-settings': '/settings',
};

function navEntryHidden(tourId: string): boolean {
  const href = NAV_TOUR_HREF[tourId];
  if (!href) return false;
  return getNavLayoutSnapshot().hidden.includes(href);
}

/** 从 from 起、沿 dir 方向找到第一个不被跳过的步骤下标；越界返回 -1 */
function resolveStep(from: number, dir: 1 | -1): number {
  let i = from;
  while (i >= 0 && i < STEPS.length) {
    if (!STEPS[i].skipIf?.()) return i;
    i += dir;
  }
  return -1;
}

/** **文字** → 高亮 */
function renderRich(text: string, keyBase: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map((part, i) => {
    if (/^\*\*[^*]+\*\*$/.test(part)) {
      return (
        <strong key={`${keyBase}-${i}`} className="font-semibold text-teal-700">
          {part.slice(2, -2)}
        </strong>
      );
    }
    return <span key={`${keyBase}-${i}`}>{part}</span>;
  });
}

const CARD_WIDTH_MAX = 372;
const MARGIN = 12;
const GAP = 14;

export function ProductTour() {
  const navigate = useNavigate();
  const location = useLocation();
  const t = useT();

  const [phase, setPhase] = useState<Phase>('idle');
  const [stepIndex, setStepIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  /** 卡片是否可见：高亮框移动到位后才淡入，避免一闪而过 */
  const [cardVisible, setCardVisible] = useState(false);
  const [vw, setVw] = useState(() => (typeof window === 'undefined' ? 1024 : window.innerWidth));

  const targetElRef = useRef<HTMLElement | null>(null);
  const rectRef = useRef<Rect | null>(null);
  /**
   * 最后一次「真的量到」的高亮框位置。
   * 高亮框靠 CSS 过渡从一个目标滑到下一个目标——前提是它**一直挂着**。
   * 以前只要某一步没找到目标就 setRect(null)，框直接卸载，下一步再挂上时
   * 没有起点可过渡，于是每次都是「闪现」到新位置而不是滑过去。
   * 现在框常驻挂载，找不到目标时停在原地淡出，重新找到目标时从那里滑过去。
   */
  const lastGoodRectRef = useRef<Rect | null>(null);
  if (rect) lastGoodRectRef.current = rect;
  /** 正在跟随平滑滚动：此时高亮框逐帧贴合、不走 CSS 过渡 */
  const trackingRef = useRef(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const [cardPos, setCardPos] = useState<{ top: number; left: number } | null>(null);

  rectRef.current = rect;

  /** 高亮框移动动画时长（与下方 CSS transition 保持一致） */
  const MOVE_MS = 340;

  const step = STEPS[stepIndex];
  const total = STEPS.length;
  /** 当前步骤的高度上限：remeasure 的监听只依赖 phase，靠 ref 读到最新值 */
  const maxHeightRef = useRef<number | undefined>(undefined);
  maxHeightRef.current = step?.maxHeight;

  /**
   * 量目标位置；设了 maxHeight 的步骤只从顶部往下框这么多，不跟着容器一起撑大。
   *
   * 但「撑大」有两种，不能一刀切：
   * - 容器被内容塞满（日志刷屏、列表很长）：它自己就是滚动容器，scrollHeight 明显
   *   大于 clientHeight。这时整块都是内容，就该框整块——按 maxHeight 砍成半屏，
   *   反而框不住用户正在看的那些行。
   * - 容器只是 flex-1 撑开、里面其实没多少内容：才是当初加 maxHeight 要对付的情况，
   *   按内容真实高度（scrollHeight）收一下，免得框住一大片空白。
   */
  const measureRect = useCallback((el: HTMLElement): Rect => {
    const r = el.getBoundingClientRect();
    const cap = maxHeightRef.current;
    let height = r.height;
    if (cap && r.height > cap) {
      const overflowing = el.scrollHeight > el.clientHeight + 4;
      height = overflowing ? r.height : Math.min(cap, Math.max(el.scrollHeight, cap / 3));
    }
    return clampToViewport({ top: r.top, left: r.left, width: r.width, height });
  }, []);

  /* —— 首次自动弹出（未看过时）—— */
  useEffect(() => {
    if (isProductTourSeen()) return;
    const t = window.setTimeout(() => {
      setPhase((p) => (p === 'idle' ? 'welcome' : p));
      // 记的时候机：欢迎页上直接点跳过也要能还原，不能在 beginTour 才记
      rememberSidebarState();
    }, 650);
    return () => window.clearTimeout(t);
  }, []);

  /* —— 手动触发（设置页）—— */
  useEffect(() => {
    const onStart = () => {
      rememberSidebarState();
      setStepIndex(0);
      setPhase('welcome');
    };
    window.addEventListener(PRODUCT_TOUR_EVENT, onStart);
    return () => window.removeEventListener(PRODUCT_TOUR_EVENT, onStart);
  }, []);

  const closeTour = useCallback(() => {
    closeConnDialog();
    closeSimConfig();
    // 还原到导览开始时的状态：导览期间为高亮导航项把它展开过，用完还回去
    restoreSidebar();
    setPhase('idle');
    setRect(null);
    setCardVisible(false);
    targetElRef.current = null;
    trackingRef.current = false;
    setCardPos(null);
  }, []);

  const finish = useCallback(
    (result: 'done' | 'skipped') => {
      markProductTourSeen(result);
      closeTour();
    },
    [closeTour],
  );

  const beginTour = useCallback(() => {
    setStepIndex(0);
    setPhase('running');
  }, []);

  const goNext = useCallback(() => {
    setStepIndex((i) => {
      const next = resolveStep(i + 1, 1);
      if (next < 0) {
        markProductTourSeen('done');
        closeConnDialog();
        closeSimConfig();
        restoreSidebar();
        setPhase('idle');
        setRect(null);
        setCardVisible(false);
        targetElRef.current = null;
        trackingRef.current = false;
        setCardPos(null);
        return i;
      }
      return next;
    });
  }, []);

  const goPrev = useCallback(() => {
    setStepIndex((i) => {
      const prev = resolveStep(i - 1, -1);
      return prev < 0 ? i : prev;
    });
  }, []);

  const hasNext = resolveStep(stepIndex + 1, 1) >= 0;
  const hasPrev = resolveStep(stepIndex - 1, -1) >= 0;

  /* —— 定位当前步骤目标（含自动跳转 + 平滑滚动跟随 + 轮询等待元素）—— */
  useEffect(() => {
    if (phase !== 'running' || !step) return;

    if (step.route && location.pathname !== step.route) {
      navigate(step.route);
      return;
    }

    // 进入副作用（如打开/关闭连接管理弹窗），需幂等
    step.enter?.();
    if (step.sidebar === 'open') openSidebar();
    else closeSidebar();

    let cancelled = false;
    const timers: number[] = [];
    let raf = 0;
    // 切换步骤：先把卡片淡出，等高亮框移动到位再淡入
    setCardVisible(false);

    const revealAfter = (ms: number) => {
      timers.push(window.setTimeout(() => {
        if (!cancelled) setCardVisible(true);
      }, ms));
    };

    const setRectFrom = (el: HTMLElement) => {
      const rect0 = measureRect(el);
      setRect(rect0);
      return el.getBoundingClientRect();
    };

    if (step.center || !step.target) {
      targetElRef.current = null;
      trackingRef.current = false;
      setRect(null);
      revealAfter(120);
      return () => {
        cancelled = true;
        timers.forEach((t) => window.clearTimeout(t));
      };
    }

    /*
     * 目标迟迟不出现（页面还在拉数据、顶栏在重排）时，别让用户对着空白干等：
     * 先按居中把说明卡片显示出来，等目标出现后高亮框再从这里滑过去。
     * 以前只有「定位成功」或「彻底放弃」两种时机才显示卡片，中间这段就是那 3 秒空白。
     */
    revealAfter(560);

    let tries = 0;
    const tick = () => {
      if (cancelled) return;
      // 每轮都重跑一次进入副作用：确保「打开弹窗/面板」的事件即使早于目标页监听注册也能生效（幂等）
      step.enter?.();
      if (step.sidebar === 'open') openSidebar();
      else closeSidebar();
      // 侧栏刚开合过：等宽度过渡收尾再定位，否则高亮框会贴在过渡中途的位置上
      if (Date.now() - sidebarTouchedAt < 340) {
        timers.push(window.setTimeout(tick, 16));
        return;
      }
      const el = findVisibleTarget(step.target as string);
      if (!el) {
        tries += 1;
        // 300 × 16ms ≈ 4.8s：商城这类要先拉完列表、顶栏才把操作按钮渲染出来的界面，
        // 原来的 1.9s 不够，正好卡在「按钮刚出现、导览已经放弃了」的缝里
        if (tries > 300) {
          // 找不到（数据未加载 / 该端无此入口 / 锚点被包装组件吞了）→ 居中浮层，仍展示说明
          // 打一条警告：这类问题在界面上只表现为「没高亮」，不看控制台根本查不出是哪一步
          console.warn(
            `[tour] 步骤「${step.id}」找不到可高亮的目标：${step.target}`
            + '（锚点是否真的渲染进了 DOM？包一层自定义组件却没透传 props 是最常见的坑）',
          );
          targetElRef.current = null;
          trackingRef.current = false;
          setRect(null);
          revealAfter(120);
          return;
        }
        timers.push(window.setTimeout(tick, 16));
        return;
      }

      targetElRef.current = el;
      const r0 = el.getBoundingClientRect();
      const hadRect = rectRef.current != null;
      // 只在目标所在的滚动容器内滚动（见 findScrollParent）。用 scrollIntoView 会向上冒泡去滚
      // 窗口/根滚动，把 background-attachment:fixed 的氛围底和固定背景层整体推走，
      // 停下后又缓慢弹回——这正是导览期间「背景上移再慢慢下降」的来源。
      const scroller = findScrollParent(el);
      const view = scroller?.getBoundingClientRect() ?? null;
      // 判定放宽到「视口」：目标可能已经伸出屏幕（比屏幕还高的容器更是必然），
      // 只要它有一截没露出来就先滚，别把高亮框钉在用户看不见的地方。
      const offTop = r0.top < (view ? view.top : 0) + 72;
      const offBottom = r0.bottom > (view ? view.bottom : window.innerHeight) - 72;
      /** 目标在滚动容器里真正露出来的高度 */
      const shown = view ? Math.min(r0.bottom, view.bottom) - Math.max(r0.top, view.top) : r0.height;
      // 光看上下越界还不够：目标是「贴着容器边缘只露一条」时上下判定都不过线，
      // 用户却只看到一条边。至少要露出 72px（目标本身没这么高就按它自己的高度算）。
      const tooLittle = shown < Math.min(r0.height, 72);
      const needScroll = !!scroller && !!view && (offTop || offBottom || tooLittle);

      if (needScroll && scroller && view) {
        // 平滑滚动，并逐帧让高亮框贴住目标，直到滚动停稳
        trackingRef.current = true;
        setRect(measureRect(el));

        const scrollOnce = () => {
          const r = el.getBoundingClientRect();
          const v = scroller.getBoundingClientRect();
          // 比容器还高的目标（AI 编辑表单、设置页的外观卡片这类）别去居中——居中等于把它的
          // 开头顶出屏幕，直接对齐到容器顶部更容易看懂「框的是从哪儿开始的一大块」
          const toTop = scroller.scrollTop + (r.top - v.top) - 72;
          const centered = scroller.scrollTop + (r.top - v.top) - (v.height / 2 - r.height / 2);
          const desired = r.height > v.height - 16 ? toTop : centered;
          const maxTop = scroller.scrollHeight - scroller.clientHeight;
          const next = Math.max(0, Math.min(maxTop, desired));
          /*
           * 跨屏滚动（设置页从顶部跳到「界面外观」就是）用平滑动画要跑一秒以上，
           * 比下面跟随循环的耐心（1.5s）还长：循环先判定「已经停稳」并定格，
           * 滚动却还在半路——高亮框钉在中途，看着就像「压根没滚」。
           * 距离超过一屏就直接跳到位，短距离才平滑。
           */
          const far = Math.abs(next - scroller.scrollTop) > v.height * 1.1;
          scroller.scrollTo({ top: next, behavior: far ? 'auto' : 'smooth' });
          return far;
        };

        let lastTop = Number.NaN;
        let stable = 0;
        let round = 0;
        let startAt = performance.now();
        const loop = () => {
          if (cancelled) return;
          const r = setRectFrom(el);
          const cur = Math.round(r.top);
          if (cur === lastTop) stable += 1;
          else { stable = 0; lastTop = cur; }
          if (stable >= 4 || performance.now() - startAt > 1500) {
            /*
             * 停稳后再验一次：目标真的露出来了吗？
             * 容器的可滚动高度有时会在滚动过程中变（图片/卡片加载完变高、
             * 吸顶工具栏改变布局），第一轮的落点就偏了。只补一轮，别陷入来回滚。
             */
            const v = scroller.getBoundingClientRect();
            const visible = Math.min(r.bottom, v.bottom) - Math.max(r.top, v.top);
            if (visible < Math.min(r.height, 72) && round < 1) {
              round += 1;
              lastTop = Number.NaN;
              stable = 0;
              startAt = performance.now();
              scrollOnce();
              raf = requestAnimationFrame(loop);
              return;
            }
            trackingRef.current = false;
            setRectFrom(el); // 恢复过渡后再定格一次
            revealAfter(70);
            return;
          }
          raf = requestAnimationFrame(loop);
        };
        scrollOnce();
        raf = requestAnimationFrame(loop);
      } else {
        // 无需滚动：靠 CSS 过渡把高亮框平移过去
        trackingRef.current = false;
        setRect(measureRect(el));
        revealAfter(hadRect ? MOVE_MS : 90);
      }
    };
    tick();

    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, [phase, stepIndex, step, location.pathname, navigate, measureRect]);

  /* —— 视口变化 / 滚动时重新测量高亮框 —— */
  useEffect(() => {
    if (phase !== 'running') return;
    const remeasure = () => {
      setVw(window.innerWidth);
      const el = targetElRef.current;
      if (el && document.contains(el)) setRect(measureRect(el));
    };
    window.addEventListener('resize', remeasure);
    window.addEventListener('scroll', remeasure, true);
    return () => {
      window.removeEventListener('resize', remeasure);
      window.removeEventListener('scroll', remeasure, true);
    };
  }, [phase, measureRect]);

  /* —— 导览期间：把「导览在跑」广播出去，弹窗据此收起自动聚焦 —— */
  useEffect(() => {
    setTourActive(phase !== 'idle');
  }, [phase]);
  // 组件卸载才收：换步骤时不要先关后开，中间那一瞬会被弹窗当成「导览已结束」
  useEffect(() => () => setTourActive(false), []);

  /*
   * 导览期间不让底层输入框拿到焦点。
   *
   * 导览为了演示会主动打开连接表单 / 模型表单这类弹窗，Radix 一开弹窗就把焦点
   * 塞给里面第一个可聚焦元素，恰好大多是输入框：电脑端只是多了个光标，
   * 手机端会直接顶起软键盘、把说明卡片挤到屏幕外——用户什么也看不成。
   *
   * 弹窗层面已经在 onOpenAutoFocus 里拦了一道（见 ui/dialog），这里是兜底：
   * 无论焦点从哪来（autoFocus、程序化 focus()、焦点陷阱回捞），一律还回去。
   */
  useEffect(() => {
    if (phase === 'idle') return;
    // 进入导览那一刻焦点可能已经落在输入框上（上一步刚开的弹窗），先还回去
    const cur = document.activeElement;
    if (cur instanceof HTMLElement && isEditableElement(cur) && !cur.closest(TOUR_ROOT)) cur.blur();

    const onFocusIn = (e: FocusEvent) => {
      const el = e.target instanceof HTMLElement ? e.target : null;
      if (!isEditableElement(el)) return;
      if (el?.closest(TOUR_ROOT)) return; // 导览自己的输入区（目前没有，留个口子）
      /*
       * 有些组件（Radix 的焦点陷阱、受控表单）会在 blur 后立刻把焦点塞回同一个
       * 输入框，硬顶下去就成了「聚焦—失焦」的死循环，界面一直在抖。
       * 同一元素短时间内被反复抓超过 3 次就放手，宁可让它弹一次键盘。
       */
      const now = Date.now();
      const rec = focusGuardHits.get(el as HTMLElement);
      if (rec && now - rec.at < 600) {
        rec.n += 1;
        rec.at = now;
        if (rec.n > 3) return;
      } else {
        focusGuardHits.set(el as HTMLElement, { at: now, n: 1 });
      }
      el?.blur();
    };
    document.addEventListener('focusin', onFocusIn, true);
    return () => document.removeEventListener('focusin', onFocusIn, true);
  }, [phase]);

  /* —— 键盘：Esc 跳过、← → / Enter 翻页 —— */
  useEffect(() => {
    if (phase !== 'running') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (suppressTourEscape) return;
        e.preventDefault();
        finish('skipped');
      } else if (e.key === 'ArrowRight' || e.key === 'Enter') {
        e.preventDefault();
        goNext();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        goPrev();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, finish, goNext, goPrev]);

  const cardWidth = Math.min(CARD_WIDTH_MAX, vw - MARGIN * 2);

  /* —— 计算说明卡片位置（相对高亮框，自动上/下/居中）—— */
  useLayoutEffect(() => {
    if (phase !== 'running') return;
    const card = cardRef.current;
    if (!card) return;
    const cw = card.offsetWidth || cardWidth;
    const ch = card.offsetHeight || 220;
    const winW = window.innerWidth;
    const winH = window.innerHeight;

    if (!rect) {
      setCardPos({ left: (winW - cw) / 2, top: Math.max(MARGIN, (winH - ch) / 2) });
      return;
    }

    const pad = step?.padding ?? 8;
    const boxTop = rect.top - pad;
    const boxBottom = rect.top + rect.height + pad;

    let top: number;
    if (boxBottom + GAP + ch <= winH - MARGIN) {
      top = boxBottom + GAP;
    } else if (boxTop - GAP - ch >= MARGIN) {
      top = boxTop - GAP - ch;
    } else {
      top = rect.top > winH / 2 ? MARGIN : winH - ch - MARGIN;
    }
    top = Math.max(MARGIN, Math.min(top, winH - ch - MARGIN));

    const centerX = rect.left + rect.width / 2 - cw / 2;
    const left = Math.max(MARGIN, Math.min(winW - cw - MARGIN, centerX));
    setCardPos({ top, left });
  }, [phase, rect, stepIndex, step, cardWidth]);

  if (phase === 'idle') return null;

  /* —— 欢迎弹窗（强制，两个按钮）—— */
  if (phase === 'welcome') {
    return createPortal(
      <div className="kk-tour-root fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm" style={{ pointerEvents: 'auto' }}>
        {/* 阴影改读 --glass-shadow-hover：原来写死的 0_20px_60px 是 utilities 层，
            直接盖掉 kk-glass-2 的玻璃阴影，「阴影透明度」滑块对导览弹窗完全无效 */}
        <div className="kk-pop kk-glass-2 w-full max-w-sm overflow-hidden rounded-[1.35rem] p-6 shadow-[var(--glass2-shadow)]">
          <div className="flex flex-col items-center text-center">
            <span className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-teal-500/15 text-teal-600">
              <Compass className="h-7 w-7" />
            </span>
            <h2 className="text-xl font-bold tracking-tight text-slate-800">{t('tour.welcomeTitle')}</h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-600">
              {t('tour.welcomeP1')}
              <span className="font-semibold text-teal-700">{t('tour.welcomeTour')}</span>
              {t('tour.welcomeP2')}
              <span className="font-semibold text-teal-700">{t('tour.welcomeOrder')}</span>
              {t('tour.welcomeP3')}
            </p>
          </div>
          <div className="mt-6 flex gap-3">
            {/* kk-field：outline 变体的 bg-white/35 + border-white/55 + backdrop-blur-md
                全是写死值，导览按钮因此既不受外观控制、也没有阴影 */}
            <Button
              variant="outline"
              className="kk-field flex-1 text-slate-600 hover:text-slate-800"
              onClick={() => finish('skipped')}
            >
              {t('tour.skipBtn')}
            </Button>
            <Button className="flex-1" onClick={beginTour}>
              {t('tour.startBtn')}
            </Button>
          </div>
        </div>
      </div>,
      getPortalRoot(),
    );
  }

  /* —— 运行中：遮罩 + 高亮 + 说明卡片 —— */
  const pad = step?.padding ?? 8;
  /** 高亮框实际画在哪：有目标就用目标，没目标就停在最后一次的位置淡出 */
  const boxRect = rect ?? lastGoodRectRef.current;
  const progress = Math.round(((stepIndex + 1) / total) * 100);

  return createPortal(
    <div
      className="kk-tour-root fixed inset-0 z-[80]"
      style={{ pointerEvents: 'auto' }}
      aria-live="polite"
      // 阻止指针事件冒泡到 document：否则 Radix 弹窗会把「点击导览按钮」当成点击窗外而自动关闭
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* 捕获层：屏蔽底层交互，导览只能用卡片按钮推进 */}
      <div
        className="absolute inset-0"
        style={{ background: rect ? 'transparent' : 'rgba(15,23,42,0.55)' }}
        onClick={(e) => e.stopPropagation()}
      />

      {/*
        高亮聚光框：**常驻挂载**（用最后一次量到的位置兜底）。
        以前是 `{rect ? ... : null}`——某一步没找到目标就卸载，下一步重新挂载时没有起点，
        CSS 过渡无从生效，看着就是「闪现」到新位置。现在停在原地淡出，下次从那里滑过去。
      */}
      {boxRect ? (
        <div
          aria-hidden
          className="pointer-events-none absolute"
          style={{
            top: boxRect.top - pad,
            left: boxRect.left - pad,
            width: boxRect.width + pad * 2,
            height: boxRect.height + pad * 2,
            borderRadius: 16,
            opacity: rect ? 1 : 0,
            // 没有目标时不铺那圈 9999px 的暗场，交给上面的捕获层
            boxShadow: rect
              ? '0 0 0 2px rgb(var(--kk-comp-rgb) / 0.95), 0 0 22px 6px rgb(var(--kk-comp-rgb) / 0.35), 0 0 0 9999px rgba(15,23,42,0.55)'
              : 'none',
            transition: trackingRef.current
              ? 'none'
              : 'top .34s cubic-bezier(0.22,1,0.36,1), left .34s cubic-bezier(0.22,1,0.36,1), width .34s cubic-bezier(0.22,1,0.36,1), height .34s cubic-bezier(0.22,1,0.36,1), opacity .2s ease',
          }}
        />
      ) : null}

      {/* 说明卡片：常驻挂载，高亮框移动到位后淡入 */}
      {phase === 'running' ? (
        <div
          ref={cardRef}
          className="kk-glass-2 absolute flex flex-col overflow-y-auto no-scrollbar rounded-[1.25rem] p-4 shadow-[var(--glass2-shadow)] sm:p-5"
          /*
           * 按住卡片时不让焦点跟着走：焦点一变，开着弹窗的那一步里 Radix 的焦点陷阱
           * 就会把焦点往弹窗里捞（第一个往往正是输入框），手机端随即顶起软键盘。
           * 只取消默认行为、不阻止事件，按钮的 click 照常触发、键盘导航也照常生效。
           */
          onMouseDown={(e) => e.preventDefault()}
          style={{
            width: cardWidth,
            maxHeight: 'calc(100dvh - 24px)',
            top: cardPos?.top ?? -9999,
            left: cardPos?.left ?? -9999,
            opacity: cardVisible && cardPos ? 1 : 0,
            transform: cardVisible && cardPos ? 'translateY(0)' : 'translateY(6px)',
            pointerEvents: cardVisible && cardPos ? 'auto' : 'none',
            transition:
              'opacity .22s ease, transform .22s cubic-bezier(0.22,1,0.36,1)',
          }}
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-teal-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-teal-700">
              {t('tour.stepLabel', { n: stepIndex + 1, total })}
            </span>
            <button
              type="button"
              onClick={() => finish('skipped')}
              className="inline-flex h-7 w-7 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-rose-500/10 hover:text-rose-600"
              aria-label={t('tour.closeTourAria')}
              title={t('tour.skipBtn')}
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <h3 className="text-base font-bold tracking-tight text-slate-800">{step ? t(step.title) : ''}</h3>
          <div className="mt-1.5 space-y-1.5">
            {step?.body.map((line, i) => (
              <p key={i} className="text-[13px] leading-relaxed text-slate-600">
                {renderRich(t(line), `l${i}`)}
              </p>
            ))}
          </div>

          {step?.callout ? (
            <div
              className={cn(
                'mt-3 flex items-start gap-2 rounded-xl px-3 py-2 text-[12.5px] leading-relaxed ring-1',
                step.callout.tone === 'warn'
                  ? 'bg-amber-400/15 text-amber-800 ring-amber-400/30'
                  : 'bg-teal-500/15 text-teal-800 ring-teal-500/25',
              )}
            >
              {step.callout.tone === 'warn' ? (
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              ) : (
                <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-teal-600" />
              )}
              <span>{renderRich(t(step.callout.text), 'co')}</span>
            </div>
          ) : null}

          {/* 进度条 */}
          <div className="mt-3.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-300/40">
            <div
              className="h-full rounded-full bg-teal-500 transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>

          <div className="mt-3.5 flex items-center justify-between gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => finish('skipped')}
              className="kk-field text-slate-500 hover:text-rose-600"
            >
              {t('tour.skipBtn')}
            </Button>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" className="kk-field" onClick={goPrev} disabled={!hasPrev}>
                <ArrowLeft className="h-3.5 w-3.5" />
                {t('tour.prevBtn')}
              </Button>
              <Button size="sm" onClick={goNext}>
                {hasNext ? (
                  <>
                    {t('tour.nextBtn')}
                    <ArrowRight className="h-3.5 w-3.5" />
                  </>
                ) : (
                  <>
                    {t('tour.doneBtn')}
                    <Check className="h-3.5 w-3.5" />
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>,
    getPortalRoot(),
  );
}
