import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANNOUNCEMENT_SOURCES,
  raceAnnouncementSources,
  probeAnnouncementSources,
  type AnnouncementFetcher,
} from '../src/admin/announcement-source.js';

const [SRC_A, SRC_B] = ANNOUNCEMENT_SOURCES;

/** 可控延迟的假 fetcher：delay 后成功；若在 delay 前被中断则 reject */
function delayed(delay: number, payload = '正文'): AnnouncementFetcher {
  return (_url, signal) => new Promise<string>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => resolve(payload), delay);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    });
  });
}

/** 永远挂着不返回的假 fetcher（用于验证窗口超时） */
function never(): AnnouncementFetcher {
  return (_url, signal) => new Promise<string>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
}

/** 立即失败的假 fetcher */
function failing(): AnnouncementFetcher {
  return () => Promise.reject(new Error('HTTP 502'));
}

/** 按 url 分派不同行为的假 fetcher */
function byUrl(map: Record<string, AnnouncementFetcher>): AnnouncementFetcher {
  return (url, signal) => (map[url] ?? failing())(url, signal);
}

test('竞速：谁先拿到可用正文就用谁的', async () => {
  const fetcher = byUrl({
    [SRC_A.url]: delayed(120, 'A 的正文'),
    [SRC_B.url]: delayed(20, 'B 的正文'),
  });
  const hit = await raceAnnouncementSources(2_000, fetcher);
  assert.equal(hit?.id, SRC_B.id, '慢的源不应该抢到');
  assert.equal(hit?.markdown, 'B 的正文');
});

test('竞速：先返回的源失败 → 用后返回的那个', async () => {
  const fetcher = byUrl({
    [SRC_A.url]: failing(),
    [SRC_B.url]: delayed(60, 'B 的正文'),
  });
  const hit = await raceAnnouncementSources(2_000, fetcher);
  assert.equal(hit?.id, SRC_B.id);
  assert.equal(hit?.markdown, 'B 的正文');
});

test('竞速：两个源都失败 → null（前端改走本地备用）', async () => {
  const hit = await raceAnnouncementSources(2_000, failing());
  assert.equal(hit, null);
});

test('竞速：窗口内没人返回 → null，且仍在跑的请求被中断', async () => {
  let aborted = 0;
  const countingNever: AnnouncementFetcher = (_url, signal) => new Promise<string>((_r, reject) => {
    signal.addEventListener('abort', () => {
      aborted += 1;
      reject(new Error('aborted'));
    });
  });
  const hit = await raceAnnouncementSources(80, countingNever);
  assert.equal(hit, null);
  assert.equal(aborted, ANNOUNCEMENT_SOURCES.length, '超时应掐掉全部在跑的请求');
});

test('竞速：赢了之后立刻掐掉另一个还在跑的请求', async () => {
  let otherAborted = false;
  const fetcher = byUrl({
    [SRC_A.url]: delayed(10, 'A 的正文'),
    [SRC_B.url]: (_url, signal) => new Promise<string>((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        otherAborted = true;
        reject(new Error('aborted'));
      });
    }),
  });
  const hit = await raceAnnouncementSources(2_000, fetcher);
  assert.equal(hit?.id, SRC_A.id);
  // 中断是同步发起的，resolve 之后稍等一个 tick 就能观察到
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(otherAborted, '已经定了赢家，另一个源不该继续挂着');
});

test('探测：两个源都成功 → 两份正文都收回（谁的版本新由调用方比）', async () => {
  const fetcher = byUrl({
    [SRC_A.url]: delayed(10, 'A 正文'),
    [SRC_B.url]: delayed(40, 'B 正文'),
  });
  const { hits, errors } = await probeAnnouncementSources(2_000, fetcher);
  assert.equal(hits.length, 2, '探测不等竞速，两个源的结果都要');
  assert.deepEqual(errors, []);
  assert.deepEqual(hits.map((h) => h.id).sort(), [SRC_A.id, SRC_B.id].sort());
});

test('探测：一个源失败不影响另一个，失败原因单独收集', async () => {
  const fetcher = byUrl({
    [SRC_A.url]: failing(),
    [SRC_B.url]: delayed(10, 'B 正文'),
  });
  const { hits, errors } = await probeAnnouncementSources(2_000, fetcher);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, SRC_B.id);
  assert.equal(errors.length, 1);
  assert.match(errors[0], new RegExp(`^${SRC_A.id}: `), '错误要带上是哪个源挂了');
});

test('探测：全部失败 → hits 为空，不抛异常', async () => {
  const { hits, errors } = await probeAnnouncementSources(2_000, failing());
  assert.deepEqual(hits, []);
  assert.equal(errors.length, ANNOUNCEMENT_SOURCES.length);
});

test('永不返回的源不会把探测永久挂住（超时中断兜底还在）', async () => {
  // AbortSignal.timeout 用的是 unref 定时器，自己不撑事件循环——这对生产是好事
  // （后台探测不会拖着 kakake 进程不退出），但测试里循环会先空掉，得手动撑一下。
  const keepAlive = setTimeout(() => {}, 500);
  try {
    const { hits, errors } = await probeAnnouncementSources(80, never());
    assert.deepEqual(hits, []);
    assert.equal(errors.length, ANNOUNCEMENT_SOURCES.length);
  } finally {
    clearTimeout(keepAlive);
  }
});
