import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Eye, EyeOff, FileImage, FileLock2, Loader2, Lock, Shuffle, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { authHeaders } from '@/lib/api';
import {
  detectMediaKind,
  downloadBytes,
  readFileAsArrayBuffer,
  bytesToObjectUrl,
  type MediaDetect,
} from '@/pages/tools/base64-media';
import {
  seedFromPassword,
  aesDecrypt,
  aesEncrypt,
  decodeContainer,
  isContainer,
  byteStreamDeobfuscate,
  byteStreamObfuscate,
  peekImageSize,
  pixelFamilyDeobfuscate,
  pixelFamilyObfuscate,
  ObfCancelled,
  type AesCipher,
  type AesKdf,
  type ByteScheme,
  type ObfOptions,
  type ObfProgress,
  type PixelMode,
} from '@/pages/tools/image-obf';

type Mode = 'obf' | 'deobf';
type Route = 'aes' | 'pixel' | 'xor' | 'channel' | 'bitplane' | 'chaos' | 'bytes';

/** 服务端临时缓存 / 处理相关接口 */
const TMP_UPLOAD = '/api/tools/obf-upload';
const TMP_STORE = '/api/tools/obf-store';
const TMP_RUN = '/api/tools/obf-run';
const TMP_STATUS = '/api/tools/obf-run';
const TMP_CANCEL = '/api/tools/obf-run-cancel';
const TMP_CLEAR = '/api/tools/obf-clear';
const tmpDownloadUrl = (token: string) => `/api/tools/obf-download/${token}`;
/** 预估耗时超过这个阈值才显示进度条（毫秒） */
const PROGRESS_SHOW_MS = 30_000;

/** 免密码模式下使用的公开常量密钥：混淆结果无保密性，任何人都可还原 */
const OPEN_KEY = 'kakake_nokey_open';

const ROUTES: { id: Route; label: string; desc: string }[] = [
  {
    id: 'aes',
    label: '对称字节加密',
    desc: 'AES 加密原始字节，与图片格式无关——兼容任意图片，输出为可被同密码还原的容器文件',
  },
  {
    id: 'pixel',
    label: '像素位置置乱',
    desc: '打乱像素位置，输出仍是「能打开的图片」（视觉噪点）；仅支持浏览器可解码的光栅图',
  },
  {
    id: 'xor',
    label: '像素异或',
    desc: '用密码派生的密钥流逐像素异或，输出仍是图片，兼具视觉混淆与数值扩散',
  },
  {
    id: 'channel',
    label: '通道洗牌',
    desc: '打乱 R/G/B 通道顺序（红蓝互换 / 循环移位），纯视觉混淆，输出仍是图片',
  },
  {
    id: 'bitplane',
    label: '位平面置乱',
    desc: '重排像素的位平面或比特位，输出接近噪点，强度高',
  },
  {
    id: 'chaos',
    label: '混沌置乱(Arnold)',
    desc: '基于 Arnold 猫映射的混沌空间置乱，迭代轮数由密码决定，输出为方阵 PNG',
  },
  {
    id: 'bytes',
    label: '字节流混淆',
    desc: '不解码、不重编码：直接对原始文件字节做可逆变换。输出与输入体积完全一致、任意大小都可用（不受画布/内存限制），但结果不再是可打开的图片',
  },
];

const ROUTE_BYTES: Record<Route, number> = { aes: 1, pixel: 2, xor: 3, channel: 4, bitplane: 5, chaos: 6, bytes: 7 };

const BYTE_SCHEMES: { id: ByteScheme; label: string; hint: string }[] = [
  { id: 'xor', label: '异或密钥流', hint: '逐字节异或密码派生的密钥流，速度快、自逆' },
  { id: 'shuffle', label: '字节块置换', hint: '每 4096 字节为一块，块内位置重排' },
  { id: 'bitperm', label: '比特置换', hint: '每个字节内部 8 个比特重排' },
];

const AES_CIPHERS: { id: AesCipher; label: string; hint: string }[] = [
  { id: 'AES-GCM', label: 'AES-GCM', hint: '带认证，推荐' },
  { id: 'AES-CBC', label: 'AES-CBC', hint: '无认证，兼容性好' },
  { id: 'AES-CTR', label: 'AES-CTR', hint: '流密码模式' },
];

const AES_KDFS: { id: AesKdf; label: string; hint: string }[] = [
  { id: 'pbkdf2', label: 'PBKDF2', hint: '慢哈希，抗暴力，可调迭代' },
  { id: 'hkdf', label: 'HKDF', hint: '快，本地即时用' },
];

const PBKDF2_ITERS: { value: number; label: string }[] = [
  { value: 100_000, label: '100k' },
  { value: 250_000, label: '250k' },
  { value: 600_000, label: '600k' },
];

const PIXEL_MODES: { id: PixelMode; label: string; hint: string }[] = [
  { id: 'perPixel', label: '逐像素洗牌', hint: '每个像素随机重排' },
  { id: 'block', label: '分块洗牌', hint: '按块整体打乱（可自选块大小）' },
  { id: 'row', label: '行乱序', hint: '整行随机重排' },
];

/** 分块置乱（图像分块置乱）可选块边长 */
const BLOCK_SIZES: { value: number; label: string }[] = [
  { value: 8, label: '8×8' },
  { value: 16, label: '16×16' },
  { value: 32, label: '32×32' },
  { value: 64, label: '64×64' },
];

const XOR_SCHEMES: { id: string; label: string; hint: string }[] = [
  { id: 'stream', label: '逐像素流', hint: '每像素独立密钥流，强度最高' },
  { id: 'row', label: '逐行流', hint: '每行一个密钥流' },
  { id: 'byte', label: '单字节', hint: '全图异或同一字节（经典但弱）' },
];

