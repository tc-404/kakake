import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Check,
  Crop,
  Download,
  ImagePlus,
  Link2,
  Loader2,
  RotateCcw,
  Trash2,
  Unlink,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useT } from '@/lib/i18n';
import { Slider } from '@/components/ui/slider';
import { errText } from '@/lib/server-error';
import {
  detectMediaKind,
  downloadBytes,
  readFileAsArrayBuffer,
  bytesToObjectUrl,
} from '@/pages/tools/base64-media';
import {
  computeTargetSize,
  clampCrop,
  encodeEdit,
  withResizeDefaults,
  ASPECT_PRESETS,
  DEFAULT_SPEC,
  extOf,
  loadImageFromUrl,
  renderEdit,
  type CropRect,
  type EditSpec,
  type ImageFormat,
  type ResizeMode,
} from '@/pages/tools/image-edit';

/** 底部统一操作栏：所有主动作都在这一行，样式统一、顺序固定 */
function ActionButton({
  onClick,
  disabled,
  tone = 'ghost',
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  tone?: 'primary' | 'ghost' | 'danger';
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'inline-flex h-10 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-xl px-3 text-sm font-medium transition disabled:opacity-45',
        tone === 'primary' && 'kk-tool-ctl kk-tool-ctl--on',
        tone === 'ghost' && 'kk-tool-ctl text-slate-700',
        tone === 'danger' && 'kk-tool-ctl kk-tool-ctl--danger text-slate-500',
      )}
    >
      {children}
    </button>
  );
}

function Seg<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-slate-500">{label}</span>
      <div className="kk-tool-well grid grid-cols-2 gap-1 rounded-xl p-0.5 text-xs font-medium sm:grid-cols-4 sm:flex-nowrap">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            aria-pressed={value === o.value}
            className="kk-tool-seg min-w-0 truncate rounded-full px-2 py-1.5 text-slate-600"
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function NumField({
  label,
  value,
  onChange,
  suffix,
  min = 1,
  className,
}: {
  label: string;
  value: number | '';
  onChange: (v: number) => void;
  suffix?: string;
  min?: number;
  className?: string;
}) {
  return (
    <label className={cn('flex min-w-0 items-center gap-1.5', className)}>
      {label ? <span className="shrink-0 text-xs text-slate-500">{label}</span> : null}
      <input
        type="number"
        min={min}
        value={value}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
        className="kk-num-input kk-tool-ctl w-full min-w-0 rounded-lg px-2 py-1.5 text-sm"
      />
      {suffix ? <span className="shrink-0 text-xs text-slate-500">{suffix}</span> : null}
    </label>
  );
}

const RESIZE_MODES: { value: ResizeMode; label: string }[] = [
  { value: 'none', label: 'tools.resizeNone' },
  { value: 'percent', label: 'tools.resizePercent' },
  { value: 'longside', label: 'tools.resizeLongside' },
  { value: 'exact', label: 'tools.resizeExact' },
];

const FORMATS: { value: ImageFormat | 'keep'; label: string }[] = [
  { value: 'keep', label: 'tools.fmtKeep' },
  { value: 'png', label: 'PNG' },
  { value: 'jpeg', label: 'JPEG' },
  { value: 'webp', label: 'WebP' },
];

const BG_COLORS = ['#ffffff', '#000000', '#f1f5f9', '#0f172a'];

/** 超过这个规模的图不做实时预览（每次改动都重绘会卡） */
const LIVE_PREVIEW_MAX_PIXELS = 4_000_000;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

type FileItem = {
  id: string;
  name: string;
  bytes: Uint8Array;
  mime: string;
  width: number;
  height: number;
  previewUrl: string;
  /** 已解码的图片元素，长期复用：预览和导出都不再重复解码原图 */
  img: HTMLImageElement;
};

type ResultItem = {
  id: string;
  name: string;
  bytes: Uint8Array;
  mime: string;
  width: number;
  height: number;
  previewUrl: string | null;
  srcBytes: number;
};

