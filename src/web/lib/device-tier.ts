/**
 * 设备能力判定与「性能模式」。
 *
 * 三层漏斗：
 * 1. 加载时静态判定：CPU 逻辑核 ≤4 或内存档 ≤4GB → 低端；iOS Safari 默认降档；
 * 2. 首屏后动态校准：实测 1.2s rAF 帧率 <45fps → 升级为低端（仅 auto 模式、且静态判定为 normal 时）；
 * 3. 用户手动覆盖：设置页三态开关（auto / low / normal），记忆到 localStorage。
 *
 * 判定结果只影响视觉层（backdrop-filter / 氛围动画 / 视频背景），
 * 通过 html 根元素的 .kk-lowtier 类驱动 CSS 降级，不动任何功能。
 */

export type PerfMode = 'auto' | 'low' | 'normal';
export type DeviceTier = 'low' | 'normal';

const MODE_KEY = 'kk-perf-mode';
const FPS_SAMPLE_MS = 1200;
const FPS_LOW_THRESHOLD = 45;

let currentTier: DeviceTier = 'normal';
let calibrated = false;
const listeners = new Set<() => void>();

function emit(): void {
  currentTier = computeTier();
  applyTierClass();
  for (const fn of listeners) fn();
}

function applyTierClass(): void {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle('kk-lowtier', currentTier === 'low');
}

/* ─────────── 用户手动模式 ─────────── */

export function getPerfMode(): PerfMode {
  try {
    const raw = localStorage.getItem(MODE_KEY);
    if (raw === 'low' || raw === 'normal' || raw === 'auto') return raw;
  } catch { /* 隐私模式等 localStorage 不可用，按 auto */ }
  return 'auto';
}

export function setPerfMode(mode: PerfMode): void {
  try {
    if (mode === 'auto') localStorage.removeItem(MODE_KEY);
    else localStorage.setItem(MODE_KEY, mode);
  } catch { /* 写不进就只影响本次会话 */ }
  calibrated = true; // 手动选择后不再做动态校准
  emit();
}

/* ─────────── 静态判定 ─────────── */

function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const classic = /iPad|iPhone|iPod/.test(ua);
  // iPadOS 13+ 桌面版 UA（Macintosh + 触屏）
  const ipadOS = /Macintosh/.test(ua) && typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 1;
  return classic || ipadOS;
}

function detectStaticLow(): boolean {
  if (isIOS()) return true; // iOS Safari 拿不到硬件信号，默认降一档保流畅
  const nav = navigator as Navigator & { deviceMemory?: number };
  if (typeof nav.hardwareConcurrency === 'number' && nav.hardwareConcurrency > 0 && nav.hardwareConcurrency <= 4) return true;
  if (typeof nav.deviceMemory === 'number' && nav.deviceMemory > 0 && nav.deviceMemory <= 4) return true;
  return false;
}

/* ─────────── 动态校准：rAF 实测帧率 ─────────── */

function measureFPS(onDone: (fps: number) => void): void {
  if (typeof requestAnimationFrame !== 'function') return;
  let frames = 0;
  const start = performance.now();
  const tick = (now: number) => {
    frames += 1;
    if (now - start >= FPS_SAMPLE_MS) {
      onDone(Math.round((frames * 1000) / (now - start)));
      return;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function scheduleCalibration(): void {
  if (calibrated || getPerfMode() !== 'auto' || currentTier === 'low') return;
  calibrated = true;
  // 等首屏渲染与网络高峰过去再测，避免把加载中的掉帧误判为设备弱
  const delay = typeof window !== 'undefined' && document.visibilityState === 'visible' ? 2500 : 8000;
  window.setTimeout(() => {
    if (document.hidden || getPerfMode() !== 'auto' || currentTier === 'low') return;
    measureFPS((fps) => {
      if (fps > 0 && fps < FPS_LOW_THRESHOLD) emit(); // 静态 normal → 动态判低端
    });
  }, delay);
}

/* ─────────── 对外快照接口（useSyncExternalStore 友好） ─────────── */

function computeTier(): DeviceTier {
  const mode = getPerfMode();
  if (mode === 'low') return 'low';
  if (mode === 'normal') return 'normal';
  return staticLow ? 'low' : 'normal';
}

const staticLow = detectStaticLow();
currentTier = computeTier();

/** 订阅判定结果变化（供 React useSyncExternalStore / 设置页展示用） */
export function subscribeDeviceTier(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getDeviceTier(): DeviceTier {
  return currentTier;
}

/** 模块加载即生效：首帧渲染前就挂好降级类，低端设备不会先闪一帧重特效 */
applyTierClass();
if (typeof window !== 'undefined') {
  window.addEventListener('load', scheduleCalibration, { once: true });
  // load 已错过（脚本晚于 load 执行）就立即调度
  if (document.readyState === 'complete') scheduleCalibration();
}
