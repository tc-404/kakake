import type { Config } from 'tailwindcss';
import animate from 'tailwindcss-animate';

/**
 * teal（组件与按钮）与 slate（全局字体）两条色阶改为从调色变量派生。
 * 每档写成 [明度%, 浓度倍率]：档位之间的明度比例沿用 Tailwind 原色阶，
 * 整体再乘设置页给的明度倍率，因此换色不会破坏原有的对比度层次。
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

function ramp(prefix: string, spec: Ramp): Record<string, string> {
  return Object.fromEntries(
    Object.entries(spec).map(([shade, [lightness, satScale]]) => [
      shade,
      `hsl(var(${prefix}-h) min(100%, calc(var(${prefix}-s) * ${satScale}))`
      + ` min(98%, calc(${lightness}% * var(${prefix}-lmul))) / <alpha-value>)`,
    ]),
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
        teal: ramp('--kk-comp', ACCENT_RAMP),
        slate: ramp('--kk-ink', INK_RAMP),
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
