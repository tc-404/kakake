import { useCallback, useEffect, useRef, useState } from 'react';
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
  TriangleAlert,
} from 'lucide-react';
import { api } from '@/lib/api';
import type { MediaParseResult, MediaPlatform, MediaStats } from '@/lib/types';
import { ToolTextField } from '@/pages/tools/ToolTextField';
import { cn } from '@/lib/utils';
import { useT } from '@/lib/i18n';
import { errText, resText, svcText } from '@/lib/server-error';
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
  blbl: 'tools.platformBlbl',
  dy: 'tools.platformDy',
  xhs: 'tools.platformXhs',
  ks: 'tools.platformKs',
  tt: 'tools.platformTt',
  yt: 'tools.platformYt',
  x: 'tools.platformX',
  tg: 'tools.platformTg',
};

const TYPE_LABEL: Record<string, string> = {
  video: 'tools.videoLabel',
  image: 'tools.typeImage',
  live: 'tools.typeLive',
  animated: 'tools.typeAnimated',
  unknown: 'tools.typeUnknown',
};

const LONG_PRESS_MS = 480;

function formatCount(n: number): string {
  if (n < 10000) return String(n);
  if (n < 100000000) {
    const v = n / 10000;
    return `${v >= 100 ? Math.round(v) : Number(v.toFixed(1))}万`;
  }
  const v = n / 100000000;
  return `${v >= 100 ? Math.round(v) : Number(v.toFixed(2))}亿`;
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * 防盗链判定：B站/抖音/小红书/快手等 CDN 校验 Referer/UA，浏览器直连原始地址会 403，
 * 这类平台的展示与「复制地址」都改走服务端代理端点（服务端补 Referer 后回源）。
 * X（twimg 被墙）与 Telegram（telesco.pe 国内不可达）原本就走代理，保持不变。
 */
function needsServerProxyFor(
  url: string,
  platform?: MediaPlatform | null,
): boolean {
  const host = hostOf(url);
  if (
    /(^|\.)twimg\.(com|co)$/i.test(host)
    || /(^|\.)telesco\.pe$/i.test(host)
  ) {
    return true;
  }
  if (platform === 'x' || platform === 'tg') return true;
  if (platform === 'blbl' || platform === 'dy' || platform === 'xhs' || platform === 'ks') {
    return true;
  }
  // 未传 platform 时按 CDN 域名兜底
  return /bili|hdslb|douyin|iesdouyin|byteimg|snssdk|amemv|xiaohongshu|xhscdn|xhslink|kuaishou|kwimgs|yximgs|gifshow/i.test(host);
}

function proxyViewUrl(
  url: string,
  kind: 'video' | 'cover',
  platform?: MediaPlatform | null,
): string {
  return api.tools.mediaViewUrl({ url, kind, platform });
}

/**
 * 页面展示地址：防盗链平台与被墙平台走服务端预览端点；其他平台 CDN 可直连，保持原地址。
 */
function displaySrc(
  url: string | null | undefined,
  kind: 'video' | 'cover',
  platform?: MediaPlatform | null,
): string | undefined {
  if (!url) return undefined;
  // 防盗链平台（B站/抖音/小红书/快手等 CDN 校验 Referer）一律走服务端代理，
  // 浏览器直连原始 CDN 地址必然 403
  if (needsServerProxyFor(url, platform)) {
    return api.tools.mediaViewUrl({ url, kind, platform });
  }
  return url;
}

type StatItem = { key: keyof MediaStats; label: string; icon: typeof Eye };

const STAT_ITEMS: StatItem[] = [
  { key: 'views', label: 'tools.statView', icon: Eye },
  { key: 'likes', label: 'tools.statLike', icon: Heart },
  { key: 'comments', label: 'tools.statComment', icon: MessageCircle },
  { key: 'shares', label: 'tools.statShare', icon: Share2 },
  { key: 'favorites', label: 'tools.statFavorite', icon: Star },
  { key: 'coins', label: 'tools.statCoin', icon: Coins },
  { key: 'danmaku', label: 'tools.statDanmaku', icon: MessageSquare },
];

function StatsRow({ stats }: { stats: MediaStats }) {
  const t = useT();
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
          className="inline-flex items-center gap-1 rounded-lg bg-slate-500/10 px-2.5 py-1 text-xs text-slate-600"
          title={t(label)}
        >
          <Icon className="h-3.5 w-3.5 text-slate-400" />
          <span className="text-slate-500">{t(label)}</span>
          <span className="font-medium tabular-nums text-slate-700">{formatCount(stats[key]!)}</span>
        </span>
      ))}
    </div>
  );
}

