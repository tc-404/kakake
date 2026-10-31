import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { requireSharp } from './sharp-loader.js';
import {
  decodeContainer,
  encodeContainer,
  pixelFamilyTransform,
  pixelFamilyUntransform,
  ObfCancelled,
  type ObfProgress,
} from './image-obf-core.js';
import {
  obfOutDir,
  removeObfInput,
  writeObfOut,
} from './obf-temp.store.js';

/**
 * 图片混淆的服务端执行引擎（像素路线专用）。
 *
 * 为什么要有它：浏览器里像素路线受画布上限（单边 16384px / 总面积 2.68 亿像素）
 * 和标签页内存限制，超过就只能降级缩小。放到服务端用 sharp 编解码就没有这些限制，
 * 可以按原始分辨率处理。
 *
 * 密码安全：客户端只上传**从密码派生的随机种子**，密码本身不离开浏览器。
 * （种子仅用于重建置换，反推不出密码。）
 *
 * 进度/取消：按阶段上报（解码 → 变换 → 编码 → 落盘），每阶段之间检查取消标志。
 * 变换本身是一整段同步计算，这一段内无法中断——若以后要支持细粒度取消，
 * 需要把 image-obf-core 的各个变换按行带拆分（变换都是逐像素独立的，可拆），
 * 或改用 worker_threads 真正隔离（注意 build-server.mjs 是单文件打包，
 * 加 worker 需要同时改打包配置）。
 */

export type ObfServerSpec = {
  op: 'obf' | 'deobf';
  /** 混淆时的像素路线（还原时从容器里读） */
  route?: 2 | 3 | 4 | 5 | 6;
  scheme?: number;
  blockSize?: number;
  preserveAlpha?: boolean;
  /** 客户端派生的种子（不是密码） */
  seed: number;
  /** 输出文件名 */
  name: string;
};

export type ObfJobStatus = 'running' | 'done' | 'error' | 'cancelled';

export type ObfJob = {
  id: string;
  op: 'obf' | 'deobf';
  status: ObfJobStatus;
  progress: ObfProgress;
  error?: string;
  /** 完成后可下载的 token */
  token?: string;
  outName?: string;
  outSize?: number;
  /** 结果图片分辨率（非图片结果为 0） */
  width?: number;
  height?: number;
  createdAt: number;
};

/**
 * sharp 的加载统一放在 ./sharp-loader.js：按需 import + 失败不缓存，缺依赖时只让本功能
 * 报错，不会把整个框架的启动拖下水（详见该文件注释）。
 * 设置页的「图片引擎环境」卡片装完 sharp 后无需重启，下一次处理就会用上。
 */

const jobs = new Map<string, ObfJob>();
/** 已请求取消的任务 ID */
const cancelled = new Set<string>();

/** 并发闸：像素变换是整段同步计算，放开并发就是放开事件循环被冻结 */
const OBF_MAX_RUNNING = 1;
const OBF_MAX_QUEUE = 2;
let obfRunning = 0;
const obfWaiters: Array<() => void> = [];
/** 已结束任务记录保留时长（前端轮询取结果用），超时即清，Map 不会无界增长 */
const OBF_JOB_TTL_MS = 10 * 60_000;
const OBF_MAX_JOBS = 200;

function obfAcquire(): Promise<void> {
  if (obfRunning < OBF_MAX_RUNNING) {
    obfRunning += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => obfWaiters.push(resolve));
}

function obfRelease(): void {
  obfRunning -= 1;
  const next = obfWaiters.shift();
  if (next) next();
}

function pruneObfJobs(): void {
  const now = Date.now();
  for (const [id, j] of jobs) {
    if (j.status !== 'running' && now - j.createdAt > OBF_JOB_TTL_MS) jobs.delete(id);
  }
  if (jobs.size > OBF_MAX_JOBS) {
    const finished = [...jobs.entries()]
      .filter(([, j]) => j.status !== 'running')
      .sort((a, b) => a[1].createdAt - b[1].createdAt);
    for (const [id] of finished) {
      if (jobs.size <= OBF_MAX_JOBS) break;
      jobs.delete(id);
    }
  }
}

function isCancelled(id: string): boolean {
  return cancelled.has(id);
}

function report(job: ObfJob, done: number): void {
  job.progress = { done, total: 100 };
}

/** 用 sharp 解码成 RGBA；显式限制解码像素数，防超大图吃穿内存 */
async function decodeImage(
  bytes: Uint8Array,
): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
  const sharp = await requireSharp();
  const meta = await sharp(bytes, { failOn: 'none', limitInputPixels: 80_000_000 }).metadata();
  if (!meta.width || !meta.height) throw new Error('无法读取图片尺寸（文件可能已损坏）');
  const { data, info } = await sharp(bytes, { failOn: 'none', limitInputPixels: 80_000_000 })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    // Buffer 是 Uint8Array 但不是 Uint8ClampedArray，这里做零拷贝视图转换
    data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length),
    width: info.width,
    height: info.height,
  };
}

