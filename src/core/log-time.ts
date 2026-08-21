/** 日志用本地时区时间（跟随运行机器系统时区，不用 UTC） */

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** YYYY-MM-DD（本地日期，用于按日切分日志文件） */
export function formatLocalDate(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** HH:mm:ss.SSS（本地，终端前缀） */
export function formatLocalClock(d = new Date()): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** YYYY-MM-DD HH:mm:ss.SSS（本地，写入 log-store / 文件 / 控制台） */
export function formatLocalDateTime(d = new Date()): string {
  return `${formatLocalDate(d)} ${formatLocalClock(d)}`;
}
