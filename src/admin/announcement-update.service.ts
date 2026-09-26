import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../paths.js';
import { rootLogger } from '../core/logger.js';

/**
 * 远程公告「版本提示」机制（与 /api/agreement 门禁彼此独立）。
 *
 * 目标行为（见需求）：
 * - 每次登录成功 → 后台异步（fire-and-forget）拉一次远程公告，解析其版本号；
 *   若比已知版本更高，只写入 pendingVersion，**不在本次会话生效**。
 * - 登录那一刻先做一次「提升」：把上一轮探测到的 pendingVersion 提升为
 *   showVersion。于是新版本只会在「下一次进入后台」才弹出，而不是本次。
 * - 后台探测若超时 / 出错：仅记 lastError，不动 pending、不重试；因为它只在
 *   登录时触发一次，本次会话内不会再发起网络获取。
 * - 「进入后台是否弹窗」只读本地状态，绝不在进入时发起网络请求。
 */

const ANNOUNCEMENT_REMOTE_URL =
  'https://xn--mk-ub3cl61ae1v.xn--c5w857b.xn--fiqs8s/mkbot/%E5%92%94%E5%92%94%E5%85%AC%E5%91%8A.md';

const FETCH_TIMEOUT_MS = 7_000;

type UpdateState = {
  /** 用户已确认（读过）的公告版本 */
  seenVersion: string;
  /** 本次起该弹出的公告版本（登录时由 pending 提升而来） */
  showVersion: string;
  /** 后台探测到、待下次登录提升的公告版本 */
  pendingVersion: string;
  /** 最近一次后台探测时间（ISO） */
  lastCheckedAt: string;
  /** 最近一次探测错误（成功则为空） */
  lastError: string;
};

const EMPTY_STATE: UpdateState = {
  seenVersion: '',
  showVersion: '',
  pendingVersion: '',
  lastCheckedAt: '',
  lastError: '',
};

/** 从公告 Markdown 顶部解析「- **版本**：1.2」形式的版本号 */
export function parseAnnouncementVersion(markdown: string): string {
  if (!markdown) return '';
  // 只看前若干行，避免正文里出现「版本」二字被误匹配
  const head = markdown.split(/\r?\n/).slice(0, 20).join('\n');
  const m = head.match(/版本[^\d]{0,6}(\d+(?:\.\d+){0,3})/);
  return m ? m[1] : '';
}

/** 语义化比较：a>b 返回正，a<b 返回负，相等返回 0（缺位按 0）。空版本视为最低 */
export function compareVersions(a: string, b: string): number {
  const pa = String(a || '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '').split('.').map((x) => parseInt(x, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** 读内置 fallback 公告的版本号，作为首次运行的 seen 基线（不因自带版本弹窗） */
function readBundledVersion(): string {
  const candidates = [
    path.join(PATHS.webApp, 'content', 'announcement-fallback.md'),
    path.join(PATHS.webApp, 'public', 'announcement-fallback.md'),
  ];
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        const v = parseAnnouncementVersion(fs.readFileSync(file, 'utf8'));
        if (v) return v;
      }
    } catch {
      /* try next */
    }
  }
  return '';
}

function readState(): UpdateState {
  try {
    if (fs.existsSync(PATHS.announcementUpdate)) {
      const raw = JSON.parse(fs.readFileSync(PATHS.announcementUpdate, 'utf8')) as Partial<UpdateState>;
      return {
        seenVersion: String(raw.seenVersion || ''),
        showVersion: String(raw.showVersion || ''),
        pendingVersion: String(raw.pendingVersion || ''),
        lastCheckedAt: String(raw.lastCheckedAt || ''),
        lastError: String(raw.lastError || ''),
      };
    }
  } catch {
    /* fall through to seed */
  }
  // 首次运行：把内置版本记为已读基线，避免对自带公告误弹
  const seed: UpdateState = { ...EMPTY_STATE, seenVersion: readBundledVersion() };
  writeState(seed);
  return seed;
}

function writeState(state: UpdateState): void {
  try {
    const dir = path.dirname(PATHS.announcementUpdate);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PATHS.announcementUpdate, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  } catch (e) {
    rootLogger.warn(`[announcement] 状态写入失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * 登录时调用：把上一轮后台探测到的 pending 提升为 show（仅当比已读更高）。
 * 必须在触发后台探测**之前**同步执行，确保本次探测结果不会在本次会话生效。
 */
export function promotePendingOnLogin(): void {
  const state = readState();
  if (state.pendingVersion && compareVersions(state.pendingVersion, state.seenVersion) > 0) {
    // pending 比已读新：提升为本次起应弹出的版本
    if (compareVersions(state.pendingVersion, state.showVersion) > 0) {
      state.showVersion = state.pendingVersion;
    }
    state.pendingVersion = '';
    writeState(state);
  } else if (state.pendingVersion) {
    // pending 已不高于已读（用户可能已在别处确认）：清掉即可
    state.pendingVersion = '';
    writeState(state);
  }
}

/**
 * 后台异步探测（fire-and-forget）：拉远程公告解析版本号。
 * 只写 pendingVersion / lastChecked / lastError，绝不触碰 showVersion。
 * 失败仅记录，不重试。
 */
export function checkRemoteAnnouncementInBackground(): void {
  void (async () => {
    const state = readState();
    try {
      const resp = await fetch(ANNOUNCEMENT_REMOTE_URL, {
        headers: { Accept: 'text/markdown, text/plain, */*', 'User-Agent': 'Kakake/0.2' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const markdown = await resp.text();
      const remoteVersion = parseAnnouncementVersion(markdown);
      state.lastCheckedAt = new Date().toISOString();
      if (!remoteVersion) {
        state.lastError = '远程公告未解析到版本号';
        writeState(state);
        return;
      }
      state.lastError = '';
      // 只有比「已读」和「已探测到的 pending」都更高，才更新 pending
      if (
        compareVersions(remoteVersion, state.seenVersion) > 0 &&
        compareVersions(remoteVersion, state.pendingVersion) > 0 &&
        compareVersions(remoteVersion, state.showVersion) > 0
      ) {
        state.pendingVersion = remoteVersion;
        rootLogger.info(`[announcement] 探测到新公告版本 v${remoteVersion}，将在下次进入后台时提示`);
      }
      writeState(state);
    } catch (e) {
      // 超时 / 网络错误：只记录，不重试、不动 pending
      state.lastCheckedAt = new Date().toISOString();
      state.lastError = e instanceof Error ? e.message : String(e);
      writeState(state);
    }
  })();
}

/** 进入后台时读取：是否有应弹出的公告更新（不发起任何网络请求） */
export function getAnnouncementUpdateState() {
  const state = readState();
  const hasUpdate =
    !!state.showVersion && compareVersions(state.showVersion, state.seenVersion) > 0;
  return {
    hasUpdate,
    showVersion: state.showVersion,
    seenVersion: state.seenVersion,
  };
}

/** 用户已阅读当前提示版本：写回 seen，清空 show */
export function acknowledgeAnnouncementUpdate(version?: string) {
  const state = readState();
  const target = (version && version.trim()) || state.showVersion;
  if (target && compareVersions(target, state.seenVersion) > 0) {
    state.seenVersion = target;
  }
  // 已读到的版本 >= show 时清空 show
  if (state.showVersion && compareVersions(state.seenVersion, state.showVersion) >= 0) {
    state.showVersion = '';
  }
  writeState(state);
  return { ok: true, seenVersion: state.seenVersion };
}
