import { useState } from 'react';
import { AtSign, FileWarning, Reply, Smile, Music, Layers, FileText } from 'lucide-react';
import { resolveMediaSrc, normalizeMessage, type Seg } from './media-source';
import { ImageLightbox } from './MediaViewer';
import { Portal } from './Portal';

/** 渲染一个 OB11 消息段数组（用户输入或插件发送的 message 字段） */
export function MessageSegments({ message }: { message: unknown }) {
  const segs = normalizeMessage(message);
  if (!segs.length) {
    return <span className="text-muted-foreground italic">（空消息）</span>;
  }

  // 整条消息本身就是一个合并转发 → 只渲染「一张」聊天记录卡片（仿 QQ），
  // 点开才看内容；节点内部若再含合并转发，才会在里层继续出现卡片。
  if (segs.length === 1 && segs[0].type === 'forward') {
    return <ForwardCard data={segs[0].data} />;
  }
  if (segs.every((s) => s.type === 'node')) {
    return <ForwardCard data={{ content: segs.map((s) => s.data) }} />;
  }

  // reply 段抽到顶部，换行堆叠显示（仿手机引用）
  const reply = segs.find((s) => s.type === 'reply');
  const rest = segs.filter((s) => s.type !== 'reply');

  return (
    <div className="flex min-w-0 max-w-full flex-col gap-1.5">
      {reply && <ReplyQuote data={reply.data} />}
      <div className="flex min-w-0 max-w-full flex-wrap items-center gap-x-1 gap-y-1">
        {rest.map((seg, i) => (
          <SegmentView key={i} seg={seg} />
        ))}
      </div>
    </div>
  );
}

/** 引用：换行堆叠在正文上方 */
function ReplyQuote({ data }: { data: Record<string, unknown> }) {
  return (
    <div className="flex min-w-0 items-start gap-1 rounded-lg border-l-2 border-teal-400/60 bg-black/5 px-2 py-1 text-[12px] text-slate-500">
      <Reply className="mt-0.5 h-3 w-3 shrink-0" />
      <span className="min-w-0 break-words">
        回复消息 {String(data.id ?? data.seq ?? '')}
      </span>
    </div>
  );
}

function SegmentView({ seg }: { seg: Seg }) {
  const d = seg.data ?? {};
  switch (seg.type) {
    case 'text':
      return <span className="min-w-0 whitespace-pre-wrap break-words break-all">{String(d.text ?? '')}</span>;

    case 'at':
      return (
        <span className="inline-flex items-center gap-0.5 rounded bg-sky-500/15 px-1.5 py-0.5 text-sky-600 dark:text-sky-300">
          <AtSign className="h-3 w-3" />
          {String(d.qq === 'all' ? '全体成员' : d.qq ?? '')}
        </span>
      );

    case 'face':
      return (
        <span className="inline-flex items-center gap-0.5 rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-600 dark:text-amber-300">
          <Smile className="h-3 w-3" />
          表情{String(d.id ?? '')}
        </span>
      );

    case 'image':
      return <ImageSeg src={resolveMediaSrc(d.file ?? d.url, 'image/png')} summary={String(d.summary ?? '')} />;

    case 'video':
      return <VideoSeg src={resolveMediaSrc(d.file ?? d.url, 'video/mp4')} />;

    case 'record':
      return <AudioSeg src={resolveMediaSrc(d.file ?? d.url, 'audio/amr')} />;

    case 'json':
      return <JsonCardSeg raw={d.data} />;

    case 'music':
      return <MusicCardSeg data={d} />;

    case 'file':
      return <FileSeg data={d} />;

    case 'forward':
      // 混排里出现的子合并转发：仍是一张卡片
      return <ForwardCard data={d} />;

    case 'node':
      // 单个节点混在别的段里：直接把该节点内容内联渲染，不当作合并转发卡片
      return <MessageSegments message={d.content ?? d.message ?? ''} />;

    default:
      return <UnknownSeg type={seg.type} data={d} />;
  }
}

function ImageSeg({ src, summary }: { src: string | null; summary?: string }) {
  const [err, setErr] = useState(false);
  const [zoom, setZoom] = useState(false);
  if (!src || err) {
    return <BrokenMedia label={`图片${summary ? `：${summary}` : ''}`} />;
  }
  return (
    <>
      <img
        src={src}
        alt={summary || '图片'}
        className="max-h-52 max-w-[min(14rem,100%)] cursor-zoom-in rounded-lg object-contain"
        onError={() => setErr(true)}
        onClick={() => setZoom(true)}
      />
      {zoom && <ImageLightbox src={src} onClose={() => setZoom(false)} />}
    </>
  );
}

