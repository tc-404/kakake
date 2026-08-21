import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Copy, Download, FileUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ToolTextField } from '@/pages/tools/ToolTextField';
import {
  base64ToBytes,
  bytesToBase64,
  bytesToObjectUrl,
  captureVideoPoster,
  detectMediaKind,
  downloadTextAsDateFile,
  isLikelyTextFile,
  readFileAsArrayBuffer,
  readFileAsText,
  type MediaKind,
} from '@/pages/tools/base64-media';

type Mode = 'base64' | 'url' | 'unicode';

type MediaPreview = {
  kind: MediaKind;
  url: string;
  mime: string;
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
  { id: 'url', label: 'URL' },
  { id: 'unicode', label: 'Unicode' },
];

const ACTION_BTN =
  'inline-flex h-10 w-full min-w-0 items-center justify-center rounded-xl text-sm font-medium transition disabled:opacity-50';

function encodeBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

function decodeBase64Text(text: string): string {
  return new TextDecoder().decode(base64ToBytes(text));
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
  try {
    await navigator.clipboard.writeText(text);
    toast.success('已复制');
  } catch {
    toast.error('复制失败');
  }
}

export default function EncodeTool() {
  const [mode, setMode] = useState<Mode>('base64');
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [mediaPreview, setMediaPreview] = useState<MediaPreview | null>(null);
  const [dragging, setDragging] = useState(false);
  const [pendingFile, setPendingFile] = useState<PendingFile | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const previewUrlRef = useRef<string | null>(null);
  const pendingPreviewRef = useRef<string | null>(null);

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

  function setMediaFromBytes(bytes: Uint8Array) {
    const detected = detectMediaKind(bytes);
    if (!detected) {
      clearMediaPreview();
      return false;
    }
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    const url = bytesToObjectUrl(bytes, detected.mime);
    previewUrlRef.current = url;
    setMediaPreview({ kind: detected.kind, url, mime: detected.mime });
    return true;
  }

  useEffect(
    () => () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      if (pendingPreviewRef.current) URL.revokeObjectURL(pendingPreviewRef.current);
    },
    [],
  );

  function runEncode() {
    try {
      clearMediaPreview();
      let next = '';
      if (mode === 'base64') {
        if (pendingFile) next = bytesToBase64(pendingFile.bytes);
        else next = encodeBase64(input);
      } else if (mode === 'url') next = encodeURIComponent(input);
      else next = encodeUnicode(input);
      setOutput(next);
      toast.success('编码成功');
    } catch (e) {
      setOutput('');
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  function runDecode() {
    try {
      if (mode === 'base64') {
        if (pendingFile) {
          toast.message('当前是待编码的文件，请先点「编码」，或清空后粘贴 Base64 再解码');
          return;
        }
        const bytes = base64ToBytes(input);
        if (setMediaFromBytes(bytes)) {
          setOutput('');
          toast.success('解码成功');
          return;
        }
        clearMediaPreview();
        setOutput(decodeBase64Text(input));
        toast.success('解码成功');
        return;
      }
      clearMediaPreview();
      let next = '';
      if (mode === 'url') next = decodeURIComponent(input);
      else next = decodeUnicode(input);
      setOutput(next);
      toast.success('解码成功');
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

  function onDownload() {
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
      toast.success(`已选择 ${file.name}，点「编码」生成 Base64`);
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

  const actionButtons = (
    <div className="grid shrink-0 grid-cols-3 gap-2 sm:gap-3">
      <button
        type="button"
        onClick={runEncode}
        className={cn(ACTION_BTN, 'bg-teal-500/90 text-white hover:bg-teal-600')}
      >
        编码
      </button>
      <button
        type="button"
        onClick={runDecode}
        className={cn(ACTION_BTN, 'border border-white/50 bg-white/40 text-slate-700 hover:bg-white/60')}
      >
        解码
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
        {mode === 'base64' ? (
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
          mode === 'base64' && dragging && 'kk-tool-field-drop-active',
        )}
        onDragEnter={
          mode === 'base64'
            ? (e) => {
                e.preventDefault();
                e.stopPropagation();
                setDragging(true);
              }
            : undefined
        }
        onDragOver={
          mode === 'base64'
            ? (e) => {
                e.preventDefault();
                e.stopPropagation();
                setDragging(true);
              }
            : undefined
        }
        onDragLeave={
          mode === 'base64'
            ? (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (e.currentTarget.contains(e.relatedTarget as Node)) return;
                setDragging(false);
              }
            : undefined
        }
        onDrop={
          mode === 'base64'
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
              mode === 'base64' && dragging && 'kk-tool-field--dragover',
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
              {' · 点「编码」生成 Base64'}
            </p>
          </div>
        ) : (
          <ToolTextField
            fill
            value={input}
            onChange={(e) => onInputChange(e.target.value)}
            placeholder={
              mode === 'base64'
                ? '粘贴文本，或拖拽 / 选择文件…'
                : '在此粘贴要转换的文本…'
            }
            spellCheck={false}
            className={cn(mode === 'base64' && dragging && 'kk-tool-field--dragover')}
          />
        )}
        {mode === 'base64' && dragging ? (
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
      <div className="flex shrink-0 flex-wrap gap-2">
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
