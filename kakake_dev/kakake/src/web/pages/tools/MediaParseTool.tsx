import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Copy,
  Loader2,
  Link2,
  Eye,
  Heart,
  MessageCircle,
  Share2,
  Star,
  Coins,
  MessageSquare,
  Download,
} from 'lucide-react';
import { api } from '@/lib/api';
import type { MediaParseResult, MediaPlatform, MediaStats } from '@/lib/types';
import { ToolTextField } from '@/pages/tools/ToolTextField';
import { cn } from '@/lib/utils';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

const PLATFORM_LABEL: Record<string, string> = {
  blbl: '哔哩哔哩',
  dy: '抖音',
  xhs: '小红书',
  ks: '快手',
};

const TYPE_LABEL: Record<string, string> = {
  video: '视频',
  image: '图文',
  live: '实况',
  animated: '动图',
  unknown: '未知',
};

const LONG_PRESS_MS = 480;

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

function formatCount(n: number): string {
  if (n < 10000) return String(n);
  if (n < 100000000) {
    const v = n / 10000;
    return `${v >= 100 ? Math.round(v) : Number(v.toFixed(1))}万`;
  }
  const v = n / 100000000;
  return `${v >= 100 ? Math.round(v) : Number(v.toFixed(2))}亿`;
}

type StatItem = { key: keyof MediaStats; label: string; icon: typeof Eye };

const STAT_ITEMS: StatItem[] = [
  { key: 'views', label: '浏览', icon: Eye },
  { key: 'likes', label: '点赞', icon: Heart },
  { key: 'comments', label: '评论', icon: MessageCircle },
  { key: 'shares', label: '分享', icon: Share2 },
  { key: 'favorites', label: '收藏', icon: Star },
  { key: 'coins', label: '投币', icon: Coins },
  { key: 'danmaku', label: '弹幕', icon: MessageSquare },
];

function StatsRow({ stats }: { stats: MediaStats }) {
  const items = STAT_ITEMS.filter((s) => {
    const v = stats[s.key];
    return typeof v === 'number' && v > 0;
  });
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {items.map(({ key, label, icon: Icon }) => (
        <span
          key={key}
          className="inline-flex items-center gap-1 rounded-lg bg-slate-500/8 px-2.5 py-1 text-xs text-slate-600"
          title={label}
        >
          <Icon className="h-3.5 w-3.5 text-slate-400" />
          <span className="text-slate-500">{label}</span>
          <span className="font-medium tabular-nums text-slate-700">{formatCount(stats[key]!)}</span>
        </span>
      ))}
    </div>
  );
}

/** 图集单项：按自身比例显示；长按询问下载（无点击放大） */
function GalleryImage({
  url,
  onLongPressDownload,
}: {
  url: string;
  onLongPressDownload: (url: string) => void;
}) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressedRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const startPress = useCallback(() => {
    pressedRef.current = false;
    clearTimer();
    timerRef.current = setTimeout(() => {
      pressedRef.current = true;
      onLongPressDownload(url);
    }, LONG_PRESS_MS);
  }, [clearTimer, onLongPressDownload, url]);

  const endPress = useCallback(() => {
    clearTimer();
  }, [clearTimer]);

  return (
    <figure className="mb-2 break-inside-avoid overflow-hidden rounded-xl border border-white/40 bg-black/5">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt=""
        referrerPolicy="no-referrer"
        draggable={false}
        className="h-auto w-full select-none object-contain"
        onPointerDown={startPress}
        onPointerUp={endPress}
        onPointerCancel={endPress}
        onPointerLeave={endPress}
        onContextMenu={(e) => {
          e.preventDefault();
          onLongPressDownload(url);
        }}
        onClick={(e) => {
          if (pressedRef.current) {
            e.preventDefault();
            pressedRef.current = false;
          }
        }}
      />
    </figure>
  );
}