/** 图集单项：按自身比例显示；长按询问下载（无点击放大） */
function GalleryImage({
  url,
  src,
  onLongPressDownload,
}: {
  /** 下载/长按用的原始地址 */
  url: string;
  /** 展示地址（可与 url 不同，如 X 媒体走服务端预览） */
  src?: string;
  onLongPressDownload: (url: string) => void;
}) {
  const display = src || url;
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
        src={display}
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
  /**
   * 解析失败的原因也要留下来渲染成常驻提示。
   * 之前失败只弹一次 toast，几秒后消失，页面上什么都不剩——
   * 用户看到的是「点了解析，页面毫无反应」，会以为工具坏了。
   * 这里只留卡片要用的两个字段，不必凑出一个完整的解析结果。
   */
  const [failure, setFailure] = useState<{ platform: MediaPlatform | null; message: string } | null>(
    null,
  );
  const [videoPlayError, setVideoPlayError] = useState(false);
  const [downloading, setDownloading] = useState<
    'video' | 'cover' | 'image' | 'live' | 'music' | null
  >(null);
  const [pendingImageUrl, setPendingImageUrl] = useState<string | null>(null);
  const t = useT();

  async function copyText(text: string) {
    if (!text) {
      toast.message(t('tools.nothingToCopy'));
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t('tools.copied'));
    } catch {
      toast.error(t('tools.copyFailed'));
    }
  }

  /** 复制地址：防盗链平台复制服务端代理地址（原始 CDN 链接浏览器直开必 403），其余复制原地址 */
  function copyAddr(url: string | null | undefined, kind: 'video' | 'cover') {
    if (!url) return;
    void copyText(
      needsServerProxyFor(url, result?.platform)
        ? proxyViewUrl(url, kind, result?.platform)
        : url,
    );
  }

  /** 正在进行的解析请求；取消时真的中止，不再白等一次服务端限速额度 */
  const abortRef = useRef<AbortController | null>(null);

  /**
   * 动静态混搭（图集里部分图带视频轨）时，那几张会同时出现在 images 和
   * liveItems 里，图片区若不剔除就会把同一张展示两遍。
   */
  const liveImageUrls = new Set(
    (result?.liveItems ?? []).map((it) => it.image).filter(Boolean),
  );
  const stillImages = (result?.images ?? []).filter((u) => !liveImageUrls.has(u));

  // 离开页面时中止在途请求，避免「已经走了，服务端还在拉上游」
  useEffect(() => () => abortRef.current?.abort(), []);

  function cancelParse() {
    const ctrl = abortRef.current;
    abortRef.current = null;
    if (!ctrl) return;
    ctrl.abort();
    setLoading(false);
    toast.message(t('tools.parseCancelled'));
  }

  async function runParse() {
    if (!text.trim() || loading) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setLoading(true);
    setResult(null);
    setFailure(null);
    setVideoPlayError(false);
    setPendingImageUrl(null);
    try {
      const res = await api.tools.mediaParse(text, { signal: ctrl.signal });
      if (!res.ok) {
        // toast 负责「立刻知道」，常驻卡片负责「回头看还能看到原因」
        setFailure({ platform: res.platform, message: res.message || t('tools.parseFailed') });
        toast.error(resText(res) || t('tools.parseFailed'));
        return;
      }
      setResult(res);
      const plat = res.platform ? t(PLATFORM_LABEL[res.platform]) || res.platform : '';
      toast.success(plat ? `${plat} ${t('tools.parseSuccess')}` : t('tools.parseSuccess'));
    } catch (e) {
      // 主动取消不是错误，不要再弹一次报错
      if (e instanceof DOMException && e.name === 'AbortError') return;
      if (e instanceof Error && e.name === 'AbortError') return;
      // 卡片里存原始报文，渲染时再按当前语言翻译（切语言能跟着变）
      const msg = e instanceof Error ? e.message : String(e);
      // 网络中断这类异常也要落到卡片上：只弹 toast 的话，超时后同样是一片空白
      setFailure({ platform: null, message: msg });
      toast.error(errText(e));
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
      setLoading(false);
    }
  }

  function clearAll() {
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
    setText('');
    setResult(null);
    setFailure(null);
    setVideoPlayError(false);
    setPendingImageUrl(null);
    setDownloading(null);
    toast.success(t('tools.cleared'));
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
      cookie: result?.cookie,
    });
  }

  async function downloadMedia(kind: 'video' | 'cover') {
    if (!result?.ok || downloading) return;
    const url = kind === 'cover' ? result.cover : result.videoUrl;
    if (!url) {
      toast.message(kind === 'cover' ? t('tools.noCover') : t('tools.noVideo'));
      return;
    }
    setDownloading(kind);
    try {
      await downloadByUrl(url, kind, result.platform);
      toast.success(kind === 'cover' ? t('tools.coverDownloadStarted') : t('tools.videoDownloadStarted'));
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setDownloading(null);
    }
  }

  /**
   * 下载实况的动态轨。
   * downloadMedia 只认 result.cover / result.videoUrl，而实况的每条动态轨地址
   * 是独立的，只能按 URL 直接下载，所以单独开一个入口。
   */
  async function downloadLiveVideo(url: string) {
    if (!url || downloading) return;
    setDownloading('live');
    try {
      await downloadByUrl(url, 'video', result?.platform);
      toast.success(t('tools.liveDownloadStarted'));
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setDownloading(null);
    }
  }

  /** 背景音乐：快手图集等配乐作品才有，按音频直链下载 */
  async function downloadMusic() {
    if (!result?.music?.url || downloading) return;
    setDownloading('music');
    try {
      await downloadByUrl(result.music.url, 'cover', result.platform);
      toast.success(t('tools.musicDownloadStarted'));
    } catch (e) {
      toast.error(errText(e));
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
      toast.success(t('tools.imageDownloadStarted'));
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setDownloading(null);
    }
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col gap-4">
      <div className="kk-glass flex flex-col gap-3 rounded-2xl border border-white/40 p-4">
        <label className="text-sm font-medium text-slate-700">{t('tools.linkLabel')}</label>
        <ToolTextField
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          disabled={loading}
          placeholder={t('tools.linkPlaceholder')}
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
            {loading ? t('tools.parsing') : t('tools.parseBtn')}
          </button>
          <button
            type="button"
            disabled={loading || (!text.trim() && !result)}
            onClick={clearAll}
            className="inline-flex h-10 w-full items-center justify-center rounded-xl border border-white/50 bg-white/40 text-sm font-medium text-slate-700 hover:bg-white/60 disabled:opacity-50 sm:w-auto sm:px-6"
          >
            {t('tools.clearBtn')}
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
          <p className="text-sm font-medium text-slate-700">{t('tools.parsingWait')}</p>
          <button
            type="button"
              onClick={cancelParse}
              className="h-9 rounded-xl border border-white/50 bg-white/40 px-5 text-sm font-medium text-slate-700 hover:bg-white/60"
            >
              {t('tools.cancel')}
            </button>
        </div>
      ) : null}

      {!loading && failure ? (
        <div
          role="alert"
          className="kk-glass flex flex-col gap-3 rounded-2xl border border-amber-300/70 bg-amber-500/10 p-4"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/20 px-2.5 py-0.5 text-xs font-medium text-amber-900">
              <TriangleAlert className="h-3.5 w-3.5" />
              {t('tools.parseFailedBadge')}
            </span>
            {failure.platform ? (
              <span className="rounded-full bg-slate-500/10 px-2.5 py-0.5 text-xs text-slate-600">
                {PLATFORM_LABEL[failure.platform] || failure.platform}
              </span>
            ) : null}
          </div>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700">
            {svcText(failure.message)}
          </p>
          {failure.platform === 'tg' ? (
            <p className="text-xs leading-relaxed text-slate-500">{t('tools.tgFailNote')}</p>
          ) : null}
        </div>
      ) : null}

      {!loading && result?.ok ? (
        <div className="kk-glass flex flex-col gap-4 rounded-2xl border border-white/40 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-teal-500/15 px-2.5 py-0.5 text-xs font-medium text-teal-800">
              {result.platform ? t(PLATFORM_LABEL[result.platform]) || result.platform : t('tools.typeUnknown')}
            </span>
            <span className="rounded-full bg-slate-500/10 px-2.5 py-0.5 text-xs text-slate-600">
              {t(TYPE_LABEL[result.type]) || result.type}
            </span>
            {typeof result.duration === 'number' && result.duration > 0 ? (
              <span className="rounded-full bg-slate-500/10 px-2.5 py-0.5 text-xs tabular-nums text-slate-600">
                {formatDuration(result.duration)}
              </span>
            ) : null}
            {result.sizeText ? (
              <span className="rounded-full bg-slate-500/10 px-2.5 py-0.5 text-xs tabular-nums text-slate-600">
                {result.sizeText}
              </span>
            ) : null}
            {result.publishTime ? (
              <span className="rounded-full bg-slate-500/10 px-2.5 py-0.5 text-xs tabular-nums text-slate-600">
                {result.publishTime}
              </span>
            ) : null}
          </div>

          {result.message || result.platform === 'yt' ? (
            <p className="rounded-xl bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-800">
              {result.message}
              {result.message && result.platform === 'yt' ? ' ' : ''}
              {result.platform === 'yt'
                ? t('tools.ytNote')
                : ''}
            </p>
          ) : null}

          {result.title ? (
            <h2 className="text-lg font-semibold leading-snug tracking-tight text-slate-900 md:text-xl">
              {result.title}
            </h2>
          ) : null}

          {result.author ? (
            <p className="text-xs text-slate-500">{t('tools.author')}{result.author}</p>
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
                <p className="text-xs font-medium text-slate-500">{t('tools.coverLabel')}</p>
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
                  {t('tools.downloadCover')}
                </button>
              </div>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={displaySrc(result.cover, 'cover', result.platform)}
                alt={t('tools.coverLabel')}
                referrerPolicy="no-referrer"
                className="max-h-56 w-auto max-w-full rounded-xl border border-white/50 object-contain bg-black/5"
              />
            </div>
          ) : null}

          {result.videoUrl ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-medium text-slate-500">{t('tools.videoLabel')}</p>
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={() => copyAddr(result.videoUrl || '', 'video')}
                    className="inline-flex items-center gap-1 text-xs text-slate-600 hover:text-teal-700"
                  >
                    <Copy className="h-3.5 w-3.5" />
                    {t('tools.copyAddr')}
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
                    {t('tools.downloadVideo')}
                  </button>
                </div>
              </div>
              {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
              <video
                key={result.videoUrl}
                src={displaySrc(result.videoUrl, 'video', result.platform)}
                controls
                playsInline
                className="max-h-80 w-full rounded-xl bg-black"
                onError={() => setVideoPlayError(true)}
                onLoadedData={() => setVideoPlayError(false)}
              />
              {videoPlayError ? (
                <p className="text-xs text-amber-700">
                  {result.platform === 'yt'
                    ? t('tools.ytPlayError')
                    : result.platform === 'tg'
                      ? t('tools.tgPlayError')
                      : t('tools.genericPlayError')}
                </p>
              ) : null}
              <p className="break-all text-xs text-slate-400">{result.videoUrl}</p>
            </div>
          ) : null}

          {stillImages.length > 0 ? (
            <div>
              <p className="mb-2 text-xs font-medium text-slate-500">
                {t('tools.imagesCount', { count: stillImages.length })}
              </p>
              <div className="columns-2 gap-2 sm:columns-3">
                {stillImages.map((url, i) => (
                  <GalleryImage
                    // 同一条内容里可能出现重复地址（如转推保留原图），key 带上序号才不会撞
                    key={`${i}-${url}`}
                    url={url}
                    src={displaySrc(url, 'cover', result.platform)}
                    onLongPressDownload={setPendingImageUrl}
                  />
                ))}
              </div>
            </div>
          ) : null}

          {result.liveItems.length > 0 ? (
            <div className="space-y-3">
              <p className="text-xs font-medium text-slate-500">{t('tools.liveCount', { count: result.liveItems.length })}</p>
              {result.liveItems.map((item, i) => (
                <div key={`${item.image}-${i}`} className="grid gap-3 sm:grid-cols-2">
                  {item.image ? (
                    <GalleryImage
                      url={item.image}
                      src={displaySrc(item.image, 'cover', result.platform)}
                      onLongPressDownload={setPendingImageUrl}
                    />
                  ) : null}
                  {item.video ? (
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-xs font-medium text-slate-500">{t('tools.dynamicTrack')}</p>
                        <div className="flex flex-wrap items-center gap-3">
                          <button
                            type="button"
                            onClick={() => copyAddr(item.video, 'video')}
                            className="inline-flex items-center gap-1 text-xs text-slate-600 hover:text-teal-700"
                          >
                            <Copy className="h-3.5 w-3.5" />
                            {t('tools.copyAddr')}
                          </button>
                          <button
                            type="button"
                            disabled={downloading === 'live'}
                            onClick={() => void downloadLiveVideo(item.video)}
                            className="inline-flex items-center gap-1 text-xs text-slate-600 hover:text-teal-700 disabled:opacity-50"
                          >
                            {downloading === 'live' ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Download className="h-3.5 w-3.5" />
                            )}
                    {t('tools.downloadLive')}
                  </button>
                        </div>
                      </div>
                      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                      <video
                        src={displaySrc(item.video, 'video', result.platform)}
                        controls
                        playsInline
                        className="max-h-40 w-full rounded-xl bg-black"
                      />
                      <p className="break-all text-xs text-slate-400">{item.video}</p>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}

          {result.music?.url ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-medium text-slate-500">
                  {t('tools.bgmLabel')}{result.music.name ? `：${result.music.name}` : ''}
                  {result.music.artist ? ` - ${result.music.artist}` : ''}
                </p>
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={() => copyAddr(result.music!.url, 'cover')}
                    className="inline-flex items-center gap-1 text-xs text-slate-600 hover:text-teal-700"
                  >
                    <Copy className="h-3.5 w-3.5" />
                    {t('tools.copyAddr')}
                  </button>
                  <button
                    type="button"
                    disabled={downloading === 'music'}
                    onClick={() => void downloadMusic()}
                    className="inline-flex items-center gap-1 text-xs text-slate-600 hover:text-teal-700 disabled:opacity-50"
                  >
                    {downloading === 'music' ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Download className="h-3.5 w-3.5" />
                    )}
                    {t('tools.downloadMusic')}
                  </button>
                </div>
              </div>
              {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
              <audio src={result.music.url} controls className="w-full" />
              <p className="break-all text-xs text-slate-400">{result.music.url}</p>
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
            <AlertDialogTitle>{t('tools.downloadImageTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('tools.downloadImageDesc')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('tools.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void confirmDownloadImage();
              }}
              disabled={downloading === 'image'}
            >
              {downloading === 'image' ? t('tools.downloading') : t('tools.downloadBtn')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
