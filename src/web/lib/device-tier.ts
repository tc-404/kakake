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

export function getPerfMode(): PerfMode {
  try {
    const raw = localStorage.getItem(MODE_KEY);
    if (raw === 'low' || raw === 'normal' || raw === 'auto') return raw;
  } catch {
    return 'auto';
  }
  return 'auto';
}

export function setPerfMode(mode: PerfMode): void {
  try {
    if (mode === 'auto') localStorage.removeItem(MODE_KEY);
    else localStorage.setItem(MODE_KEY, mode);
  } catch {
    void 0;
  }
  calibrated = true;
  emit();
}

function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const classic = /iPad|iPhone|iPod/.test(ua);
  const ipadOS = /Macintosh/.test(ua) && typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 1;
  return classic || ipadOS;
}

function detectStaticLow(): boolean {
  if (isIOS()) return true;
  const nav = navigator as Navigator & { deviceMemory?: number };
  if (typeof nav.hardwareConcurrency === 'number' && nav.hardwareConcurrency > 0 && nav.hardwareConcurrency <= 4) return true;
  if (typeof nav.deviceMemory === 'number' && nav.deviceMemory > 0 && nav.deviceMemory <= 4) return true;
  return false;
}

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
  const delay = typeof window !== 'undefined' && document.visibilityState === 'visible' ? 2500 : 8000;
  window.setTimeout(() => {
    if (document.hidden || getPerfMode() !== 'auto' || currentTier === 'low') return;
    measureFPS((fps) => {
      if (fps > 0 && fps < FPS_LOW_THRESHOLD) emit();
    });
  }, delay);
}

function computeTier(): DeviceTier {
  const mode = getPerfMode();
  if (mode === 'low') return 'low';
  if (mode === 'normal') return 'normal';
  return staticLow ? 'low' : 'normal';
}

const staticLow = detectStaticLow();
currentTier = computeTier();

export function subscribeDeviceTier(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function getDeviceTier(): DeviceTier {
  return currentTier;
}

applyTierClass();
if (typeof window !== 'undefined') {
  window.addEventListener('load', scheduleCalibration, { once: true });
  if (document.readyState === 'complete') scheduleCalibration();
}

export function perfPollMs(baseMs: number): number {
  return getDeviceTier() === 'low' ? baseMs * 3 : baseMs;
}

let softwareRenderer: boolean | undefined;

export function isSoftwareRenderer(): boolean {
  if (softwareRenderer !== undefined) return softwareRenderer;
  if (typeof document === 'undefined') return (softwareRenderer = false);
  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl') || canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
    if (!gl) return (softwareRenderer = true);
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) ?? '');
    softwareRenderer = /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic|mesa offscreen/i.test(name);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    softwareRenderer = false;
  }
  return softwareRenderer;
}
