import { isKakakePluginDir, toKakakePluginDirName } from './plugin-id.js';
import { isGfPluginDir, toGfPluginDirName, GF_PLUGIN_DIR_PREFIX } from './gf-plugin-id.js';
import { isWxPluginDir, toWxPluginDirName, WX_PLUGIN_DIR_PREFIX } from './wx-plugin-id.js';
import { isSsPluginDir, toSsPluginDirName, SS_PLUGIN_DIR_PREFIX } from './ss-plugin-id.js';
import { isSssxPluginDir, toSssxPluginDirName, SSSX_PLUGIN_DIR_PREFIX } from './sssx-plugin-id.js';
import { isKzPluginDir, toKzPluginDirName, KZ_PLUGIN_DIR_PREFIX } from './kz-plugin-id.js';
import { isTgPluginDir, toTgPluginDirName, TG_PLUGIN_DIR_PREFIX } from './tg-plugin-id.js';

export type PluginKind = 'kakake' | 'gf' | 'wx' | 'ss' | 'sssx' | 'kz' | 'tg';

export type PluginRenameErrorCode =
  | 'NAME_EMPTY'
  | 'NAME_INVALID'
  | 'NAME_RESERVED'
  | 'NAME_TOO_LONG'
  | 'NAME_CONFLICT'
  | 'KIND_MISMATCH'
  | 'META_INVALID';

const KIND_PREFIX: Record<PluginKind, string> = {
  kakake: 'kakake-',
  gf: GF_PLUGIN_DIR_PREFIX,
  wx: WX_PLUGIN_DIR_PREFIX,
  ss: SS_PLUGIN_DIR_PREFIX,
  sssx: SSSX_PLUGIN_DIR_PREFIX,
  kz: KZ_PLUGIN_DIR_PREFIX,
  tg: TG_PLUGIN_DIR_PREFIX,
};

const INVALID_CHARS = /[<>:"/\\|?*\u0000-\u001f]/;
const RESERVED_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/;

const DIR_NAME_MAX = 100;
const META_VALUE_MAX = 64;

const NORMALIZERS: Record<PluginKind, (name: string) => string> = {
  kakake: toKakakePluginDirName,
  gf: toGfPluginDirName,
  wx: toWxPluginDirName,
  ss: toSsPluginDirName,
  sssx: toSssxPluginDirName,
  kz: toKzPluginDirName,
  tg: toTgPluginDirName,
};

export function detectPluginKindByPrefix(name: string): PluginKind | null {
  const value = String(name || '').trim();
  if (!value) return null;
  if (isKzPluginDir(value) || /^kz[-_]?plugin/i.test(value)) return 'kz';
  if (isWxPluginDir(value) || /^wx[-_]?plugin/i.test(value) || /^wxbot/i.test(value)) return 'wx';
  if (isTgPluginDir(value) || /^tg[-_]?plugin/i.test(value) || /^tgbot[-_]?plugin/i.test(value)) return 'tg';
  if (isSssxPluginDir(value) || /^sssx[-_]?plugin/i.test(value)) return 'sssx';
  if (isSsPluginDir(value) || /^ss[-_]?plugin/i.test(value)) return 'ss';
  if (isGfPluginDir(value) || /^gf[-_]?plugin/i.test(value)) return 'gf';
  if (isKakakePluginDir(value) || /^napcat[-_]?plugin/i.test(value)) return 'kakake';
  return null;
}

export function buildPluginDirName(kind: PluginKind, raw: string): string {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  return NORMALIZERS[kind](trimmed);
}

export function pluginDirBaseName(kind: PluginKind, dirName: string): string {
  const value = String(dirName || '');
  const prefixes = kind === 'kakake'
    ? ['kakake-plugin-', KIND_PREFIX.kakake]
    : [KIND_PREFIX[kind]];
  for (const prefix of prefixes) {
    if (prefix && value.startsWith(prefix)) return value.slice(prefix.length);
  }
  return value;
}

export function validatePluginDirName(
  kind: PluginKind,
  raw: string,
): { ok: true; dirName: string } | { ok: false; code: PluginRenameErrorCode; message: string } {
  const trimmed = String(raw || '').trim();
  if (!trimmed) {
    return { ok: false, code: 'NAME_EMPTY', message: '插件名字不能为空' };
  }

  const detected = detectPluginKindByPrefix(trimmed);
  if (detected && detected !== kind) {
    return { ok: false, code: 'KIND_MISMATCH', message: '不能改成其它类型的前缀' };
  }

  if (INVALID_CHARS.test(trimmed) || trimmed.includes('..')) {
    return { ok: false, code: 'NAME_INVALID', message: '插件名字含有非法字符' };
  }
  if (/[. ]$/.test(trimmed)) {
    return { ok: false, code: 'NAME_INVALID', message: '插件名字不能以点或空格结尾' };
  }
  if (trimmed.length > DIR_NAME_MAX) {
    return { ok: false, code: 'NAME_TOO_LONG', message: `插件名字不能超过 ${DIR_NAME_MAX} 个字符` };
  }

  let dirName = '';
  try {
    dirName = buildPluginDirName(kind, trimmed);
  } catch {
    return { ok: false, code: 'NAME_INVALID', message: '插件名字含有非法字符' };
  }
  if (!dirName) {
    return { ok: false, code: 'NAME_EMPTY', message: '插件名字不能为空' };
  }
  if (dirName.length > DIR_NAME_MAX) {
    return { ok: false, code: 'NAME_TOO_LONG', message: `插件名字不能超过 ${DIR_NAME_MAX} 个字符` };
  }
  if (INVALID_CHARS.test(dirName) || dirName.includes('..')) {
    return { ok: false, code: 'NAME_INVALID', message: '插件名字含有非法字符' };
  }
  if (/[. ]$/.test(dirName)) {
    return { ok: false, code: 'NAME_INVALID', message: '插件名字不能以点或空格结尾' };
  }

  const base = pluginDirBaseName(kind, dirName);
  if (!base.trim()) {
    return { ok: false, code: 'NAME_EMPTY', message: '插件名字不能为空' };
  }
  if (RESERVED_NAMES.test(base.split('.')[0].trim().toLowerCase())) {
    return { ok: false, code: 'NAME_RESERVED', message: '插件名字与系统保留名冲突' };
  }

  return { ok: true, dirName };
}

export function validateMetaValue(
  raw: string,
): { ok: true; value: string } | { ok: false; code: PluginRenameErrorCode; message: string } {
  const value = String(raw ?? '').trim();
  if (value.length > META_VALUE_MAX) {
    return { ok: false, code: 'META_INVALID', message: `内容不能超过 ${META_VALUE_MAX} 个字符` };
  }
  if (/[\u0000-\u001f]/.test(value)) {
    return { ok: false, code: 'META_INVALID', message: '内容含有非法字符' };
  }
  return { ok: true, value };
}
