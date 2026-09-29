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

const TOUR_KEY = 'kk-product-tour-v2';
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
  /** 高亮描边的内边距（px） */
  padding?: number;
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
/** 点击第一个「可见」的匹配元素（badge 在侧栏与手机顶栏各有一个，需挑当前可见的那个） */
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

const STEPS: TourStep[] = [
  {
    id: 'dashboard',
    route: '/',
    target: '[data-tour="nav-dashboard"]',
    title: '概览页',
    body: [
      '这里是控制台首页，进来先看它。',
      '左侧（手机是底部）这排就是**主导航**，所有功能都从这里进：概览、连接、插件、资源、工具、日志、设置。',
    ],
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
      '右上角这个 **＋** 就是「添加连接」。',
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
    id: 'nav-plugins',
    route: '/connections',
    target: '[data-tour="nav-plugins"]',
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
      '这排标签按来源过滤：**全部 / 三方（OneBot）/ 官方 / 微信 / KOOK**。',
      '上面的搜索框可以按 **插件名或 ID** 快速查找。装了很多插件时很好用。',
    ],
  },
  {
    id: 'plugins-toolbar',
    route: '/plugins',
    target: '[data-tour="plugins-toolbar"]',
    title: '插件页顶部工具栏',
    body: [
      '这排是插件页的**顶部工具栏**：一个搜索框，加上「上传 zip」「刷新」两个按钮。',
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
    title: '资源 · 搜索 / 排序 / 刷新',
    body: [
      '这排工具条会**吸顶固定**，往下翻也一直在手边。',
      '**搜索框**按标题 / 作者 / 标签匹配；**排序**会随「资源来源」自适应——GitHub 源可按 **星标数 / 更新时间 / 作者作品数** 排序，官方源则有浏览、下载等维度。',
      '右上角 **刷新** 是「强制刷新」：清掉缓存重新拉取最新列表，点下会有刷新动画与提示。',
    ],
    callout: { tone: 'tip', text: '平时进页面会自动用缓存秒开、并在后台校准到最新；想立刻拿最新就点刷新。' },
  },
  {
    id: 'store-grid',
    route: '/plugin-store',
    target: '[data-tour="store-grid"]',
    title: '资源卡片 · 一键安装与翻页',
    body: [
      '每张卡片展示 **简介、标签、版本**，底部按钮可直接 **安装 / 更新**（已装会显示「已安装」）。',
      '点卡片可查看**详情与文档**；GitHub 源卡片点头像还能跳到源码仓库。',
      '每页最多 **16 个**，超过时底部会出现**翻页条**；页数超过 5 页还会有 **跳页输入框 + Go** 快速跳转。',
    ],
  },
  {
    id: 'tools',
    route: '/tools',
    target: '[data-tour="tools-grid"]',
    title: '工具箱总览',
    body: [
      '「工具」页汇集了几样调试 / 实用小工具，点任意一张卡片进入。',
      '下面我一张一张带你看它们分别干嘛。',
    ],
  },
  {
    id: 'tool-simulate',
    route: '/tools',
    target: '[data-tour="tool-simulate"]',
    title: '工具 · 模拟消息',
    body: [
      '**模拟消息**：在本地假装收到一条消息 / 事件，真实触发插件来调试，不用真去群里发。',
      '这是开发 / 排查插件时最常用的一样，稍后我还会单独带你走一遍它的内部设置。',
    ],
  },
  {
    id: 'tool-encode',
    route: '/tools',
    target: '[data-tour="tool-encode"]',
    title: '工具 · 常用编码转换',
    body: [
      '**常用编码转换**：Base64 / Hex / URL / Unicode / 进制 / gzip 等互转。',
      '纯本地计算、不联网，粘进去即得结果。',
    ],
  },
  {
    id: 'tool-media',
    route: '/tools',
    target: '[data-tour="tool-media"]',
    title: '工具 · 视频解析',
    body: [
      '**视频解析**：粘贴 B站 / 抖音 / 小红书 / 快手 / TikTok / YouTube / X / Telegram 链接。',
      '解析出标题、封面与直链，方便做下载或转发类插件时取素材。',
    ],
  },
  {
    id: 'tool-plugin-dev',
    route: '/tools',
    target: '[data-tour="tool-plugin-dev"]',
    title: '工具 · 插件开发',
    body: [
      '**插件开发**：TS / JS(ESM) / JS(CJS) 三套上手教程与示例代码。',
      '想自己写插件从这里起步。',
    ],
  },
  {
    id: 'tool-zepp-steps',
    route: '/tools',
    target: '[data-tour="tool-zepp-steps"]',
    title: '工具 · Zepp 步数',
    body: [
      '**Zepp 步数**：同步 Zepp Life 账号步数的小工具。',
      '需要相关玩法时才用得上，日常可忽略。',
    ],
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
    id: 'logs-filters',
    route: '/logs',
    target: '[data-tour="logs-filters"]',
    title: '日志 · 顶部过滤区',
    body: [
      '出问题先来「日志」页。顶部这一行是**过滤区**：一个搜索框 + 旁边两个下拉。',
      '下面我把这三样一个一个讲清楚。',
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
    callout: { tone: 'tip', text: '点某条日志可展开完整内容，JSON 会自动高亮。' },
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
      '**下载**：导出当前进程的完整日志文件。',
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
      '改完就显示在**这里**——电脑端是左侧边栏顶部的品牌字，手机端是顶栏标题。',
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
    title: '外观 · 组件速度',
    body: [
      '**组件速度**：全站动画的快慢倍率。调大更利落、调小更舒缓。',
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
    title: '外观 · 组件模糊度',
    body: [
      '**组件模糊度**：卡片背后的毛玻璃模糊半径。值越大背景越朦胧。',
    ],
  },
  {
    id: 'ap-card2Opacity',
    route: '/settings',
    target: '[data-tour="ap-row-card2Opacity"]',
    title: '外观 · 组件2透明度',
    body: [
      '**组件2透明度**：次级表面（**悬浮窗**、弹窗、下载气泡等）的透明度。',
      '想让弹窗更通透就调低它——它和「组件1」分开控制。',
    ],
  },
  {
    id: 'ap-card2Blur',
    route: '/settings',
    target: '[data-tour="ap-row-card2Blur"]',
    title: '外观 · 组件2模糊度',
    body: [
      '**组件2模糊度**：悬浮窗那一类次级表面的毛玻璃模糊半径。',
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
    title: '最后 · 检查更新（版本号徽标）',
    body: [
      '侧边栏（手机在顶栏）顶部这个**版本号徽标**就是「更新中心」入口，有新版本时右上角会有红色 NEW 气泡。',
      '下一步我直接帮你点开它，把里面的每一块都讲清楚。',
    ],
    enter: closeColorDialog,
  },
  {
    id: 'uc-header',
    route: '/settings',
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

function findVisibleTarget(selector: string): HTMLElement | null {
  const nodes = Array.from(document.querySelectorAll<HTMLElement>(selector));
  for (const el of nodes) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    return el;
  }
  return null;
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
  /** 正在跟随平滑滚动：此时高亮框逐帧贴合、不走 CSS 过渡 */
  const trackingRef = useRef(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const [cardPos, setCardPos] = useState<{ top: number; left: number } | null>(null);

  rectRef.current = rect;

  /** 高亮框移动动画时长（与下方 CSS transition 保持一致） */
  const MOVE_MS = 340;

  const step = STEPS[stepIndex];
  const total = STEPS.length;

  /* —— 首次自动弹出（未看过时）—— */
  useEffect(() => {
    if (isProductTourSeen()) return;
    const t = window.setTimeout(() => {
      setPhase((p) => (p === 'idle' ? 'welcome' : p));
    }, 650);
    return () => window.clearTimeout(t);
  }, []);

  /* —— 手动触发（设置页）—— */
  useEffect(() => {
    const onStart = () => {
      setStepIndex(0);
      setPhase('welcome');
    };
    window.addEventListener(PRODUCT_TOUR_EVENT, onStart);
    return () => window.removeEventListener(PRODUCT_TOUR_EVENT, onStart);
  }, []);

  const closeTour = useCallback(() => {
    closeConnDialog();
    closeSimConfig();
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
      const r = el.getBoundingClientRect();
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
      return r;
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
      const el = findVisibleTarget(step.target as string);
      if (!el) {
        tries += 1;
        if (tries > 120) {
          // 找不到（数据未加载 / 该端无此入口）→ 居中浮层，仍展示说明
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
        setRect({ top: r0.top, left: r0.left, width: r0.width, height: r0.height });
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
        setRect({ top: r0.top, left: r0.left, width: r0.width, height: r0.height });
        revealAfter(hadRect ? MOVE_MS : 90);
      }
    };
    tick();

    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, [phase, stepIndex, step, location.pathname, navigate]);

  /* —— 视口变化 / 滚动时重新测量高亮框 —— */
  useEffect(() => {
    if (phase !== 'running') return;
    const remeasure = () => {
      setVw(window.innerWidth);
      const el = targetElRef.current;
      if (el && document.contains(el)) {
        const r = el.getBoundingClientRect();
        setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
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
      <div className="kk-tour-root fixed inset-0 z-[80] flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm" style={{ pointerEvents: 'auto' }}>
        <div className="kk-pop kk-glass-2 w-full max-w-sm overflow-hidden rounded-[1.35rem] p-6 shadow-[0_20px_60px_rgba(0,0,0,0.25)]">
          <div className="flex flex-col items-center text-center">
            <span className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-teal-500/15 text-teal-600">
              <Compass className="h-7 w-7" />
            </span>
            <h2 className="text-xl font-bold tracking-tight text-slate-800">欢迎使用咔咔珂</h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-600">
              第一次进来可能有点摸不着头脑？花两三分钟跟着
              <span className="font-semibold text-teal-700">产品导览</span>
              走一遍，带你逐个认识每个功能在哪、怎么点，尤其是最容易绕晕的
              <span className="font-semibold text-teal-700">「连接 + 插件」启用顺序</span>。
            </p>
          </div>
          <div className="mt-6 flex gap-3">
            <Button
              variant="outline"
              className="flex-1 border-slate-300/70 text-slate-600 hover:bg-white/60 hover:text-slate-800"
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

      {/* 高亮聚光框：跨步骤保持挂载，靠 CSS 过渡平移到新目标 */}
      {rect ? (
        <div
          aria-hidden
          className="pointer-events-none absolute"
          style={{
            top: rect.top - pad,
            left: rect.left - pad,
            width: rect.width + pad * 2,
            height: rect.height + pad * 2,
            borderRadius: 16,
            boxShadow:
              '0 0 0 2px rgba(45,212,191,0.95), 0 0 22px 6px rgba(45,212,191,0.35), 0 0 0 9999px rgba(15,23,42,0.55)',
            transition: trackingRef.current
              ? 'none'
              : 'top .34s cubic-bezier(0.22,1,0.36,1), left .34s cubic-bezier(0.22,1,0.36,1), width .34s cubic-bezier(0.22,1,0.36,1), height .34s cubic-bezier(0.22,1,0.36,1)',
          }}
        />
      ) : null}

      {/* 说明卡片：常驻挂载，高亮框移动到位后淡入 */}
      {phase === 'running' ? (
        <div
          ref={cardRef}
          className="kk-glass-2 absolute flex flex-col overflow-y-auto no-scrollbar rounded-[1.25rem] p-4 shadow-[0_16px_48px_rgba(0,0,0,0.24)] sm:p-5"
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
              className="border border-slate-300/60 text-slate-500 hover:bg-rose-500/10 hover:text-rose-600"
            >
              跳过教程
            </Button>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={goPrev} disabled={!hasPrev}>
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
