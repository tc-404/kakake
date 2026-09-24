import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ArrowLeftRight, Copy, Download, FileUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import { copyToClipboard } from '@/lib/clipboard';
import { ToolTextField } from '@/pages/tools/ToolTextField';
import {
  base32ToBytes,
  base64GzipToText,
  base64ToBytes,
  bytesToBase32,
  bytesToBase64,
  bytesToBase64Url,
  bytesToHex,
  bytesToObjectUrl,
  captureVideoPoster,
  detectMediaKind,
  downloadBytes,
  downloadTextAsDateFile,
  gzipTextToBase64,
  hexToBytes,
  isLikelyTextFile,
  looksBinary,
  readFileAsArrayBuffer,
  readFileAsText,
  type MediaKind,
} from '@/pages/tools/base64-media';
import {
  RADIX_VALUES,
  decimalToRadix,
  decodeHtmlEntities,
  encodeHtmlEntities,
  radixToDecimal,
  type Radix,
} from '@/pages/tools/text-codecs';

type Mode = 'base64' | 'base32' | 'hex' | 'url' | 'unicode' | 'html' | 'radix' | 'gzip';

type BinaryMode = 'base64' | 'base32' | 'hex';

type MediaPreview = {
  kind: MediaKind;
  url: string;
  mime: string;
  bytes: Uint8Array;
};

type PendingFile = {
  name: string;
  bytes: Uint8Array;
  kind: MediaKind | 'other';
  /** 输入框内：图片预览或视频封面 */
  inputPreviewUrl: string | null;
};

const MODES: { id: Mode; label: string }[] = [
  { id: 'base64', label: 'Base64' },
  { id: 'base32', label: 'Base32' },
  { id: 'hex', label: 'Hex' },
  { id: 'url', label: 'URL' },
  { id: 'unicode', label: 'Unicode' },
  { id: 'html', label: 'HTML 实体' },
  { id: 'radix', label: '进制' },
  { id: 'gzip', label: '压缩' },
];

const BINARY_LABEL: Record<BinaryMode, string> = {
  base64: 'Base64',
  base32: 'Base32',
  hex: 'Hex',
};

const ACTION_BTN =
  'inline-flex h-10 w-full min-w-0 items-center justify-center gap-1.5 rounded-xl text-sm font-medium transition disabled:opacity-50';

/** 支持「文件 / 二进制预览」的模式 */
function isBinaryMode(mode: Mode): mode is BinaryMode {
  return mode === 'base64' || mode === 'base32' || mode === 'hex';
}

function encodeBase64Text(text: string, urlSafe: boolean): string {
  const bytes = new TextEncoder().encode(text);
  return urlSafe ? bytesToBase64Url(bytes) : bytesToBase64(bytes);
}

function encodeBase64Bytes(bytes: Uint8Array, urlSafe: boolean): string {
  return urlSafe ? bytesToBase64Url(bytes) : bytesToBase64(bytes);
}

function decodeBytesText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function encodeUnicode(text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp <= 0xffff) {
      out += `\\u${cp.toString(16).padStart(4, '0')}`;
    } else {
      const hi = Math.floor((cp - 0x10000) / 0x400) + 0xd800;
      const lo = ((cp - 0x10000) % 0x400) + 0xdc00;
      out += `\\u${hi.toString(16).padStart(4, '0')}\\u${lo.toString(16).padStart(4, '0')}`;
    }
  }
  return out;
}

function decodeUnicode(text: string): string {
  return text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
}

/**
 * URL 编码：
 * - whole = false（默认）走 encodeURIComponent，连 : / ? # 一并转义，适合拼参数值；
 * - whole = true 走 encodeURI，保留 : / ? # & = 等结构符号，适合整条链接。
 */
function encodeUrl(text: string, whole: boolean): string {
  try {
    return whole ? encodeURI(text) : encodeURIComponent(text);
  } catch {
    throw new Error('含无法编码的字符（如孤立代理项）');
  }
}

