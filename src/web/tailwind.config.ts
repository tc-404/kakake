import type { Config } from 'tailwindcss';
import animate from 'tailwindcss-animate';
import { ACCENT_RAMP, INK_RAMP, type RampSpec } from './lib/color-ramp';

/**
 * 三条色阶全部改为从调色变量派生：
 * - teal（组件与按钮）  ← --kk-comp-*
 * - slate（全局字体）    ← --kk-ink-*
 * - brand（品牌 Logo）   ← --kk-logo-*
 *
 * 每档写成 [明度%, 浓度倍率]：档位之间的明度比例沿用 Tailwind 原色阶，
 * 整体再乘设置页给的明度倍率，因此换色不会破坏原有的对比度层次。
 *
 * 两套取值：
 * 1. **单色**（默认）：色相 / 饱和度由 `--kk-<role>-h` / `-s` 整条色阶共用；
 * 2. **渐变**（设置页给该角色选了渐变色）：运行时把 `--kk-<role>-<档>-hs`
 *    逐档写到 <html> 上（见 lib/appearance.ts 的 applyGradientTokens），
 *    档位取渐变上对应位置的颜色 —— 于是整条色阶（浅底、描边、深字、悬停）
 *    都跟着渐变走，而不是只有一个"代表色"跟着变。
 *    变量没写时自动回落到单色公式（var() 的 fallback），所以两种状态共用一份配置。
 *
 * 明度都挂着 var(--kk-dark)（波浪背景预设时置 1，见 globals.css）：
 * - ink（slate）：整体**反相** —— text-slate-800 这类既有深色字在暗色下自动变浅色字，
 *   bg-slate-100 这类浅色底自动变深色底，全站不用逐处加 dark: 变体；
 * - accent（teal / brand）：不反相，只朝中间亮度收敛一档，暗底上依旧鲜艳可辨。
 */
type Ramp = RampSpec;

/**
 * ink 最浅两档的明度上限（仅浅色主题会碰到）：
 *
 * 明度倍率是乘法，浅色字体（lmul 1.2）会把 300 档从 84% 推到 98%——
 * 插件卡片的禁用「说明」、空状态图标、AI 会话操作图标全部变成近白色，
 * 看上去就是「有按钮但完全透明」；200 档的描边也会跟着消失。
 * 这两档在色阶里本来就只承担「很淡但仍可见」的角色，给一个上限即可；
 * 暗色主题下它们走反相（约 10–20%），不会受这个上限影响。
 */
const INK_LIGHT_CAP: Record<number, number> = { 200: 92, 300: 86 };

function ramp(prefix: string, spec: Ramp, mode: 'ink' | 'accent'): Record<string, string> {
  return Object.fromEntries(
    Object.entries(spec).map(([shade, [lightness, satScale]]) => {
      // 明度随 --kk-dark 的迁移式（d = 0 时光明度即原值）：
      //   ink:    L' = L + (100 - 2L)·d          —— d=1 时严格反相（L → 100-L）
      //   accent: L' = L + (72 - L)·0.45·d       —— d=1 时向 72% 收敛 45%，保持色相与鲜艳度
      const lightnessExpr = mode === 'ink'
        ? `calc(${lightness}% + (100% - ${lightness}% * 2) * var(--kk-dark, 0))`
        : `calc(${lightness}% + (72% - ${lightness}%) * 0.45 * var(--kk-dark, 0))`;
      /*
       * 单色态分量：色相直接取角色色相，饱和度乘档位倍率（浅档略淡、深档略浓）。
       * 它同时是 hsl() 里 var() 的 fallback —— 渐变没启用时走这条路，观感与改动前一致。
       */
      const mono = `var(${prefix}-h) min(100%, calc(var(${prefix}-s) * ${satScale}))`;
      const cap = mode === 'ink' ? (INK_LIGHT_CAP[Number(shade)] ?? 98) : 98;
      return [
        shade,
        `hsl(var(${prefix}-${shade}-hs, ${mono}) min(${cap}%, calc((${lightnessExpr}) * var(${prefix}-lmul))) / <alpha-value>)`,
      ];
    }),
  );
}

