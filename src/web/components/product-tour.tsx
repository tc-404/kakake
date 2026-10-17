import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
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
import { cn } from '@/lib/utils';

/* ------------------------------------------------------------------ *
 *  产品导览（Product Tour）
 *  - 首次设置密码后进入控制台强制弹出（刷新不消失，直到「跳过」或「完成」）
 *  - 逐步高亮目标、说明内容并显示进度，允许自动跳转页面
 *  - 同一套步骤兼容手机端与电脑端 UI（按 data-tour 选中当前可见的元素）
 * ------------------------------------------------------------------ */

/**
 * 看过标记。
 * 内容有较大更新（补了资源商城逐个按钮、开放平台、智能助手，重排了场景切换顺序）时
 * 往上推一版，好让看过旧版的人也能看到新的。
 */
const TOUR_KEY = 'kk-product-tour-v3';
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

/* —— 配色方案：拾色盘弹窗 —— */
/** 拾色盘弹窗是否已打开（以色相竖条为标志） */
const colorDialogOpen = () => !!document.querySelector('[data-tour="color-hue"]');
/** 打开「组件及按钮」配色的拾色盘弹窗 */
function openColorDialog(): void {
  if (colorDialogOpen()) return;
  document.querySelector<HTMLElement>('[data-tour="color-swatch"]')?.click();
}
/** 关闭拾色盘弹窗（点它的取消） */
function closeColorDialog(): void {
  if (!colorDialogOpen()) return;
  document.querySelector<HTMLElement>('[data-tour="color-cancel"]')?.click();
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

/** 按文字找元素并点击（DropdownMenuItem 这类靠文字识别的项用得上） */
function clickByText(selector: string, text: string): boolean {
  const want = text.trim();
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
    if ((el.textContent || '').trim() === want) {
      el.click();
      return true;
    }
  }
  return false;
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
/** 在展开的分类菜单里选一档（幂等：已经选上了就不动） */
function pickStoreCategory(label: string): void {
  const btn = document.querySelector<HTMLElement>('[data-tour="store-category"]');
  if (btn && (btn.textContent || '').trim() === label) return;
  if (!storeCategoryMenuOpen()) {
    openStoreCategoryMenu();
    return;
  }
  if (clickByText('[data-tour="store-category-item"]', label)) closeStoreCategoryMenu();
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
  const label = (btn.textContent || '').trim();
  // 按钮上没文字 = 当前就是全部；此时只需确保菜单是关着的
  if (!label) {
    if (storeCategoryMenuOpen()) closeStoreCategoryMenu();
    return;
  }
  if (!storeCategoryMenuOpen()) {
    btn.click();
    return;
  }
  clickByText('[data-tour="store-category-item"]', label);
}

/* —— 资源商城：资源详情弹窗 —— */
const storeDetailOpen = () => !!document.querySelector('[data-tour="store-detail-install"]');
/** 打开第一张资源卡片的详情 */
function openStoreDetail(): void {
  if (storeDetailOpen()) return;
  document.querySelector<HTMLElement>('[data-tour="store-card"]')?.click();
}
/** 关闭资源详情（点底部的「关闭」） */
function closeStoreDetail(): void {
  if (!storeDetailOpen()) return;
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-tour="store-detail"] button'))) {
    if ((el.textContent || '').trim() === '关闭') {
      el.click();
      return;
    }
  }
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
    title: '概览页',
    body: [
      '这里是控制台首页，进来先看它。',
      '这排就是**主导航**，所有功能都从这里进：概览、连接、插件、资源、工具、开放平台、智能助手、模拟、日志、设置。',
      '它装在**侧边栏**里，而侧边栏默认是收起的——用顶栏最左边的按钮就能呼出来。',
    ],
  },
  {
    id: 'nav-toggle',
    route: '/',
    target: '[data-tour="nav-toggle"]',
    sidebar: 'open',
    title: '顶栏最左 · 开关侧边栏',
    body: [
      '顶栏最左边这个按钮就是**侧边栏开关**，点一下展开、再点一下收起。',
      '**电脑**点这个按钮开合；**手机**上点侧边栏以外的空白处即可收起。',
      '侧边栏默认收起，而且切换界面时不会自动关掉——它会保持你上一次的选择。',
    ],
    callout: { tone: 'tip', text: '宽窄可以在「设置 → 界面外观 → 侧边栏宽度」里分别调电脑和手机两种。' },
  },
  {
    id: 'dashboard-stats',
    route: '/',
    target: '[data-tour="dashboard-stats"]',
    title: '运行状态一览',
    body: [
      '概览顶部这一排是**四个关键数字**，一眼看出机器人是否在正常工作。',
      '接下来我一个一个带你看它们分别代表什么。',
    ],
    callout: { tone: 'tip', text: '下方还会列出每个连接的实时状态，红色失败的可直接点卡片里的「重试」。' },
  },
  {
    id: 'dash-stat-listen',
    route: '/',
    target: '[data-tour="dash-stat-listen"]',
    title: '① 监听配置',
    body: [
      '**监听配置**：你一共添加了多少个连接（不管有没有连上、有没有启用）。',
      '也就是「连接」页里的卡片总数。',
    ],
  },
  {
    id: 'dash-stat-connected',
    route: '/',
    target: '[data-tour="dash-stat-connected"]',
    title: '② 已连入',
    body: [
      '**已连入**：真正连上线的连接数。',
      '这个数 **> 0** 才说明机器人确实连通了；一直是 0 就要回连接页检查启用状态和客户端配置。',
    ],
  },
  {
    id: 'dash-stat-plugins',
    route: '/',
    target: '[data-tour="dash-stat-plugins"]',
    title: '③ 插件总数',
    body: [
      '**插件总数**：本地已安装的插件数量（不代表都在运行）。',
      '对应「插件」页里的卡片总数。',
    ],
  },
  {
    id: 'dash-stat-loaded',
    route: '/',
    target: '[data-tour="dash-stat-loaded"]',
    title: '④ 已加载',
    body: [
      '**已加载**：此刻真正在跑的插件数。',
      '这个数 **> 0** 才说明插件真的在工作；装了插件但这里是 0，多半是「两道开关」没都打开（后面插件页会细讲）。',
    ],
  },
  {
    id: 'nav-connections',
    route: '/',
    target: '[data-tour="nav-connections"]',
    sidebar: 'open',
    title: '第一步 · 连接',
    body: [
      '机器人要先「连上」才能收发消息，一切从 **连接** 页开始。',
      '点这里进入连接管理。',
    ],
  },
  {
    id: 'connections-add',
    route: '/connections',
    target: '[data-tour="connections-add"]',
    title: '添加连接',
    body: [
      '**顶栏右侧**这个 **＋** 就是「添加连接」。',
      '不管你现在有没有连接，我都直接帮你点开它，带你把整个添加流程和每一项要填什么走一遍。',
    ],
    callout: { tone: 'warn', text: '新添加的连接默认是「关闭」的，需要你手动启用后才会工作。' },
    enter: () => {
      closeConnAdd();
      closeConnDialog();
    },
  },
  {
    id: 'conn-type-modal',
    route: '/connections',
    target: '[data-tour="conn-type-list"]',
    title: '第 1 步 · 选择接入方式',
    body: [
      '点「添加」后先弹出这个「选择连接类型」列表，按你的机器人平台挑一个：',
      '**反向 WS**（NapCat 等 OneBot 最常用）、**正向 WS / HTTP / HTTP-SSE / HTTP 客户端**、**QQ 官方**（WS / HTTPS）、**KOOK**、**微信 AI×BOT**。',
    ],
    callout: { tone: 'tip', text: '拿不准就选「反向 WS」，它配 NapCat 最省心；下面我就以它为例往下走。' },
    enter: openConnTypeModal,
  },
  {
    id: 'conn-form',
    route: '/connections',
    target: '[data-tour="conn-form"]',
    title: '第 2 步 · 填写连接（以反向 WS 为例）',
    body: [
      '选「反向 WS」后就进到这个填写表单。',
      '整张表单就这几栏，接下来我一栏一栏讲清楚每一项填什么。',
    ],
    enter: openConnForm,
  },
  {
    id: 'conn-form-name',
    route: '/connections',
    target: '[data-tour="conn-form-name"]',
    title: '连接项 · 名称',
    body: [
      '**名称**：给这个连接起个好认的名字，随便填，只是列表里显示用，不影响连接。',
      '例如「主号 NapCat」「测试号」。',
    ],
    enter: openConnForm,
  },
  {
    id: 'conn-form-host',
    route: '/connections',
    target: '[data-tour="conn-form-host"]',
    title: '连接项 · 监听地址',
    body: [
      '**监听地址**：咔咔珂在哪个网卡上等 NapCat 连进来。',
      '一般填 **0.0.0.0**（所有网卡都可连，别的设备 / 容器也能接入）；只想本机连就填 127.0.0.1。',
    ],
    enter: openConnForm,
  },
  {
    id: 'conn-form-port',
    route: '/connections',
    target: '[data-tour="conn-form-port"]',
    title: '连接项 · 监听端口',
    body: [
      '**监听端口**：等待连接的端口号，如 **6700**。',
      '记住这个端口——等下要在 NapCat 里把 WebSocket 客户端指向 `ws://本机IP:这个端口`。',
    ],
    callout: { tone: 'warn', text: '端口别和后台端口(默认8787)或其他程序冲突；两个连接也不能用同一端口。' },
    enter: openConnForm,
  },
  {
    id: 'conn-form-token',
    route: '/connections',
    target: '[data-tour="conn-form-token"]',
    title: '连接项 · Access Token（可选）',
    body: [
      '**Access Token**：连接口令，可**留空**。',
      '若填了，NapCat 那边要填**一模一样**的 Token 才能连上，相当于加把锁防止别人乱连。',
    ],
    enter: openConnForm,
  },
  {
    id: 'conn-form-submit',
    route: '/connections',
    target: '[data-tour="conn-form-submit"]',
    title: '第 3 步 · 点「添加」',
    body: [
      '填好后点 **添加**，连接就会出现在列表里——但**默认是关闭的**，记得点开它再启用。',
      '然后到 NapCat 等客户端把 **WebSocket 客户端** 指向 `ws://本机IP:端口`，Token 与这里一致，即可连上。',
    ],
    callout: { tone: 'tip', text: 'QQ 官方 / KOOK 填的是 AppID+AppSecret / 机器人 Token；微信则是添加后扫码登录——套路一样，按表单提示填即可。' },
    enter: openConnForm,
  },
  {
    // 有连接时：讲点开卡片能干嘛
    id: 'connections-card',
    route: '/connections',
    target: '.kk-conn-card',
    title: '点开连接卡片',
    body: [
      '刚才是「怎么新建」，现在看「已有的连接怎么管」。',
      '每张卡片就是一个连接。**点一下它**会弹出「管理」窗。下一步我直接帮你打开。',
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
    title: '管理窗 · 启用开关',
    body: [
      '管理窗打开了。最上面这一行就是这个连接的 **启用 / 关闭** 开关。',
      '往下还能**编辑**名称、地址、端口、Token，以及**复制**监听地址、设置**重连策略**、**删除**连接。',
    ],
    enter: openConnDialog,
    skipIf: () => !hasConnCards(),
  },
  {
    id: 'conn-dialog-plugins',
    route: '/connections',
    target: '[data-tour="conn-dialog-plugins"]',
    title: '管理窗 · 插件（第二道开关）',
    body: [
      '这个 **「插件」** 按钮最关键：点开它，会列出所有插件，你在这里为**当前这个账号**勾选要启用哪些插件。',
      '这就是前面说的第二道开关——插件在「插件」页开了总开关后，**还要在这里勾选**，才会真正在这个连接上加载。',
    ],
    callout: { tone: 'warn', text: '记住：插件页总开关（全局）+ 这里的账号勾选（局部），两处都开才生效。' },
    enter: openConnDialog,
    skipIf: () => !hasConnCards(),
  },
  {
    id: 'connections-export',
    route: '/connections',
    target: '[data-tour="connections-export"]',
    title: '顶栏 · 导出连接配置',
    body: [
      '顶栏这个**分享图标**就是**导出**：把整套连接配置——连同每条连接开了哪些插件——存成一份 json 下载下来。',
      '换机器、重装、或者想给别人一套同样的配置时，先点它留一份备份。',
    ],
    callout: { tone: 'tip', text: '导出的 json 里密钥是完整保留的（用它才能原样恢复），别随手发给别人。' },
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
    title: '顶栏 · 导入连接配置',
    body: [
      '旁边这个**文件图标**才是**导入**（和导出是两个按钮，别点错）。选一份之前导出的 json 即可导回来。',
      '**导入既是叠加也是覆盖**：认得出来的那条就覆盖，认不出来的就当新的加进来，不会动到其它连接。',
      '**OneBot 认四个要素：账号 + 地址 + 端口 + 密钥**，四个都一样才算同一条；只同账号但换了端口，那是另一个接入点，会作为新连接加进来。官方 / KOOK / 微信则按账号认。',
      '除了点按钮，**直接把 json 文件拖进界面**也能导入（界面上任意位置都接得住），只认 .json，语法不对会直接判失败。',
    ],
    callout: { tone: 'tip', text: '插件开关是合并的：文件里写了的以它为准，没写到的保持原样——不会因为导入把原本开着的插件关掉。' },
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
    title: '第二步 · 插件',
    body: [
      '**插件** 页是全局插件库：安装、卸载、查看说明都在这里。',
      '点进去看看。',
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
    title: '插件的两道开关（最容易绕晕）',
    body: [
      '① 在这个「插件」页，把插件卡片右上角的 **总开关** 打开——这是全局层面的启用。',
      '② 再回到 **连接** 页 → 点开对应连接 → 进 **插件管理** → 为这个机器人账号**也勾选启用**这个插件。',
    ],
    callout: { tone: 'warn', text: '两处都开，插件才真正在该账号上加载运行；只开一处 = 不生效！这也是新手最常见的坑。' },
  },
  {
    id: 'plugins-filter',
    route: '/plugins',
    target: '[data-tour="plugins-filter"]',
    title: '筛选与搜索插件',
    body: [
      '这排标签按来源过滤：**全部 / 三方（OneBot）/ 官方 / 双生 / 微信 / KOOK**。',
      '**双生**是目录名 `sssx-plugin-` 开头那一类：一份代码同时挂在 OneBot 和 QQ 官方两条协议上，两边都要各开一次开关。',
      '上面的搜索框可以按 **插件名或 ID** 快速查找。装了很多插件时很好用。',
    ],
  },
  {
    id: 'plugins-toolbar',
    route: '/plugins',
    target: '[data-tour="plugins-toolbar"]',
    title: '插件页 · 搜索框与顶栏操作',
    body: [
      '这里是插件页的**搜索框**，按名称 / 作者过滤插件。',
      '「上传 zip」「刷新」这两个按钮已经移到**顶栏右侧**了——顶栏会跟着当前界面显示它对应的操作按钮。',
      '下面把这两个按钮分开一个一个讲。',
    ],
  },
  {
    id: 'plugins-upload',
    route: '/plugins',
    target: '[data-tour="plugins-upload"]',
    title: '工具栏 · 上传 zip',
    body: [
      '**上传 zip**：安装本地插件压缩包。点它选文件，或直接把压缩包**拖进页面**——会先弹出队列让你确认后再上传。',
      '支持 zip / tar / gz / rar / 7z 等常见格式。',
    ],
  },
  {
    id: 'plugins-refresh',
    route: '/plugins',
    target: '[data-tour="plugins-refresh"]',
    title: '工具栏 · 刷新',
    body: [
      '**刷新**：重新扫描本地插件目录。',
      '装完 / 删完插件后列表若没立刻变化，点一下它多半就同步过来了。',
    ],
  },
  {
    id: 'plugins-card',
    route: '/plugins',
    target: '.kk-plugin-card',
    title: '插件卡片总览',
    body: [
      '每张卡片就是一个已安装的插件：左上角**图标 / 名称 / 版本号**，右上角**状态徽标 + 总开关**，底部还有一排操作按钮。',
      '下一步先带你看最关键的「总开关」。',
    ],
    skipIf: () => !hasPluginCards(),
  },
  {
    id: 'plugin-master-switch',
    route: '/plugins',
    target: '[data-tour="plugin-master-switch"]',
    title: '卡片 · 总开关（第一道开关）',
    body: [
      '卡片右上角这个开关是插件的 **全局总开关**。',
      '打开它只是「全局层面允许」——还得回连接页为具体账号勾选启用（第二道开关），插件才会真的加载运行。',
    ],
    callout: { tone: 'warn', text: '旁边的状态徽标：运行中 / 停止 / 错误；报错时卡片上会显示红色错误原因。' },
    skipIf: () => !hasPluginCards(),
  },
  {
    id: 'plugins-card-actions',
    route: '/plugins',
    target: '.kk-plugin-card',
    title: '卡片 · 底部操作按钮',
    body: [
      '卡片底部一排按钮：**说明**（查看插件文档，有文档才显示）、**打开控制台**（插件自带的管理页，需先加载成功才有）、**删除**（移除安装目录，可选是否一并清数据）。',
      '左下角还有**类型 / 作者**标签，方便一眼分辨插件来源。',
    ],
    skipIf: () => !hasPluginCards(),
  },
  {
    id: 'nav-plugin-store',
    route: '/plugins',
    target: '[data-tour="nav-plugin-store"]',
    sidebar: 'open',
    title: '资源商店',
    body: [
      '不想自己找插件？**资源** 页是在线插件商店。',
      '可以**浏览**在线资源、看**简介与文档**、**一键安装**到本地——装完同样要按上一步的「两道开关」启用。',
    ],
  },
  {
    id: 'store-toolbar',
    route: '/plugin-store',
    target: '[data-tour="store-toolbar"]',
    title: '资源 · 先看这一条搜索栏',
    body: [
      '进到资源页，顶栏下面这条就是**搜索栏**，只用来找东西。',
      '资源页的操作按钮全部在**顶栏右侧**（来源 / 分类 / 排序 / 刷新），下面我带你一个一个看过去。',
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
    title: '顶栏下方 · 搜索框',
    body: [
      '**搜索框**按**标题 / 作者 / 标签**匹配，边打边过滤，不用回车。',
      '记得住插件名的时候它最快；记不住就用下面的分类筛选慢慢挑。',
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
    title: '顶栏 ① 打开当前资源来源',
    body: [
      '最左边这个**外链图标**是「打开当前资源来源」：在新标签页打开你现在用的这个源站。',
      '当前是**咔咔珂官方源**还是 **GitHub 社区源**，由「设置 → 资源来源」决定（后面设置页会讲）。',
      '想看看源站上还有没有别的东西、或者去仓库看源码，点它最省事。',
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
    title: '顶栏 ② 分类筛选（按钮本身）',
    body: [
      '第二个是**分类筛选**。**还没选**的时候它显示一个**标签图标**；选定某一档之后，图标会直接变成那两个字的名字。',
      '也就是说：看按钮上是图标还是文字，就知道现在有没有在筛选。',
      '下一步我直接帮你把它点开，看看里面能选什么。',
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
    title: '分类筛选 · 展开后的五档',
    body: [
      '这就是点开后的分类列表，一共五档：',
      '**野鸡**（第三方 / 野生插件）、**官方**（咔咔珂官方出品）、**双生**（`sssx-plugin-` 开头，一份代码同时跑 OneBot 与 QQ 官方两条协议）、**微信**、**其他**（KOOK 等）。',
      '选中哪一项，前面的**对勾**就落在哪一项上；**再点一次已选中的那项就是取消**，回到全部。',
      '下面我直接帮你选「官方」这一档，看看列表会变成什么样。',
    ],
    callout: { tone: 'tip', text: '分类是「一次性」的：刷新网页或切走界面就自动清空；但停在本页安装 / 更新 / 刷新资源都不会丢。' },
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
    title: '分类筛选 · 选好之后',
    body: [
      '看这里——按钮上的图标已经变成了**「官方」两个字**，一眼就知道现在筛的是哪一档。',
      '下面这个就是**筛选后的列表**：只剩这一类的资源了。想换一档就再点按钮重选；想看全部，再点一次当前这项即可取消。',
      '万一这一类暂时没有资源，列表位置会显示「该分类下暂无资源」——不是坏了，是这一类真的空着。',
    ],
    enter: () => {
      closeStoreDetail();
      pickStoreCategory('官方');
    },
  },
  {
    id: 'store-grid',
    route: '/plugin-store',
    target: '[data-tour="store-grid"]',
    title: '资源列表 · 一页 16 个',
    body: [
      '这一片就是资源列表，每页最多 **16 个**。',
      '顺便说下刚才那个筛选：想恢复全部，点一下已经选中的分类即可取消（下面为了把完整列表讲清楚，我已经帮你取消筛选了）。',
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
    title: '资源卡片 · 每张讲了什么',
    body: [
      '每张卡片从上到下：**版本号**（右上角）、**头像 + 标题 + 作者**（作者名后面那个小色块是**类型角标**，五档各一种颜色）、**简介**（最多两行）、**下载次数 + 标签**。**点卡片任意位置**看详情。',
      '列表一次最多 **16 个**，超出就翻页——下面会讲。',
    ],
    skipIf: () => !hasStoreCards(),
  },
  {
    id: 'store-install',
    route: '/plugin-store',
    target: '[data-tour="store-install"]',
    title: '资源卡片 · 一键安装',
    body: [
      '卡片底部这个按钮就是**安装 / 更新**：没装过显示「安装」，装过但源上有新版就变成「更新」，已是最新则显示灰色的「已安装」。',
      '装的时候会有进度气泡，装完直接进插件页——但**还没生效**：仍要回「插件」页开总开关、再到连接里勾选，也就是前面讲的两道开关。',
      '灰色不可点的按钮说明这个资源**不允许下载**（鼠标悬停会给出原因）。',
    ],
    callout: { tone: 'warn', text: 'GitHub 源的资源安装前会先弹一份风险声明（第三方投稿，自行甄别），确认后才会开始下载。' },
    skipIf: () => !hasStoreCards(),
  },
  {
    id: 'store-detail',
    route: '/plugin-store',
    target: '[data-tour="store-detail-head"]',
    title: '详情弹窗 · 头部',
    body: [
      '点卡片就进到这个**详情弹窗**。最上面是**头像 + 标题 + 作者 / 版本 / 上传人**；GitHub 源的头像是可点的，直接跳到作者主页。',
      '右上角 × 关闭。下面我把弹窗里每一块讲一遍。',
    ],
    enter: openStoreDetail,
    skipIf: () => !hasStoreCards(),
  },
  {
    id: 'store-detail-intro',
    route: '/plugin-store',
    target: '[data-tour="store-detail-intro"]',
    title: '详情 · 简介与版本标签',
    body: [
      '**简介**是作者写的完整介绍（列表卡片上只有两行，这里能看全）。',
      '紧跟着是**版本号 + 标签**，用来确认这个资源做什么、适配哪些场景。',
    ],
    enter: openStoreDetail,
    skipIf: () => !hasStoreCards(),
  },
  {
    id: 'store-detail-info',
    route: '/plugin-store',
    target: '[data-tour="store-detail"]',
    title: '详情 · 插件信息与文档',
    body: [
      '再往下是**插件信息**：当前装的是哪个版本、有没有可更新、**最低版本要求**（你的咔咔珂版本不够会标红提醒）、GitHub 源还有**仓库星数**。',
      '有文档的会接一段**文档**（GitHub 源直接渲染仓库 README）；咔咔珂源的卡片下面则是**评论**区，可以看看别人用了怎么说（只能看，不能发）。',
    ],
    callout: { tone: 'warn', text: '「当前版本偏低」时先去更新咔咔珂再装，否则插件可能跑不起来。' },
    enter: openStoreDetail,
    skipIf: () => !hasStoreCards(),
  },
  {
    id: 'store-detail-install',
    route: '/plugin-store',
    target: '[data-tour="store-detail-install"]',
    title: '详情 · 在这里安装',
    body: [
      '弹窗底部同样有**安装 / 更新**按钮，和卡片上那个是同一件事——看清楚简介、版本要求、文档之后再决定装不装，比较稳。',
      '左边「关闭」可以退出弹窗。',
    ],
    enter: openStoreDetail,
    skipIf: () => !hasStoreCards(),
  },
  {
    id: 'store-pagination',
    route: '/plugin-store',
    target: '[data-tour="store-pagination"]',
    title: '列表底部 · 翻页',
    body: [
      '资源多于一页时，底部会出现这条**翻页条**：左右箭头翻前后页，中间直接点页码。',
      '页数超过 5 页时还会多出**跳页输入框 + Go**，输入页码回车即可直达。',
    ],
    callout: { tone: 'tip', text: '翻页只影响「看」，不影响已经装好的插件。' },
    skipIf: () => !document.querySelector('[data-tour="store-pagination"]'),
    enter: closeStoreDetail,
  },
  {
    id: 'store-sort',
    route: '/plugin-store',
    target: '[data-tour="store-sort"]',
    title: '顶栏 ③ 排序方式',
    body: [
      '第三个是**排序**。它点开之后有哪些选项，**会跟着你用的资源来源变**：',
      '**GitHub 源**可按 **星标数 / 更新时间 / 作者作品数** 排；**咔咔珂官方源**则是浏览、下载等维度。',
      '想找热门就按星标 / 下载排，想找新出的就按更新时间排。',
    ],
    callout: { tone: 'tip', text: '排序和分类可以同时用：先筛分类缩小范围，再排序把最想要的顶到前面。' },
    enter: () => {
      closeStoreDetail();
      clearStoreCategory();
    },
  },
  {
    id: 'store-refresh',
    route: '/plugin-store',
    target: '[data-tour="store-refresh"]',
    title: '顶栏 ④ 强制刷新',
    body: [
      '最后一个是**刷新**，而且是**强制刷新**：清掉缓存、重新拉一遍最新列表，期间会有「正在刷新资源」的提示。',
      '源站刚上了新插件、但你这还看不到的时候，点它就对了。',
    ],
    callout: { tone: 'tip', text: '强制刷新不会清掉你选的分类和排序，放心点。' },
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
    title: '下一站 · 实用工具',
    body: [
      '侧边栏从上往下第六个是 **实用工具**，点它进入工具箱。',
      '里面是几样调试 / 日常会用到的小工具，下面一张一张带你看。',
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
    title: '工具箱总览',
    body: [
      '「工具」页就是这几张卡片，点任意一张进入对应工具。',
      '下面我按顺序把它讲完——**先讲完工具箱里的三样**，再往下走别的界面。',
    ],
  },
  {
    id: 'tool-encode',
    route: '/tools',
    target: '[data-tour="tool-encode"]',
    title: '工具 ① 常用编码转换',
    body: [
      '**常用编码转换**：Base64 / Hex / URL / Unicode / 进制 / gzip 等互转。',
      '纯本地计算、不联网，粘进去即得结果，做插件时拼报文、解回调很好用。',
    ],
  },
  {
    id: 'tool-media',
    route: '/tools',
    target: '[data-tour="tool-media"]',
    title: '工具 ② 视频解析',
    body: [
      '**视频解析**：粘贴 B站 / 抖音 / 小红书 / 快手 / TikTok / YouTube / X / Telegram 链接。',
      '解析出标题、封面与直链，方便做下载或转发类插件时取素材。整段分享文案粘进去也认，会自动从里面挖出链接。',
    ],
  },
  {
    id: 'tool-plugin-dev',
    route: '/tools',
    target: '[data-tour="tool-plugin-dev"]',
    title: '工具 ③ 插件开发',
    body: [
      '**插件开发**：总览 + 五条轨的教程与示例代码——OneBot 的 **TS（构建式）/ JS ESM / JS CJS**、**QQ 官方（GF-）**、**双生（sssx-）**。',
      '想自己写插件从这里起步：先读总览，再按你要接的机器人类型挑一条轨。',
    ],
  },
  {
    id: 'nav-open-platform',
    route: '/tools',
    target: '[data-tour="nav-open-platform"]',
    sidebar: 'open',
    title: '下一站 · 开放平台',
    body: [
      '再往下是 **开放平台**，专门管**腾讯 QQ 官方机器人**的账号。',
      '和「连接」页不同：这里走的是腾讯官方扫码通道，不用自己申请开发者账号、不用手填密钥。',
      '点它进去看看。',
    ],
  },
  {
    id: 'op-login',
    route: '/open-platform',
    target: '[data-tour="op-login"]',
    title: '开放平台 · 扫码接入（这页是干嘛的）',
    body: [
      '先说清楚这一页**是干嘛的**：它管的是**腾讯 QQ 官方机器人**（q.qq.com 那条官方通道），不是 NapCat 那种。',
      '**扫码登录的用途**：点「扫码接入」，用**手机 QQ 扫**一下，咔咔珂会自动取回这个机器人的 **AppID 与密钥**并完成接入——**不用你去开放平台申请开发者账号，也不用手动抄密钥**。扫完这个机器人就登记在这里了，并且会自动成为一条「QQ 官方」连接，之后插件就能在它上面跑。',
      '所以这页和「连接」页的分工是：**连接页是手动填参数**，**这里是扫码免填**。已经用官方通道接进来的机器人，来这一页管最方便。',
      '一个二维码 = 一个机器人；想接多个就再扫一次，接完这里会显示已绑定的 AppID 和来源 IP。',
    ],
    callout: { tone: 'warn', text: '必须用 QQ 内置相机直接扫，长按识别 / 相册截图都不行。扫的是腾讯官方通道，咔咔珂不会经手你的 QQ 密码。' },
  },
  {
    id: 'op-stats',
    route: '/open-platform',
    target: '[data-tour="op-stats"]',
    title: '开放平台 · 三个数字',
    body: [
      '下面这一排是三个总览数字：**机器人账号**（一共接了几个）、**连接中**（此刻在线几个，绿色）、**今日日活**（今天有多少用户跟这些机器人互动过）。',
      '一眼就能看出官方机器人整体跑没跑起来。',
    ],
  },
  {
    id: 'op-add',
    route: '/open-platform',
    target: '[data-tour="op-add"]',
    title: '开放平台 · 手动添加账号',
    body: [
      '不想扫码也能加：点这个 **添加账号**。',
      '**只填 AppID** = 先登记为「未接入」（占位，之后可以补）；**同时填 AppSecret** = 直接创建连接并接入咔咔珂。',
      '已经在腾讯开放平台建好的机器人，用这条路径最省事。',
    ],
  },
  {
    id: 'op-card',
    route: '/open-platform',
    target: '[data-tour="op-card"]',
    title: '开放平台 · 账号卡片',
    body: [
      '每张卡片是一个官方机器人账号：**头像 + 名称 + AppID**，右上角小圆点绿色表示在线，右上角的标签区分 **正式 / 沙箱 / 未接入**。',
      '已接入的卡片下面还有四个日活小格：**今日 / 昨日 / 近7天 / 累计**。',
      '下一步我直接帮你点开一张卡片，看看详情里有什么。',
    ],
    skipIf: () => !hasOpCards(),
    enter: closeOpDetail,
  },
  {
    id: 'op-detail',
    route: '/open-platform',
    target: '[data-tour="op-detail"]',
    title: '账号详情 · 概览',
    body: [
      '这就是账号详情。最上面是**头像、名称、AppID**，下面一行标明 **正式 / 沙箱环境** 与接入方式（HTTPS Webhook 或 WebSocket 网关），再下面一排是**连接状态**。',
      '右上角 × 关闭。往下滚，还有日活与官方数据。',
    ],
    skipIf: () => !hasOpCards(),
    enter: openOpDetail,
  },
  {
    id: 'op-detail-dau',
    route: '/open-platform',
    target: '[data-tour="op-detail-dau"]',
    title: '账号详情 · 日活（DAU）',
    body: [
      '**日活**：今日 / 昨日 / 近 7 天 / 累计四个数字，下面还有一张走势小图。',
      '这数据是腾讯官方接口给的，能看出这个机器人到底有没有人在用、用得怎么样。',
    ],
    skipIf: () => !document.querySelector('[data-tour="op-detail-dau"]'),
    enter: openOpDetail,
  },
  {
    id: 'op-detail-insight',
    route: '/open-platform',
    title: '账号详情 · 官方接口数据 / 交互配置',
    center: true,
    body: [
      '**官方接口数据**：拉取并显示机器人在腾讯那边的资料（头像、简介、WSS 网关接入点、Token 剩余时间），还能展开看它**加入了哪些频道**、频道里有哪些子频道。点「重新拉取」可手动刷新。',
      '**交互配置**：给这个机器人配自定义菜单、指令面板等交互入口，各自在独立窗口里编辑。',
    ],
    callout: { tone: 'tip', text: '这两块要填了 AppSecret 才有数据；只登记 AppID 的「未接入」账号拉不到。' },
    skipIf: () => !document.querySelector('[data-tour="op-detail-insight"]'),
    enter: openOpDetail,
  },
  {
    id: 'op-detail-actions',
    route: '/open-platform',
    target: '[data-tour="op-detail-actions"]',
    title: '账号详情 · 底部操作',
    body: [
      '最底下一排是操作：**刷新资料**（重新拉腾讯那边的资料）、**启用 / 停用**（临时让这个机器人下线，不用删掉它）、**删除**（把账号从咔咔珂移除，会先弹确认）。',
      '未接入的账号这里显示的是「补密钥并接入」。',
    ],
    skipIf: () => !hasOpCards(),
    enter: openOpDetail,
  },
  {
    id: 'nav-ai',
    route: '/open-platform',
    target: '[data-tour="nav-ai"]',
    sidebar: 'open',
    title: '下一站 · 智能助手',
    body: [
      '再往下是 **智能助手**：一个内置在咔咔珂里的 AI 对话界面。',
      '接上你自己的大模型服务，就能在这里直接问问题、让它帮忙看代码 / 改文件。',
      '点它进去看看怎么用。',
    ],
    enter: closeOpDetail,
  },
  {
    id: 'ai-new',
    route: '/ai',
    target: '[data-tour="ai-new"]',
    title: '智能助手 · 新建会话',
    body: [
      '进来是**会话列表**。右上角这个 **新建会话** 就是开一轮新对话——每次想换个话题、换个任务，就新建一个，历史不会被冲掉。',
      '列表里每一行是一个会话：显示标题、最后活动时间；鼠标移上去会出现**重命名**和**删除**两个小按钮。',
    ],
    enter: () => {
      closeAiProfile();
    },
  },
  {
    id: 'ai-list',
    route: '/ai',
    target: '[data-tour="ai-list"]',
    title: '智能助手 · 会话列表',
    body: [
      '这一片就是会话列表。**点任意一行**进入那轮对话；正在执行的会话标题旁边会有小转圈，上次出错的会有一个红点。',
      '要真正用起来，还得有一个**模型服务**——下一步就讲顶栏那个齿轮怎么配。',
    ],
    enter: closeAiProfile,
  },
  {
    id: 'ai-config',
    route: '/ai',
    target: '[data-tour="ai-config"]',
    title: '智能助手 · 上游配置（齿轮）',
    body: [
      '顶栏右上角这个**齿轮**是 **AI 上游配置**：在这里添加并管理你的**模型服务**（OpenAI / Anthropic 两种协议）。',
      '至少要有一个模型服务，智能助手才能用。下一步我直接帮你打开它。',
    ],
    enter: closeAiProfile,
  },
  {
    id: 'ai-profile',
    route: '/ai',
    target: '[data-tour="ai-profile"]',
    title: '模型服务 · 添加与管理',
    body: [
      '这里列出所有模型服务：**点名字**把它设为当前使用（当前那个有青色描边），旁边可**测试连通性**（显示正常 / 失败）、**编辑**、**删除**。',
      '点 **添加模型** 填：名称、协议（OpenAI / Anthropic）、接口地址、密钥、模型名，是否支持图片识别。',
    ],
    callout: { tone: 'warn', text: '密钥只存在你本机；接口地址填错会「测试」失败，先测通再用。' },
    enter: openAiProfile,
  },
  {
    id: 'ai-profile-edit',
    route: '/ai',
    target: '[data-tour="ai-profile-edit"]',
    title: '添加模型 · 表单怎么填',
    body: [
      '点「添加模型」就进到这张表单。**最上面一排是预设**（常见厂商一键填入地址），有你用的就直接点，省得手打。',
      '要填的就这几项：**显示名称**（自己认得就行）、**请求协议**（OpenAI 兼容 / Anthropic）、**服务器地址**、**API Key**、**请求路径**（留空走默认）、**模型名称**（可点「获取模型」自动拉列表，也可手填）。',
      '再下面是可选的调参：**思考强度**（开思考会让模型先想再答）、**最大输出 Token**、**超时**、**失败重试次数**。',
      '填完点**保存并测试**最稳妥——它会存下来的同时测一次连通性，通了就直接能用。',
    ],
    callout: { tone: 'warn', text: '开了「思考强度」的话，最大输出 Token 建议不低于 8192：思考内容也占这个额度，给少了会出现「只在思考、没有回复」。' },
    enter: openAiProfileEdit,
  },
  {
    id: 'ai-profile-vision',
    route: '/ai',
    target: '[data-tour="ai-profile-vision"]',
    title: '添加模型 · 图片识别开关',
    body: [
      '最后这个 **图片识别（多模态）** 默认是**关**的：只有勾上它，你在对话里挂的图片才会真的发给模型。',
      '模型其实不支持图片也没关系——上游会以 400 拒收，系统会自动去掉图片重试，不会把任务中断。',
    ],
    callout: { tone: 'tip', text: '图片按输入 token 计费且不便宜，用不上就别开。Anthropic 协议还会多一个「提示词缓存」选项，官方直连建议开，能省约九成输入费用。' },
    enter: openAiProfileEdit,
  },
  {
    id: 'ai-composer',
    route: '/ai',
    target: '[data-tour="ai-composer"]',
    title: '对话里 · 输入区',
    body: [
      '进到某个会话后，底部这块就是**输入区**：上面打字，下面一行是**选择模型 / 添加文件 / 发送**。',
      '**直接把文件拖进页面**也能挂上去，和点文件夹按钮是同一条路径。',
      '执行中再点发送 = 把新消息**加入排队**，不会打断正在跑的那一轮。',
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
    title: '输入区 · 选择模型服务',
    body: [
      '这里显示**当前用的模型服务**，点开可切换成你配好的另一个（比如从便宜的换到强的）。',
      '菜单最后一项「添加 / 管理模型服务…」会直接跳到刚才那个配置弹窗。',
      '还没配模型时这里显示「选择模型」，点了就去配。',
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
    title: '输入区 · 挂文件 / 图片',
    body: [
      '这个**文件夹图标**是**添加文件 / 图片**：让它照着你本地的文件来回答问题或改代码。',
      '挂上去的文件会在输入框上方显示成小气泡，点 × 可移除；**拖文件进页面**效果一样。',
    ],
    callout: { tone: 'warn', text: '图片只有在模型开了「图片识别」时才会真的发给它；没开的话只会把文件名告诉它（气泡会带琥珀色描边提示）。' },
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
    title: '输入区 · 发送键',
    body: [
      '最右边这颗就是**发送**。空闲时点它发出消息；**AI 正在执行时**它会变成停止 / 排队键——点它可打断当前这一轮，或把新消息排进队列。',
      '回车发送、Shift+回车换行。执行过程中会实时显示思考过程与改动的文件，结束后底部会留一行「已完成 / 执行中断」的结果。',
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
    title: '下一站 · 模拟消息',
    body: [
      '再往下是 **模拟消息**——它在侧边栏有**独立入口**，不在工具箱里。',
      '它能在本机假装收到一条消息 / 事件，真实触发插件来调试，不用真去群里发。',
      '这是开发 / 排查插件时最常用的一样，下面单独带你走一遍它的设置。',
    ],
    enter: closeAiProfile,
  },
  {
    id: 'simulate',
    route: '/simulate',
    target: '[data-tour="simulate-send"]',
    title: '模拟消息 · 输入栏',
    body: [
      '底部就是输入栏，输入文字点这颗发送键，就能让插件「收到」一条消息。',
      '重点：**长按发送键约 3 秒**，会呼出 **「模拟设置」** 面板。下一步我直接帮你打开它，逐块讲解。',
    ],
    callout: { tone: 'tip', text: '输入栏左侧「+」可插入 图片 / @ / 视频 / 语音 / JSON卡片。插件的回复与 API 调用会被拦截展示，不会真的发出去。' },
    enter: closeSimConfig,
  },
  {
    id: 'sim-config-account',
    route: '/simulate',
    target: '[data-tour="sim-config-account"]',
    title: '模拟设置 · 账号',
    body: [
      '这就是长按发送键呼出的「模拟设置」面板。',
      '**账号**：选择要调试哪一个机器人连接——插件会以这个账号的身份收到模拟消息；官方账号会走 openid 语义。',
    ],
    enter: openSimConfig,
  },
  {
    id: 'sim-config-identity',
    route: '/simulate',
    target: '[data-tour="sim-config-identity"]',
    title: '模拟设置 · 发送身份',
    body: [
      '**群聊 / 私聊** 切换：决定这条消息是从群里还是私聊发来的。',
      '下面填**群号**（群聊时）、**发送者 QQ**、**昵称**——插件里 group_id、user_id、发送者昵称取到的就是这些值，方便你精确构造测试场景。',
    ],
    enter: openSimConfig,
  },
  {
    id: 'sim-config-event',
    route: '/simulate',
    target: '[data-tour="sim-config-event"]',
    title: '模拟设置 · 事件上报',
    body: [
      '不止发消息——这里能模拟各类**通知 / 请求事件**：入群、退群、禁言、戳一戳、群文件上传、加好友 / 加群请求等。',
      '选事件类型后按提示填参数（群号、目标 QQ、时长、验证消息……），点触发，插件就会收到对应事件，用来测试进群欢迎、审批等逻辑。',
    ],
    callout: { tone: 'tip', text: '面板底部还有「清空缓存」清空当前会话记录、「完成」关闭面板。' },
    enter: openSimConfig,
  },
  {
    id: 'nav-logs',
    route: '/simulate',
    target: '[data-tour="nav-logs"]',
    sidebar: 'open',
    title: '下一站 · 运行日志',
    body: [
      '倒数第二站是 **运行日志**。插件没反应、机器人连不上、想知道刚才到底发生了什么——都来这里看。',
      '点它进入日志页。',
    ],
    enter: closeSimConfig,
  },
  {
    id: 'logs-filters',
    route: '/logs',
    target: '[data-tour="logs-filters"]',
    title: '日志 · 顶部过滤区',
    body: [
      '出问题先来「日志」页。顶部这一行是**过滤区**：一个搜索框 + 旁边三个下拉（**分类 / 级别 / 选择**）。',
      '下面我把这几样一个一个讲清楚。',
    ],
    enter: closeSimConfig,
  },
  {
    id: 'logs-search',
    route: '/logs',
    target: '[data-tour="logs-search"]',
    title: '过滤 · 搜索框',
    body: [
      '**搜索框**：按关键词实时过滤日志，比如输入插件名、报错关键字、群号来快速定位。',
    ],
  },
  {
    id: 'logs-cat',
    route: '/logs',
    target: '[data-tour="logs-cat"]',
    title: '过滤 · 分类下拉',
    body: [
      '搜索框旁的第一个下拉是 **分类** 筛选，点开可选：**全部分类** 或下面这些具体来源——',
      '**系统**（框架自身）、**上报**（收到的消息 / 事件）、**输出**（调用 OneBot 接口）、**插件**（插件打的日志）；官方通道另有 **官方上报 / 官方输出 / 官方插件**；工具页模拟则有 **模拟上报 / 模拟输出**。',
      '选一项就只看那一类，排查特定环节时非常快。',
    ],
  },
  {
    id: 'logs-level',
    route: '/logs',
    target: '[data-tour="logs-level"]',
    title: '过滤 · 级别下拉',
    body: [
      '第二个下拉是 **级别** 筛选，点开可选：**全部级别**、**DEBUG**（最详细的调试信息）、**INFO**（常规运行信息）、**WARN**（警告）、**ERROR**（错误）。',
      '排查问题时选 **ERROR** 只看报错最快；想看最详细的过程，就配合「设置 → 运行参数」把日志级别调到 DEBUG，再回这里选 DEBUG。',
    ],
    callout: { tone: 'tip', text: '和搜索框一起用更快：先框定级别，再搜插件名或群号。' },
  },
  {
    id: 'logs-file',
    route: '/logs',
    target: '[data-tour="logs-file"]',
    title: '过滤 · 选择（回看历史）',
    body: [
      '第三个下拉是 **选择**，用来临时查看**某一天的日志文件**。',
      '默认停在 **实时日志**；选一天就切到那天的存档，方便回看已经翻过去的内容。',
      '注意这只是**临时查看**，刷新页面就会回到实时日志。',
    ],
  },
  {
    id: 'logs-stream',
    route: '/logs',
    target: '[data-tour="logs-stream"]',
    // 日志区是 flex-1，会一路撑到屏幕底部；不设上限的话高亮框比里面的日志行高出一大截，
    // 看着像框错了地方。这里只从日志区顶部往下框一段，正好盖住最前面几行。
    maxHeight: 240,
    title: '日志区 · 一行一条',
    body: [
      '下面这片就是日志区：**一行一条**，按时间从旧到新往下排。',
      '每行固定按「**分类 · 连接账号 · 时间 · 摘要**」排列，整行颜色随分类走，报错行会整条变玫红加粗。',
      '内容长时会**自动折行续排**（最多两行，再长就截断），所以不会出现横向滚动条把版面撑乱。',
      '图片 / 语音 / 视频这类消息会显示成 `[图片]` `[语音]` `[视频]` 这样的占位标记，不会把整屏撑开。',
      '摘要里的**群号会自动显示成群名**、`@某人` 会显示成 **@昵称**，读起来比看一串数字友好得多（群名是框架记下来的，记过一次以后都认得）。',
    ],
    callout: { tone: 'tip', text: '想知道被截断的那一整条写了什么，点一下该行就能展开完整内容（JSON 会自动高亮）。' },
  },
  {
    id: 'logs-toolbar',
    route: '/logs',
    target: '[data-tour="logs-toolbar"]',
    title: '日志 · 底部操作条',
    body: [
      '页面底部这条固定的操作栏一共有 **5 个操作**。',
      '下面我一个一个带你看。',
    ],
  },
  {
    id: 'logs-refresh',
    route: '/logs',
    target: '[data-tour="logs-refresh"]',
    title: '操作 ① 刷新',
    body: [
      '**刷新**：立即重新拉取最新日志。',
      '关掉了「自动滚动」暂停接收后，想看新日志就点它。',
    ],
  },
  {
    id: 'logs-copy',
    route: '/logs',
    target: '[data-tour="logs-copy"]',
    title: '操作 ② 复制可见日志',
    body: [
      '**复制可见日志**：把当前筛选后、屏幕上这些日志一次性复制到剪贴板。',
      '方便你粘到群里 / 文档里求助或存档。',
    ],
  },
  {
    id: 'logs-download',
    route: '/logs',
    target: '[data-tour="logs-download"]',
    title: '操作 ③ 下载',
    body: [
      '**下载**：导出**当前进程**的日志文件。',
      '会带上你现在选的**分类 / 级别**筛选，只想导出报错就先选 ERROR 再下载。',
      '比复制更全，适合把整份日志发给别人排查问题。',
    ],
  },
  {
    id: 'logs-clear',
    route: '/logs',
    target: '[data-tour="logs-clear"]',
    title: '操作 ④ 清空',
    body: [
      '**清空**（红色）：清掉现有日志记录，会先弹确认框防误触。',
      '清空后新日志会照常继续产生，不影响运行。',
    ],
    callout: { tone: 'warn', text: '清空不可恢复，确认前最好先「下载」备份一份。' },
  },
  {
    id: 'logs-autoscroll',
    route: '/logs',
    target: '[data-tour="logs-autoscroll"]',
    title: '操作 ⑤ 自动滚动（暂停键）',
    body: [
      '最右边的 **自动滚动** 开关其实就是「暂停键」。',
      '**关掉它**日志就不再实时刷入、画面定住，方便你盯住某一条慢慢看；需要新数据时点左边的刷新即可。',
    ],
  },
  {
    id: 'nav-settings',
    route: '/logs',
    target: '[data-tour="nav-settings"]',
    sidebar: 'open',
    title: '最后一站 · 系统设置',
    body: [
      '最后一站是 **系统设置**：监听地址、端口、日志级别、界面外观、配色、性能、资源来源、更新，都在这一页。',
      '内容比较多，下面我按卡片一张一张带你过。',
    ],
  },
  {
    id: 'settings-listen',
    route: '/settings',
    target: '[data-tour="settings-listen"]',
    title: '很好，来到「设置」页 · 监听地址',
    body: [
      '最后一站是「设置」页。这里的卡片我都按「先看整张卡片、再逐项讲」的方式带你过。',
      '先看这张 **监听地址** 卡片，它有两项可调，下面一项一项说。',
    ],
  },
  {
    id: 'row-host',
    route: '/settings',
    target: '[data-tour="row-host"]',
    title: '监听地址 · 地址',
    body: [
      '**监听地址**：控制台 / 服务在哪个网卡上对外提供。',
      '填 **0.0.0.0** = 允许所有网卡访问（想让别的设备 / 容器连进来用它）；填 **127.0.0.1** = 仅本机可访问。',
    ],
    callout: { tone: 'warn', text: '地址改完需要重启咔咔珂才生效。' },
  },
  {
    id: 'row-port',
    route: '/settings',
    target: '[data-tour="row-port"]',
    title: '监听地址 · 后台端口',
    body: [
      '**后台端口**：访问这个控制台用的端口，默认 **8787**，范围 1–65535。',
      '改了它，下次就要用新端口来打开控制台。',
    ],
    callout: { tone: 'warn', text: '端口改完同样需要重启咔咔珂才生效。' },
  },
  {
    id: 'settings-runtime',
    route: '/settings',
    target: '[data-tour="settings-runtime"]',
    title: '接着看 · 运行参数',
    body: [
      '这张 **运行参数** 卡片同样有两项可调，继续一项一项看。',
    ],
  },
  {
    id: 'row-loglevel',
    route: '/settings',
    target: '[data-tour="row-loglevel"]',
    title: '运行参数 · 日志级别',
    body: [
      '**日志级别**：控制日志详细程度。**DEBUG** 看得最细（调试用），**INFO** 是日常默认，**WARN / ERROR** 只留警告 / 错误。',
      '这里调的是「记录多细」，配合日志页那个级别下拉「看哪一档」一起用。',
    ],
  },
  {
    id: 'row-timeout',
    route: '/settings',
    target: '[data-tour="row-timeout"]',
    title: '运行参数 · API 超时',
    body: [
      '**API 超时**：调用 OneBot 接口的等待上限，单位**秒**，修改后立即生效。',
      '发大文件 / 长视频容易超时，可以把它适当调大。',
    ],
  },
  {
    id: 'settings-title',
    route: '/settings',
    target: '[data-tour="settings-title"]',
    title: '再来 · 自定义标题',
    body: [
      '这张 **自定义标题** 卡片可以把控制台顶部显示的「咔咔珂」改成你自己喜欢的名字。',
      '下一步我带你看它填在哪、改完在哪生效、怎么才算生效。',
    ],
  },
  {
    id: 'row-title',
    route: '/settings',
    target: '[data-tour="row-title"]',
    title: '自定义标题 · 输入框',
    body: [
      '在这里输入名字（最多 20 字），**输入即自动保存**，没有单独的保存按钮。',
      '留空则用默认「咔咔珂」。',
    ],
  },
  {
    id: 'brand-title',
    route: '/settings',
    target: '[data-tour="brand-title"]',
    title: '自定义标题 · 生效位置',
    body: [
      '改完就显示在**这里**——**顶栏**左侧的品牌字，也就是「应用标题 · 当前界面标题」的前半段。',
      '侧边栏顶部显示的是同一个名字，所以电脑和手机上看到的是一致的。',
      '**怎么才生效：输入自动存下后，刷新一次页面（或重进控制台），这里的标题就会变成你填的名字。**',
    ],
    callout: { tone: 'tip', text: '如果没变，多半是还没刷新；刷新后即更新。' },
  },
  {
    id: 'settings-appearance',
    route: '/settings',
    target: '[data-tour="settings-appearance"]',
    title: '重点 · 界面外观',
    body: [
      '这张 **界面外观** 卡片能调整整个控制台的观感，可调的东西不少。',
      '别急，下面我把里面每一样都带你过一遍——先是背景，再是各条滑动条。所有改动**即时预览、自动保存**，不用点保存。',
    ],
  },
  {
    id: 'ap-bg',
    route: '/settings',
    target: '[data-tour="ap-bg"]',
    title: '外观 · 自定义背景',
    body: [
      '最上面这两张卡分别给**竖屏 / 横屏**设置背景，可上传**图片**，也可上传 **mp4 / 实况视频**（自动循环播放）。',
      '手机竖着用取竖屏那张，电脑 / 横屏取横屏那张。',
    ],
  },
  {
    id: 'ap-uiSpeed',
    route: '/settings',
    target: '[data-tour="ap-row-uiSpeed"]',
    title: '外观 · 动效速度',
    body: [
      '**动效速度**：全站动画的快慢倍率。调大更利落、调小更舒缓。',
    ],
  },
  {
    id: 'ap-cardOpacity',
    route: '/settings',
    target: '[data-tour="ap-row-cardOpacity"]',
    title: '外观 · 卡片透明度',
    body: [
      '**卡片透明度**：主要卡片（组件1）玻璃的通透程度。值越低越透、越能看见背景。',
    ],
  },
  {
    id: 'ap-cardBlur',
    route: '/settings',
    target: '[data-tour="ap-row-cardBlur"]',
    title: '外观 · 卡片模糊度',
    body: [
      '**卡片模糊度**：卡片背后的毛玻璃模糊半径，和上面的「卡片透明度」是一对。值越大背景越朦胧。',
    ],
  },
  {
    id: 'ap-card2Opacity',
    route: '/settings',
    target: '[data-tour="ap-row-card2Opacity"]',
    title: '外观 · 悬浮层透明度',
    body: [
      '**悬浮层透明度**：次级表面（**悬浮窗**、弹窗、下载气泡等）的透明度。',
      '想让弹窗更通透就调低它——它和「卡片」分开控制。',
    ],
  },
  {
    id: 'ap-card2Blur',
    route: '/settings',
    target: '[data-tour="ap-row-card2Blur"]',
    title: '外观 · 悬浮层模糊度',
    body: [
      '**悬浮层模糊度**：悬浮窗那一类次级表面的毛玻璃模糊半径。',
    ],
  },
  {
    id: 'ap-backgroundBlur',
    route: '/settings',
    target: '[data-tour="ap-row-backgroundBlur"]',
    title: '外观 · 背景模糊度',
    body: [
      '**背景模糊度**：对你上传的**背景图 / 视频**整体做模糊。',
      '背景太花影响读字时，调大它能让前景更清爽。',
    ],
  },
  {
    id: 'ap-sidebarWidthPc',
    route: '/settings',
    target: '[data-tour="ap-row-sidebarWidthPc"]',
    title: '外观 · 侧边栏宽度（电脑）',
    body: [
      '**侧边栏宽度 · 电脑**：电脑端展开侧边栏时的**像素宽度**。',
      '默认落在区间正中间，往左调窄、往右调宽都留了余量。',
    ],
  },
  {
    id: 'ap-sidebarWidthMobile',
    route: '/settings',
    target: '[data-tour="ap-row-sidebarWidthMobile"]',
    title: '外观 · 侧边栏宽度（手机）',
    body: [
      '**侧边栏宽度 · 手机**：手机端侧边栏**占屏宽的百分比**，默认约三分之二。',
      '和电脑端是两根独立的调节线，各管一端，互不影响。',
    ],
  },
  {
    id: 'settings-color',
    route: '/settings',
    target: '[data-tour="settings-color"]',
    title: '接着 · 配色方案',
    body: [
      '这张 **配色方案** 卡片有三组独立配色：**全局字体**、**组件及按钮**、**品牌 Logo**，行尾的小色块就是当前色。',
      '点色块会弹出**拾色盘**——下一步我直接帮你把「组件及按钮」的拾色盘打开，看看怎么选色。',
    ],
  },
  {
    id: 'color-area',
    route: '/settings',
    target: '[data-tour="color-area"]',
    title: '拾色盘 · 取色区',
    body: [
      '这就是拾色盘。这块大方块是**饱和度 × 明度**取色区：左右调饱和、上下调明暗，拖动中间的小球取色。',
    ],
    enter: openColorDialog,
  },
  {
    id: 'color-hue',
    route: '/settings',
    target: '[data-tour="color-hue"]',
    title: '拾色盘 · 色相竖条',
    body: [
      '右边这根**彩色竖条**就是**色相**选择：上下拖动它换主色调（红→橙→黄→绿→蓝→紫）。',
      '先用竖条定色调，再回左边方块调深浅浓淡。',
    ],
    enter: openColorDialog,
  },
  {
    id: 'color-hex',
    route: '/settings',
    target: '[data-tour="color-hex"]',
    title: '拾色盘 · 颜色代码输入框',
    body: [
      '不想手动拖？直接在这个**颜色代码输入框**里粘一个代码，色盘会实时跟着变。',
      '支持 `#66CCFF`、`rgb(102,204,255)`、`hsl(...)` 等写法；填好点「确定」即刻生效并保存。',
    ],
    enter: openColorDialog,
  },
  {
    id: 'settings-performance',
    route: '/settings',
    target: '[data-tour="settings-performance"]',
    title: '接着 · 性能模式',
    body: [
      '这张 **性能模式** 卡片管的是整个控制台的「特效开销」。',
      '它会自动判断你的设备性能，性能不够就自动关掉最吃性能的视觉效果（实时模糊、氛围动画等），让低配设备也能流畅用。',
    ],
    enter: closeColorDialog,
  },
  {
    id: 'perf-mode-toggle',
    route: '/settings',
    target: '[data-tour="perf-mode-toggle"]',
    title: '性能模式 · 三档开关',
    body: [
      '**跟随设备**（默认）：按 CPU 核数 / 内存 / 实测帧率自动判定，iOS 设备默认降一档。',
      '**性能模式**：强制关闭实时模糊与氛围动画、暂停视频背景，用起来卡顿就选它。',
      '**完整特效**：玻璃拟态、动效、视频背景全开，好设备选它。',
    ],
    callout: { tone: 'tip', text: '这个设置只保存在当前浏览器里，换设备互不影响。' },
  },
  {
    id: 'settings-store-origin',
    route: '/settings',
    target: '[data-tour="settings-store-origin"]',
    title: '设置 · 资源来源',
    body: [
      '这里切换「资源」页从哪拉插件：**咔咔珂官方源** 或 **GitHub 社区源**。',
      '点一下即时切换（带滑动动画）并自动保存，回到资源页就是新来源的列表。',
    ],
    callout: { tone: 'warn', text: 'GitHub 社区源是第三方投稿，安装前请自行甄别风险；官方源相对更稳妥。' },
    enter: closeColorDialog,
  },
  {
    id: 'update-center',
    route: '/settings',
    target: '[data-tour="update-center"]',
    sidebar: 'open',
    title: '最后 · 检查更新（版本号徽标）',
    body: [
      '侧边栏顶部这个**版本号徽标**就是「更新中心」入口，有新版本时右上角会有红色 NEW 气泡。',
      '下一步我直接帮你点开它，把里面的每一块都讲清楚。',
    ],
    enter: closeColorDialog,
  },
  {
    id: 'uc-header',
    route: '/settings',
    sidebar: 'open',
    target: '[data-tour="uc-header"]',
    title: '更新中心 ① 版本与状态',
    body: [
      '悬浮窗打开了。最上面这一行显示**当前版本 → 最新版本**以及**检查状态**（检查中 / 已是最新 / 有新版本）。',
      '一眼就知道要不要更新。',
    ],
    enter: openUpdateCenter,
  },
  {
    id: 'uc-mirror',
    route: '/settings',
    sidebar: 'open',
    target: '[data-tour="uc-mirror"]',
    title: '更新中心 ② 镜像源',
    body: [
      '**镜像源**：点开可选加速通道（如 gh-proxy / catmak）。国内访问 GitHub 慢或失败时换一个通常就好了。',
      '关键：**资源页（GitHub 源）与在线更新共用这一个镜像**——你在这选了哪个，资源列表 / 文档 / 下载就都走哪个。',
    ],
    callout: { tone: 'tip', text: '没手动选时会自动用测速最快的可用镜像；港澳台 / 国际网络通常可直连官方。' },
    enter: openUpdateCenter,
  },
  {
    id: 'uc-version',
    route: '/settings',
    sidebar: 'open',
    target: '[data-tour="uc-version"]',
    title: '更新中心 ③ 版本选择',
    body: [
      '**版本**：默认最新，也可展开挑一个**具体版本**来安装（比如想留在某个稳定版）。',
    ],
    enter: openUpdateCenter,
  },
  {
    id: 'uc-actions',
    route: '/settings',
    sidebar: 'open',
    target: '[data-tour="uc-actions"]',
    title: '更新中心 ④ 底部操作',
    body: [
      '底部这排按钮：**一键 Ping**（给所有镜像测速，挑最快的）、**测试所选**（只测当前这个镜像）、以及**去下载 / 安装所选版本**。',
      '流程一般是：先 Ping 测速 → 选个快的镜像 → 再安装。',
    ],
    enter: openUpdateCenter,
  },
  {
    id: 'settings-tour',
    route: '/settings',
    target: '[data-tour="settings-tour"]',
    title: '随时重看本教程',
    body: [
      '以后想再走一遍这个导览，就来 **设置 → 新手引导** 点「重新查看产品导览」。',
    ],
    enter: closeUpdateCenter,
  },
  {
    id: 'done',
    center: true,
    title: '教程完成 🎉',
    body: [
      '核心流程记住这条就够：',
      '**① 连接**页添加并**启用**连接 → **② 插件**页开**总开关** → **③** 回到该连接的**插件管理**为账号启用插件。',
      '祝你玩得开心！',
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

  /** 量目标位置；设了 maxHeight 的步骤只从顶部往下框这么多，不跟着容器一起撑大 */
  const measureRect = useCallback((el: HTMLElement): Rect => {
    const r = el.getBoundingClientRect();
    const cap = maxHeightRef.current;
    return {
      top: r.top,
      left: r.left,
      width: r.width,
      height: cap && r.height > cap ? cap : r.height,
    };
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
        if (tries > 120) {
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
      // 只在目标所在的「页面滚动容器」内滚动。用 scrollIntoView 会向上冒泡去滚
      // 窗口/根滚动，把 background-attachment:fixed 的氛围底和固定背景层整体推走，
      // 停下后又缓慢弹回——这正是导览期间「背景上移再慢慢下降」的来源。
      const scroller = el.closest<HTMLElement>('[data-kk-page-scroll]');
      const view = scroller?.getBoundingClientRect() ?? null;
      const needScroll = !!scroller && !!view && (r0.top < view.top + 72 || r0.bottom > view.bottom - 72);

      if (needScroll && scroller && view) {
        // 平滑滚动，并逐帧让高亮框贴住目标，直到滚动停稳
        trackingRef.current = true;
        setRect(measureRect(el));
        const desired = scroller.scrollTop + (r0.top - view.top) - (view.height / 2 - r0.height / 2);
        const maxTop = scroller.scrollHeight - scroller.clientHeight;
        scroller.scrollTo({ top: Math.max(0, Math.min(maxTop, desired)), behavior: 'smooth' });

        let lastTop = Number.NaN;
        let stable = 0;
        const startAt = performance.now();
        const loop = () => {
          if (cancelled) return;
          const r = setRectFrom(el);
          const cur = Math.round(r.top);
          if (cur === lastTop) stable += 1;
          else { stable = 0; lastTop = cur; }
          if (stable >= 4 || performance.now() - startAt > 1000) {
            trackingRef.current = false;
            setRectFrom(el); // 恢复过渡后再定格一次
            revealAfter(70);
            return;
          }
          raf = requestAnimationFrame(loop);
        };
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
      if (el && document.contains(el)) {
        const r = el.getBoundingClientRect();
        const cap = maxHeightRef.current;
        setRect({
          top: r.top,
          left: r.left,
          width: r.width,
          height: cap && r.height > cap ? cap : r.height,
        });
      }
    };
    window.addEventListener('resize', remeasure);
    window.addEventListener('scroll', remeasure, true);
    return () => {
      window.removeEventListener('resize', remeasure);
      window.removeEventListener('scroll', remeasure, true);
    };
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
            <h2 className="text-xl font-bold tracking-tight text-slate-800">欢迎使用咔咔珂</h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-600">
              第一次进来可能有点摸不着头脑？跟着
              <span className="font-semibold text-teal-700">产品导览</span>
              走一遍，带你逐个认识每个功能在哪、怎么点，尤其是最容易绕晕的
              <span className="font-semibold text-teal-700">「连接 + 插件」启用顺序</span>。
              步骤比较多，随时可以「跳过教程」，之后在设置里也能再看。
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
              跳过教程
            </Button>
            <Button className="flex-1" onClick={beginTour}>
              开始教程
            </Button>
          </div>
        </div>
      </div>,
      document.body,
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
              ? '0 0 0 2px rgba(45,212,191,0.95), 0 0 22px 6px rgba(45,212,191,0.35), 0 0 0 9999px rgba(15,23,42,0.55)'
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
              步骤 {stepIndex + 1} / {total}
            </span>
            <button
              type="button"
              onClick={() => finish('skipped')}
              className="inline-flex h-7 w-7 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-rose-500/10 hover:text-rose-600"
              aria-label="关闭导览"
              title="跳过教程"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <h3 className="text-base font-bold tracking-tight text-slate-800">{step?.title}</h3>
          <div className="mt-1.5 space-y-1.5">
            {step?.body.map((line, i) => (
              <p key={i} className="text-[13px] leading-relaxed text-slate-600">
                {renderRich(line, `l${i}`)}
              </p>
            ))}
          </div>

          {step?.callout ? (
            <div
              className={cn(
                'mt-3 flex items-start gap-2 rounded-xl px-3 py-2 text-[12.5px] leading-relaxed ring-1',
                step.callout.tone === 'warn'
                  ? 'bg-amber-400/15 text-amber-800 ring-amber-400/30'
                  : 'bg-teal-500/12 text-teal-800 ring-teal-500/25',
              )}
            >
              {step.callout.tone === 'warn' ? (
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              ) : (
                <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-teal-600" />
              )}
              <span>{renderRich(step.callout.text, 'co')}</span>
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
              跳过教程
            </Button>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" className="kk-field" onClick={goPrev} disabled={!hasPrev}>
                <ArrowLeft className="h-3.5 w-3.5" />
                上一步
              </Button>
              <Button size="sm" onClick={goNext}>
                {hasNext ? (
                  <>
                    下一步
                    <ArrowRight className="h-3.5 w-3.5" />
                  </>
                ) : (
                  <>
                    完成
                    <Check className="h-3.5 w-3.5" />
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
