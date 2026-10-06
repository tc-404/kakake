import { resolveConnVisual, connBorderClass } from '@/lib/conn-status';
import type { ConnectionStatus } from '@/lib/types';
import { cn } from '@/lib/utils';

/** 1×1 全透明 GIF，作为默认头像占位 */
export const TRANSPARENT_AVATAR =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/**
 * 右上角标签：只显示连接状态。
 *
 * 原先这里放的是连接类型（官方 / 微信 / KOOK / 野生），但类型在卡片底部
 * 「模式/类型」那行已经写了一遍，占着右上角这个最显眼的位置没意义；
 * 真正扫一眼就要知道的是「这条现在连上没有」。
 * 文案刻意压到三字以内——角标只有 9px，长文案在小卡上会挤掉头像。
 * 完整说法（如「等待腾讯回调」）留在按钮 title 里。
 */
function statusBadge(
  conn: ConnectionStatus,
  key: ReturnType<typeof resolveConnVisual>['key'],
): { label: string; tone: string } {
  switch (key) {
    case 'connected':
      return { label: '已连接', tone: 'kk-conn-card__badge--ok' };
    case 'failed':
      return { label: '已异常', tone: 'kk-conn-card__badge--bad' };
    case 'disabled':
      return { label: '未启用', tone: 'kk-conn-card__badge--off' };
    case 'connecting':
      return {
        label: conn.reconnecting || (conn.reconnectAttempts ?? 0) > 0 ? '重连中' : '连接中',
        tone: 'kk-conn-card__badge--warn',
      };
    case 'waiting':
    default:
      return { label: '等待中', tone: 'kk-conn-card__badge--warn' };
  }
}

export function ConnectionCard({
  conn,
  avatarDataUrl,
  index = 0,
  onOpen,
}: {
  conn: ConnectionStatus;
  avatarDataUrl?: string | null;
  index?: number;
  onOpen: (conn: ConnectionStatus) => void;
}) {
  const vis = resolveConnVisual(conn);
  const src = avatarDataUrl || TRANSPARENT_AVATAR;
  const hasRealAvatar = !!(avatarDataUrl && avatarDataUrl !== TRANSPARENT_AVATAR);
  const badge = statusBadge(conn, vis.key);

  return (
    <button
      type="button"
      onClick={() => onOpen(conn)}
      className={cn(
        'kk-card kk-card-interactive kk-stagger-item kk-conn-card',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        connBorderClass(vis.key),
      )}
      style={{ animationDelay: `${0.08 + index * 0.06}s` }}
      title={`${conn.name} · ${vis.label}`}
    >
      <span className={cn('kk-conn-card__badge', badge.tone)} title={vis.label}>
        {badge.label}
      </span>
      <div className="kk-conn-card__stage">
        <div
          className={cn(
            'kk-conn-card__avatar',
            /*
             * 真实头像**不给底色**：带透明通道的 PNG / WebP，透明区要直接透出卡片玻璃。
             * 之前这里在 hasRealAvatar 时铺了一层 bg-muted/40，等于把透明图层吃掉——
             * 透明 logo 会套出一圈灰盘，看着就是「头像不支持透明图」。
             * 只有占位态（没有真头像）才需要灰盘 + 描边来兜底。
             */
            !hasRealAvatar && 'bg-muted/25 ring-1 ring-border/40',
          )}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt=""
            className={cn(!hasRealAvatar && 'opacity-40')}
            draggable={false}
          />
        </div>
      </div>
      <div className="kk-conn-card__meta">
        <div className="kk-conn-card__name">{conn.name}</div>
        <div className="kk-conn-card__mode">{conn.modeLabel || conn.typeLabel}</div>
      </div>
    </button>
  );
}
