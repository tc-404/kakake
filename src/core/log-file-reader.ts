import type { LogCategory } from './log-store.js';
import { summarizeEventReport } from './log-format.js';

/** 落盘分类标签 → 日志分类（与 log-file-writer 的 CATEGORY_TAG 互逆） */
const TAG_TO_CATEGORY: Record<string, LogCategory> = {
  SYSTEM: 'system',
  EVENT: 'event',
  ACTION: 'action',
  PLUGIN: 'plugin',
  GF_EVENT: 'gf_event',
  GF_ACTION: 'gf_action',
  GF_PLUGIN: 'gf_plugin',
  TG_EVENT: 'tg_event',
  TG_ACTION: 'tg_action',
  SIM_EVENT: 'sim_event',
  SIM_ACTION: 'sim_action',
};

function fromTagLevel(tag: string): 'debug' | 'info' | 'warn' | 'error' | undefined {
  if (tag === 'DEBUG' || tag === 'INFO' || tag === 'WARN' || tag === 'ERROR') {
    return tag.toLowerCase() as 'debug' | 'info' | 'warn' | 'error';
  }
  return undefined;
}

function inferLevel(body: string): 'debug' | 'info' | 'warn' | 'error' {
  const text = body.trim();
  if (/^(错误|失败|异常)[，。:：\s]|\[(ERROR|ERR|FATAL)\]|错误[:：]|失败[:：]|异常[:：]|(Error|Exception|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EACCES)/i.test(text)) return 'error';
  if (/^(警告|注意)[，。:：\s]|\[WARN(ING)?\]|警告[:：]|未配置|被拒绝|不可用|超时重试/i.test(text)) return 'warn';
  if (/^\[DEBUG\]|调试[:：]/i.test(text)) return 'debug';
  return 'info';
}

export interface FileLogEntry {
  time: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  category: LogCategory;
  prefix: string;
  message: string;
  detail?: string;
}

// group3 单独捕获 TAG 后的第一个字符：上报类是 tab，其余是空格。
// 不能用 \s* 一口吞掉——那样 tab 会被吃掉，无法区分两种格式。
const HEAD_RE = /^\[([^\]]+)\]\s*\[([^\]]+)\](\s?)([\s\S]*)$/;
const PREFIX_RE = /^\[([^\]]*)\]\s*([\s\S]*)$/;

/**
 * 把磁盘上的 .log 文本还原成日志条目，供控制台「临时查看指定文件」使用。
 * 落盘格式（见 log-file-writer）：
 *   [时间] [TAG]\t{原始 JSON}               —— 上报类（event / gf_event）
 *   [时间] [TAG] [prefix] message | detail  —— 其余
 */
export function parseLogFile(text: string): FileLogEntry[] {
  const out: FileLogEntry[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) continue;
    const head = HEAD_RE.exec(line);
    // 续行（未以「[时间] [TAG]」起头）无法归属，跳过
    if (!head) continue;

    const time = head[1].trim();
    const rawTag = head[2].trim().toUpperCase();
    const colon = rawTag.indexOf(':');
    const tag = colon > 0 ? rawTag.slice(0, colon) : rawTag;
    const tagLevel = colon > 0 ? rawTag.slice(colon + 1) : '';
    const category = TAG_TO_CATEGORY[tag] ?? 'system';
    // 接回 TAG 后的原始首字符（tab 才能被识别出来）
    let body = head[3] + head[4];

    // 上报类：tab 之后是原始 JSON，摘要逻辑与实时视图同源（见 summarizeEventReport）
    if (body.startsWith('\t')) {
      const json = body.slice(1).trim();
      const { message, source, level } = summarizeEventReport(json, tag);
      out.push({ time, level: fromTagLevel(tagLevel) ?? level, category, prefix: source, message, detail: json });
      continue;
    }

    body = body.replace(/^[ \t]+/, '');
    let prefix = '';
    const pm = PREFIX_RE.exec(body);
    // 只有方括号后面还有正文时才算来源，避免把「[某某消息]」误判成 prefix
    if (pm && pm[1] && pm[2].trim()) {
      prefix = pm[1].trim();
      body = pm[2];
    }

    const sep = body.indexOf(' | ');
    const message = sep >= 0 ? body.slice(0, sep).trim() : body.trim();
    const detail = sep >= 0 ? body.slice(sep + 3).trim() : undefined;
    if (!message && !detail) continue;

    out.push({ time, level: fromTagLevel(tagLevel) ?? inferLevel(body), category, prefix, message, detail });
  }
  return out;
}
