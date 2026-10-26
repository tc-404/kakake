import { ANNOUNCEMENT_FALLBACK } from './announcement-fallback';
import type { AnnouncementSource } from './announcement';
import { api } from './api';

/**
 * 远程公告正文拉取超时（毫秒）——仅用于展示，不作为门禁。
 *
 * 后端在这个窗口内对「自有站点 + GitHub 源」双源竞速，谁先返回可用正文就用谁；
 * 超过这个时间还没拿到 → 直接用本地备用文案，不再等。
 * 后端窗口（ANNOUNCEMENT_FETCH_WINDOW_MS = 9.5s）比这里略短，是给「后端返回 →
 * 前端收到」留往返余量，否则后端刚算出结果、前端这边已经放弃了。
 */
export const ANNOUNCEMENT_LOAD_TIMEOUT_MS = 10000;

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
