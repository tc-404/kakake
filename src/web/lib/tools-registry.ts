import { Binary, Clapperboard, Footprints, MessagesSquare, Puzzle, type LucideIcon } from 'lucide-react';

export type ToolId = 'encode' | 'media' | 'plugin-dev' | 'zepp-steps' | 'simulate';

export type ToolMeta = {
  id: ToolId;
  title: string;
  description: string;
  icon: LucideIcon;
};

export const TOOLS_REGISTRY: ToolMeta[] = [
  {
    id: 'simulate',
    title: '模拟消息',
    description: '模拟 OneBot 群聊 / 私聊上报，真实触发已加载插件；插件的发消息与 API 调用被拦截并在此展示，不会真实发送',
    icon: MessagesSquare,
  },
  {
    id: 'encode',
    title: '常用编码转换',
    description: 'Base64 / Base32 / Hex / URL / Unicode / HTML 实体 / 进制 / gzip 互转，纯本地处理',
    icon: Binary,
  },
  {
    id: 'media',
    title: '视频解析',
    description: '粘贴链接自动识别 B站 / 抖音 / 小红书 / 快手 / TikTok / YouTube / X（推特）/ Telegram，不落盘不缓存',
    icon: Clapperboard,
  },
  {
    id: 'plugin-dev',
    title: '插件开发',
    description: 'OneBot11 插件教程四份：总览、野鸡 TS 开发（构建式）、野鸡 JS 开发 ESM 版（export/import）、野鸡 JS 开发 CJS 版（require/module.exports），按需选读',
    icon: Puzzle,
  },
  {
    id: 'zepp-steps',
    title: 'Zepp 步数',
    description: 'Zepp Life 账号步数同步，数据保存在本机 data，可反复使用',
    icon: Footprints,
  },
];

export function getToolMeta(id: string | undefined): ToolMeta | undefined {
  return TOOLS_REGISTRY.find((t) => t.id === id);
}