const config: Config = {
  darkMode: ['class'],
  content: [
    './index.html',
    './main.tsx',
    './App.tsx',
    './pages/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        teal: {
          ...ramp('--kk-comp', ACCENT_RAMP, 'accent'),
          /*
           * 400 / 500 两档不走 HSL 公式，直接绑到组件色双通道：
           * - --kk-comp-rgb   = 单色派生（组件色本身）或渐变**首站**色标（applyGradientTokens）
           * - --kk-comp-alt-rgb = 单色派生（色相 +23°）或渐变**末站**色标
           * 于是 bg-teal-500 / from-teal-500 to-teal-400 这类填充与双色渐变面，
           * 在「组件及按钮」选了渐变后呈现的是用户自定义渐变的真实两端色，
           * 未启用渐变时与原公式取值几乎一致（明度公式相同），零回归。
           */
          400: 'rgb(var(--kk-comp-alt-rgb) / <alpha-value>)',
          500: 'rgb(var(--kk-comp-rgb) / <alpha-value>)',
        },
        /*
         * 品牌 Logo 色阶：品牌字、侧栏图标之外的"第二强调色"。
         * 面板里大量装饰性分类色（统计卡、系统信息图标、次要强调块）改用它，
         * 「Logo」那张调色卡才真正管得到界面，而不只是顶部几个字。
         */
        brand: {
          ...ramp('--kk-logo', ACCENT_RAMP, 'accent'),
          400: 'rgb(var(--kk-logo-alt-rgb) / <alpha-value>)',
          500: 'rgb(var(--kk-logo-rgb) / <alpha-value>)',
        },
        slate: ramp('--kk-ink', INK_RAMP, 'ink'),
        /*
         * 语义 token 统一带 <alpha-value>：变量本身是 "h s% l%" 通道串，
         * 补上占位符之后 bg-success/15、hover:border-primary/35 这类透明度写法才真的生效
         * （缺了它，Tailwind 只能整条颜色原样输出，斜杠后面的浓度会被静默丢掉）。
         */
        border: 'hsl(var(--border) / <alpha-value>)',
        input: 'hsl(var(--input) / <alpha-value>)',
        ring: 'hsl(var(--ring) / <alpha-value>)',
        background: 'hsl(var(--background) / <alpha-value>)',
        foreground: 'hsl(var(--foreground) / <alpha-value>)',
        primary: {
          DEFAULT: 'hsl(var(--primary) / <alpha-value>)',
          foreground: 'hsl(var(--primary-foreground) / <alpha-value>)',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary) / <alpha-value>)',
          foreground: 'hsl(var(--secondary-foreground) / <alpha-value>)',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive) / <alpha-value>)',
          foreground: 'hsl(var(--destructive-foreground) / <alpha-value>)',
        },
        success: {
          DEFAULT: 'hsl(var(--success) / <alpha-value>)',
          foreground: 'hsl(var(--success-foreground) / <alpha-value>)',
        },
        warning: {
          DEFAULT: 'hsl(var(--warning) / <alpha-value>)',
          foreground: 'hsl(var(--warning-foreground) / <alpha-value>)',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted) / <alpha-value>)',
          foreground: 'hsl(var(--muted-foreground) / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent) / <alpha-value>)',
          foreground: 'hsl(var(--accent-foreground) / <alpha-value>)',
        },
        card: {
          DEFAULT: 'hsl(var(--card) / <alpha-value>)',
          foreground: 'hsl(var(--card-foreground) / <alpha-value>)',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      /**
       * 阴影整套改为由 --kk-shadow-alpha（设置页「阴影透明度」）派生。
       *
       * 之前这里用的是 Tailwind 出厂值（清一色 rgba(0,0,0,.05~.25)），是写死的——
       * 于是「阴影透明度」这根滑块只管得住 .kk-glass / .kk-glass-2 这类组件层材质，
       * 页面上几十处 shadow-sm / md / lg、以及悬浮窗**内部**的卡片与控件统统不跟着动。
       *
       * 倍率是按出厂值 0.14 反推的，保证默认观感不变：
       *   sm / inner 原 0.05 → ×0.36      md / lg / xl 原 0.10 → ×0.71      2xl 原 0.25 → ×1.79
       * 墨色沿用组件层同一支 rgb(15 40 60)（原来是纯黑，默认浓度下肉眼无差）。
       *
       * 注意 shadow-<颜色> 的用法（如 shadow-md shadow-teal-500/30）走的是 Tailwind 的
       * --tw-shadow-colored 分支，颜色被 var(--tw-shadow-color) 替换、不含这里的 alpha，
       * 所以行为与改动前完全一致，不会被这次改动影响。
       */
      boxShadow: {
        sm: '0 1px 2px 0 rgb(15 40 60 / calc(var(--kk-shadow-alpha, 0.14) * 0.36))',
        DEFAULT: '0 1px 3px 0 rgb(15 40 60 / calc(var(--kk-shadow-alpha, 0.14) * 0.71)), 0 1px 2px -1px rgb(15 40 60 / calc(var(--kk-shadow-alpha, 0.14) * 0.71))',
        md: '0 4px 6px -1px rgb(15 40 60 / calc(var(--kk-shadow-alpha, 0.14) * 0.71)), 0 2px 4px -2px rgb(15 40 60 / calc(var(--kk-shadow-alpha, 0.14) * 0.71))',
        lg: '0 10px 15px -3px rgb(15 40 60 / calc(var(--kk-shadow-alpha, 0.14) * 0.71)), 0 4px 6px -4px rgb(15 40 60 / calc(var(--kk-shadow-alpha, 0.14) * 0.71))',
        xl: '0 20px 25px -5px rgb(15 40 60 / calc(var(--kk-shadow-alpha, 0.14) * 0.71)), 0 8px 10px -6px rgb(15 40 60 / calc(var(--kk-shadow-alpha, 0.14) * 0.71))',
        '2xl': '0 25px 50px -12px rgb(15 40 60 / calc(var(--kk-shadow-alpha, 0.14) * 1.79))',
        inner: 'inset 0 2px 4px 0 rgb(15 40 60 / calc(var(--kk-shadow-alpha, 0.14) * 0.36))',
        none: 'none',
      },
      fontFamily: {
        sans: ['"DM Sans"', '"PingFang SC"', '"Hiragino Sans GB"', '"Microsoft YaHei"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      /**
       * 全站动效时长统一乘 --kk-motion（设置页「组件速度」写入）。
       * tailwindcss-animate 的 animationDuration 继承自这里，
       * 所以 Radix 弹窗的 animate-in / animate-out 也一并受控。
       */
      transitionDuration: {
        DEFAULT: 'calc(150ms * var(--kk-motion, 1))',
        0: '0ms',
        75: 'calc(75ms * var(--kk-motion, 1))',
        100: 'calc(100ms * var(--kk-motion, 1))',
        150: 'calc(150ms * var(--kk-motion, 1))',
        200: 'calc(200ms * var(--kk-motion, 1))',
        300: 'calc(300ms * var(--kk-motion, 1))',
        500: 'calc(500ms * var(--kk-motion, 1))',
        700: 'calc(700ms * var(--kk-motion, 1))',
        1000: 'calc(1000ms * var(--kk-motion, 1))',
      },
    },
  },
  plugins: [animate],
};

export default config;
