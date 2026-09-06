import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../paths.js';

/** 背景图分两套：竖屏与横屏是各自独立的图，互不覆盖 */
export type BackgroundOrientation = 'portrait' | 'landscape';

export const BACKGROUND_ORIENTATIONS: readonly BackgroundOrientation[] = ['portrait', 'landscape'];

/** 单张背景图上限 10MB，前后端都拦一次 */
export const BACKGROUND_MAX_BYTES = 10 * 1024 * 1024;

export interface AppearanceSettings {
  /** 动效速度倍率：1 = 默认，越大越快 */
  uiSpeed: number;
  /** 组件卡片底色不透明度（0–1） */
  cardOpacity: number;
  /** 组件毛玻璃模糊半径（px） */
  cardBlur: number;
  /** 背景图模糊半径（px） */
  backgroundBlur: number;
  /**
   * 三个可调色角色，各自一组 HSV：
   * ink = 全局字体、comp = 组件与按钮、logo = 品牌标识。
   * 色相 0–360，饱和度与明度 0–100，与标准拾色器的取值一致。
   */
  inkHue: number;
  inkSat: number;
  inkVal: number;
  compHue: number;
  compSat: number;
  compVal: number;
  logoHue: number;
  logoSat: number;
  logoVal: number;
}

export interface BackgroundMeta {
  ext: string;
  mime: string;
  size: number;
  /** 文件 mtime，前端用它做图片 URL 的缓存刷新参数 */
  updatedAt: number;
}

export interface AppearanceState extends AppearanceSettings {
  backgrounds: Record<BackgroundOrientation, BackgroundMeta | null>;
}

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  uiSpeed: 1,
  cardOpacity: 0.32,
  cardBlur: 22,
  backgroundBlur: 0,
  // 默认值等价于原来的 HSL 青色主色与石板色文字，未调色时观感完全不变
  // （HSV(215,33,60) ≈ HSL(215,20%,50%)，HSV(173,89,90) ≈ HSL(173,80%,50%)）
  inkHue: 215,
  inkSat: 33,
  inkVal: 60,
  compHue: 173,
  compSat: 89,
  compVal: 90,
  logoHue: 173,
  logoSat: 89,
  logoVal: 90,
};

/** [最小值, 最大值, 保留小数位]，与前端滑动条区间保持一致 */
const RANGES: Record<keyof AppearanceSettings, [number, number, number]> = {
  uiSpeed: [0.5, 2.5, 2],
  cardOpacity: [0.05, 0.85, 2],
  cardBlur: [0, 40, 0],
  backgroundBlur: [0, 40, 0],
  inkHue: [0, 360, 0],
  inkSat: [0, 100, 0],
  inkVal: [0, 100, 0],
  compHue: [0, 360, 0],
  compSat: [0, 100, 0],
  compVal: [0, 100, 0],
  logoHue: [0, 360, 0],
  logoSat: [0, 100, 0],
  logoVal: [0, 100, 0],
};

function clampSetting(key: keyof AppearanceSettings, value: unknown): number {
  const [min, max, digits] = RANGES[key];
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_APPEARANCE[key];
  const clamped = Math.min(max, Math.max(min, n));
  const factor = 10 ** digits;
  return Math.round(clamped * factor) / factor;
}

/** 0.4.13 之前颜色只有 accentHue/accentSat（HSL 语义，明度固定 50%），迁移成 HSV 并分给组件色与 Logo 色 */
interface LegacyColorFields {
  accentHue?: unknown;
  accentSat?: unknown;
}

function hslMidToHsv(sat: number): { s: number; v: number } {
  // 由 HSL(h, sat%, 50%) 反推 HSV：V = 0.5 + sat/2，S = 2 * (1 - 0.5 / V)
  const s = Math.min(1, Math.max(0, sat / 100));
  const v = 0.5 + s / 2;
  return { s: v === 0 ? 0 : 2 * (1 - 0.5 / v) * 100, v: v * 100 };
}

function migrateLegacy(src: Partial<AppearanceSettings> & LegacyColorFields): Partial<AppearanceSettings> {
  const out: Partial<AppearanceSettings> = { ...src };
  if (src.compHue !== undefined || src.accentHue === undefined) return out;
  const hue = Number(src.accentHue);
  const { s, v } = hslMidToHsv(Number(src.accentSat ?? 80));
  out.compHue = hue;
  out.compSat = s;
  out.compVal = v;
  out.logoHue = hue;
  out.logoSat = s;
  out.logoVal = v;
  return out;
}

export function normalizeAppearance(
  raw: (Partial<AppearanceSettings> & LegacyColorFields) | null | undefined,
): AppearanceSettings {
  const src = migrateLegacy(raw ?? {});
  const out = {} as AppearanceSettings;
  // 按 RANGES 逐项收口：只认已知字段，越界与非数字都退回默认值
  for (const key of Object.keys(RANGES) as (keyof AppearanceSettings)[]) {
    out[key] = clampSetting(key, src[key] ?? DEFAULT_APPEARANCE[key]);
  }
  return out;
}

export function isBackgroundOrientation(value: unknown): value is BackgroundOrientation {
  return value === 'portrait' || value === 'landscape';
}

type Sniffed = { ext: string; mime: string };

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
};

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * 按文件头判定图片类型，不信任上传时声明的 Content-Type / 扩展名。
 * 只放常见位图；SVG 可内嵌脚本，同源直开有 XSS 风险，故不收。
 */
