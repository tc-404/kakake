import { Binary, Clapperboard, Puzzle, type LucideIcon } from 'lucide-react';

/**
 * 工具 id。'simulate' 只保留类型——侧边栏有「模拟消息」独立入口，
 * 工具页不再重复放卡片，但 /tools/simulate 路由仍然可达。
 */
export type ToolId = 'encode' | 'media' | 'plugin-dev' | 'simulate';

export type ToolMeta = {
  id: ToolId;
  title: string;
  description: string;
  icon: LucideIcon;
};

export const TOOLS_REGISTRY: ToolMeta[] = [
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
];

export function getToolMeta(id: string | undefined): ToolMeta | undefined {
  return TOOLS_REGISTRY.find((t) => t.id === id);
}
