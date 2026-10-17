import { Binary, Clapperboard, Puzzle, Shuffle, Wand2, type LucideIcon } from 'lucide-react';

/**
 * 工具 id。'simulate' 只保留类型——侧边栏有「模拟消息」独立入口，
 * 工具页不再重复放卡片，但 /tools/simulate 路由仍然可达。
 */
export type ToolId = 'encode' | 'media' | 'plugin-dev' | 'image-obf' | 'image-edit' | 'simulate';

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
    description: '总览、TS 构建式开发、JS ESM / CJS、QQ 官方（GF-）、双生（sssx-）等教程，按需选读',
    icon: Puzzle,
  },
  {
    id: 'image-obf',
    title: '图片混淆',
    description: '预设 AES 字节加密与像素置乱多种路线，支持自定义密码，兼容任意图片格式，可同密码还原',
    icon: Shuffle,
  },
  {
    id: 'image-edit',
    title: '图片工具箱',
    description: '改分辨率、裁剪、圆角、压缩体积、格式转换（PNG/JPEG/WebP），支持批量与目标体积自动逼近',
    icon: Wand2,
  },
];

export function getToolMeta(id: string | undefined): ToolMeta | undefined {
  return TOOLS_REGISTRY.find((t) => t.id === id);
}