function VideoSeg({ src }: { src: string | null }) {
  const [err, setErr] = useState(false);
  if (!src || err) return <BrokenMedia label="视频" />;
  return (
    <video
      src={src}
      controls
      className="max-h-60 w-full max-w-[min(16rem,100%)] rounded-lg"
      onError={() => setErr(true)}
    />
  );
}

function AudioSeg({ src }: { src: string | null }) {
  const [err, setErr] = useState(false);
  if (!src || err) return <BrokenMedia label="语音" />;
  // 给足宽度，让原生进度条完整显示（此前被挤成几像素）
  return (
    <audio
      src={src}
      controls
      preload="metadata"
      className="h-10 w-[min(17rem,72vw)]"
      onError={() => setErr(true)}
    />
  );
}

function BrokenMedia({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded bg-rose-500/10 px-2 py-1 text-xs text-rose-500">
      <FileWarning className="h-3.5 w-3.5" />
      {label}（无法加载）
    </span>
  );
}

/**
 * 合并转发卡片：无论最外层还是嵌套，都渲染成「一张」聊天记录卡片（仿 QQ）——
 * 外显只有标题 + 前几行摘要，点击后在视口固定悬浮窗里展开全部节点；
 * 节点内容用 MessageSegments 递归渲染，可含图片/文字/视频/文件/卡片/子合并转发。
 */