const CHANNEL_SCHEMES: { id: string; label: string; hint: string }[] = [
  { id: 'rb', label: '红蓝互换', hint: 'R↔B' },
  { id: 'rotate', label: '循环移位', hint: 'R→G→B→R' },
  { id: 'rotateRev', label: '逆循环', hint: 'R→B→G→R' },
];

const BITPLANE_SCHEMES: { id: string; label: string; hint: string }[] = [
  { id: 'plane', label: '位平面洗牌', hint: '全局 8 个位平面重排' },
  { id: 'intra', label: '字节内比特置换', hint: '每字节 8 个比特重排' },
];

const ACTION_BTN = 'kk-tool-ctl inline-flex h-10 w-full min-w-0 items-center justify-center gap-1.5 rounded-xl text-sm font-medium disabled:opacity-50';

type LoadedFile = {
  name: string;
  bytes: Uint8Array;
  isImage: boolean;
  previewUrl: string | null;
};

type OutputState = {
  kind: 'container' | 'restored';
  bytes: Uint8Array;
  mime: string;
  name: string;
  /** 还原后的图片预览 URL，或像素置乱的噪点预览 URL */
  previewUrl: string | null;
  previewLabel?: string;
  /** 服务端处理时浏览器不持有字节，只记体积用于显示 */
  sizeBytes?: number;
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/** 铺满宽度的胶囊分段选择器：上方小标题 + 下方整行胶囊 */
function Seg<T extends string | number | boolean>({
  label,
  options,
  value,
  onChange,
  gridClassName,
  optionClassName,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (next: T) => void;
  /** 给了就用网格排布（选项多、手机上要折成多行时），否则默认单行胶囊 */
  gridClassName?: string;
  /** 网格排布下的按钮圆角，默认 rounded-full */
  optionClassName?: string;
}) {
  return (
    <div className="flex w-full flex-col gap-1">
      <span className="text-xs font-medium text-slate-600">{label}</span>
      <div
        className={
          gridClassName ??
          'kk-tool-well flex w-full items-center gap-0.5 rounded-full p-0.5 text-xs font-medium'
        }
      >
        {options.map((o) => (
          <button
            key={String(o.value)}
            type="button"
            onClick={() => onChange(o.value)}
            aria-pressed={value === o.value}
            className={cn(
              'kk-tool-seg min-w-0 flex-1 truncate px-2.5 py-1.5 text-slate-600',
              optionClassName ?? 'rounded-full',
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * 混淆路线有 7 项：手机 4 列 × 2 行（同一个选择器内折行，不拆成两个组件），
 * 电脑 7 列一行不换行（标签长了有 truncate 兜底，不会撑出滚动条）。
 */
const ROUTE_GRID = 'kk-tool-well grid w-full grid-cols-4 gap-0.5 rounded-2xl p-0.5 text-xs font-medium md:grid-cols-7';

export default function ImageObfuscationTool() {
  const [mode, setMode] = useState<Mode>('obf');
  const [route, setRoute] = useState<Route>('aes');
  const [cipher, setCipher] = useState<AesCipher>('AES-GCM');
  const [kdf, setKdf] = useState<AesKdf>('pbkdf2');
  const [iterations, setIterations] = useState<number>(250_000);
  const [pixelMode, setPixelMode] = useState<PixelMode>('perPixel');
  const [blockSize, setBlockSize] = useState(16);
  const [preserveAlpha, setPreserveAlpha] = useState(true);
  const [xorScheme, setXorScheme] = useState('stream');
  const [channelScheme, setChannelScheme] = useState('rb');
  const [bitPlaneScheme, setBitPlaneScheme] = useState('plane');
  const [byteScheme, setByteScheme] = useState<ByteScheme>('xor');
  const [noPassword, setNoPassword] = useState(false);
  const [password, setPassword] = useState('123456');
  const [showPassword, setShowPassword] = useState(false);

  const [file, setFile] = useState<LoadedFile | null>(null);
  const [output, setOutput] = useState<OutputState | null>(null);
  const [processing, setProcessing] = useState(false);
  const [dragging, setDragging] = useState(false);
  /** 处理进度；只有预估剩余时间超过 30 秒才把进度条显示出来（showProgress） */
  const [progress, setProgress] = useState<ObfProgress | null>(null);
  const [showProgress, setShowProgress] = useState(false);
  /** 服务端暂存 token：有就走服务端下载，没有就退回浏览器 Blob */
  const [tmpToken, setTmpToken] = useState<string | null>(null);

  const cancelRef = useRef(false);
  const startedAtRef = useRef(0);

  const fileRef = useRef<HTMLInputElement>(null);
  const filePreviewRef = useRef<string | null>(null);
  const outputPreviewRef = useRef<string | null>(null);
  /** 原图预览 <img> 的实际渲染高度：拿它当输入/输出两卡的共同最小高度，保证两卡等高 */
  const inputImgRef = useRef<HTMLImageElement>(null);
  const [previewH, setPreviewH] = useState<number | null>(null);
  /** 原图 / 结果的原始分辨率，用于标题旁显示（容器类资源没有分辨率，只显示体积） */
  const [inputMeta, setInputMeta] = useState<{ w: number; h: number } | null>(null);
  const [outputMeta, setOutputMeta] = useState<{ w: number; h: number } | null>(null);

  useEffect(
    () => () => {
      if (filePreviewRef.current) URL.revokeObjectURL(filePreviewRef.current);
      if (outputPreviewRef.current) URL.revokeObjectURL(outputPreviewRef.current);
    },
    [],
  );

  useEffect(() => {
    const onResize = () => setPreviewH(inputImgRef.current ? inputImgRef.current.clientHeight : null);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  /** 两卡共用的最小高度：有图时按图片实际高度 + 上下 padding(24)，无图时兜底 12rem */
  const boxMinH = previewH ? Math.max(192, previewH + 24) : 192;

  /** 标题旁显示的「分辨率 · 体积」：只有资源存在时才显示；容器类资源没有分辨率，就只显示体积 */
  const inputMetaText = file
    ? [inputMeta ? `${inputMeta.w}×${inputMeta.h}` : null, formatBytes(file.bytes.byteLength)]
        .filter(Boolean)
        .join(' · ')
    : '';
  const outputMetaText = output
    ? [outputMeta ? `${outputMeta.w}×${outputMeta.h}` : null, formatBytes(output.sizeBytes ?? output.bytes.byteLength)]
        .filter(Boolean)
        .join(' · ')
    : '';

  /** 进度回调：顺带按已用时间外推剩余耗时，超过 30 秒才亮出进度条 */
  const progressOpts: ObfOptions = {
    onProgress: (p: ObfProgress) => {
      setProgress(p);
      const elapsed = Date.now() - startedAtRef.current;
      const ratio = p.total > 0 ? p.done / p.total : 0;
      if (elapsed > 800 && ratio > 0.02) {
        const etaRemain = elapsed / ratio - elapsed;
        if (etaRemain > PROGRESS_SHOW_MS) setShowProgress(true);
      }
    },
    shouldCancel: () => cancelRef.current,
  };

  /** 把结果传到服务端临时目录，拿 token 供下载；失败返回 null（前端会退回 Blob 下载） */
  const uploadTmp = useCallback(async (bytes: Uint8Array, name: string): Promise<string | null> => {
    try {
      const fd = new FormData();
      fd.append('file', new Blob([bytes as BlobPart], { type: 'application/octet-stream' }), name);
      const res = await fetch(TMP_STORE, {
        method: 'POST',
        credentials: 'include',
        headers: authHeaders(),
        body: fd,
      });
      if (!res.ok) return null;
      const j = (await res.json()) as { ok?: boolean; token?: string };
      return j.ok && j.token ? j.token : null;
    } catch {
      return null;
    }
  }, []);

  /** 清空服务端临时目录（刷新/关页面用 sendBeacon，点清空用 fetch） */
  const clearTmp = useCallback((beacon = false) => {
    setTmpToken(null);
    if (beacon) {
      // 页面正在卸载，只有 sendBeacon 能可靠发出
      try {
        navigator.sendBeacon(TMP_CLEAR);
      } catch {
        /* 忽略 */
      }
      return;
    }
    void fetch(TMP_CLEAR, { method: 'POST', credentials: 'include', headers: authHeaders() }).catch(
      () => undefined,
    );
  }, []);

  // 刷新 / 关页面 / 切走：清掉服务端临时目录（pagehide 在刷新与关闭时都触发）
  useEffect(() => {
    const onHide = () => clearTmp(true);
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, [clearTmp]);

  // 刷新 / 关页面 / 切走：清掉服务端临时目录（pagehide 在刷新与关闭时都触发）
  useEffect(() => {
    const onHide = () => clearTmp(true);
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, [clearTmp]);

  /**
   * 超过这个尺寸/体积就改走服务端处理。
   * 浏览器里像素路线受画布上限（单边 16384px）和标签页内存限制，超过只能降级缩小；
   * 服务端用 sharp 编解码没有这些限制，可以按原始分辨率处理。
   * （密码不上传：只上传从密码派生的种子。）
   */
  const SERVER_LIMIT = { side: 8000, area: 40_000_000, bytes: 24 * 1024 * 1024 };

  function shouldUseServer(w: number, h: number, byteLen: number): boolean {
    return (
      w > SERVER_LIMIT.side ||
      h > SERVER_LIMIT.side ||
      w * h > SERVER_LIMIT.area ||
      byteLen > SERVER_LIMIT.bytes
    );
  }

  /** 服务端跑一次处理：上传 → 启动 → 轮询进度 → 返回结果信息 */
  async function runOnServer(
    kind: 'obf' | 'deobf',
    bytes: Uint8Array,
    fileName: string,
    spec: { route?: number; scheme?: number; blockSize?: number; preserveAlpha?: boolean },
    seed: number,
  ): Promise<{ token: string; name: string; size: number; width: number; height: number }> {
    // 1) 上传待处理文件
    const fd = new FormData();
    fd.append('file', new Blob([bytes as BlobPart], { type: 'application/octet-stream' }), fileName);
    const upRes = await fetch(TMP_UPLOAD, {
      method: 'POST',
      credentials: 'include',
      headers: authHeaders(),
      body: fd,
    });
    const up = (await upRes.json()) as { ok?: boolean; jobId?: string; message?: string };
    if (!up.ok || !up.jobId) throw new Error(up.message || '上传到服务端失败');

    // 2) 启动处理（只传种子，不传密码）
    const runRes = await fetch(TMP_RUN, {
      method: 'POST',
      credentials: 'include',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ jobId: up.jobId, op: kind, ...spec, seed, name: fileName }),
    });
    const run = (await runRes.json()) as { ok?: boolean; taskId?: string; message?: string };
    if (!run.ok || !run.taskId) throw new Error(run.message || '启动服务端处理失败');

    // 3) 轮询进度（顺便响应取消）
    for (;;) {
      if (cancelRef.current) {
        await fetch(TMP_CANCEL, {
          method: 'POST',
          credentials: 'include',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ taskId: run.taskId }),
        }).catch(() => undefined);
        throw new ObfCancelled();
      }
      await new Promise((r) => setTimeout(r, 500));
      const stRes = await fetch(`${TMP_STATUS}/${run.taskId}`, {
        credentials: 'include',
        headers: authHeaders(),
      });
      const st = (await stRes.json()) as {
        ok?: boolean;
        status?: string;
        done?: number;
        total?: number;
        error?: string;
        token?: string;
        name?: string;
        size?: number;
        width?: number;
        height?: number;
      };
      if (!st.ok) throw new Error('任务状态查询失败');
      if (st.status === 'done' && st.token) {
        return {
          token: st.token,
          name: st.name || fileName,
          size: st.size ?? 0,
          width: st.width ?? 0,
          height: st.height ?? 0,
        };
      }
      if (st.status === 'error') throw new Error(st.error || '服务端处理失败');
      if (st.status === 'cancelled') throw new ObfCancelled();
      if (typeof st.done === 'number' && typeof st.total === 'number') {
        progressOpts.onProgress?.({ done: st.done, total: st.total });
      }
    }
  }

  function setFilePreview(url: string | null) {
    if (filePreviewRef.current) URL.revokeObjectURL(filePreviewRef.current);
    filePreviewRef.current = url;
  }

  function setOutputPreview(url: string | null) {
    if (outputPreviewRef.current) URL.revokeObjectURL(outputPreviewRef.current);
    outputPreviewRef.current = url;
  }

  function clearAll() {
    setFilePreview(null);
    setOutputPreview(null);
    setPreviewH(null);
    setInputMeta(null);
    setOutputMeta(null);
    setFile(null);
    setOutput(null);
    setProgress(null);
    setShowProgress(false);
    cancelRef.current = true;
    // 手动清空要把服务端临时目录一起清掉
    clearTmp();
  }

  // 临时缓存：切模式 / 切路线 / 改参数都不清空已载入的文件与结果，
  // 只有「刷新页面」或手动点「清空」才清（clearAll）。
  function onModeChange(next: Mode) {
    if (next === mode) return;
    setMode(next);
  }

  function onRouteChange(next: Route) {
    if (next === route) return;
    setRoute(next);
  }

  async function loadFile(f: File) {
    try {
      const buf = await readFileAsArrayBuffer(f);
      const bytes = new Uint8Array(buf);

      if (mode === 'obf') {
        // 仅允许图片资源
        const detected: MediaDetect | null = detectMediaKind(bytes);
        const isImage = f.type.startsWith('image/') || detected?.kind === 'image';
        if (!isImage) {
          toast.error('只能选择图片文件（当前传入的不是图片资源）');
          return;
        }
        setOutputPreview(null);
        setOutput(null);
        setFilePreview(null);
        setPreviewH(null);
        setInputMeta(null);
        setOutputMeta(null);
        const previewUrl = bytesToObjectUrl(bytes, detected?.mime ?? (f.type || 'image/png'));
        setFilePreview(previewUrl);
        setFile({ name: f.name, bytes, isImage: true, previewUrl });
        toast.success(`已载入图片 ${f.name}`);
      } else {
        // 解除混淆：必须是 KKOBF 容器
        if (!isContainer(bytes)) {
          toast.error('这不是有效的混淆文件（请传入之前导出的 .kkobf 容器）');
          return;
        }
        setOutputPreview(null);
        setOutput(null);
        setFilePreview(null);
        setFile({ name: f.name, bytes, isImage: false, previewUrl: null });
        toast.success(`已载入混淆文件 ${f.name}`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '读取文件失败');
    }
  }

  async function runObfuscate() {
    if (!file?.isImage) {
      toast.error('请先选择一张图片');
      return;
    }
    const eff = noPassword ? OPEN_KEY : password;
    if (!noPassword && !password) {
      toast.error('请输入自定义密码（还原时需要同一密码）');
      return;
    }
    cancelRef.current = false;
    startedAtRef.current = Date.now();
    setProgress(null);
    setShowProgress(false);
    setProcessing(true);
    try {
      let container: Uint8Array;
      let preview: Uint8Array | null = null;
      // 字节流路线没有图可预览，但分辨率可以从原始文件头解析出来
      let bytesPeek: { w: number; h: number } | null = null;
      if (route === 'aes') {
        container = await aesEncrypt(file.bytes, eff, cipher, kdf, iterations, file.name, progressOpts);
      } else if (route === 'bytes') {
        // 字节流：不解码、不重编码，输出体积与输入完全一致
        const res = await byteStreamObfuscate(file.bytes, eff, byteScheme, file.name, progressOpts);
        container = res.container;
        bytesPeek = peekImageSize(file.bytes);
      } else {
        const rb = ROUTE_BYTES[route];
        let sb = 1;
        if (route === 'pixel') sb = pixelMode === 'block' ? 2 : pixelMode === 'row' ? 3 : 1;
        else if (route === 'xor') sb = XOR_SCHEMES.findIndex((s) => s.id === xorScheme) + 1;
        else if (route === 'channel') sb = CHANNEL_SCHEMES.findIndex((s) => s.id === channelScheme) + 1;
        else if (route === 'bitplane') sb = BITPLANE_SCHEMES.findIndex((s) => s.id === bitPlaneScheme) + 1;
        const preserve = route === 'pixel' ? preserveAlpha && pixelMode === 'perPixel' : false;

        // 超大图：浏览器画布/内存扛不住，改走服务端（sharp 编解码，保持原始分辨率）
        if (shouldUseServer(inputMeta?.w ?? 0, inputMeta?.h ?? 0, file.bytes.byteLength)) {
          const st = await runOnServer(
            'obf',
            file.bytes,
            file.name,
            { route: rb, scheme: sb, blockSize, preserveAlpha: preserve },
            seedFromPassword(eff),
          );
          setOutputPreview(null);
          setOutputMeta(st.width && st.height ? { w: st.width, h: st.height } : null);
          setOutput({
            kind: 'container',
            bytes: new Uint8Array(0),
            sizeBytes: st.size,
            mime: 'application/octet-stream',
            name: st.name,
            previewUrl: null,
          });
          setTmpToken(st.token);
          toast.success(`已按原始分辨率在服务端完成混淆（${st.width}×${st.height}），可下载`);
          return;
        }

        const res = await pixelFamilyObfuscate(
          file.bytes,
          eff,
          rb as 2 | 3 | 4 | 5 | 6,
          sb,
          preserve,
          file.name,
          blockSize,
        );
        container = res.container;
        preview = res.preview;
        if (res.scaledFrom) {
          toast.warning(
            `图片 ${res.scaledFrom.w}×${res.scaledFrom.h} 超出浏览器处理上限（约 4000 万像素 / 单边 16384px），` +
              `已自动等比缩放到 ${res.width}×${res.height} 后再混淆。`,
            { duration: 8000 },
          );
        }
      }
      const previewUrl = preview ? bytesToObjectUrl(preview, 'image/png') : null;
      setOutputPreview(previewUrl);
      setOutputMeta(bytesPeek);
      const outName = `${file.name}.kkobf`;
      setOutput({
        kind: 'container',
        bytes: container,
        mime: 'application/octet-stream',
        name: outName,
        previewUrl,
        previewLabel: preview ? '混淆后预览（噪点图）' : undefined,
      });
      // 结果暂存到服务端，刷新/清空/重启都会自动清掉
      const token = await uploadTmp(container, outName);
      setTmpToken(token);
      toast.success('混淆完成，已生成容器文件，可下载');
    } catch (e) {
      if (e instanceof ObfCancelled) {
        toast.message('已取消');
        return;
      }
      toast.error(e instanceof Error ? e.message : '混淆失败');
    } finally {
      setProcessing(false);
      setProgress(null);
      setShowProgress(false);
    }
  }

  async function runDeobfuscate() {
    if (!file) {
      toast.error('请先选择混淆文件');
      return;
    }
    const eff = noPassword ? OPEN_KEY : password;
    if (!noPassword && !password) {
      toast.error('请输入自定义密码');
      return;
    }
    cancelRef.current = false;
    startedAtRef.current = Date.now();
    setProgress(null);
    setShowProgress(false);
    setProcessing(true);
    try {
      const parsed = decodeContainer(file.bytes);
      let plain: Uint8Array;

      // 像素类路线 + 大文件：同样走服务端（浏览器装不下）
      if (parsed.route !== 1 && parsed.route !== 7 && shouldUseServer(0, 0, file.bytes.byteLength)) {
        const st = await runOnServer('deobf', file.bytes, file.name, {}, seedFromPassword(eff));
        setOutputPreview(null);
        setOutputMeta(st.width && st.height ? { w: st.width, h: st.height } : null);
        setOutput({
          kind: 'restored',
          bytes: new Uint8Array(0),
          sizeBytes: st.size,
          mime: 'image/png',
          name: st.name,
          previewUrl: null,
        });
        setTmpToken(st.token);
        toast.success('已在服务端完成还原，可下载');
        return;
      }

      if (parsed.route === 1) plain = await aesDecrypt(parsed, eff, progressOpts);
      else if (parsed.route === 7) plain = await byteStreamDeobfuscate(parsed, eff, progressOpts);
      else plain = await pixelFamilyDeobfuscate(parsed, eff, progressOpts);
      const detected = detectMediaKind(plain);
      const mime = detected?.mime ?? 'image/png';
      const name = parsed.meta.name || 'restored';
      const previewUrl = detected?.kind === 'image' ? bytesToObjectUrl(plain, mime) : null;
      setOutputPreview(previewUrl);
      setOutputMeta(peekImageSize(plain));
      setOutput({
        kind: 'restored',
        bytes: plain,
        mime,
        name,
        previewUrl,
        previewLabel: '还原预览',
      });
      // 还原结果同样暂存到服务端（可能也是个大文件）
      const token = await uploadTmp(plain, name);
      setTmpToken(token);
      toast.success('已还原，可下载');
    } catch (e) {
      if (e instanceof ObfCancelled) {
        toast.message('已取消');
        return;
      }
      toast.error(e instanceof Error ? e.message : '还原失败');
    } finally {
      setProcessing(false);
      setProgress(null);
      setShowProgress(false);
    }
  }

  function onDownload() {
    if (!output) {
      toast.message('还没有可下载的内容');
      return;
    }
    if (output.kind === 'container') {
      // 优先走服务端暂存（大文件不占浏览器内存）；没拿到 token 才退回 Blob
      if (tmpToken) {
        const a = document.createElement('a');
        a.href = tmpDownloadUrl(tmpToken);
        a.download = output.name;
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        a.remove();
        toast.success('已开始下载混淆文件');
        return;
      }
      const ab = new ArrayBuffer(output.bytes.byteLength);
      new Uint8Array(ab).set(output.bytes);
      const url = URL.createObjectURL(new Blob([ab], { type: 'application/octet-stream' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = output.name;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success('已开始下载混淆文件');
    } else if (tmpToken) {
      // 还原结果同样优先走服务端暂存
      const a = document.createElement('a');
      a.href = tmpDownloadUrl(tmpToken);
      a.download = output.name;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast.success('已开始下载还原文件');
    } else {
      downloadBytes(output.bytes, output.mime, output.name);
      toast.success('已开始下载还原图片');
    }
  }

  const inputAccept = mode === 'obf' ? 'image/*' : 'image/*,.kkobf,.bin';

  /** 中断进行中的处理：置标志后由各分片循环检查并抛出 ObfCancelled */
  function onCancel() {
    cancelRef.current = true;
    toast.message('正在中断…');
  }

  const actionButtons = (
    <div className="grid shrink-0 grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3">
      <button
        type="button"
        onClick={() => (mode === 'obf' ? void runObfuscate() : void runDeobfuscate())}
        disabled={processing}
        className={cn(ACTION_BTN, 'kk-tool-ctl--on')}
      >
        {processing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Lock className="h-3.5 w-3.5" />}
        {mode === 'obf' ? '混淆' : '解除混淆'}
      </button>
      <button
        type="button"
        onClick={onDownload}
        disabled={!output}
        className={cn(ACTION_BTN, 'text-slate-700')}
      >
        下载
      </button>
      <button
        type="button"
        onClick={clearAll}
        className={cn(ACTION_BTN, 'text-slate-700')}
      >
        清空
      </button>
    </div>
  );

  // 输入区：整框可点击选择文件，同时支持拖拽
  const inputPane = (
    <div className="flex min-w-0 flex-col gap-2 md:h-full">
      <div className="flex min-w-0 items-baseline gap-2">
        <label className="shrink-0 text-sm font-medium text-slate-700">
          {mode === 'obf' ? '原图' : '混淆文件'}
        </label>
        {inputMetaText ? (
          <span className="min-w-0 truncate whitespace-nowrap text-xs text-slate-500">{inputMetaText}</span>
        ) : null}
      </div>
      <input
        ref={fileRef}
        type="file"
        accept={inputAccept}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void loadFile(f);
        }}
      />
      <div
        role="button"
        tabIndex={0}
        onClick={() => fileRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            fileRef.current?.click();
          }
        }}
        className={cn(
          // 不用 kk-tool-field--fill（它带 height:100%），也不要在手机端用 flex-1：
          // 二者与不确定的父高互相打架会把框压塌 / 互相重叠。
          // 手机：min-h 12rem + 随图片高度自然长高（图片按比例显示）；
          // 电脑：同一网格行内 md:h-full + md:flex-1，输入/输出两框强制等高。
          // 高度：有图时按图片实际渲染高度走（图片按比例显示），并与输出卡共用同一高度 → 两卡恒等。
          // 不用 kk-tool-field--fill（带 height:100%）也不要 flex-1（basis 0），二者在不确定父高下会压塌/重叠。
          'kk-tool-field relative flex w-full flex-col items-center justify-center cursor-pointer md:flex-1',
          dragging && 'kk-tool-field-drop-active',
        )}
        style={{ minHeight: boxMinH }}
        onDragEnter={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDragging(true);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDragging(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (e.currentTarget.contains(e.relatedTarget as Node)) return;
          setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDragging(false);
          const f = e.dataTransfer.files?.[0];
          if (f) void loadFile(f);
        }}
      >
        <span className="kk-tool-field__accent" aria-hidden />
        {file ? (
          <div className="relative z-[1] flex w-full flex-col items-center justify-center px-3 py-3">
            {file.previewUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                ref={inputImgRef}
                src={file.previewUrl}
                alt="原图预览"
                onLoad={(e) => {
                  setPreviewH(e.currentTarget.clientHeight);
                  setInputMeta({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight });
                }}
                // 关键：必须用「明确的最大高度」，不能用 md:max-h-full ——
                // 父级是 auto 高度，百分比 max-height 会被当成 none，竖图就会按宽度撑满整屏。
                className="max-h-[min(45vh,16rem)] max-w-full rounded-lg object-contain shadow-sm md:max-h-[min(50vh,20rem)]"
              />
            ) : (
              <FileImage className="h-8 w-8 text-slate-400" />
            )}
          </div>
        ) : (
          <div className="relative z-[1] flex w-full flex-col items-center justify-center gap-1.5 px-4 py-4 text-center text-sm text-slate-500">
            <Shuffle className="h-7 w-7 text-slate-400" />
            <p>{mode === 'obf' ? '点击此处或拖入一张图片（仅限图片格式）' : '点击此处或拖入 .kkobf 混淆文件'}</p>
          </div>
        )}
        {dragging ? (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[1.05rem] bg-[rgb(var(--kk-comp-rgb)/0.12)] text-sm font-medium text-slate-700">
            松开以载入文件
          </div>
        ) : null}
      </div>
    </div>
  );

  // 输出区：与输入区同构（标题 + 单一铺满框），桌面端两者等高、尺寸一致
  const outputPane = (
    <div className="flex min-w-0 flex-col gap-2 md:h-full">
      <div className="flex min-w-0 items-baseline gap-2">
        <label className="shrink-0 text-sm font-medium text-slate-700">输出</label>
        {outputMetaText ? (
          <span className="min-w-0 truncate whitespace-nowrap text-xs text-slate-500">{outputMetaText}</span>
        ) : null}
      </div>
      {output ? (
        <div
          className="kk-tool-field relative flex w-full flex-col md:flex-1"
          style={{ minHeight: boxMinH }}
        >
          <span className="kk-tool-field__accent" aria-hidden />
          <div className="relative z-[1] flex w-full flex-1 items-center justify-center p-3">
            {output.previewUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={output.previewUrl}
                alt={output.previewLabel ?? '预览'}
                onLoad={(e) =>
                  setOutputMeta({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
                }
                className="max-h-[min(45vh,16rem)] max-w-full rounded-lg object-contain md:max-h-[min(50vh,20rem)]"
              />
            ) : (
              // 结果不是图片（字节流 / AES 容器）：只显示文件图标 + 一行说明
              <div className="flex flex-col items-center gap-2 text-center">
                <FileLock2 className="h-10 w-10 text-slate-400" />
                <p className="text-xs text-slate-500">
                  {output.kind === 'container'
                    ? '已生成混淆文件（非图片，无法预览）'
                    : '已还原文件（非图片，无法预览）'}
                </p>
                <p className="text-xs text-slate-500">点「下载」保存到本地后即可正常使用</p>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div
          className="kk-tool-field flex w-full flex-col items-center justify-center gap-1.5 px-4 py-4 text-center text-sm text-slate-500 md:flex-1"
          style={{ minHeight: boxMinH }}
        >
          <Lock className="h-7 w-7 text-slate-400" />
          <p>结果将显示在这里</p>
        </div>
      )}
    </div>
  );

  return (
    // 不自建滚动容器：外壳 [data-kk-page-scroll] 才是滚动容器，
    // 本层用 shrink-0 跟着内容自然长高（与 kk-page-flow 同一套口径），
    // 否则会被 flex-1 + min-h-0 压回视口高度、内容「漫出盒子」且滚不动。
    <div className="flex w-full shrink-0 flex-col gap-3">
      {/* 模式：横屏铺满的左右胶囊式切换 */}
      <div className="flex shrink-0 flex-col gap-1">
        <span className="text-xs font-medium text-slate-600">模式</span>
        <div className="kk-tool-well grid w-full grid-cols-2 gap-0.5 rounded-full p-0.5 text-sm font-medium">
          <button
            type="button"
            onClick={() => onModeChange('obf')}
            aria-pressed={mode === 'obf'}
            className="kk-tool-seg rounded-full py-1.5 text-slate-600"
          >
            混淆
          </button>
          <button
            type="button"
            onClick={() => onModeChange('deobf')}
            aria-pressed={mode === 'deobf'}
            className="kk-tool-seg rounded-full py-1.5 text-slate-600"
          >
            解除混淆
          </button>
        </div>
      </div>

      {/* 路线选择 */}
      <div className="flex shrink-0 flex-col gap-1.5">
        <Seg
          label="混淆路线"
          options={ROUTES.map((r) => ({ value: r.id, label: r.label }))}
          value={route}
          onChange={(v) => onRouteChange(v)}
          gridClassName={ROUTE_GRID}
          optionClassName="rounded-xl"
        />
        <p className="text-xs text-slate-500">{ROUTES.find((r) => r.id === route)?.desc}</p>
      </div>

      {/* 算法 / 方案：随路线变化 */}
      <div className="flex shrink-0 flex-col gap-2">
        {route === 'aes' ? (
          <>
            <div className="flex flex-col gap-1.5">
              <Seg
                label="对称算法"
                options={AES_CIPHERS.map((c) => ({ value: c.id, label: c.label }))}
                value={cipher}
                onChange={setCipher}
              />
              <p className="text-xs text-slate-500">{AES_CIPHERS.find((c) => c.id === cipher)?.hint}</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Seg
                label="密钥派生"
                options={AES_KDFS.map((k) => ({ value: k.id, label: k.label }))}
                value={kdf}
                onChange={setKdf}
              />
              <p className="text-xs text-slate-500">{AES_KDFS.find((k) => k.id === kdf)?.hint}</p>
            </div>
            {kdf === 'pbkdf2' ? (
              <div className="flex flex-col gap-1.5">
                <Seg
                  label="迭代次数"
                  options={PBKDF2_ITERS.map((i) => ({ value: i.value, label: i.label }))}
                  value={iterations}
                  onChange={setIterations}
                />
                <p className="text-xs text-slate-500">PBKDF2 迭代次数，越高越慢越抗暴力</p>
              </div>
            ) : null}
          </>
        ) : route === 'pixel' ? (
          <>
            <div className="flex flex-col gap-1.5">
              <Seg
                label="置乱模式"
                options={PIXEL_MODES.map((p) => ({ value: p.id, label: p.label }))}
                value={pixelMode}
                onChange={setPixelMode}
              />
              <p className="text-xs text-slate-500">{PIXEL_MODES.find((p) => p.id === pixelMode)?.hint}</p>
            </div>
            {pixelMode === 'block' ? (
              <div className="flex flex-col gap-1.5">
                <Seg label="块大小" options={BLOCK_SIZES} value={blockSize} onChange={setBlockSize} />
                <p className="text-xs text-slate-500">
                  块越小越碎、越接近噪点；块越大越能看出原图的色块轮廓。块大小会写进容器，还原时自动读取，无需重新选择。
                </p>
              </div>
            ) : null}
            <div className="flex flex-col gap-1.5">
              <Seg
                label="透明通道"
                options={[
                  { value: true, label: '保留透明通道' },
                  { value: false, label: '一并打乱' },
                ]}
                value={preserveAlpha && pixelMode === 'perPixel'}
                onChange={(v) => setPreserveAlpha(v)}
              />
              <p className="text-xs text-slate-500">
                {pixelMode === 'perPixel' ? '逐像素模式下可让透明通道不被打乱' : '仅逐像素模式生效'}
              </p>
            </div>
          </>
        ) : route === 'xor' ? (
          <div className="flex flex-col gap-1.5">
            <Seg
              label="异或方案"
              options={XOR_SCHEMES.map((s) => ({ value: s.id, label: s.label }))}
              value={xorScheme}
              onChange={setXorScheme}
            />
            <p className="text-xs text-slate-500">{XOR_SCHEMES.find((s) => s.id === xorScheme)?.hint}</p>
          </div>
        ) : route === 'channel' ? (
          <div className="flex flex-col gap-1.5">
            <Seg
              label="通道方案"
              options={CHANNEL_SCHEMES.map((s) => ({ value: s.id, label: s.label }))}
              value={channelScheme}
              onChange={setChannelScheme}
            />
            <p className="text-xs text-slate-500">{CHANNEL_SCHEMES.find((s) => s.id === channelScheme)?.hint}</p>
          </div>
        ) : route === 'bitplane' ? (
          <div className="flex flex-col gap-1.5">
            <Seg
              label="位平面方案"
              options={BITPLANE_SCHEMES.map((s) => ({ value: s.id, label: s.label }))}
              value={bitPlaneScheme}
              onChange={setBitPlaneScheme}
            />
            <p className="text-xs text-slate-500">{BITPLANE_SCHEMES.find((s) => s.id === bitPlaneScheme)?.hint}</p>
          </div>
        ) : route === 'bytes' ? (
          <div className="flex flex-col gap-1.5">
            <Seg
              label="字节变换"
              options={BYTE_SCHEMES.map((s) => ({ value: s.id, label: s.label }))}
              value={byteScheme}
              onChange={setByteScheme}
            />
            <p className="text-xs text-slate-500">{BYTE_SCHEMES.find((s) => s.id === byteScheme)?.hint}</p>
            <p className="text-xs text-slate-500">
              不解码、不重编码 → 输出体积与输入完全一致，超大图也不受限；结果不再是图片，所以只显示文件图标。
            </p>
          </div>
        ) : (
          <p className="text-xs text-slate-500">
            混沌置乱的迭代轮数由密码决定；非正方形图片会先补成方阵，还原时自动裁回原尺寸。
          </p>
        )}
      </div>

      {/* 密码保护模式 */}
      <div className="flex shrink-0 flex-col gap-1.5">
        <Seg
          label="密码保护"
          options={[
            { value: false, label: '启用密码' },
            { value: true, label: '免密码模式' },
          ]}
          value={noPassword}
          onChange={setNoPassword}
        />
        <p className="text-xs text-slate-500">
          {noPassword
            ? '免密码模式：混淆结果无保密性，任何人都可还原（适合快速变换 / 演示）'
            : '启用密码：混淆结果只有用同一密码才能还原'}
        </p>
      </div>

      {/* 自定义密码：免密码模式下整块不显示 */}
      {noPassword ? null : (
        <div className="flex shrink-0 flex-col gap-1.5">
          <label className="text-sm font-medium text-slate-700">自定义密码</label>
          <div className="relative">
            <input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="设置密码，还原时必须使用同一密码"
              spellCheck={false}
              className="kk-tool-ctl w-full rounded-xl px-3 py-2 pr-10 text-sm text-slate-800 placeholder:text-slate-400"
            />
            <button
              type="button"
              onClick={() => setShowPassword((s) => !s)}
              className="kk-tool-seg absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-slate-500"
              aria-label={showPassword ? '隐藏密码' : '显示密码'}
            >
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          <p className="text-xs text-slate-500">
            密码不会上传，仅在本地参与加密 / 还原；遗忘将无法恢复图片。
          </p>
        </div>
      )}

      {/* 不设死高度、不 overflow-hidden：高度交给内容，滚动交给外壳。
          md 起变两列网格（输入 | 输出，按钮整行跨列）；手机端按 DOM 顺序
          输入 → 输出 → 按钮 竖排，不再用 order-* 打乱顺序（那正是重叠来源之一）。 */}
      <div
        className={cn(
          'kk-glass rounded-2xl p-3 sm:p-4',
          'flex flex-col gap-3',
          'md:grid md:grid-cols-2 md:gap-x-4 md:gap-y-3',
        )}
      >
        <div className="flex min-w-0 flex-col">{inputPane}</div>
        <div className="flex min-w-0 flex-col md:col-start-2 md:row-start-1">{outputPane}</div>
        <div className="md:col-span-2">{actionButtons}</div>
      </div>

      {/* 进度条：只在预估剩余时间超过 30 秒时出现（短任务不打扰），带取消按钮 */}
      {showProgress && progress ? (
        <div className="kk-glass shrink-0 rounded-2xl p-3">
          <div className="flex items-center justify-between gap-3 text-xs text-slate-600">
            <span className="min-w-0 truncate">
              {mode === 'obf' ? '正在混淆' : '正在还原'}…
              {progress.total > 0 ? ` ${Math.round((progress.done / progress.total) * 100)}%` : ''}
            </span>
            <button
              type="button"
              onClick={onCancel}
              className="kk-tool-ctl inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-slate-700"
            >
              <X className="h-3 w-3" />
              取消
            </button>
          </div>
          <div className="kk-tool-well mt-2 h-1.5 w-full overflow-hidden rounded-full">
            <div
              className="h-full rounded-full bg-[rgb(var(--kk-comp-rgb)/0.9)] transition-[width] duration-200"
              style={{
                width: `${progress.total > 0 ? Math.min(100, (progress.done / progress.total) * 100) : 0}%`,
              }}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
