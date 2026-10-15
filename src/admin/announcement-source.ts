/**
 * 远程公告的「来源清单 + 取正文」公共逻辑。
 *
 * 背景：同一个公告 URL 原先在 api.controller（展示加载）和
 * announcement-update.service（后台版本探测）里各硬编码了一份，加第二个源时
 * 必然漂移，所以收敛到这一个文件里，两边共用。
 *
 * 两条路线：
 * - remote：维护者自有站点（原本就在用的地址）
 * - github：仓库 tc-404/kakake-plugin-main 的 GitHub 源
 *   ⚠️ 用 raw.githubusercontent.com 而不是 blob 页面——blob 页面返回的是 HTML
 *   外壳，正文夹在 JS 数据里，取不到干净 Markdown。
 */

export type AnnouncementSourceId = 'remote' | 'github';

export type AnnouncementSource = {
  id: AnnouncementSourceId;
  url: string;
};

export const ANNOUNCEMENT_SOURCES: readonly AnnouncementSource[] = [
  {
    id: 'remote',
    url: 'https://xn--mk-ub3cl61ae1v.xn--c5w857b.xn--fiqs8s/mkbot/%E5%92%94%E5%92%94%E5%85%AC%E5%91%8A.md',
  },
  {
    id: 'github',
    url: 'https://raw.githubusercontent.com/tc-404/kakake-plugin-main/main/%E5%92%94%E5%92%94%E5%85%AC%E5%91%8A.md',
  },
];

/**
 * 展示用加载的竞速窗口。
 * 前端 10s 到点就改本地备用文案，这里留 0.5s 给「后端返回 → 前端收到」的往返，
 * 否则后端刚算出结果前端已经放弃了，白跑一趟。
 */
export const ANNOUNCEMENT_FETCH_WINDOW_MS = 9_500;

/**
 * 后台版本探测的中断兜底。
 * 探测是 fire-and-forget，不卡界面，所以不像展示那样卡 10 秒窗口——
 * 但请求本身还是要能自己结束，不能永久挂起（GitHub raw 在国内偶尔十几秒才通）。
 */
export const ANNOUNCEMENT_PROBE_TIMEOUT_MS = 30_000;

export type AnnouncementHit = {
  id: AnnouncementSourceId;
  markdown: string;
};

/** 便于测试注入：只管「给 url + signal，返回正文」 */
export type AnnouncementFetcher = (url: string, signal: AbortSignal) => Promise<string>;

/** 拉单个源：非 2xx / 空正文都算失败（超时由调用方的 signal 触发） */
export async function fetchAnnouncementText(url: string, signal: AbortSignal): Promise<string> {
  const resp = await fetch(url, {
    headers: {
      Accept: 'text/markdown, text/plain, */*',
      'User-Agent': 'Kakake/0.2',
    },
    signal,
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const markdown = (await resp.text()).trim();
  if (!markdown) throw new Error('远程公告为空');
  return markdown;
}

/**
 * 展示用：两个源同时发，**谁先拿到可用正文就用谁的**，其余请求立刻中断。
 * 窗口内一个都没拿到 → null（调用方改走本地备用文案）。
 */
export async function raceAnnouncementSources(
  windowMs: number = ANNOUNCEMENT_FETCH_WINDOW_MS,
  fetcher: AnnouncementFetcher = fetchAnnouncementText,
): Promise<AnnouncementHit | null> {
  return new Promise<AnnouncementHit | null>((resolve) => {
    let settled = false;
    let remaining = ANNOUNCEMENT_SOURCES.length;
    const controllers = ANNOUNCEMENT_SOURCES.map(() => new AbortController());

    const settle = (hit: AnnouncementHit | null) => {
      if (settled) return;
      settled = true;
      // 结果已定，掐掉还在跑的请求，别让它们继续白占连接
      for (const c of controllers) {
        if (!c.signal.aborted) c.abort();
      }
      resolve(hit);
    };

    ANNOUNCEMENT_SOURCES.forEach((source, i) => {
      const controller = controllers[i];
      const timer = setTimeout(() => controller.abort(), windowMs);
      fetcher(source.url, controller.signal).then(
        (markdown) => {
          clearTimeout(timer);
          settle({ id: source.id, markdown });
        },
        () => {
          clearTimeout(timer);
          remaining -= 1;
          if (remaining <= 0) settle(null);
        },
      );
    });
  });
}

/**
 * 后台版本探测：两个源都发，**等全部结束**，把成功的正文一起交回去。
 * 谁的版本号最新由调用方（announcement-update.service）比较后决定。
 */
export async function probeAnnouncementSources(
  timeoutMs: number = ANNOUNCEMENT_PROBE_TIMEOUT_MS,
  fetcher: AnnouncementFetcher = fetchAnnouncementText,
): Promise<{ hits: AnnouncementHit[]; errors: string[] }> {
  const results = await Promise.allSettled(
    ANNOUNCEMENT_SOURCES.map((source) => fetcher(source.url, AbortSignal.timeout(timeoutMs))),
  );
  const hits: AnnouncementHit[] = [];
  const errors: string[] = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      hits.push({ id: ANNOUNCEMENT_SOURCES[i].id, markdown: r.value });
    } else {
      const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
      errors.push(`${ANNOUNCEMENT_SOURCES[i].id}: ${reason}`);
    }
  });
  return { hits, errors };
}
