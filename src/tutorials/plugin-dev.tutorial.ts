import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../paths.js';

export type PluginDevFilePayload = {
  path: string;
  title: string;
  downloadName: string;
  language: string;
  content: string;
  /** 控制台代码块上方的分步小标题（可选） */
  heading?: string;
};

/** 目录卡片文案（控制台「工具 → 插件开发」首屏的三张卡） */
export type PluginDevCardPayload = {
  title: string;
  subtitle: string;
  description: string;
};

export type PluginDevTrackPayload = {
  id: string;
  label: string;
  /** 卡片文案；缺省时由 label / dir 兜底 */
  cardTitle: string;
  cardSubtitle: string;
  cardDescription: string;
  dir: string;
  guide: string;
  guideMarkdown: string;
  files: PluginDevFilePayload[];
};

export type PluginDevTutorialPayload = {
  introMarkdown: string;
  introCard: PluginDevCardPayload;
  tracks: PluginDevTrackPayload[];
};

type ManifestFile = {
  path: string;
  title: string;
  downloadName: string;
  language?: string;
  heading?: string;
};

type ManifestTrack = {
  id: string;
  label: string;
  /** 卡片标题（缺省用 label） */
  cardTitle?: string;
  /** 卡片副标题（缺省用 label） */
  cardSubtitle?: string;
  /** 卡片说明（缺省留空） */
  cardDescription?: string;
  dir: string;
  guide: string;
  files: ManifestFile[];
};

type Manifest = {
  intro: string;
  introCard?: { title?: string; subtitle?: string; description?: string };
  tracks: ManifestTrack[];
};

function tutorialsPluginDevRoot(): string {
  return path.join(PATHS.tutorials, '插件开发');
}

/** 只允许读教程根目录内的相对路径 */
function resolveUnderRoot(root: string, rel: string): string | null {
  const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean || clean.includes('..')) return null;
  const abs = path.resolve(root, ...clean.split('/'));
  const rootResolved = path.resolve(root);
  if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) return null;
  return abs;
}

function readTextFile(abs: string): string {
  return fs.readFileSync(abs, 'utf-8');
}

export function loadPluginDevTutorial(): PluginDevTutorialPayload {
  const root = tutorialsPluginDevRoot();
  const manifestPath = path.join(root, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error('教程文件未找到：manifest.json');
  }

  let manifest: Manifest;
  try {
    manifest = JSON.parse(readTextFile(manifestPath)) as Manifest;
  } catch {
    throw new Error('教程 manifest.json 解析失败');
  }

  const introRel = String(manifest.intro || '前言.md');
  const introAbs = resolveUnderRoot(root, introRel);
  if (!introAbs || !fs.existsSync(introAbs)) {
    throw new Error(`教程文件未找到：${introRel}`);
  }

  const tracks: PluginDevTrackPayload[] = [];
  for (const track of manifest.tracks || []) {
    const trackDir = String(track.dir || '');
    const guideRel = path.posix.join(trackDir, String(track.guide || '说明.md'));
    const guideAbs = resolveUnderRoot(root, guideRel);
    if (!guideAbs || !fs.existsSync(guideAbs)) {
      throw new Error(`教程文件未找到：${guideRel}`);
    }

    const files: PluginDevFilePayload[] = [];
    for (const f of track.files || []) {
      const fileRel = path.posix.join(trackDir, String(f.path || ''));
      const fileAbs = resolveUnderRoot(root, fileRel);
      if (!fileAbs || !fs.existsSync(fileAbs)) {
        throw new Error(`教程文件未找到：${fileRel}`);
      }
      files.push({
        path: fileRel,
        title: String(f.title || f.path || ''),
        downloadName: String(f.downloadName || path.posix.basename(f.path || 'file.txt')),
        language: String(f.language || 'text'),
        content: readTextFile(fileAbs),
        ...(f.heading ? { heading: String(f.heading) } : {}),
      });
    }

    tracks.push({
      id: String(track.id || trackDir),
      label: String(track.label || trackDir),
      cardTitle: String(track.cardTitle || track.label || trackDir),
      cardSubtitle: String(track.cardSubtitle || track.label || trackDir),
      cardDescription: String(track.cardDescription || ''),
      dir: trackDir,
      guide: String(track.guide || '说明.md'),
      guideMarkdown: readTextFile(guideAbs),
      files,
    });
  }

  return {
    introMarkdown: readTextFile(introAbs),
    introCard: {
      title: String(manifest.introCard?.title || '总览'),
      subtitle: String(manifest.introCard?.subtitle || path.posix.basename(introRel)),
      description: String(manifest.introCard?.description || ''),
    },
    tracks,
  };
}