function ForwardCard({ data, title }: { data: Record<string, unknown>; title?: string }) {
  const [open, setOpen] = useState(false);
  const nodes = extractNodes(data);
  const heading = title || String(data.title ?? '聊天记录');
  const preview = nodes.slice(0, 4).map((n) => `${n.name ? n.name + '：' : ''}${plainOf(n.content)}`);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-[min(15rem,100%)] rounded-xl border border-white/40 bg-white/30 p-2.5 text-left transition-colors hover:bg-white/45"
      >
        <div className="mb-1 flex items-center gap-1 text-[11px] font-medium text-slate-500">
          <Layers className="h-3 w-3" /> {heading}
        </div>
        <div className="flex flex-col gap-0.5">
          {preview.length === 0 && <span className="text-xs text-muted-foreground">（无内容）</span>}
          {preview.map((line, i) => (
            <div key={i} className="truncate text-[12px] text-slate-500">{line}</div>
          ))}
        </div>
        <div className="mt-1 text-[11px] text-teal-600/80">查看 {nodes.length} 条转发消息 ›</div>
      </button>

      {open && (
        <ForwardViewer heading={heading} nodes={nodes} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

/** 合并转发悬浮窗：视口固定居中，支持嵌套子合并转发继续弹层 */
function ForwardViewer({
  heading, nodes, onClose,
}: {
  heading: string;
  nodes: Array<{ name?: string; content: unknown }>;
  onClose: () => void;
}) {
  return (
    <Portal>
      <div
        className="fixed inset-0 z-[200] flex items-center justify-center bg-black/45 p-4 backdrop-blur-sm"
        onClick={onClose}
      >
        <div
          className="flex max-h-[80dvh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-white/50 bg-white/90 shadow-2xl backdrop-blur-xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex shrink-0 items-center gap-1.5 border-b border-black/5 px-4 py-3 text-sm font-semibold text-slate-700">
            <Layers className="h-4 w-4 text-teal-600" /> {heading}
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 no-scrollbar">
            {nodes.map((n, i) => (
              <div key={i} className="flex flex-col gap-1">
                <div className="text-[11px] font-medium text-slate-400">{n.name || '成员'}</div>
                <div className="min-w-0 overflow-hidden rounded-xl bg-white/70 px-3 py-2 text-sm text-slate-800">
                  <MessageSegments message={n.content} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Portal>
  );
}

function extractNodes(data: Record<string, unknown>): Array<{ name?: string; content: unknown }> {
  const raw = (data.content ?? data.messages ?? data.message) as unknown;
  if (Array.isArray(raw)) {
    return raw.map((item) => {
      const it = (item ?? {}) as Record<string, unknown>;
      const inner = (it.data ?? it) as Record<string, unknown>;
      return {
        name: String(inner.nickname ?? inner.name ?? '') || undefined,
        content: inner.content ?? inner.message ?? it,
      };
    });
  }
  if (raw != null) {
    return [{ name: String(data.nickname ?? data.name ?? '') || undefined, content: raw }];
  }
  return [];
}

/** 从任意消息内容里取一段纯文本预览 */
function plainOf(content: unknown): string {
  const segs = normalizeMessage(content);
  const parts: string[] = [];
  for (const s of segs) {
    if (s.type === 'text') parts.push(String(s.data.text ?? ''));
    else if (s.type === 'image') parts.push('[图片]');
    else if (s.type === 'record') parts.push('[语音]');
    else if (s.type === 'video') parts.push('[视频]');
    else if (s.type === 'file') parts.push(`[文件]${s.data.name ? String(s.data.name) : ''}`);
    else if (s.type === 'face') parts.push('[表情]');
    else if (s.type === 'at') parts.push(`@${s.data.qq ?? ''}`);
    else if (s.type === 'music') parts.push('[音乐]');
    else if (s.type === 'json') parts.push('[卡片]');
    else if (s.type === 'forward' || s.type === 'node') parts.push('[聊天记录]');
    else parts.push(`[${s.type}]`);
  }
  return parts.join(' ').trim() || '[消息]';
}

/** 文件段：卡片显示文件名与大小 */
function FileSeg({ data }: { data: Record<string, unknown> }) {
  const name = String(data.name ?? data.file ?? '文件');
  const sizeNum = Number(data.size ?? 0);
  const size = sizeNum > 0 ? formatSize(sizeNum) : '';
  return (
    <div className="flex w-[min(15rem,100%)] items-center gap-2.5 rounded-xl border border-white/40 bg-white/30 p-2.5">
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-sky-500/15 text-sky-600">
        <FileText className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-slate-700">{name}</div>
        {size && <div className="text-[12px] text-slate-500">{size}</div>}
      </div>
    </div>
  );
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 音乐卡片 */
function MusicCardSeg({ data }: { data: Record<string, unknown> }) {
  const title = String(data.title ?? data.name ?? '音乐分享');
  const singer = String(data.content ?? data.singer ?? data.desc ?? '');
  const img = resolveMediaSrc(data.image ?? data.cover ?? data.pic, 'image/png');
  const jump = String(data.jump_url ?? data.url ?? '');

  const Card = (
    <div className="flex w-[min(15rem,100%)] items-center gap-2.5 rounded-xl border border-white/40 bg-white/30 p-2.5">
      {img
        ? <img src={img} alt="" className="h-11 w-11 shrink-0 rounded-lg object-cover" />
        : <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-teal-500/15 text-teal-600"><Music className="h-5 w-5" /></div>}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-slate-700">{title}</div>
        {singer && <div className="truncate text-[12px] text-slate-500">{singer}</div>}
        <div className="mt-0.5 flex items-center gap-1 text-[11px] text-teal-600/80"><Music className="h-3 w-3" />音乐</div>
      </div>
    </div>
  );

  if (jump) {
    return <a href={jump} target="_blank" rel="noreferrer" className="block no-underline">{Card}</a>;
  }
  return Card;
}

/** json 卡片：尽量展示标题/描述，否则折叠原文 */
function JsonCardSeg({ raw }: { raw: unknown }) {
  let obj: Record<string, unknown> | null = null;
  try {
    obj = typeof raw === 'string' ? JSON.parse(raw) : (raw as Record<string, unknown>);
  } catch { obj = null; }

  const meta = obj?.meta as Record<string, unknown> | undefined;
  const detail = meta ? (Object.values(meta)[0] as Record<string, unknown> | undefined) : undefined;
  const title = String(detail?.title ?? detail?.desc ?? obj?.prompt ?? 'JSON 卡片');
  const desc = String(detail?.desc ?? '');
  const preview = String(detail?.preview ?? detail?.icon ?? '');
  const img = preview ? resolveMediaSrc(preview.startsWith('http') ? preview : `https://${preview}`, 'image/png') : null;
  const jump = String(detail?.qqdocurl ?? detail?.jumpUrl ?? detail?.url ?? '');

  const Card = (
    <div className="flex w-[min(15rem,100%)] items-center gap-2.5 rounded-xl border border-white/40 bg-white/30 p-2.5">
      {img && <img src={img} alt="" className="h-11 w-11 shrink-0 rounded-lg object-cover" />}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-slate-700">🃏 {title}</div>
        {desc && desc !== title && <div className="truncate text-[12px] text-slate-500">{desc}</div>}
      </div>
    </div>
  );

  if (jump) return <a href={jump} target="_blank" rel="noreferrer" className="block no-underline">{Card}</a>;
  return Card;
}

function UnknownSeg({ type, data }: { type: string; data: Record<string, unknown> }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="rounded bg-white/40 px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-white/60"
      >
        [{type}]
      </button>
      {open && (
        <pre className="mt-1 max-w-[min(16rem,100%)] overflow-x-auto rounded bg-slate-900/80 p-2 text-[11px] text-slate-100">
          {JSON.stringify(data, null, 2)}
        </pre>
      )}
    </span>
  );
}
