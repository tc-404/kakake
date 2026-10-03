/** 北京时间部件（步数按小时缩放、日期写入 band_data） */

function part(
  parts: Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
): string {
  return parts.find((p) => p.type === type)?.value || '';
}

export function beijingParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const year = part(parts, 'year');
  const month = part(parts, 'month');
  const day = part(parts, 'day');
  return {
    year,
    month,
    day,
    hour: Number(part(parts, 'hour')),
    minute: Number(part(parts, 'minute')),
    second: Number(part(parts, 'second')),
    dateStr: `${year}-${month}-${day}`,
  };
}

export function beijingNowLabel(date = new Date()): string {
  const p = beijingParts(date);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.dateStr} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

/** Unix 毫秒（与 mimotion get_time 一致，时区不影响 epoch） */
export function nowMsString(date = new Date()): string {
  return String(date.getTime());
}
