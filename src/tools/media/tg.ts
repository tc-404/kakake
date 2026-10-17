// ---------------------------------------------------------------------------
// Telegram 解析（t.me 公开帖 embed 页面）
//
// 公开频道 / 公开群的消息页拼上 ?embed=1&single 后会返回一份「分享卡片」HTML，
// 里面直接带 <video src>、图片背景图、时长、正文、作者与发布时间——不需要账号、
// 不需要 api_id/api_hash，也没有任何登录态。这条路覆盖不了私有频道（t.me/c/...）
// 和邀请链接（t.me/+...），那两种只能走 MTProto，这里直接给出可读原因，
// 而不是笼统的「解析失败」。
//
// 选择器与 yt-dlp 的 TelegramEmbedIE 对齐（yt_dlp/extractor/telegram.py）：
// 上游改版时对照那份实现比对即可，它是这条路上维护最勤的参考实现。
// ---------------------------------------------------------------------------

import { proxyConfigured, proxyFetch } from './http-proxy';
import {
  DEFAULT_USER_AGENT,
  PAGE_TIMEOUT_MS,
  createDeadline,
  fetchFollowingAllowedRedirects,
  isAllowedDomain,
  type Deadline,
} from './http-utils';

/** 解析阶段允许访问的域名：embed 页只在 t.me 上（telegram.me/.dog 是它的旧别名） */
const ALLOWED_DOMAINS = ['t.me', 'telegram.me', 'telegram.dog', 'telegram.org'];

/**
 * 媒体直链所在 CDN。
 * 视频在 cdn1~cdn5.telesco.pe（按 file id 分散），图片也在同一后缀下；
 * 国内直连这两个域名会超时，所以体积探测必须走代理。
 * cdn-telegram.org 没有 A 记录，不用列。
 */
const MEDIA_DOMAINS = ['telesco.pe'];

/** 一次解析的总时限：embed 页 + 体积探测，正常 1~2 秒完成，留足重试余量 */
const DEADLINE_MS = 20000;

/** 正文里拿第一行当标题时最多显示多少字符 */
const TITLE_MAX = 80;

export interface TgMediaData {
  type: 'video' | 'image';
  /** 正文第一行（过长则截断）；没有正文时为空 */
  title: string;
  /** 正文去掉第一行后的剩余部分 */
  description: string;
  author: string;
  cover: string;
  /** 视频直链；图片帖为空 */
  url: string;
  images: string[];
  duration: number | null;
  /** 发布时间（已格式化文案，如 2024-05-01 12:00:00） */
  publishTime?: string;
  /** 视频体积（人类可读，如 12.34MB） */
  sizeText?: string;
  /** 该帖包含的视频数量（>1 时只展示第 1 个） */
  videoCount: number;
  /** 结果可用但有需要告知用户的前提 */
  message?: string;
}

export interface TgApiResult {
  code: number;
  msg: string;
  data?: TgMediaData;
}

function output(code: number, msg: string, data?: TgMediaData): TgApiResult {
  return data ? { code, msg, data } : { code, msg };
}

/* ---------------------------------------------------------------------------
 * 链接 → 频道 / 帖号
 * ------------------------------------------------------------------------- */

export type TgPostRef =
  | { ok: true; channel: string; id: string }
  | { ok: false; msg: string };

/**
 * 从一段文本里认出 Telegram 帖子链接。
 * 用户粘进来的常常是「一句话 + 链接」，也常常没有 https:// 前缀，
 * 所以这里不要求协议头。
 */
