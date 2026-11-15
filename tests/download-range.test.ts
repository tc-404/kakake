import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import '../src/storage/atomic-file.js';
import {
  pluginStoreService,
  StoreInstallCancelledError,
} from '../src/plugin/plugin-store.service.js';

/**
 * 多线程分段下载器（downloadRangeParallel / probeRemoteSize）的离线回归：
 * 用本地 HTTP 服务模拟三种源——支持 Range / 无视 Range 返 200 / 响应越界多发。
 * 私有方法经由 any 调用，纯本机回环，不出网。
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const svc = pluginStoreService as any;

/** 确定性内容：position 敏感，任何错位拼装都比对得出来 */
function makeBody(total: number): Buffer {
  const buf = Buffer.alloc(total);
  for (let i = 0; i < total; i += 1) buf[i] = (i * 31 + 7) % 251;
  return buf;
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as { port: number }).port);
    });
  });
}

/** 标准 Range 源：HEAD 回总量，GET 按 Range 切 206 */
function rangeServer(body: Buffer): http.Server {
  return http.createServer((req, res) => {
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'content-length': String(body.length), 'accept-ranges': 'bytes' });
      res.end();
      return;
    }
    const m = /bytes=(\d+)-(\d+)/.exec(String(req.headers.range || ''));
    if (!m) {
      res.writeHead(200, { 'content-length': String(body.length) });
      res.end(body);
      return;
    }
    const start = Number(m[1]);
    const end = Math.min(Number(m[2]), body.length - 1);
    res.writeHead(206, { 'content-length': String(end - start + 1), 'accept-ranges': 'bytes' });
    res.end(body.subarray(start, end + 1));
  });
}

test('probeRemoteSize：读到总量与 accept-ranges', async () => {
  const body = makeBody(1024);
  const server = rangeServer(body);
  const port = await listen(server);
  try {
    const probe = await svc.probeRemoteSize(`http://127.0.0.1:${port}/file`);
    assert.deepEqual(probe, { total: 1024, acceptRanges: true });
  } finally {
    server.close();
  }
});

test('downloadRangeParallel：4 路分段拼装与原文件逐字节一致', async () => {
  const body = makeBody(3 * 1024 * 1024 + 17);
  const server = rangeServer(body);
  const port = await listen(server);
  try {
    const got = await svc.downloadRangeParallel(`http://127.0.0.1:${port}/file`, body.length);
    assert.equal(Buffer.compare(got, body), 0);
  } finally {
    server.close();
  }
});

test('源无视 Range 返回 200：整体失败，交由上层回退单流', async () => {
  const body = makeBody(4096);
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-length': String(body.length) });
    res.end(body);
  });
  const port = await listen(server);
  try {
    await assert.rejects(() => svc.downloadRangeParallel(`http://127.0.0.1:${port}/file`, body.length));
  } finally {
    server.close();
  }
});

test('分段越界多发：立即中止不写缓冲外', async () => {
  const body = makeBody(4096);
  // 每个分段请求都回全量（长度远超 range），必须被判失败而不是默默拼错
  const server = http.createServer((req, res) => {
    res.writeHead(206, { 'content-length': String(body.length), 'accept-ranges': 'bytes' });
    res.end(body);
  });
  const port = await listen(server);
  try {
    await assert.rejects(() => svc.downloadRangeParallel(`http://127.0.0.1:${port}/file`, body.length));
  } finally {
    server.close();
  }
});

test('download-config：默认关闭、阈值收敛到 1~1024', () => {
  const cfg = pluginStoreService.getDownloadConfig();
  assert.equal(typeof cfg.multiThread, 'boolean');
  const next = pluginStoreService.setDownloadConfig({ minSizeMB: 999999 });
  assert.equal(next.minSizeMB, 1024);
  const back = pluginStoreService.setDownloadConfig({ mode: 'minSize', minSizeMB: 4 });
  assert.equal(back.mode, 'minSize');
  assert.equal(back.minSizeMB, 4);
});

