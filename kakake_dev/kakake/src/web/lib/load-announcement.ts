import { ANNOUNCEMENT_FALLBACK } from './announcement-fallback';
import type { AnnouncementSource } from './announcement';
import { api } from './api';

/** 远程协议正文拉取超时（毫秒）——仅用于展示，不作为门禁 */
export const ANNOUNCEMENT_LOAD_TIMEOUT_MS = 7000;

export type LoadedAnnouncement = {
  markdown: string;
  source: AnnouncementSource;
};

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** 加载协议正文（展示用）；失败则本地备份 */
export async function loadAnnouncementMarkdown(): Promise<LoadedAnnouncement> {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const abortTimer =
    controller
      ? setTimeout(() => controller.abort(), ANNOUNCEMENT_LOAD_TIMEOUT_MS)
      : null;

  try {
    const remote = await withTimeout(
      api.announcement(controller?.signal),
      ANNOUNCEMENT_LOAD_TIMEOUT_MS,
      'announcement',
    );
    if (remote.markdown.trim()) {
      return { markdown: remote.markdown, source: 'remote' };
    }
  } catch {
    // fall through
  } finally {
    if (abortTimer) clearTimeout(abortTimer);
  }

  return { markdown: ANNOUNCEMENT_FALLBACK, source: 'fallback' };
}