export function sniffImage(head: Buffer): Sniffed | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return { ext: 'jpg', mime: MIME_BY_EXT.jpg };
  }
  if (head.length >= 8 && head.subarray(0, 8).equals(PNG_MAGIC)) {
    return { ext: 'png', mime: MIME_BY_EXT.png };
  }
  if (head.length >= 6 && head.subarray(0, 4).toString('latin1') === 'GIF8') {
    return { ext: 'gif', mime: MIME_BY_EXT.gif };
  }
  if (
    head.length >= 12
    && head.subarray(0, 4).toString('latin1') === 'RIFF'
    && head.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return { ext: 'webp', mime: MIME_BY_EXT.webp };
  }
  if (head.length >= 2 && head[0] === 0x42 && head[1] === 0x4d) {
    return { ext: 'bmp', mime: MIME_BY_EXT.bmp };
  }
  if (head.length >= 12 && head.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = head.subarray(8, 12).toString('latin1');
    if (brand === 'avif' || brand === 'avis') return { ext: 'avif', mime: MIME_BY_EXT.avif };
  }
  return null;
}

function readHead(filePath: string, length = 16): Buffer {
  const buf = Buffer.alloc(length);
  const fd = fs.openSync(filePath, 'r');
  try {
    const read = fs.readSync(fd, buf, 0, length, 0);
    return buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

export class AppearanceService {
  private get dir(): string {
    return PATHS.appearanceDir;
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
  }

  getSettings(): AppearanceSettings {
    if (!fs.existsSync(PATHS.appearance)) return { ...DEFAULT_APPEARANCE };
    try {
      const raw = JSON.parse(fs.readFileSync(PATHS.appearance, 'utf-8')) as Partial<AppearanceSettings> & LegacyColorFields;
      return normalizeAppearance(raw);
    } catch {
      return { ...DEFAULT_APPEARANCE };
    }
  }

  saveSettings(raw: Partial<AppearanceSettings>): AppearanceSettings {
    const next = normalizeAppearance({ ...this.getSettings(), ...raw });
    this.ensureDir();
    fs.writeFileSync(PATHS.appearance, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
    return next;
  }

  /** 背景图实际落盘文件；类型未知时返回 null，元信息一律以磁盘为准 */
  findBackgroundFile(orientation: BackgroundOrientation): { path: string; meta: BackgroundMeta } | null {
    if (!fs.existsSync(this.dir)) return null;
    for (const ext of Object.keys(MIME_BY_EXT)) {
      const abs = path.join(this.dir, `background-${orientation}.${ext}`);
      if (!fs.existsSync(abs)) continue;
      const st = fs.statSync(abs);
      return {
        path: abs,
        meta: {
          ext,
          mime: MIME_BY_EXT[ext],
          size: st.size,
          updatedAt: Math.floor(st.mtimeMs),
        },
      };
    }
    return null;
  }

  getState(): AppearanceState {
    return {
      ...this.getSettings(),
      backgrounds: {
        portrait: this.findBackgroundFile('portrait')?.meta ?? null,
        landscape: this.findBackgroundFile('landscape')?.meta ?? null,
      },
    };
  }

  /**
   * 收下一张临时文件作为背景图：校验大小与真实图片类型后原子替换。
   * 无论成败都会清掉临时文件。
   */
  adoptBackground(
    orientation: BackgroundOrientation,
    tempPath: string,
  ): { ok: true; meta: BackgroundMeta } | { ok: false; message: string } {
    try {
      const st = fs.statSync(tempPath);
      if (st.size === 0) return { ok: false, message: '文件为空' };
      if (st.size > BACKGROUND_MAX_BYTES) return { ok: false, message: '图片超过 10MB' };

      const kind = sniffImage(readHead(tempPath));
      if (!kind) return { ok: false, message: '不支持该图片格式' };

      this.ensureDir();
      this.removeBackground(orientation);
      const dest = path.join(this.dir, `background-${orientation}.${kind.ext}`);
      fs.renameSync(tempPath, dest);
      const saved = fs.statSync(dest);
      return {
        ok: true,
        meta: {
          ext: kind.ext,
          mime: kind.mime,
          size: saved.size,
          updatedAt: Math.floor(saved.mtimeMs),
        },
      };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    } finally {
      if (fs.existsSync(tempPath)) {
        try {
          fs.unlinkSync(tempPath);
        } catch { /* 已被 rename 掉或占用，忽略 */ }
      }
    }
  }

  removeBackground(orientation: BackgroundOrientation): boolean {
    let removed = false;
    if (!fs.existsSync(this.dir)) return removed;
    for (const ext of Object.keys(MIME_BY_EXT)) {
      const abs = path.join(this.dir, `background-${orientation}.${ext}`);
      if (!fs.existsSync(abs)) continue;
      try {
        fs.unlinkSync(abs);
        removed = true;
      } catch { /* 忽略删除失败，交由上层返回当前状态 */ }
    }
    return removed;
  }

  /** 恢复默认：参数回默认值 + 清空两张背景图 */
  reset(): AppearanceState {
    for (const orientation of BACKGROUND_ORIENTATIONS) this.removeBackground(orientation);
    this.saveSettings({ ...DEFAULT_APPEARANCE });
    return this.getState();
  }
}

export const appearanceService = new AppearanceService();