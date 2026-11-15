import { resolveConnVisual, connBorderClass, connLabelKey } from '@/lib/conn-status';
import type { ConnectionStatus } from '@/lib/types';
import { cn } from '@/lib/utils';
import { useT } from '@/lib/i18n';

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
): { msgKey: string; tone: string } {
  switch (key) {
    case 'connected':
      return { msgKey: 'connections.badgeConnected', tone: 'kk-conn-card__badge--ok' };
    case 'failed':
      return { msgKey: 'connections.badgeFailed', tone: 'kk-conn-card__badge--bad' };
    case 'disabled':
      return { msgKey: 'connections.badgeDisabled', tone: 'kk-conn-card__badge--off' };
    case 'connecting':
      return {
        msgKey: conn.reconnecting || (conn.reconnectAttempts ?? 0) > 0 ? 'connections.badgeReconnecting' : 'connections.badgeConnecting',
        tone: 'kk-conn-card__badge--warn',
      };
    case 'waiting':
    default:
      return { msgKey: 'connections.badgeWaiting', tone: 'kk-conn-card__badge--warn' };
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
  const t = useT();
  const vis = resolveConnVisual(conn);
  const src = avatarDataUrl || TRANSPARENT_AVATAR;
  const hasRealAvatar = !!(avatarDataUrl && avatarDataUrl !== TRANSPARENT_AVATAR);
  const badge = statusBadge(conn, vis.key);
  const badgeLabel = t(badge.msgKey);
  // 后端给的 modeLabel / typeLabel 是中文常量，英文模式下要换成字典文案
  const kindKey = connLabelKey(conn.modeLabel) ?? connLabelKey(conn.typeLabel);
  const kindText = kindKey ? t(kindKey) : (conn.modeLabel || conn.typeLabel);
  const tgMode = conn.telegramMode ?? (conn.mode === 'webhook' ? 'webhook' : 'polling');
  /*
   * Telegram 卡片：主行 = 机器人显示名（如「咔咔」），副行 = 账号 @用户名。
   * 后端会把展示名 name 强制成 `@用户名`，所以不能直接拿 name 当主行；
   * 这里改用 telegramBotFirstName 作主行，缺少显示名时回退 name；
   * 副行归一化后若与主行重复则不再渲染（避免两行一模一样）。
   * 模式、本地 API、测试环境等细节只在悬停 title 出现。
   */
  const tgNameKey = (s: string) => s.replace(/^@/, '').trim().toLowerCase();
  const tgDisplayName = conn.telegramBotFirstName?.trim() || '';
  const tgHandle = conn.telegramBotUsername ? `@${conn.telegramBotUsername}` : '';
  const isTelegram = conn.type === 'telegram';
  // 主行：TG 优先显示名，没有则退回后端给的 name
  const primaryName = isTelegram && tgDisplayName ? tgDisplayName : conn.name;
  // 副行：TG 用 @用户名（去重后可能为空）；其它类型用模式/类型
  let metaSecondary = isTelegram ? '' : kindText;
  if (isTelegram && tgHandle && tgNameKey(tgHandle) !== tgNameKey(primaryName)) {
    metaSecondary = tgHandle;
  }
  const telegramDetail = conn.type === 'telegram'
    ? [
        tgMode === 'webhook' ? t('connections.tg.badgeWebhook') : t('connections.tg.badgePolling'),
        conn.telegramApiBase && conn.telegramApiBase !== 'https://api.telegram.org'
          ? t('connections.tg.badgeLocalApi')
          : null,
        conn.telegramTestEnv ? t('connections.tg.badgeTestEnv') : null,
        conn.telegramWebhookInfo?.last_error_message ? t('connections.tg.badgeWebhookError') : null,
      ].filter(Boolean).join(' · ')
    : '';

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
      title={`${isTelegram ? primaryName : conn.name}${isTelegram && metaSecondary ? ` · ${metaSecondary}` : ''} · ${badgeLabel}${telegramDetail ? ` · ${telegramDetail}` : ''}`}
    >
      <span className={cn('kk-conn-card__badge', badge.tone)} title={badgeLabel}>
        {badgeLabel}
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
        <div className="kk-conn-card__name">{primaryName}</div>
        {metaSecondary ? <div className="kk-conn-card__mode">{metaSecondary}</div> : null}
      </div>
    </button>
  );
}