export default function MediaParseTool() {
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<MediaParseResult | null>(null);
  const [videoPlayError, setVideoPlayError] = useState(false);
  const [downloading, setDownloading] = useState<'video' | 'cover' | 'image' | null>(null);
  const [pendingImageUrl, setPendingImageUrl] = useState<string | null>(null);

  async function runParse() {
    if (!text.trim() || loading) return;
    setLoading(true);
    setResult(null);
    setVideoPlayError(false);
    setPendingImageUrl(null);
    try {
      const res = await api.tools.mediaParse(text);
      if (!res.ok) {
        toast.error(res.message || '解析失败');
        return;
      }
      setResult(res);
      const plat = res.platform ? PLATFORM_LABEL[res.platform] || res.platform : '';
      toast.success(plat ? `${plat} 解析成功` : '解析成功');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  function clearAll() {
    setText('');
    setResult(null);
    setVideoPlayError(false);
    setPendingImageUrl(null);
    setDownloading(null);
    toast.success('已清空');
  }

  async function downloadByUrl(
    url: string,
    kind: 'video' | 'cover',
    platform?: MediaPlatform | null,
  ) {
    await api.tools.mediaDownload({
      url,
      kind,
      platform: platform ?? result?.platform,
    });
  }

  async function downloadMedia(kind: 'video' | 'cover') {
    if (!result?.ok || downloading) return;
    const url = kind === 'cover' ? result.cover : result.videoUrl;
    if (!url) {
      toast.message(kind === 'cover' ? '没有封面可下载' : '没有视频可下载');
      return;
    }
    setDownloading(kind);
    try {
      await downloadByUrl(url, kind, result.platform);
      toast.success(kind === 'cover' ? '封面已开始下载' : '视频已开始下载');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setDownloading(null);
    }
  }

  async function confirmDownloadImage() {
    if (!pendingImageUrl || downloading) return;
    const url = pendingImageUrl;
    setPendingImageUrl(null);
    setDownloading('image');
    try {
      await downloadByUrl(url, 'cover', result?.platform);
      toast.success('图片已开始下载');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setDownloading(null);
    }
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col gap-4">
      <div className="kk-glass flex flex-col gap-3 rounded-2xl border border-white/40 p-4">
        <label className="text-sm font-medium text-slate-700">链接或含链接文本</label>
        <ToolTextField
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          disabled={loading}
          placeholder="粘贴 B站 / 抖音 / 小红书 / 快手 分享链接…"
          spellCheck={false}
        />
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
          <button
            type="button"
            disabled={loading || !text.trim()}
            onClick={() => void runParse()}
            className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-teal-500/90 text-sm font-medium text-white hover:bg-teal-600 disabled:opacity-50 sm:w-auto sm:px-6"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
            {loading ? '解析中…' : '解析'}
          </button>
          <button
            type="button"
            disabled={loading || (!text.trim() && !result)}
            onClick={clearAll}
            className="inline-flex h-10 w-full items-center justify-center rounded-xl border border-white/50 bg-white/40 text-sm font-medium text-slate-700 hover:bg-white/60 disabled:opacity-50 sm:w-auto sm:px-6"
          >
            清空
          </button>
        </div>
      </div>

      {loading ? (
        <div
          className="kk-glass flex flex-col items-center justify-center gap-3 rounded-2xl border border-white/40 px-4 py-16"
          role="status"
          aria-live="polite"
        >
          <Loader2 className="h-9 w-9 animate-spin text-teal-600" />
          <p className="text-sm font-medium text-slate-700">正在解析，请稍候…</p>
        </div>
      ) : null}

      {!loading && result?.ok ? (
        <div className="kk-glass flex flex-col gap-4 rounded-2xl border border-white/40 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-teal-500/15 px-2.5 py-0.5 text-xs font-medium text-teal-800">
              {result.platform ? PLATFORM_LABEL[result.platform] || result.platform : '未知'}
            </span>
            <span className="rounded-full bg-slate-500/10 px-2.5 py-0.5 text-xs text-slate-600">
              {TYPE_LABEL[result.type] || result.type}
            </span>
          </div>

          {result.title ? (
            <h2 className="text-lg font-semibold leading-snug tracking-tight text-slate-900 md:text-xl">
              {result.title}
            </h2>
          ) : null}

          {result.description ? (
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-500">
              {result.description}
            </p>
          ) : null}

          {result.tags?.length ? (
            <div className="flex flex-wrap gap-1.5">
              {result.tags.map((tag) => (
                <span
                  key={tag}
                  className="rounded-md bg-teal-500/10 px-2 py-0.5 text-xs text-teal-700"
                >
                  #{tag.replace(/^#/, '')}
                </span>
              ))}
            </div>
          ) : null}

          {result.stats ? <StatsRow stats={result.stats} /> : null}

          {result.cover ? (
            <div>
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-xs font-medium text-slate-500">封面</p>
                <button
                  type="button"
                  disabled={downloading === 'cover'}
                  onClick={() => void downloadMedia('cover')}
                  className="inline-flex items-center gap-1 text-xs text-slate-600 hover:text-teal-700 disabled:opacity-50"
                >
                  {downloading === 'cover' ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Download className="h-3.5 w-3.5" />
                  )}
                  下载封面
                </button>
              </div>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={result.cover}
                alt="封面"
                referrerPolicy="no-referrer"
                className="max-h-56 w-auto max-w-full rounded-xl border border-white/50 object-contain bg-black/5"
              />
            </div>
          ) : null}

          {result.videoUrl ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-medium text-slate-500">视频</p>
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={() => void copyText(result.videoUrl || '')}
                    className="inline-flex items-center gap-1 text-xs text-slate-600 hover:text-teal-700"
                  >
                    <Copy className="h-3.5 w-3.5" />
                    复制地址
                  </button>
                  <button
                    type="button"
                    disabled={downloading === 'video'}
                    onClick={() => void downloadMedia('video')}
                    className={cn(
                      'inline-flex items-center gap-1 text-xs hover:text-teal-700 disabled:opacity-50',
                      videoPlayError ? 'font-medium text-teal-700' : 'text-slate-600',
                    )}
                  >
                    {downloading === 'video' ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Download className="h-3.5 w-3.5" />
                    )}
                    下载视频
                  </button>
                </div>
              </div>
              {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
              <video
                key={result.videoUrl}
                src={result.videoUrl}
                controls
                playsInline
                className="max-h-80 w-full rounded-xl bg-black"
                referrerPolicy="no-referrer"
                onError={() => setVideoPlayError(true)}
                onLoadedData={() => setVideoPlayError(false)}
              />
              {videoPlayError ? (
                <p className="text-xs text-amber-700">
                  浏览器无法直接播放（常见于抖音防盗链 403），请使用「下载视频」保存后本地打开。
                </p>
              ) : null}
              <p className="break-all text-xs text-slate-400">{result.videoUrl}</p>
            </div>
          ) : null}

          {result.images.length > 0 ? (
            <div>
              <p className="mb-2 text-xs font-medium text-slate-500">
                图片（{result.images.length}）· 长按可下载
              </p>
              <div className="columns-2 gap-2 sm:columns-3">
                {result.images.map((url) => (
                  <GalleryImage
                    key={url}
                    url={url}
                    onLongPressDownload={setPendingImageUrl}
                  />
                ))}
              </div>
            </div>
          ) : null}

          {result.liveItems.length > 0 ? (
            <div className="space-y-3">
              <p className="text-xs font-medium text-slate-500">实况（{result.liveItems.length}）</p>
              {result.liveItems.map((item, i) => (
                <div key={`${item.image}-${i}`} className="grid gap-2 sm:grid-cols-2">
                  {item.image ? (
                    <GalleryImage
                      url={item.image}
                      onLongPressDownload={setPendingImageUrl}
                    />
                  ) : null}
                  {item.video ? (
                    // eslint-disable-next-line jsx-a11y/media-has-caption
                    <video src={item.video} controls playsInline className="max-h-40 w-full rounded-xl bg-black" />
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <AlertDialog
        open={!!pendingImageUrl}
        onOpenChange={(open) => {
          if (!open) setPendingImageUrl(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>下载这张图片？</AlertDialogTitle>
            <AlertDialogDescription>
              将通过服务端代理保存到本地，可避免部分平台防盗链导致下载失败。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void confirmDownloadImage();
              }}
              disabled={downloading === 'image'}
            >
              {downloading === 'image' ? '下载中…' : '下载'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
