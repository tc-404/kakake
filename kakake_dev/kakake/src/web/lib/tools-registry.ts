import { Binary, Clapperboard, Footprints, Puzzle, type LucideIcon } from 'lucide-react';

export type ToolId = 'encode' | 'media' | 'plugin-dev' | 'zepp-steps';

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
    description: 'Base64 / URL / Unicode 互转，纯本地处理，离开即清空',
    icon: Binary,
  },
  {
    id: 'media',
    title: '视频解析',
    description: '粘贴链接自动识别 B站 / 抖音 / 小红书 / 快手，不落盘不缓存',
    icon: Clapperboard,
  },
  {
    id: 'plugin-dev',
    title: '插件开发',
    description: 'OneBot11 基础插件教程：JavaScript 直编与 TypeScript 构建',
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
