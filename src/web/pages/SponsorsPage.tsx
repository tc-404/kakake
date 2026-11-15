import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { SponsorItem } from '@/lib/types';
import { cn } from '@/lib/utils';

function initialOf(name: string): string {
  return (name.trim().charAt(0) || '赞').toUpperCase();
}

function SponsorAvatar({ item }: { item: SponsorItem }) {
  const [failed, setFailed] = useState(false);
  const url = /^\d+$/.test(item.qq) ? `https://q4.qlogo.cn/g?b=qq&nk=${item.qq}&s=5` : '';
  return (
    <div className="kk-sp-avatar" aria-hidden="true">
      {url && !failed ? (
        <img
          src={url}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        <span>{initialOf(item.name)}</span>
      )}
    </div>
  );
}

function SponsorCard({
  item,
  index,
  open,
  onToggle,
}: {
  item: SponsorItem;
  index: number;
  open: boolean;
  onToggle: () => void;
}) {
  const start = useRef<{ x: number; y: number } | null>(null);
  const hasThanks = Boolean(item.thanks);
  const moneyLike = /^[¥￥$€£]?\s*\d/.test(item.amount);
  return (
    <article
      tabIndex={hasThanks ? 0 : undefined}
      className={cn('kk-sp-card', `kk-sp-card--${item.tier}`)}
      style={{ animationDelay: `${Math.min(index * 40, 320)}ms` }}
      data-open={open ? 'true' : undefined}
      onPointerDown={(event) => {
        start.current = { x: event.clientX, y: event.clientY };
      }}
      onPointerUp={(event) => {
        if (!hasThanks || event.pointerType === 'mouse') return;
        const from = start.current;
        start.current = null;
        if (from && Math.hypot(event.clientX - from.x, event.clientY - from.y) > 8) return;
        onToggle();
      }}
    >
      <div className="kk-sp-card__inner">
        <SponsorAvatar item={item} />
        <h2 className="kk-sp-card__name">{item.name}</h2>
        {item.amount ? (
          <span className={cn('kk-sp-card__amount', !moneyLike && 'kk-sp-card__amount--text')}>
            {item.amount}
          </span>
        ) : null}
        {hasThanks ? (
          <div className="kk-sp-card__reveal">
            <p className="kk-sp-card__thanks">{item.thanks}</p>
          </div>
        ) : null}
      </div>
    </article>
  );
}

function SkeletonWall() {
  return (
    <div className="kk-sp-wall">
      {Array.from({ length: 12 }, (_, i) => (
        <div key={i} className="kk-sp-skeleton" style={{ animationDelay: `${i * 40}ms` }} />
      ))}
    </div>
  );
}

export default function SponsorsPage() {
  const [items, setItems] = useState<SponsorItem[] | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const ctrl = new AbortController();
    api.sponsors
      .list(ctrl.signal)
      .then((r) => {
        if (alive) setItems(r.sponsors);
      })
      .catch(() => {
        if (alive) setItems([]);
      });
    return () => {
      alive = false;
      ctrl.abort();
    };
  }, []);

  return (
    <div className="kk-sp-page">
      {items === null ? (
        <SkeletonWall />
      ) : (
        <div className="kk-sp-wall">
          {items.map((item, index) => {
            const key = `${item.tier}-${item.name}-${index}`;
            return (
              <SponsorCard
                key={key}
                item={item}
                index={index}
                open={openKey === key}
                onToggle={() => setOpenKey((prev) => (prev === key ? null : key))}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