export default function ImageEditTool() {
  const t = useT();
  const [files, setFiles] = useState<FileItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [spec, setSpec] = useState<EditSpec>(DEFAULT_SPEC);
  /** 宽高联动：开启时改一边会自动按图片比例算另一边 */
  const [aspectLock, setAspectLock] = useState(true);
  const [targetKB, setTargetKB] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  /** 当前正在跑的那个处理动作，用来只在对应按钮上显示进度 */
  const [runScope, setRunScope] = useState<'current' | 'all' | null>(null);
  const [results, setResults] = useState<ResultItem[]>([]);
  /** 结果区里被点选的结果 id（可多选，只有选中的才允许下载） */
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  /** 预览只记尺寸；真正的画面是直接挂上去的 canvas，不经过编码 */
  const [previewSize, setPreviewSize] = useState<{ width: number; height: number } | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  /** 整页拖入高亮 */
  const [dropActive, setDropActive] = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);
  const previewHostRef = useRef<HTMLDivElement>(null);
  /** 同一时刻只允许一个批处理在跑，挡住连点造成的重复结果 */
  const runningRef = useRef(false);

  const active = useMemo(() => files.find((f) => f.id === activeId) ?? null, [files, activeId]);

  const targetBytes = useMemo(() => {
    const kb = Number(targetKB);
    return targetKB.trim() && Number.isFinite(kb) && kb > 0 ? Math.round(kb * 1024) : null;
  }, [targetKB]);
  const effectiveSpec = useMemo<EditSpec>(() => ({ ...spec, targetBytes }), [spec, targetBytes]);

  /** 当前设置下这张图会变成多大 */
  const predicted = useMemo(() => {
    if (!active) return null;
    const crop = effectiveSpec.crop
      ? clampCrop(effectiveSpec.crop, active.width, active.height)
      : { x: 0, y: 0, w: active.width, h: active.height };
    const size = computeTargetSize(crop.w, crop.h, effectiveSpec.resize);
    return { ...size, format: effectiveSpec.format === 'keep' ? 'png' : effectiveSpec.format };
  }, [active, effectiveSpec]);

  /**
   * 实时预览是否可用：目标体积要反复编码比对，重绘代价高；输出像素太多时挂 canvas 也卡。
   * 注意这里的判定是「输出」而不是「输入」——放大会让输出远大于输入。
   */
  const livePreviewOk = useMemo(() => {
    if (!active) return false;
    if (targetBytes) return false;
    if (!predicted) return false;
    return predicted.w * predicted.h <= LIVE_PREVIEW_MAX_PIXELS;
  }, [active, targetBytes, predicted]);

  const addFiles = useCallback(async (list: FileList | File[]) => {
    const arr = Array.from(list);
    if (!arr.length) return;
    const items: FileItem[] = [];
    for (const f of arr) {
      try {
        const bytes = new Uint8Array(await readFileAsArrayBuffer(f));
        const detected = detectMediaKind(bytes);
        if (!(f.type.startsWith('image/') || detected?.kind === 'image')) {
          toast.error(`${f.name} ${t('tools.notImageSkipped')}`);
          continue;
        }
        const mime = detected?.mime ?? f.type ?? 'image/png';
        // 缩略图和绘制共用同一条对象 URL，且长期保留（不再每次预览重新解码原图）
        const previewUrl = bytesToObjectUrl(bytes, mime);
        const img = await loadImageFromUrl(previewUrl);
        items.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: f.name,
          bytes,
          mime,
          width: img.naturalWidth,
          height: img.naturalHeight,
          previewUrl,
          img,
        });
      } catch (e) {
        toast.error(`${f.name}：${errText(e) || t('tools.loadFailed')}`);
      }
    }
    if (items.length) {
      setFiles((prev) => [...prev, ...items]);
      setActiveId((prev) => prev ?? items[0]!.id);
      setResults((prev) => {
        prev.forEach((r) => r.previewUrl && URL.revokeObjectURL(r.previewUrl));
        return [];
      });
    }
  }, []);

  /** 移除单个文件时回收它的对象 URL */
  const removeFile = useCallback((id: string) => {
    setFiles((prev) => {
      const target = prev.find((f) => f.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      const next = prev.filter((f) => f.id !== id);
      setActiveId((cur) => (cur === id ? next[0]?.id ?? null : cur));
      return next;
    });
  }, []);

  function clearAll() {
    files.forEach((f) => URL.revokeObjectURL(f.previewUrl));
    results.forEach((r) => r.previewUrl && URL.revokeObjectURL(r.previewUrl));
    setFiles([]);
    setActiveId(null);
    setResults([]);
    setSelectedIds(new Set());
    setSpec(DEFAULT_SPEC);
    setTargetKB('');
    setAspectLock(true);
    previewHostRef.current?.replaceChildren();
    setPreviewSize(null);
  }

  // 换文件时清掉上一张的预览
  useEffect(() => {
    previewHostRef.current?.replaceChildren();
    setPreviewSize(null);
  }, [activeId]);

  // 整页接收拖入：文件区大小会随内容变化，挂在 window 上才不会「有图之后拖不动」
  useEffect(() => {
    const hasFiles = (e: DragEvent) => Boolean(e.dataTransfer?.types?.includes('Files'));
    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      setDropActive(true);
    };
    const onDragLeave = (e: DragEvent) => {
      // relatedTarget 为空 = 真的离开了窗口
      if (!e.relatedTarget) setDropActive(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDropActive(false);
      if (e.dataTransfer?.files?.length) void addFiles(e.dataTransfer.files);
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [addFiles]);

  /**
   * 把结果画布直接挂到预览容器里，不做任何编码。
   * 之前是渲染成 PNG blob + 对象 URL，每次改设置都要完整编码一遍（大图上百毫秒），
   * 就是「调整时全局卡顿」的主要来源。
   */
  const paintPreview = useCallback(() => {
    if (!active) return;
    const host = previewHostRef.current;
    if (!host) return;
    const { canvas, width, height } = renderEdit(active.img, active.width, active.height, spec);
    // min-w-0 必须写：canvas 是 flex 项，默认 min-width:auto 会按内在尺寸（原图宽度）
    // 顶住容器，把整页撑出横向滚动条。
    canvas.className =
      'block h-auto max-h-[min(45vh,16rem)] w-auto max-w-full min-w-0 rounded-lg object-contain md:max-h-[min(50vh,20rem)]';
    host.replaceChildren(canvas);
    setPreviewSize({ width, height });
  }, [active, spec]);

  /** 手动渲染一次预览（实时预览不可用时用） */
  const renderNow = useCallback(() => {
    if (!active) return;
    setPreviewBusy(true);
    // 让出一个宏任务：先让按钮的 loading 态画出来，再做重活。
    // 这里刻意不用 requestAnimationFrame —— 帧被节流时（后台标签页等）它可能一直不触发。
    setTimeout(() => {
      try {
        paintPreview();
      } catch (e) {
        toast.error(errText(e) || t('tools.previewFailed'));
      } finally {
        setPreviewBusy(false);
      }
    }, 0);
  }, [active, paintPreview]);

  // 实时预览：设置变化后防抖重绘（纯 canvas 绘制，不编码）
  useEffect(() => {
    if (!active || !livePreviewOk || busy) return;
    const t = setTimeout(() => {
      try {
        paintPreview();
      } catch {
        /* 预览失败不打断操作，下次改动会重试 */
      }
    }, 260);
    return () => clearTimeout(t);
  }, [active, livePreviewOk, busy, paintPreview]);

  /**
   * 执行处理。
   * - scope='current'：只处理当前选中的那一张
   * - scope='all'：处理列表里的全部
   * 结果按 id 覆盖：本次没处理的条目保留，处理过的替换成最新一次。
   */
  async function run(scope: 'current' | 'all') {
    const targets = scope === 'current' ? (active ? [active] : []) : files;
    if (!targets.length) {
      toast.error(scope === 'current' ? t('tools.selectImageFirst') : t('tools.addImageFirst'));
      return;
    }
    // 连点保护：同一次批处理没结束前不再开第二次，避免结果区出现重复条目
    if (runningRef.current) return;
    runningRef.current = true;
    setBusy(true);
    setRunScope(scope);
    setProgress({ done: 0, total: targets.length });
    const out: ResultItem[] = [];
    try {
      for (let i = 0; i < targets.length; i++) {
        const f = targets[i]!;
        setProgress({ done: i, total: targets.length });
        // 让出一个宏任务，避免整批一次性占满主线程（多张图时尤其明显）
        await new Promise((r) => setTimeout(r, 0));
        const r = await encodeEdit(f, effectiveSpec);
        out.push({
          id: f.id,
          name: `${f.name.replace(/\.[^.]+$/, '')}.${extOf(r.format)}`,
          bytes: r.bytes,
          mime: r.mime,
          width: r.width,
          height: r.height,
          previewUrl: bytesToObjectUrl(r.bytes, r.mime),
          srcBytes: f.bytes.byteLength,
        });
        setProgress({ done: i + 1, total: targets.length });
      }
      // 覆盖式写入：本次处理过的按 id 替换，其余保留；最终按文件列表顺序排列
      const order = new Map(files.map((f, i) => [f.id, i]));
      setResults((prev) => {
        const map = new Map(prev.map((r) => [r.id, r]));
        for (const r of out) {
          const old = map.get(r.id);
          if (old?.previewUrl) URL.revokeObjectURL(old.previewUrl);
          map.set(r.id, r);
        }
        return [...map.values()].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
      });
      const before = targets.reduce((s, f) => s + f.bytes.byteLength, 0);
      const after = out.reduce((s, r) => s + r.bytes.byteLength, 0);
      const pct = before > 0 ? Math.round((1 - after / before) * 100) : 0;
      toast.success(
        t('tools.processDone', { count: out.length }) +
          (after < before
            ? t('tools.sizeDown', { pct })
            : after > before
              ? t('tools.sizeUp', { pct })
              : ''),
      );
    } catch (e) {
      toast.error(errText(e) || t('tools.processFailed'));
    } finally {
      runningRef.current = false;
      setBusy(false);
      setRunScope(null);
      setProgress(null);
    }
  }

  /** 点选 / 取消点选一条结果 */
  function toggleResult(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** 下载选中的结果（按结果列表顺序，多个就依次触发） */
  function downloadSelected() {
    const picked = results.filter((r) => selectedIds.has(r.id));
    if (!picked.length) return;
    picked.forEach((r, i) => setTimeout(() => downloadBytes(r.bytes, r.mime, r.name), i * 120));
  }

  // 结果被替换或清空后，丢掉已经不存在的选中项
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const ids = new Set(results.map((r) => r.id));
      const next = new Set<string>();
      let changed = false;
      for (const id of prev) {
        if (ids.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [results]);

  // ===================== 裁剪编辑器 =====================

  const [cropOpen, setCropOpen] = useState(false);
  const [cropDraft, setCropDraft] = useState<CropRect | null>(null);
  const [cropAspect, setCropAspect] = useState<number | null>(null);
  const cropBoxRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ mode: 'move' | 'resize'; sx: number; sy: number; orig: CropRect } | null>(null);

  function openCrop() {
    if (!active) return;
    setCropDraft(
      effectiveSpec.crop
        ? clampCrop(effectiveSpec.crop, active.width, active.height)
        : { x: 0, y: 0, w: active.width, h: active.height },
    );
    setCropOpen(true);
  }

  function onCropDown(e: React.PointerEvent, mode: 'move' | 'resize') {
    if (!cropDraft) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { mode, sx: e.clientX, sy: e.clientY, orig: cropDraft };
  }

  function onCropMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d || !active || !cropDraft || !cropBoxRef.current) return;
    const rect = cropBoxRef.current.getBoundingClientRect();
    const dx = ((e.clientX - d.sx) * active.width) / rect.width;
    const dy = ((e.clientY - d.sy) * active.height) / rect.height;
    if (d.mode === 'move') {
      setCropDraft({
        ...d.orig,
        x: Math.round(Math.min(Math.max(0, d.orig.x + dx), active.width - d.orig.w)),
        y: Math.round(Math.min(Math.max(0, d.orig.y + dy), active.height - d.orig.h)),
      });
    } else {
      let w = Math.round(d.orig.w + dx);
      let h = Math.round(d.orig.h + dy);
      if (cropAspect) h = Math.round(w / cropAspect);
      w = Math.min(Math.max(8, w), active.width - d.orig.x);
      h = Math.min(Math.max(8, h), active.height - d.orig.y);
      setCropDraft({ ...d.orig, w, h });
    }
  }

  // 宽高联动用的基准比例（裁剪后的区域）
  const baseRatio = useMemo(() => {
    if (!active) return 1;
    const c = spec.crop ? clampCrop(spec.crop, active.width, active.height) : { w: active.width, h: active.height };
    return c.w / Math.max(1, c.h);
  }, [active, spec.crop]);

  return (
    <div className="flex w-full shrink-0 flex-col gap-3">
      {/* 整页拖入时的提示层（不拦截事件，z 低于裁剪弹窗） */}
      {dropActive ? (
        <div className="pointer-events-none fixed inset-0 z-30 flex items-center justify-center bg-[rgb(var(--kk-comp-rgb)/0.12)] p-6">
          <div className="kk-tool-ctl rounded-2xl border-2 border-dashed border-[rgb(var(--kk-comp-rgb)/0.55)] px-6 py-4 text-sm font-medium text-slate-700">
            {t('tools.dropToAdd')}
          </div>
        </div>
      ) : null}

      {/* ① 图片区（整页任意位置都能拖入，见上面的 window 监听） */}
      <section className="kk-glass rounded-2xl p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-slate-700">{t('tools.imagesLabel')}{files.length ? ` ${files.length}` : ''}</span>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="kk-tool-ctl inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium text-slate-700"
          >
            <ImagePlus className="h-3.5 w-3.5" />
            {t('tools.addBtn')}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) void addFiles(e.target.files);
              e.target.value = '';
            }}
          />
        </div>

        {files.length ? (
          <div className="mt-2.5 flex gap-2 overflow-x-auto pb-1">
            {files.map((f) => (
              <div
                key={f.id}
                role="button"
                tabIndex={0}
                onClick={() => setActiveId(f.id)}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setActiveId(f.id)}
                aria-current={f.id === activeId}
                className="kk-tool-ring relative h-16 w-16 shrink-0 cursor-pointer overflow-hidden rounded-xl border-2"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={f.previewUrl} alt={f.name} className="h-full w-full object-cover" />
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeFile(f.id);
                  }}
                  className="absolute right-0.5 top-0.5 rounded-md bg-black/45 p-0.5 text-white/90"
                  aria-label={t('tools.remove')}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="kk-tool-well mt-2.5 flex min-h-[6rem] w-full flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-white/60 text-sm text-slate-500 transition hover:text-slate-700"
          >
            <ImagePlus className="h-6 w-6" />
            {t('tools.clickOrDrop')}
          </button>
        )}
      </section>

      {/* ② 实时预览区：只显示当前选中的一张 */}
      {active ? (
        <section className="kk-glass rounded-2xl p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium text-slate-700">{t('tools.previewLabel')}</span>
            <span className="min-w-0 truncate text-xs text-slate-500">
              {active.width}×{active.height} · {formatBytes(active.bytes.byteLength)}
              {previewSize
                ? ` → ${previewSize.width}×${previewSize.height}`
                : predicted
                  ? ` → ${predicted.w}×${predicted.h} ${predicted.format.toUpperCase()}`
                  : ''}
            </span>
          </div>
          <div className="kk-tool-well mt-2 flex min-h-[7rem] items-center justify-center rounded-xl p-3">
            {/* canvas 直接挂在这里，不走编码 */}
            <div ref={previewHostRef} className="flex w-full min-w-0 items-center justify-center" />
            {!previewSize ? (
              <div className="flex flex-col items-center gap-2 py-4 text-center text-xs text-slate-500">
                {previewBusy ? (
                  <>
                    <Loader2 className="h-5 w-5 animate-spin" />
                    {t('tools.genPreview')}
                  </>
                ) : livePreviewOk ? (
                  t('tools.livePreviewHint')
                ) : (
                  <>
                    <p>{t('tools.livePreviewOff')}</p>
                    <button
                      type="button"
                      onClick={() => renderNow()}
                      className="kk-tool-ctl mt-1 rounded-lg px-3 py-1.5 text-xs font-medium text-slate-700"
                    >
                      {t('tools.loadPreview')}
                    </button>
                  </>
                )}
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* ③ 调整区 */}
      {active ? (
        <section className="kk-glass flex flex-col gap-3 rounded-2xl p-3">
          <Seg
            label={t('tools.sizeLabel')}
            options={RESIZE_MODES.map((o) => ({ ...o, label: t(o.label) }))}
            value={spec.resize.mode}
            onChange={(v) =>
              setSpec((s) => {
                if (!active) return { ...s, resize: { ...s.resize, mode: v } };
                // 记录裁剪后的实际源尺寸，好给新模式补一个合理初值
                const crop = s.crop ? clampCrop(s.crop, active.width, active.height) : null;
                const srcW = crop ? crop.w : active.width;
                const srcH = crop ? crop.h : active.height;
                return { ...s, resize: withResizeDefaults(s.resize, v, srcW, srcH) };
              })
            }
          />

          {spec.resize.mode === 'percent' ? (
            <NumField
              label={t('tools.numPercent')}
              suffix="%"
              min={1}
              value={spec.resize.percent || ''}
              onChange={(v) => setSpec((s) => ({ ...s, resize: { ...s.resize, percent: v } }))}
              className="max-w-[14rem]"
            />
          ) : null}

          {spec.resize.mode === 'longside' ? (
            <NumField
              label={t('tools.numLongside')}
              suffix="px"
              value={spec.resize.longside || ''}
              onChange={(v) => setSpec((s) => ({ ...s, resize: { ...s.resize, longside: v } }))}
              className="max-w-[14rem]"
            />
          ) : null}

          {spec.resize.mode === 'exact' ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-end gap-2">
                <NumField
                  label={t('tools.numWidth')}
                  suffix="px"
                  value={spec.resize.width || ''}
                  onChange={(v) =>
                    setSpec((s) => ({
                      ...s,
                      resize: {
                        ...s.resize,
                        width: v,
                        height: aspectLock && v > 0 ? Math.round(v / Math.max(0.0001, baseRatio)) : s.resize.height,
                      },
                    }))
                  }
                  className="flex-1"
                />
                <span className="pb-2 text-slate-400">×</span>
                <NumField
                  label={t('tools.numHeight')}
                  suffix="px"
                  value={spec.resize.height || ''}
                  onChange={(v) =>
                    setSpec((s) => ({
                      ...s,
                      resize: {
                        ...s.resize,
                        height: v,
                        width: aspectLock && v > 0 ? Math.round(v * baseRatio) : s.resize.width,
                      },
                    }))
                  }
                  className="flex-1"
                />
              </div>
              <button
                type="button"
                onClick={() => setAspectLock((v) => !v)}
                aria-pressed={aspectLock}
                className="kk-tool-seg inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium text-slate-600"
              >
                {aspectLock ? <Link2 className="h-3 w-3" /> : <Unlink className="h-3 w-3" />}
                {t('tools.aspectLockLabel', { state: aspectLock ? t('tools.aspectOn') : t('tools.aspectOff') })}
              </button>
            </div>
          ) : null}

          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-slate-500">{t('tools.cropLabel')}</span>
            <div className="flex items-center gap-2">
              {spec.crop ? (
                <span className="text-xs text-slate-500">
                  {spec.crop.w}×{spec.crop.h}
                </span>
              ) : null}
              <button
                type="button"
                onClick={openCrop}
                className="kk-tool-ctl inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-slate-700"
              >
                <Crop className="h-3 w-3" />
                {spec.crop ? t('tools.recrop') : t('tools.cropBtn')}
              </button>
              {spec.crop ? (
                <button
                  type="button"
                  onClick={() => setSpec((s) => ({ ...s, crop: null }))}
                  className="text-xs text-slate-400 underline hover:text-slate-600"
                >
                  {t('tools.cancel')}
                </button>
              ) : null}
            </div>
          </div>

          <div className="flex items-center gap-2.5">
            <span className="w-10 shrink-0 text-xs font-medium text-slate-500">{t('tools.radiusLabel')}</span>
            <Slider
              min={0}
              max={Math.min(200, Math.floor(Math.min(active.width, active.height) / 2))}
              step={1}
              value={spec.round.radius}
              onValueChange={(v) => setSpec((s) => ({ ...s, round: { radius: v } }))}
              className="min-w-0 flex-1"
              aria-label={t('tools.radiusAria')}
            />
            <NumField
              label=""
              suffix="px"
              value={spec.round.radius}
              onChange={(v) => setSpec((s) => ({ ...s, round: { radius: v } }))}
              className="w-24"
            />
          </div>

          <Seg
            label={t('tools.formatLabel')}
            options={FORMATS.map((o) => ({ ...o, label: t(o.label) }))}
            value={spec.format}
            onChange={(v) => setSpec((s) => ({ ...s, format: v }))}
          />

          {spec.format !== 'png' && spec.format !== 'keep' ? (
            <div className="flex items-center gap-2.5">
              <span className="w-10 shrink-0 text-xs font-medium text-slate-500">{t('tools.qualityLabel')}</span>
              <Slider
                min={5}
                max={100}
                step={1}
                value={Math.round(spec.quality * 100)}
                onValueChange={(v) => setSpec((s) => ({ ...s, quality: v / 100 }))}
                className="min-w-0 flex-1"
                aria-label={t('tools.qualityAria')}
              />
              <span className="w-8 text-right text-xs text-slate-600">{Math.round(spec.quality * 100)}</span>
            </div>
          ) : null}

          <label className="flex max-w-[13rem] items-center gap-1.5">
            <span className="shrink-0 text-xs font-medium text-slate-500">{t('tools.targetSizeLabel')}</span>
            <input
              type="number"
              min={0}
              value={targetKB}
              onChange={(e) => setTargetKB(e.target.value)}
              placeholder={t('tools.noLimit')}
              className="kk-num-input kk-tool-ctl w-full min-w-0 rounded-lg px-2 py-1.5 text-sm"
            />
            <span className="shrink-0 text-xs text-slate-500">KB</span>
          </label>

          <div className="flex flex-wrap items-center gap-2">
            <span className="w-10 shrink-0 text-xs font-medium text-slate-500">{t('tools.bgLabel')}</span>
            {BG_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setSpec((s) => ({ ...s, background: s.background === c ? null : c }))}
                className="kk-tool-ring h-6 w-6 rounded-md border-2"
                style={{ backgroundColor: c }}
                aria-pressed={spec.background === c}
                aria-label={t('tools.bgAria', { c })}
              />
            ))}
            <input
              type="color"
              value={spec.background ?? '#ffffff'}
              onChange={(e) => setSpec((s) => ({ ...s, background: e.target.value }))}
              className="h-6 w-8 cursor-pointer rounded border-0 bg-transparent p-0"
              aria-label={t('tools.customBgAria')}
            />
            <span className="text-xs text-slate-400">{t('tools.bgKeepTransparent')}</span>
          </div>
        </section>
      ) : null}

      {/*
        ④ 统一操作栏
        手机两行（2×2 网格）、电脑一行（4 列），四个按钮尺寸/形状/顺序完全一致。
        grid-cols-N 在 Tailwind 里是 minmax(0,1fr)，比 flex-1 更不容易被内容撑破。
      */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <ActionButton onClick={() => void run('current')} disabled={busy || !active} tone="primary">
          {busy && runScope === 'current' ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {busy && runScope === 'current'
            ? `${progress?.done ?? 0}/${progress?.total ?? 0}`
            : t('tools.processCurrent')}
        </ActionButton>
        <ActionButton onClick={() => void run('all')} disabled={busy || !files.length} tone="primary">
          {busy && runScope === 'all' ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {busy && runScope === 'all' ? `${progress?.done ?? 0}/${progress?.total ?? 0}` : t('tools.processAll')}
        </ActionButton>
        <ActionButton onClick={downloadSelected} disabled={selectedIds.size === 0}>
          <Download className="h-4 w-4" />
          {t('tools.downloadBtn')}
        </ActionButton>
        <ActionButton onClick={clearAll} disabled={!files.length && !results.length} tone="danger">
          <Trash2 className="h-4 w-4" />
          {t('tools.clearBtn')}
        </ActionButton>
      </div>

      {busy && progress ? (
        <div className="kk-tool-well h-1.5 w-full overflow-hidden rounded-full">
          <div
            className="h-full rounded-full bg-[rgb(var(--kk-comp-rgb)/0.9)] transition-[width]"
            style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }}
          />
        </div>
      ) : null}

      {/* ⑤ 结果：点一下即选中（可多选），选中的才允许用底部「下载」 */}
      {results.length ? (
        <section className="kk-glass rounded-2xl p-3">
          <div className="mb-2.5 flex items-baseline justify-between gap-2">
            <span className="text-sm font-medium text-slate-700">{t('tools.resultsLabel')} {results.length}</span>
            <span className="text-xs text-slate-500">{t('tools.selectedCount', { count: selectedIds.size })}</span>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {results.map((r) => {
              const delta = r.srcBytes > 0 ? Math.round((1 - r.bytes.byteLength / r.srcBytes) * 100) : 0;
              const selected = selectedIds.has(r.id);
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => toggleResult(r.id)}
                  aria-pressed={selected}
                  title={selected ? t('tools.resultTitleSelected') : t('tools.resultTitleUnselected')}
                  // 未选中时边框透明 = 视觉上无框；选中才浮出描边，且不产生位移
                  className="kk-tool-pick relative flex flex-col gap-1.5 rounded-xl border-2 border-transparent p-1.5 text-left"
                >
                  {/* 按原始比例缩小展示，不套方框、不铺底色 */}
                  <div className="flex min-h-[5rem] items-center justify-center">
                    {r.previewUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={r.previewUrl} alt={r.name} className="block max-h-[9rem] w-auto max-w-full rounded-lg" />
                    ) : null}
                  </div>
                  <div className="min-w-0 text-xs text-slate-600">
                    <p className="truncate font-medium text-slate-700" title={r.name}>
                      {r.name}
                    </p>
                    <p>
                      {r.width}×{r.height} · {formatBytes(r.bytes.byteLength)}
                      {delta !== 0 ? (
                        <span className={delta > 0 ? 'text-emerald-600' : 'text-amber-600'}>
                          {' '}
                          {delta > 0 ? `-${delta}%` : `+${-delta}%`}
                        </span>
                      ) : null}
                    </p>
                  </div>
                  {selected ? (
                    <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-teal-500 text-white">
                      <Check className="h-3 w-3" />
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </section>
      ) : null}

      {/*
        底部垫片：工具路由走的是固定骨架（.kk-page-fixed 只留 0.75rem 底距），
        而这个工具是长内容页面，滚到底时最后一行会被视口圆角咬掉一截、也没法再往下滑。
        这里补一段可滚动距离（含安全区），口径与 .kk-page-flow 的 ::after 一致、只是给得更多。
      */}
      <div
        aria-hidden
        className="h-[calc(2.5rem+var(--safe-bottom))] w-full shrink-0 md:h-14"
      />

      {/* ⑥ 裁剪编辑器 */}
      {cropOpen && active && cropDraft ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3">
          <div className="kk-glass flex max-h-[92vh] w-full max-w-2xl flex-col gap-3 overflow-auto rounded-2xl p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-slate-700">
                {t('tools.cropLabel')} · {active.width}×{active.height}
              </span>
              <button
                type="button"
                onClick={() => setCropOpen(false)}
                className="kk-tool-seg rounded-md p-1 text-slate-500"
                aria-label={t('tools.close')}
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex flex-wrap gap-1.5">
              {ASPECT_PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => {
                    setCropAspect(p.value);
                    if (p.value && cropDraft) {
                      const w = Math.max(
                        1,
                        Math.min(cropDraft.w, Math.round(active.height * p.value), active.width),
                      );
                      setCropDraft(clampCrop({ ...cropDraft, w, h: Math.round(w / p.value) }, active.width, active.height));
                    }
                  }}
                  aria-pressed={cropAspect === p.value}
                  className="kk-tool-seg rounded-full px-2.5 py-1 text-xs font-medium text-slate-600"
                >
                  {p.label}
                </button>
              ))}
            </div>

            <div
              ref={cropBoxRef}
              className="kk-tool-well relative mx-auto w-full max-w-[32rem] select-none overflow-hidden rounded-xl"
              style={{ aspectRatio: `${active.width} / ${active.height}` }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={active.previewUrl} alt="" className="block h-full w-full" draggable={false} />
              <div
                className="absolute cursor-move border-2 border-white/90 shadow-[0_0_0_9999px_rgba(15,23,42,0.45)]"
                style={{
                  left: `${(cropDraft.x / active.width) * 100}%`,
                  top: `${(cropDraft.y / active.height) * 100}%`,
                  width: `${(cropDraft.w / active.width) * 100}%`,
                  height: `${(cropDraft.h / active.height) * 100}%`,
                }}
                onPointerDown={(e) => onCropDown(e, 'move')}
                onPointerMove={onCropMove}
                onPointerUp={() => (dragRef.current = null)}
              >
                <div
                  role="button"
                  tabIndex={0}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    onCropDown(e, 'resize');
                  }}
                  onPointerMove={onCropMove}
                  onPointerUp={() => (dragRef.current = null)}
                  className="absolute -bottom-1.5 -right-1.5 h-4 w-4 cursor-se-resize rounded-sm border-2 border-white bg-teal-500"
                  aria-label={t('tools.resizeHandle')}
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-slate-500">{t('tools.exactValues')}</span>
              {(
                [
                  ['x', 'X'],
                  ['y', 'Y'],
                  ['w', t('tools.numWidth')],
                  ['h', t('tools.numHeight')],
                ] as const
              ).map(([k, label]) => (
                <NumField
                  key={k}
                  label={label}
                  value={cropDraft[k]}
                  min={k === 'x' || k === 'y' ? 0 : 1}
                  onChange={(v) => setCropDraft((d) => (d ? { ...d, [k]: v } : d))}
                  className="w-[4.75rem] sm:w-[5.75rem]"
                />
              ))}
              <button
                type="button"
                onClick={() => setCropDraft({ x: 0, y: 0, w: active.width, h: active.height })}
                className="kk-tool-ctl inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-slate-700"
              >
                <RotateCcw className="h-3 w-3" />
                {t('tools.wholeImage')}
              </button>
            </div>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setCropOpen(false)}
                className="kk-tool-ctl rounded-lg px-3 py-1.5 text-sm font-medium text-slate-700"
              >
                {t('tools.cancel')}
              </button>
              <button
                type="button"
                onClick={() => {
                  setSpec((s) => ({ ...s, crop: clampCrop(cropDraft, active.width, active.height) }));
                  setCropOpen(false);
                }}
                className="kk-tool-ctl kk-tool-ctl--on rounded-lg px-3 py-1.5 text-sm font-medium"
              >
                {t('tools.apply')} {cropDraft.w}×{cropDraft.h}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