/**
 * URL 解码（组件模式）：encodeURIComponent 会把字面量 + 编成 %2B，
 * 所以正文里出现的 + 只可能是表单编码的空格，可以直接还原。
 */
function decodeUrlComponent(text: string): string {
  try {
    return decodeURIComponent(text.trim().replace(/\+/g, '%20'));
  } catch {
    throw new Error('URL 编码不完整或格式有误（存在非法的 % 转义）');
  }
}

/** URL 解码（整段模式）：只还原被 encodeURI 转义的字符，保留 : / ? # & = 等符号 */
function decodeWholeUrl(text: string): string {
  try {
    return decodeURI(text.trim());
  } catch {
    throw new Error('URL 格式有误（存在非法的 % 转义）');
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

async function copyText(text: string) {
  if (!text) {
    toast.message('没有可复制的内容');
    return;
  }
  const ok = await copyToClipboard(text);
  if (ok) toast.success('已复制');
  else toast.error('复制失败');
}

type Option = { value: string; label: string };

/** 模式专属的选项行（分段选择 + 一行说明） */
function OptionRow({
  options,
  value,
  onChange,
  hint,
}: {
  options: Option[];
  value: string;
  onChange: (next: string) => void;
  hint: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex items-center gap-0.5 rounded-full border border-white/50 bg-white/35 p-0.5 text-xs font-medium">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            aria-pressed={value === o.value}
            className={cn(
              'rounded-full px-2.5 py-1 transition',
              value === o.value
                ? 'bg-teal-500/90 text-white shadow-sm'
                : 'text-slate-600 hover:bg-white/55',
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
      <span className="text-xs text-slate-500">{hint}</span>
    </div>
  );
}

export default function EncodeTool() {
  const [mode, setMode] = useState<Mode>('base64');
  const [b64UrlSafe, setB64UrlSafe] = useState(false);
  const [wholeUrl, setWholeUrl] = useState(false);
  const [htmlHex, setHtmlHex] = useState(false);
  const [radix, setRadix] = useState<Radix>(16);
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [mediaPreview, setMediaPreview] = useState<MediaPreview | null>(null);
  const [dragging, setDragging] = useState(false);
  const [pendingFile, setPendingFile] = useState<PendingFile | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const previewUrlRef = useRef<string | null>(null);
  const pendingPreviewRef = useRef<string | null>(null);

  const binaryMode = isBinaryMode(mode);

  function clearMediaPreview() {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    setMediaPreview(null);
  }

  function clearPendingFile() {
    if (pendingPreviewRef.current) {
      URL.revokeObjectURL(pendingPreviewRef.current);
      pendingPreviewRef.current = null;
    }
    setPendingFile(null);
  }

  function clearAll() {
    clearMediaPreview();
    clearPendingFile();
    setInput('');
    setOutput('');
  }

  /** 切选项时只清结果，输入保留，方便直接重跑 */
  function resetResult() {
    clearMediaPreview();
    setOutput('');
  }

  function setMediaFromBytes(bytes: Uint8Array) {
    const detected = detectMediaKind(bytes);
    if (!detected) {
      clearMediaPreview();
      return false;
    }
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    const url = bytesToObjectUrl(bytes, detected.mime);
    previewUrlRef.current = url;
    setMediaPreview({ kind: detected.kind, url, mime: detected.mime, bytes });
    return true;
  }

  useEffect(
    () => () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      if (pendingPreviewRef.current) URL.revokeObjectURL(pendingPreviewRef.current);
    },
    [],
  );

  async function runEncode() {
    try {
      clearMediaPreview();
      let next = '';
      if (mode === 'base64') {
        next = pendingFile
          ? encodeBase64Bytes(pendingFile.bytes, b64UrlSafe)
          : encodeBase64Text(input, b64UrlSafe);
      } else if (mode === 'base32') {
        next = pendingFile
          ? bytesToBase32(pendingFile.bytes)
          : bytesToBase32(new TextEncoder().encode(input));
      } else if (mode === 'hex') {
        next = pendingFile
          ? bytesToHex(pendingFile.bytes)
          : bytesToHex(new TextEncoder().encode(input));
      } else if (mode === 'url') {
        next = encodeUrl(input, wholeUrl);
      } else if (mode === 'html') {
        next = encodeHtmlEntities(input, htmlHex);
      } else if (mode === 'radix') {
        next = decimalToRadix(input, radix);
      } else {
        next = await gzipTextToBase64(input);
      }
      setOutput(next);
      toast.success(mode === 'gzip' ? '压缩并编码成功' : '编码成功');
    } catch (e) {
      setOutput('');
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function runDecode() {
    try {
      // Base64 / Base32 / Hex：先按二进制处理，能识别成媒体就直接预览
      if (isBinaryMode(mode)) {
        if (pendingFile) {
          toast.message('当前是待编码的文件，请先点「编码」，或清空后粘贴内容再解码');
          return;
        }
        const bytes =
          mode === 'base64'
            ? base64ToBytes(input)
            : mode === 'base32'
              ? base32ToBytes(input)
              : hexToBytes(input);
        if (setMediaFromBytes(bytes)) {
          setOutput('');
          toast.success('解码成功');
          return;
        }
        clearMediaPreview();
        setOutput(decodeBytesText(bytes));
        if (looksBinary(bytes)) {
          toast.message('解码完成，但内容疑似二进制，已按文本展示');
        } else {
          toast.success('解码成功');
        }
        return;
      }

      clearMediaPreview();
      let next = '';
      if (mode === 'url') next = wholeUrl ? decodeWholeUrl(input) : decodeUrlComponent(input);
      else if (mode === 'unicode') next = decodeUnicode(input);
      else if (mode === 'html') next = decodeHtmlEntities(input);
      else if (mode === 'radix') next = radixToDecimal(input, radix);
      else next = await base64GzipToText(input);
      setOutput(next);
      toast.success(mode === 'gzip' ? '解压成功' : '解码成功');
    } catch (e) {
      clearMediaPreview();
      setOutput('');
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  function onClear() {
    clearAll();
    toast.success('已清空');
  }

  /** 把结果搬回输入框，方便反向验证 */
  function onSwap() {
    if (mediaPreview) {
      toast.message('当前结果是媒体预览，无法交换');
      return;
    }
    if (!output) {
      toast.message('还没有可交换的内容');
      return;
    }
    clearPendingFile();
    clearMediaPreview();
    setInput(output);
    setOutput('');
    toast.success('已交换到输入框');
  }

  function onDownload() {
    // 解码出的图片 / 视频 / 音频：按真实类型存原文件
    if (mediaPreview) {
      downloadBytes(mediaPreview.bytes, mediaPreview.mime, 'decoded');
      toast.success('已开始下载原文件');
      return;
    }
    if (!output) {
      toast.message('没有可下载的内容');
      return;
    }
    downloadTextAsDateFile(output);
    toast.success('已开始下载');
  }

  async function loadFile(file: File) {
    try {
      if (isLikelyTextFile(file)) {
        const text = await readFileAsText(file);
        clearPendingFile();
        setInput(text);
        toast.success(`已载入 ${file.name}`);
        return;
      }

      const buf = await readFileAsArrayBuffer(file);
      const bytes = new Uint8Array(buf);
      const detected = detectMediaKind(bytes);
      let inputPreviewUrl: string | null = null;

      if (detected?.kind === 'image') {
        inputPreviewUrl = bytesToObjectUrl(bytes, detected.mime);
      } else if (detected?.kind === 'video') {
        const videoUrl = bytesToObjectUrl(bytes, detected.mime);
        try {
          inputPreviewUrl = await captureVideoPoster(videoUrl);
        } catch {
          inputPreviewUrl = null;
        } finally {
          URL.revokeObjectURL(videoUrl);
        }
      }

      if (pendingPreviewRef.current) URL.revokeObjectURL(pendingPreviewRef.current);
      pendingPreviewRef.current = inputPreviewUrl;

      setPendingFile({
        name: file.name,
        bytes,
        kind: detected?.kind ?? 'other',
        inputPreviewUrl,
      });
      setInput('');
      toast.success(
        `已选择 ${file.name}，点「编码」生成 ${isBinaryMode(mode) ? BINARY_LABEL[mode] : ''}`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  function onModeChange(next: Mode) {
    if (next === mode) return;
    setMode(next);
    clearAll();
  }

  function onInputChange(value: string) {
    if (pendingFile) clearPendingFile();
    setInput(value);
  }

  function inputPlaceholder(): string {
    if (mode === 'base64') {
      return b64UrlSafe
        ? '粘贴文本或 URL-safe Base64，或拖拽 / 选择文件…'
        : '粘贴文本，或拖拽 / 选择文件…';
    }
    if (mode === 'base32') return '粘贴文本或 Base32，或拖拽 / 选择文件…';
    if (mode === 'hex') return '粘贴十六进制，或拖拽 / 选择文件（可含空格、0x 前缀）…';
    if (mode === 'url') {
      return wholeUrl ? '粘贴整条 URL（保留 : / ? # 等符号）…' : '粘贴要编码的文本或参数值…';
    }
    if (mode === 'html') return '粘贴文本或 HTML 实体…';
    if (mode === 'radix') return '输入数字（可带正负号、空格或下划线分隔）…';
    if (mode === 'gzip') return '粘贴文本，或 Base64（H4sI… / eJ… 会自动识别）…';
    return '在此粘贴要转换的文本…';
  }

  const actionButtons = (
    <div className="grid shrink-0 grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-3">
      <button
        type="button"
        onClick={() => void runEncode()}
        className={cn(ACTION_BTN, 'bg-teal-500/90 text-white hover:bg-teal-600')}
      >
        编码
      </button>
      <button
        type="button"
        onClick={() => void runDecode()}
        className={cn(ACTION_BTN, 'border border-white/50 bg-white/40 text-slate-700 hover:bg-white/60')}
      >
        解码
      </button>
      <button
        type="button"
        onClick={onSwap}
        className={cn(ACTION_BTN, 'border border-white/50 bg-white/40 text-slate-700 hover:bg-white/60')}
      >
        <ArrowLeftRight className="h-3.5 w-3.5" />
        交换
      </button>
      <button
        type="button"
        onClick={onClear}
        className={cn(ACTION_BTN, 'border border-white/50 bg-white/40 text-slate-700 hover:bg-white/60')}
      >
        清空
      </button>
    </div>
  );

  const inputPane = (
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-2">
      <div className="flex shrink-0 items-center justify-between gap-2">
        <label className="text-sm font-medium text-slate-700">输入</label>
        {binaryMode ? (
          <>
            <input
              ref={fileRef}
              type="file"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void loadFile(f);
              }}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-xs text-slate-600 hover:bg-white/50"
            >
              <FileUp className="h-3.5 w-3.5" />
              选择文件
            </button>
          </>
        ) : null}
      </div>

      <div
        className={cn(
          'relative min-h-0 flex-1',
          binaryMode && dragging && 'kk-tool-field-drop-active',
        )}
        onDragEnter={
          binaryMode
            ? (e) => {
                e.preventDefault();
                e.stopPropagation();
                setDragging(true);
              }
            : undefined
        }
        onDragOver={
          binaryMode
            ? (e) => {
                e.preventDefault();
                e.stopPropagation();
                setDragging(true);
              }
            : undefined
        }
        onDragLeave={
          binaryMode
            ? (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (e.currentTarget.contains(e.relatedTarget as Node)) return;
                setDragging(false);
              }
            : undefined
        }
        onDrop={
          binaryMode
            ? (e) => {
                e.preventDefault();
                e.stopPropagation();
                setDragging(false);
                const f = e.dataTransfer.files?.[0];
                if (f) void loadFile(f);
              }
            : undefined
        }
      >
        {pendingFile ? (
          <div
            className={cn(
              'kk-tool-field kk-tool-field--fill flex h-full flex-col items-center justify-center gap-2 px-4 py-4 text-center',
              binaryMode && dragging && 'kk-tool-field--dragover',
            )}
          >
            <span className="kk-tool-field__accent" aria-hidden />
            {pendingFile.inputPreviewUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={pendingFile.inputPreviewUrl}
                alt={pendingFile.kind === 'video' ? '视频封面' : '图片预览'}
                className="relative z-[1] max-h-[min(40vh,14rem)] max-w-full rounded-lg object-contain shadow-sm md:max-h-[min(50%,16rem)]"
              />
            ) : (
              <FileUp className="relative z-[1] h-8 w-8 text-slate-400" />
            )}
            <p className="relative z-[1] max-w-full truncate text-sm font-medium text-slate-800">
              {pendingFile.name}
            </p>
            <p className="relative z-[1] text-xs text-slate-500">
              {formatBytes(pendingFile.bytes.byteLength)}
              {pendingFile.kind === 'video' ? ' · 封面预览' : ''}
              {pendingFile.kind === 'image' ? ' · 图片预览' : ''}
              {` · 点「编码」生成 ${isBinaryMode(mode) ? BINARY_LABEL[mode] : ''}`}
            </p>
          </div>
        ) : (
          <ToolTextField
            fill
            value={input}
            onChange={(e) => onInputChange(e.target.value)}
            placeholder={inputPlaceholder()}
            spellCheck={false}
            className={cn(binaryMode && dragging && 'kk-tool-field--dragover')}
          />
        )}
        {binaryMode && dragging ? (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[1.05rem] bg-teal-500/10 text-sm font-medium text-teal-800">
            松开以载入文件
          </div>
        ) : null}
      </div>
    </div>
  );

  const outputPane = (
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-2">
      <div className="flex shrink-0 items-center justify-between gap-2">
        <label className="text-sm font-medium text-slate-700">输出</label>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void copyText(output)}
            className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-xs text-slate-600 hover:bg-white/50"
          >
            <Copy className="h-3.5 w-3.5" />
            复制
          </button>
          <button
            type="button"
            onClick={onDownload}
            className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-xs text-slate-600 hover:bg-white/50"
          >
            <Download className="h-3.5 w-3.5" />
            下载
          </button>
        </div>
      </div>

      {mediaPreview ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500">
            <span className="truncate font-medium text-slate-600">{mediaPreview.mime}</span>
            <span aria-hidden>·</span>
            <span className="shrink-0">{formatBytes(mediaPreview.bytes.byteLength)}</span>
            <span className="shrink-0">· 点右上「下载」保存原文件</span>
          </div>
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto rounded-[1.05rem] border border-white/40 bg-black/5 p-3">
            {mediaPreview.kind === 'image' ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={mediaPreview.url}
                alt="解码预览"
                className="max-h-full max-w-full rounded-lg object-contain"
              />
            ) : null}
            {mediaPreview.kind === 'video' ? (
              // eslint-disable-next-line jsx-a11y/media-has-caption
              <video
                src={mediaPreview.url}
                controls
                playsInline
                className="max-h-full w-full rounded-lg bg-black"
              />
            ) : null}
            {mediaPreview.kind === 'audio' ? (
              // eslint-disable-next-line jsx-a11y/media-has-caption
              <audio src={mediaPreview.url} controls className="w-full" />
            ) : null}
          </div>
        </div>
      ) : (
        <ToolTextField
          fill
          value={output}
          readOnly
          placeholder="结果将显示在这里…"
          spellCheck={false}
        />
      )}
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 flex-col gap-2">
        <div className="flex flex-wrap gap-2">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => onModeChange(m.id)}
              className={cn(
                'rounded-full px-3 py-1.5 text-sm font-medium transition',
                mode === m.id
                  ? 'bg-teal-500/90 text-white shadow-sm'
                  : 'bg-white/35 text-slate-600 hover:bg-white/55',
              )}
            >
              {m.label}
            </button>
          ))}
        </div>

        {mode === 'base64' ? (
          <OptionRow
            options={[
              { value: 'std', label: '标准' },
              { value: 'url', label: 'URL-safe' },
            ]}
            value={b64UrlSafe ? 'url' : 'std'}
            onChange={(v) => {
              const next = v === 'url';
              if (next === b64UrlSafe) return;
              setB64UrlSafe(next);
              resetResult();
            }}
            hint={
              b64UrlSafe
                ? '输出把 + / 换成 - _ 并去掉 =（JWT、URL 参数用）'
                : '标准字母表，含 + / 与 = 填充'
            }
          />
        ) : null}

        {mode === 'url' ? (
          <OptionRow
            options={[
              { value: 'component', label: '组件' },
              { value: 'whole', label: '整段 URL' },
            ]}
            value={wholeUrl ? 'whole' : 'component'}
            onChange={(v) => {
              const next = v === 'whole';
              if (next === wholeUrl) return;
              setWholeUrl(next);
              resetResult();
            }}
            hint={
              wholeUrl
                ? '保留 : / ? # & = 等结构符号，适合整条链接'
                : '按参数值编码，冒号斜杠也会被转义'
            }
          />
        ) : null}

        {mode === 'html' ? (
          <OptionRow
            options={[
              { value: 'dec', label: '十进制' },
              { value: 'hex', label: '十六进制' },
            ]}
            value={htmlHex ? 'hex' : 'dec'}
            onChange={(v) => {
              const next = v === 'hex';
              if (next === htmlHex) return;
              setHtmlHex(next);
              resetResult();
            }}
            hint={`非 ASCII 与 & < > " ' 会转成实体，如 ${htmlHex ? '&#x4F60;' : '&#20320;'}`}
          />
        ) : null}

        {mode === 'radix' ? (
          <OptionRow
            options={RADIX_VALUES.map((v) => ({ value: String(v), label: String(v) }))}
            value={String(radix)}
            onChange={(v) => {
              const next = Number(v) as Radix;
              if (next === radix) return;
              setRadix(next);
              resetResult();
            }}
            hint={`编码：十进制 → ${radix} 进制；解码：${radix} 进制 → 十进制`}
          />
        ) : null}

        {mode === 'gzip' ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-slate-500">
              编码：文本 → gzip → Base64；解码：Base64（gzip / zlib / deflate）→ 文本，按
              H4sI / eJ 开头自动识别
            </span>
          </div>
        ) : null}
      </div>

      <div
        className={cn(
          'kk-glass min-h-0 flex-1 overflow-hidden rounded-2xl border border-white/40 p-3 sm:p-4',
          // 手机：上下均分；电脑：左右并排 + 底栏按钮
          'flex flex-col gap-3',
          'md:grid md:grid-cols-2 md:grid-rows-[minmax(0,1fr)_auto] md:gap-x-4 md:gap-y-3',
        )}
      >
        <div className="min-h-0 flex-1 md:min-h-0">{inputPane}</div>
        <div className="order-3 min-h-0 flex-1 md:order-none md:col-start-2 md:row-start-1 md:min-h-0">
          {outputPane}
        </div>
        <div className="order-2 shrink-0 md:order-none md:col-span-2">{actionButtons}</div>
      </div>
    </div>
  );
}