export function extractTelegramLink(text: string): string | null {
  const m = String(text || '').match(
    /(?:https?:\/\/)?(?:www\.|m\.)?(?:t\.me|telegram\.me|telegram\.dog)\/[^\s"'<>)\]]*/i,
  );
  return m ? m[0] : null;
}

/**
 * 拆出频道名与帖号，并挡掉这条路走不通的三种链接。
 * 挡在前面报错比抓回来一个「频道不存在」有用得多：私有频道不是抓不到，
 * 而是必须换 MTProto，用户需要知道的是这个。
 */
export function resolvePostRef(text: string): TgPostRef {
  const link = extractTelegramLink(text);
  if (!link) return { ok: false, msg: '不是 Telegram 帖子链接' };

  const parts = link
    .replace(/^https?:\/\//i, '')
    .replace(/^(?:www\.|m\.)?/i, '')
    .replace(/^(?:t\.me|telegram\.me|telegram\.dog)\//i, '')
    .split(/[?#]/)[0]!
    .split('/')
    .filter(Boolean);

  // t.me/s/<频道>/<帖号>：频道页里的单帖链接，正文同样是那一份 embed
  if (parts[0]?.toLowerCase() === 's') parts.shift();

  const head = parts[0] ?? '';
  if (head.toLowerCase() === 'c') {
    return {
      ok: false,
      msg: '这是私有频道的内部链接（t.me/c/…），公开页面读不到：需要 Telegram 账号（api_id + 登录会话）才能下载',
    };
  }
  if (head.startsWith('+') || head.toLowerCase() === 'joinchat') {
    return {
      ok: false,
      msg: '这是群组邀请链接（t.me/+…），不是帖子链接；请改用具体帖子地址（t.me/频道/帖号）',
    };
  }

  const channel = head;
  const id = parts[1] ?? '';
  if (!channel) return { ok: false, msg: '链接里没有频道名' };
  if (!id) {
    return {
      ok: false,
      msg: `这是频道链接（@${channel}），请给具体帖子地址，例如 https://t.me/${channel}/1`,
    };
  }
  if (!/^\d{1,20}$/.test(id)) return { ok: false, msg: `帖子编号无效：${id}` };
  if (!/^[A-Za-z0-9_]{3,64}$/.test(channel)) return { ok: false, msg: `频道名无效：${channel}` };
  return { ok: true, channel, id };
}

/* ---------------------------------------------------------------------------
 * HTML 取值
 * ------------------------------------------------------------------------- */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  middot: '·',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
};

function entityChar(code: number): string {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/**
 * 实体还原。
 * `&amp;` 不还原会把直链 token 后面的参数截断；`&nbsp;` 不还原会原样显示在简介里
 * （Telegram 的正文里大量使用它做缩进）。
 */
function decodeEntities(raw: string): string {
  return String(raw || '')
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => entityChar(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => entityChar(Number(dec)))
    .replace(
      /&([a-z]+);/gi,
      (whole, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? whole,
    );
}

/** 属性值（直链、背景图地址）取值 */
function decodeAttr(raw: string): string {
  return decodeEntities(raw).trim();
}

/** 去掉标签并还原实体，用于正文 / 作者 / 错误文案 */
function textOf(html: string): string {
  return decodeEntities(
    String(html || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]*>/g, ''),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 页面里的错误块：频道不存在 / 帖子不存在 / 不允许嵌入 */
function extractError(html: string): string {
  const m = html.match(/tgme_widget_message_error[^>]*>([\s\S]{0,600}?)<\/div>/i);
  if (!m) return '';
  const text = textOf(m[1]!);
  if (!text) return '页面返回了错误';
  if (/not found/i.test(text)) return `${text}（帖子已删除、频道改名，或该频道未公开）`;
  return text;
}

function extractAuthor(html: string): string {
  const m = html.match(/tgme_widget_message_owner_name[^>]*>([\s\S]{0,200}?)<\/a>/i);
  return m ? textOf(m[1]!) : '';
}

function extractText(html: string): string {
  const m = html.match(/tgme_widget_message_text[^>]*>([\s\S]{0,8000}?)<\/div>/i);
  return m ? textOf(m[1]!) : '';
}

/** `<time datetime="...">` 只取第一条：它是帖子发布时间，视频里的时长是另一处 */
function extractPublishTime(html: string): string | undefined {
  const m = html.match(/<time[^>]*datetime="([^"]+)"/i);
  if (!m) return undefined;
  const d = new Date(m[1]!);
  if (Number.isNaN(d.getTime())) return undefined;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** `<time duration>1:01</time>` → 61 秒 */
function extractDuration(html: string): number | null {
  const m = html.match(/<time[^>]*duration[^>]*>([\d:]+)<\/time>/i);
  if (!m) return null;
  const parts = m[1]!.split(':').map(Number);
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function extractVideos(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<video[^>]+src="([^"]+)"/gi)) {
    const url = decodeAttr(m[1]!);
    if (url && !out.includes(url)) out.push(url);
  }
  return out;
}

/** 图片地址在 photo_wrap 的背景图里，不是 <img src> */
function extractPhotos(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(
    /tgme_widget_message_photo_wrap[^>]*background-image\s*:\s*url\(['"]?([^'")]+)['"]?\)/gi,
  )) {
    const url = decodeAttr(m[1]!);
    if (url && !out.includes(url)) out.push(url);
  }
  return out;
}

/** 视频封面：视频块自己的缩略图 */
function extractVideoThumb(html: string): string {
  const m = html.match(
    /tgme_widget_message_video_thumb[^>]*background-image\s*:\s*url\(['"]?([^'")]+)['"]?\)/i,
  );
  return m ? decodeAttr(m[1]!) : '';
}

/**
 * 帖子被公开卡片屏蔽时，Telegram 会在正文位置渲染一句占位提示，
 * 附件是文件 / 音频（APK、PDF、音乐、语音）以及开启「限制保存内容」的频道都是这句：
 * 「Please open Telegram to view this post」。这时整条帖子的正文与附件一起被藏掉，
 * 页面里连文件名都没有，只能去 App 里看。
 *
 * 必须按文案判断，不能只看 message_media_not_supported 这个类名：
 * 视频在不支持播放的浏览器里会渲染另一句「This media is not supported in your browser」，
 * 那句只是 <video> 的兜底文字，媒体本身拿得到，误判会把正常视频一起挡掉。
 */
function extractBlockedLabel(html: string): string {
  const m = html.match(/message_media_not_supported_label[^>]*>([\s\S]{0,300}?)<\/div>/i);
  if (!m) return '';
  const text = textOf(m[1]!);
  return /open telegram/i.test(text) ? text : '';
}

/**
 * 文件行：卡片偶尔会渲染文件条目，但只列文件名与大小，不给下载地址，
 * 所以这里只用来把「是什么文件」写进提示文案。取不到就返回空串。
 */
function extractDocumentName(html: string): string {
  const name = html.match(
    /tgme_widget_message_document_title[^>]*>([\s\S]{0,300}?)(?:<\/div>|<\/span>)/i,
  );
  const extra = html.match(
    /tgme_widget_message_document_extra[^>]*>([\s\S]{0,200}?)(?:<\/div>|<\/span>)/i,
  );
  const title = name ? textOf(name[1]!) : '';
  const size = extra ? textOf(extra[1]!) : '';
  if (!title && !size) return '';
  return size ? `${title}（${size}）` : title;
}

/**
 * 卡片里没有图片也没有视频时，把原因分清楚。
 * 这几种情况对用户的下一步完全不同，混成一句「纯文字帖」会误导：
 * 文件 / 音频帖要换方案，投票帖本来就不可下载，纯文字帖没什么可下的。
 */
function describeNoMedia(html: string): { code: number; msg: string } {
  const docName = extractDocumentName(html);
  if (docName) {
    return {
      code: 415,
      msg: `这是文件帖：${docName}。Telegram 的公开网页只列文件名和大小，不给下载地址，请在 Telegram App 内查看或保存`,
    };
  }
  if (/tgme_widget_message_poll\b/i.test(html)) {
    return { code: 400, msg: '该帖是投票，没有可下载的媒体' };
  }
  if (extractBlockedLabel(html)) {
    return {
      code: 415,
      msg: '这条帖子的附件不对网页公开：文件、音频、语音这类内容 Telegram 只在 App 内展示，公开页面里没有文件名也没有下载地址，请在 Telegram App 内查看或保存',
    };
  }
  return { code: 400, msg: '该帖没有视频或图片（纯文字帖）' };
}

/* ---------------------------------------------------------------------------
 * 抓取
 * ------------------------------------------------------------------------- */

/** embed 页只在 t.me，跳转目标也只认这几家 */
function pageAllowed(url: string): boolean {
  return isAllowedDomain(url, ALLOWED_DOMAINS);
}

function mediaAllowed(url: string): boolean {
  return isAllowedDomain(url, MEDIA_DOMAINS);
}

/**
 * 抓 embed 页：先走代理，失败再直连兜底。
 * 反向也一样——t.me 在国内只有代理能到，而部署在境外时直连更快，
 * 两条路都留着，谁通用谁。
 */
async function fetchEmbedPage(
  embedUrl: string,
  deadline: Deadline,
): Promise<{ ok: true; html: string } | { ok: false; msg: string }> {
  const headers = {
    'User-Agent': DEFAULT_USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  };
  const failures: string[] = [];

  if (proxyConfigured() && !deadline.expired()) {
    try {
      const res = await proxyFetch(embedUrl, {
        headers,
        timeoutMs: Math.min(PAGE_TIMEOUT_MS, deadline.leftMs()),
        maxRedirects: 3,
        isAllowedRedirect: pageAllowed,
      });
      if (res.ok) return { ok: true, html: await res.text() };
      failures.push(`代理返回 HTTP ${res.status}`);
    } catch (e) {
      failures.push(`代理请求失败（${e instanceof Error ? e.message : '未知原因'}）`);
    }
  }

  if (!deadline.expired()) {
    const direct = await fetchFollowingAllowedRedirects({
      url: embedUrl,
      headers,
      isAllowed: pageAllowed,
      maxRedirects: 3,
      timeoutMs: Math.min(PAGE_TIMEOUT_MS, deadline.leftMs()),
    });
    if (direct.ok) return { ok: true, html: await direct.response.text() };
    failures.push(direct.message);
  }

  const hint = proxyConfigured()
    ? ''
    : '（t.me 在国内无法直连：把 X_PROXY_URL 指向本机代理后再试）';
  return { ok: false, msg: `抓取帖子页面失败${hint}；${failures.join('；')}` };
}

/**
 * 视频体积：`Range: bytes=0-0` 只要 1 字节，总长在 Content-Range 里。
 * 顺带当一次有效性校验——直链里的 token 失效时这里会拿到 404，
 * 比「下载到一半才发现链接过期」有用。
 */
async function probeVideoSize(
  videoUrl: string,
  deadline: Deadline,
): Promise<{ sizeText?: string; expired: boolean; failure?: string }> {
  const headers = { 'User-Agent': DEFAULT_USER_AGENT, Range: 'bytes=0-0' };
  const timeoutMs = Math.min(PAGE_TIMEOUT_MS, deadline.leftMs());

  let res: Response | null = null;
  if (proxyConfigured()) {
    try {
      res = await proxyFetch(videoUrl, {
        headers,
        timeoutMs,
        maxRedirects: 3,
        isAllowedRedirect: mediaAllowed,
      });
    } catch {
      // 代理不可用就落到直连（境外部署时直连本来就通）
      res = null;
    }
  }
  if (!res) {
    const direct = await fetchFollowingAllowedRedirects({
      url: videoUrl,
      headers,
      isAllowed: mediaAllowed,
      maxRedirects: 3,
      timeoutMs,
    });
    if (!direct.ok) return { expired: false, failure: direct.message };
    res = direct.response;
  }

  const okStatus = res.ok;
  const status = res.status;
  const contentRange = res.headers.get('content-range');
  const contentLength = res.headers.get('content-length');
  // 只取了 1 字节，body 不用读，直接放弃连接
  res.body?.cancel().catch(() => {});

  if (!okStatus) {
    // 404 是 token 过期；其余情况（403/5xx）也可能只是 CDN 抖动，不当作致命错误
    return {
      expired: status === 404,
      failure: `HTTP ${status}`,
    };
  }

  const total = contentRange
    ? Number(contentRange.split('/')[1])
    : Number(contentLength);
  return { expired: false, sizeText: Number.isFinite(total) && total > 0 ? formatBytes(total) : undefined };
}

function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)}GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(2)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

/**
 * 正文拆成标题与描述：首行当标题（过长截断），其余行当描述。
 * 首行被截断且没有剩余正文时，把全文放进描述，避免截掉的内容彻底丢失。
 */
function splitTitleAndDesc(text: string): { title: string; description: string } {
  const clean = String(text || '').trim();
  if (!clean) return { title: '', description: '' };
  const lines = clean.split('\n');
  const firstLine = lines[0]!.trim();
  const rest = lines.slice(1).join('\n').trim();
  const truncated = firstLine.length > TITLE_MAX;
  const title = truncated ? `${firstLine.slice(0, TITLE_MAX)}…` : firstLine;
  return { title, description: rest || (truncated ? clean : '') };
}

/* ---------------------------------------------------------------------------
 * 对外入口
 * ------------------------------------------------------------------------- */

/**
 * 解析 Telegram 公开帖链接（视频 / 图片，多图图集全部返回）。
 */
export async function parse(urlInput: string): Promise<TgApiResult> {
  const ref = resolvePostRef(urlInput);
  if (!ref.ok) return output(400, ref.msg);

  const embedUrl = `https://t.me/${ref.channel}/${ref.id}?embed=1&single`;
  if (!pageAllowed(embedUrl)) return output(400, '非 Telegram 域名链接');

  const deadline = createDeadline(DEADLINE_MS);

  let page: { ok: true; html: string } | { ok: false; msg: string };
  try {
    page = await fetchEmbedPage(embedUrl, deadline);
  } catch (e) {
    return output(502, e instanceof Error ? e.message : '解析失败');
  }
  if (!page.ok) return output(502, `解析失败：${page.msg}`);

  const html = page.html;
  const errText = extractError(html);
  if (errText) return output(404, `无法解析该帖：${errText}`);
  if (!/tgme_widget_message/i.test(html)) {
    return output(502, '解析失败：帖子页面结构已变更（没找到消息容器）');
  }

  const videos = extractVideos(html);
  const photos = extractPhotos(html);
  const videoThumb = extractVideoThumb(html);

  if (!videos.length && !photos.length) {
    const noMedia = describeNoMedia(html);
    return output(noMedia.code, noMedia.msg);
  }

  const text = extractText(html);
  const { title, description } = splitTitleAndDesc(text);
  const type: TgMediaData['type'] = videos.length ? 'video' : 'image';
  const videoUrl = videos[0] ?? '';

  let sizeText: string | undefined;
  let warning = '';
  if (videoUrl && !deadline.expired()) {
    const probe = await probeVideoSize(videoUrl, deadline);
    sizeText = probe.sizeText;
    if (probe.expired) {
      warning = '视频直链已失效（CDN 返回 404），下载前请重新解析。';
    }
  }
  if (videos.length > 1) {
    const extra = `该帖包含 ${videos.length} 个视频，这里只展示第 1 个。`;
    warning = warning ? `${warning} ${extra}` : extra;
  }

  return output(200, '解析成功', {
    type,
    title,
    description,
    author: extractAuthor(html),
    // 视频帖优先用视频自己的缩略图，纯图帖用第一张图
    cover: videoThumb || photos[0] || '',
    url: videoUrl,
    images: photos,
    duration: extractDuration(html),
    publishTime: extractPublishTime(html),
    ...(sizeText ? { sizeText } : {}),
    videoCount: videos.length,
    ...(warning ? { message: warning } : {}),
  });
}

export default { parse };
