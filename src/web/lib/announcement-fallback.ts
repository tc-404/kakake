// 本地备用公告：远程拉取失败时兜底，保证协议页始终可读。正文见 src/web/content/announcement-fallback.md（?raw 构建时内联进包）。
import announcementFallbackMd from '../content/announcement-fallback.md?raw';

export const ANNOUNCEMENT_FALLBACK = announcementFallbackMd;
