import type { Config } from 'tailwindcss';
import animate from 'tailwindcss-animate';

/**
 * teal（组件与按钮）与 slate（全局字体）两条色阶改为从调色变量派生。
 * 每档写成 [明度%, 浓度倍率]：档位之间的明度比例沿用 Tailwind 原色阶，
 * 整体再乘设置页给的明度倍率，因此换色不会破坏原有的对比度层次。
 *
 * 明度都挂着 var(--kk-dark)（波浪背景预设时置 1，见 globals.css）：
 * - ink（slate）：整体**反相** —— text-slate-800 这类既有深色字在暗色下自动变浅色字，
 *   bg-slate-100 这类浅色底自动变深色底，全站不用逐处加 dark: 变体；
 * - accent（teal）：不反相，只朝中间亮度收敛一档，暗底上依旧鲜艳可辨。
 */
type Ramp = Record<string, [number, number]>;

const ACCENT_RAMP: Ramp = {
  50: [97, 0.95], 100: [89, 1.06], 200: [78, 1.05], 300: [64, 0.96],
  400: [50, 0.83], 500: [40, 1], 600: [32, 1.05], 700: [26, 0.96],
  800: [22, 0.86], 900: [19, 0.76], 950: [10, 1.05],
};

const INK_RAMP: Ramp = {
  50: [98, 2], 100: [96, 2], 200: [91, 1.6], 300: [84, 1.35],
  400: [65, 1], 500: [47, 0.8], 600: [35, 0.95], 700: [27, 1.25],
  800: [17, 1.65], 900: [11, 2.35], 950: [5, 4.2],
};

function ramp(prefix: string, spec: Ramp, mode: 'ink' | 'accent'): Record<string, string> {
  return Object.fromEntries(
    Object.entries(spec).map(([shade, [lightness, satScale]]) => {
      // 明度随 --kk-dark 的迁移式（d = 0 时光明度即原值）：
      //   ink:    L' = L + (100 - 2L)·d          —— d=1 时严格反相（L → 100-L）
      //   accent: L' = L + (72 - L)·0.45·d       —— d=1 时向 72% 收敛 45%，保持色相与鲜艳度
      const lightnessExpr = mode === 'ink'
        ? `calc(${lightness}% + (100% - ${lightness}% * 2) * var(--kk-dark, 0))`
        : `calc(${lightness}% + (72% - ${lightness}%) * 0.45 * var(--kk-dark, 0))`;
      return [
        shade,
        `hsl(var(${prefix}-h) min(100%, calc(var(${prefix}-s) * ${satScale}))`
        + ` min(98%, calc((${lightnessExpr}) * var(${prefix}-lmul))) / <alpha-value>)`,
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
        teal: ramp('--kk-comp', ACCENT_RAMP, 'accent'),
        slate: ramp('--kk-ink', INK_RAMP, 'ink'),
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        success: {
          DEFAULT: 'hsl(var(--success))',
          foreground: 'hsl(var(--success-foreground))',
        },
        warning: {
          DEFAULT: 'hsl(var(--warning))',
          foreground: 'hsl(var(--warning-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
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
