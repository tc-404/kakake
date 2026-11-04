import { useId, useMemo, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import {
  getAppearanceSnapshot,
  normalizeWatermark,
  subscribeAppearance,
  watermarkGap,
} from '@/lib/appearance';
import { getPortalRoot } from '@/lib/portal-root';

/**
 * 全站水印：内联 SVG pattern 铺满视口，颜色跟随 --foreground，切主题无需重绘。
 * 挂在 #kk-portal-root（body 层）才能盖住 Portal 弹窗；pointer-events:none。
 */

/** 倾斜角度、间距、字号都由设置页三根滑动条决定（见 lib/appearance.ts 的 RANGES） */
const FONT_WEIGHT = 600;
const FONT_FAMILY = '"DM Sans","PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif';
/** 墨色浓度：颜色取 --foreground，只调这一层不透明度 */
const INK_ALPHA = 0.15;

/**
 * 量文字宽度用的离屏画布：只在文字 / 字号变化时算一次。
 * 不能按「字数 × 字号」估——中英文混排、全角半角宽度差得太多，
 * 估小了水印会互相叠字，估大了中间会空出一大块。
 */
let measureCtx: CanvasRenderingContext2D | null = null;

function measureTextWidth(text: string, fontSize: number): number {
  if (typeof document === 'undefined') return text.length * fontSize;
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  if (!measureCtx) return text.length * fontSize;
  measureCtx.font = `${FONT_WEIGHT} ${fontSize}px ${FONT_FAMILY}`;
  return Math.ceil(measureCtx.measureText(text).width);
}

export function WatermarkLayer() {
  const state = useSyncExternalStore(subscribeAppearance, getAppearanceSnapshot, getAppearanceSnapshot);
  // 空串 = 关闭（设置页把文字清空即等于关掉）
  const text = normalizeWatermark(state.watermarkText);
  const angle = state.watermarkAngle;
  const density = state.watermarkDensity;
  const fontSize = state.watermarkSize;
  /*
   * pattern 的 id 只保留字母数字下划线：React 19 的 useId 会带 «» 这类字符，
   * 直接拼进 url(#…) 有解析风险（CSS 里的 <url> 对这些字符不做兜底）。
   */
  const patternId = `kk-wm-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;

  const tile = useMemo(() => {
    if (!text) return null;
    // 包围盒按绝对角度算：往左斜和往右斜的外接矩形一样大
    const rad = (Math.abs(angle) * Math.PI) / 180;
    const textW = measureTextWidth(text, fontSize);
    const textH = Math.ceil(fontSize * 1.25);
    // 旋转后的包围盒：水印斜着放，格子必须按包围盒给，否则文字会溢出到隔壁格
    const boxW = textW * Math.cos(rad) + textH * Math.sin(rad);
    const boxH = textW * Math.sin(rad) + textH * Math.cos(rad);
    const gap = watermarkGap(density);
    return { width: Math.ceil(boxW + gap.x), height: Math.ceil(boxH + gap.y) };
  }, [text, angle, density, fontSize]);

  if (!text || !tile) return null;

  const cx = tile.width / 2;
  const cy = tile.height / 2;

  return createPortal(
    <div className="kk-watermark" data-kk-watermark={text} aria-hidden="true">
      <svg className="kk-watermark__svg" width="100%" height="100%" focusable="false">
        <defs>
          <pattern
            id={patternId}
            width={tile.width}
            height={tile.height}
            patternUnits="userSpaceOnUse"
          >
            <text
              x={cx}
              y={cy}
              textAnchor="middle"
              dominantBaseline="middle"
              transform={`rotate(${angle} ${cx} ${cy})`}
              style={{
                /* 颜色 = 全局字体角色（--foreground 由 ink 色相/饱和度/明度倍率派生） */
                fill: `hsl(var(--foreground) / ${INK_ALPHA})`,
                fontFamily: FONT_FAMILY,
                fontSize: `${fontSize}px`,
                fontWeight: FONT_WEIGHT,
                letterSpacing: '0.04em',
              }}
            >
              {text}
            </text>
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill={`url(#${patternId})`} />
      </svg>
    </div>,
    getPortalRoot(),
  );
}