/** 用 sharp 编码成 PNG */
async function encodeImage(data: Uint8ClampedArray, width: number, height: number): Promise<Uint8Array> {
  const sharp = await requireSharp();
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const png = await sharp(buf, { raw: { width, height, channels: 4 } })
    .png({ compressionLevel: 6 })
    .toBuffer();
  return new Uint8Array(png);
}

async function runJob(job: ObfJob, spec: ObfServerSpec, inputPath: string): Promise<void> {
  try {
    const input = fs.readFileSync(inputPath);
    let payload: Uint8Array;
    let outName: string;
    let outW = 0;
    let outH = 0;

    if (spec.op === 'obf') {
      report(job, 5);
      const { data, width, height } = await decodeImage(input);
      if (isCancelled(job.id)) throw new ObfCancelled();
      report(job, 25);

      const res = pixelFamilyTransform(
        {
          route: spec.route ?? 2,
          scheme: spec.scheme ?? 1,
          blockSize: spec.blockSize ?? 16,
          preserveAlpha: spec.preserveAlpha ?? false,
          seed: spec.seed,
          name: spec.name,
        },
        data,
        width,
        height,
      );
      if (isCancelled(job.id)) throw new ObfCancelled();
      report(job, 65);

      const png = await encodeImage(res.data, res.width, res.height);
      if (isCancelled(job.id)) throw new ObfCancelled();
      report(job, 85);

      payload = encodeContainer({
        route: spec.route ?? 2,
        algo: res.algo,
        flags: spec.preserveAlpha ? 1 : 0,
        salt: new Uint8Array(0),
        iv: new Uint8Array(0),
        meta: res.meta,
        payload: png,
      });
      outName = `${spec.name}.kkobf`;
      outW = res.width;
      outH = res.height;
    } else {
      report(job, 5);
      const container = decodeContainer(input);
      if (isCancelled(job.id)) throw new ObfCancelled();
      report(job, 15);

      const { data, width, height } = await decodeImage(container.payload);
      if (isCancelled(job.id)) throw new ObfCancelled();
      report(job, 25);

      const res = pixelFamilyUntransform(container, data, width, height, spec.seed);
      if (isCancelled(job.id)) throw new ObfCancelled();
      report(job, 65);

      payload = await encodeImage(res.data, res.width, res.height);
      if (isCancelled(job.id)) throw new ObfCancelled();
      report(job, 85);

      outName = container.meta.name || 'restored.png';
      outW = res.width;
      outH = res.height;
    }

    const token = randomUUID();
    writeObfOut(token, { name: outName, mime: 'application/octet-stream', size: payload.byteLength, createdAt: Date.now() }, payload);
    job.token = token;
    job.outName = outName;
    job.outSize = payload.byteLength;
    job.width = outW;
    job.height = outH;
    job.status = 'done';
    report(job, 100);
  } catch (err) {
    if (err instanceof ObfCancelled || isCancelled(job.id)) {
      job.status = 'cancelled';
      job.error = '已取消';
    } else {
      job.status = 'error';
      job.error = err instanceof Error ? err.message : '处理失败';
    }
  } finally {
    // 输入文件无论成败都删掉，不占磁盘
    removeObfInput(job.id);
    cancelled.delete(job.id);
  }
}

export function startObfJob(spec: ObfServerSpec, inputPath: string): string {
  pruneObfJobs();
  // 容量闸同步检查：处理中 1 个 + 排队最多 2 个，超出直接拒绝而不是默默堆积
  if (obfRunning >= OBF_MAX_RUNNING && obfWaiters.length >= OBF_MAX_QUEUE) {
    throw new Error('已有图片任务在处理中，请等待完成后再试');
  }
  const id = randomUUID();
  const job: ObfJob = {
    id,
    op: spec.op,
    status: 'running',
    progress: { done: 0, total: 100 },
    createdAt: Date.now(),
  };
  jobs.set(id, job);
  // 不 await：立即返回任务 ID，前端轮询进度；排队由信号量接管
  void (async () => {
    await obfAcquire();
    try {
      await runJob(job, spec, inputPath);
    } finally {
      obfRelease();
    }
  })();
  return id;
}

export function getObfJob(id: string): ObfJob | undefined {
  return jobs.get(id);
}

export function cancelObfJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job || job.status !== 'running') return false;
  cancelled.add(id);
  return true;
}

/** 清空所有任务记录（配合临时目录一起清） */
export function clearObfJobs(): void {
  for (const id of [...jobs.keys()]) cancelled.add(id);
  jobs.clear();
}

/** 任务数量（供排查/日志用） */
export function obfJobCount(): number {
  return jobs.size;
}

export { obfOutDir };
