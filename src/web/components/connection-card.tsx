import { resolveConnVisual, connBorderClass } from '@/lib/conn-status';
import type { ConnectionStatus } from '@/lib/types';
import { cn } from '@/lib/utils';

/** 1×1 全透明 GIF，作为默认头像占位 */
export const TRANSPARENT_AVATAR =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

function typeBadge(type: ConnectionStatus['type']): { label: string; tone: string } {
  if (type === 'qq_official') return { label: '官方', tone: 'kk-conn-card__badge--official' };
  if (type === 'weixin_bot') return { label: '微信', tone: 'kk-conn-card__badge--weixin' };
  return { label: '野生', tone: 'kk-conn-card__badge--onebot' };
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
  const badge = typeBadge(conn.type);

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
      <span className={cn('kk-conn-card__badge', badge.tone)} aria-hidden>
        {badge.label}
      </span>
      <div className="kk-conn-card__stage">
        <div
          className={cn(
            'kk-conn-card__avatar',
            hasRealAvatar ? 'bg-muted/40' : 'bg-muted/25 ring-1 ring-border/40',
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