test('cancelInstall：无账/安装阶段都拒绝，下载阶段标记并掐断', () => {
  assert.equal(pluginStoreService.cancelInstall('nope').ok, false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const priv = pluginStoreService as any;
  priv.installProgress.set('t-installing', { downloaded: 9, total: 9, phase: 'installing' });
  assert.equal(pluginStoreService.cancelInstall('t-installing').ok, false);
  priv.installProgress.delete('t-installing');

  const ac = new AbortController();
  priv.installProgress.set('t-live', { downloaded: 1, total: 9, phase: 'downloading' });
  priv.installAborts.set('t-live', ac);
  const r = pluginStoreService.cancelInstall('t-live');
  assert.equal(r.ok, true);
  assert.equal(ac.signal.aborted, true);
  assert.equal(priv.installProgress.get('t-live').cancelled, true);
  priv.installProgress.delete('t-live');
  priv.installAborts.delete('t-live');
});

test('结果暂存：一次性取走 + 容量上限挤出最旧', () => {
  pluginStoreService.stashInstallResult('r1', { ok: true, message: 'done' });
  assert.equal(pluginStoreService.popInstallResult('r1')?.ok, true);
  assert.equal(pluginStoreService.popInstallResult('r1'), null);

  for (let i = 0; i < 25; i += 1) {
    pluginStoreService.stashInstallResult(`cap-${i}`, { ok: true, message: '' });
  }
  // 上限 20：最早的 cap-0 已被挤出，最新的还在
  assert.equal(pluginStoreService.popInstallResult('cap-0'), null);
  assert.ok(pluginStoreService.popInstallResult('cap-24'));
});

test('finishInstall：先入暂存再清进度与 abort，顺序固定', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const priv = pluginStoreService as any;
  priv.installProgress.set('t-fin', { downloaded: 1, total: 2, phase: 'downloading' });
  priv.installAborts.set('t-fin', new AbortController());
  pluginStoreService.finishInstall('t-fin', { ok: false, code: 'cancelled', message: '已取消下载' });
  assert.equal(pluginStoreService.getInstallProgress('t-fin'), null);
  const r = pluginStoreService.popInstallResult('t-fin');
  assert.equal(r?.code, 'cancelled');
});

test('链接导入复用商城记账：begin/report/cancel 同一通道同一语义', () => {
  pluginStoreService.beginInstallProgress('t-share', 100);
  pluginStoreService.reportInstallProgress('t-share', 40, 100);
  const p = pluginStoreService.getInstallProgress('t-share');
  assert.equal(p?.downloaded, 40);
  assert.equal(p?.total, 100);
  assert.equal(p?.phase, 'downloading');
  const ac = new AbortController();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pluginStoreService as any).installAborts.set('t-share', ac);
  assert.equal(pluginStoreService.cancelInstall('t-share').ok, true);
  assert.equal(ac.signal.aborted, true);
  pluginStoreService.clearInstallProgress('t-share');
  pluginStoreService.clearInstallAbort('t-share');
});

test('慢速下载中途取消：抛 StoreInstallCancelledError，进度账清干净', async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const priv = pluginStoreService as any;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-length': String(512 * 1024) });
    const drip = setInterval(() => res.write(Buffer.alloc(1024)), 30);
    res.on('close', () => clearInterval(drip));
  });
  const port = await listen(server);
  const url = `http://127.0.0.1:${port}/slow.zip`;
  const fakeResource = {
    allow_download: true,
    allow_list: 1,
    allow_detail: 1,
    allow_cover_preview: 1,
    download_block_reason: '',
    origin: 'kakake',
    sha256: '',
    links: { download: url, cover: '' },
  };
  const originalGet = priv.getResourceById;
  priv.getResourceById = async () => fakeResource;
  try {
    const task = pluginStoreService.downloadToTemp(1, undefined, 't-slow-cancel');
    // 等进度账出现（headers 到账即建账）
    for (let i = 0; i < 100 && !pluginStoreService.getInstallProgress('t-slow-cancel'); i += 1) {
      await new Promise((s) => setTimeout(s, 20));
    }
    assert.ok(pluginStoreService.getInstallProgress('t-slow-cancel'), '进度账应已建立');
    assert.equal(pluginStoreService.cancelInstall('t-slow-cancel').ok, true);
    await assert.rejects(task, (e: unknown) => e instanceof StoreInstallCancelledError);
    // 账只由控制器的 finishInstall 清（先存结果再清账）；下载层抛错时保留 cancelled 标记
    const entry = pluginStoreService.getInstallProgress('t-slow-cancel');
    assert.equal(entry?.cancelled, true);
    assert.equal(pluginStoreService.popInstallResult('t-slow-cancel'), null);
  } finally {
    priv.getResourceById = originalGet;
    server.close();
  }
});
