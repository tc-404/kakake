import { Binary, Clapperboard, Puzzle, Shuffle, Wand2, type LucideIcon } from 'lucide-react';

/**
 * 工具 id。'simulate' 只保留类型——侧边栏有「模拟消息」独立入口，
 * 工具页不再重复放卡片，但 /tools/simulate 路由仍然可达。
 */
export type ToolId = 'encode' | 'media' | 'plugin-dev' | 'image-obf' | 'image-edit' | 'simulate';

export type ToolMeta = {
  id: ToolId;
  titleKey: string;
  descKey: string;
  icon: LucideIcon;
};

export const TOOLS_REGISTRY: ToolMeta[] = [
  {
    id: 'encode',
    titleKey: 'tools.hubEncodeTitle',
    descKey: 'tools.hubEncodeDesc',
    icon: Binary,
  },
  {
    id: 'media',
    titleKey: 'tools.hubMediaTitle',
    descKey: 'tools.hubMediaDesc',
    icon: Clapperboard,
  },
  {
    id: 'plugin-dev',
    titleKey: 'tools.hubPluginDevTitle',
    descKey: 'tools.hubPluginDevDesc',
    icon: Puzzle,
  },
  {
    id: 'image-obf',
    titleKey: 'tools.hubImageObfTitle',
    descKey: 'tools.hubImageObfDesc',
    icon: Shuffle,
  },
  {
    id: 'image-edit',
    titleKey: 'tools.hubImageEditTitle',
    descKey: 'tools.hubImageEditDesc',
    icon: Wand2,
  },
];

export function getToolMeta(id: string | undefined): ToolMeta | undefined {
  return TOOLS_REGISTRY.find((t) => t.id === id);
}
