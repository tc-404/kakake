/** 模拟消息编排：构造事件 → 派发给账号已加载插件 → 捕获输出 → 实时推送 + 持久化 */
import { randomUUID } from 'node:crypto';
import { kakakeApp } from '../../kakake-app.js';
import { configService } from '../../core/config.service.js';
import { isOnebotConnection, isQqOfficialConnection } from '../../core/types.js';
import { pluginAccountService } from '../../plugin/plugin-account.service.js';
import { eventBus } from '../../event/event-bus.js';
import { logSimAction, logSimEvent } from '../../core/log-store.js';
import { segmentsToRaw } from './event-factory.js';
import { buildOb11MessageEvent, buildOb11EventEvent } from './event-factory.js';
import { buildOfficialMessageEvent, buildOfficialEventEvent } from './official-event-factory.js';
import { appendEntries, clearTranscript, loadTranscript } from './simulate.store.js';
import type {
  CapturedCall, SimulateAccountKind, SimulateEventInput, SimulateInput, TranscriptEntry,
} from './simulate.types.js';

export interface SimulateAccount {
  accountKey: string;
  connectionId: string;
  name: string;
  botUin?: string;
  connected: boolean;
  /** 账号类别：onebot / official（QQ 官方机器人） */
  kind: SimulateAccountKind;
}

/** 可模拟的账号：启用 + 已锁定账号（accountKey），含 OneBot 与 QQ 官方 */
export function listSimulateAccounts(): SimulateAccount[] {
  const out: SimulateAccount[] = [];
  const seen = new Set<string>();
  for (const conn of configService.getConnections().connections) {
    if (!conn.enable) continue;
    const isOfficial = isQqOfficialConnection(conn);
    if (!isOnebotConnection(conn) && !isOfficial) continue;
    const accountKey = pluginAccountService.resolveAccountKey(conn);
    if (!accountKey || seen.has(accountKey)) continue;
    seen.add(accountKey);
    const status = kakakeApp.connectionManager
      .getStatusList()
      .find((s) => s.id === conn.id);
    out.push({
      accountKey,
      connectionId: conn.id,
      name: conn.name,
      botUin: isOfficial ? conn.appId : conn.botUin,
      connected: status?.connected ?? false,
      kind: isOfficial ? 'official' : 'onebot',
    });
  }
  return out;
}

/** 判断某 accountKey 是否为 QQ 官方账号 */
function accountKindOf(accountKey: string): SimulateAccountKind {
  for (const conn of configService.getConnections().connections) {
    if (!conn.enable) continue;
    if (pluginAccountService.resolveAccountKey(conn) === accountKey) {
      return isQqOfficialConnection(conn) ? 'official' : 'onebot';
    }
  }
  return 'onebot';
}

/** SSE 推送：把一条捕获输出发给订阅该账号的前端 */
function emitOutput(accountKey: string, entry: TranscriptEntry): void {
  void eventBus.emit('simulate/output', { accountKey, entry });
}

/** 把一次插件捕获输出写进「模拟输出」日志分类 */
function logCapturedAction(accountKey: string, call: { pluginId: string; action: string; params: Record<string, unknown> }): void {
  let detail: string | undefined;
  try { detail = JSON.stringify(call.params); } catch { detail = undefined; }
  logSimAction(`[模拟输出:${call.pluginId}@${accountKey}]`, call.action, detail);
}

/**
 * 执行一次模拟消息。
 * 1. 记录并推送用户输入
 * 2. 构造 OB11 事件派发给该账号已加载插件（捕获版 actions.call）
 * 3. 捕获到的每条插件输出实时推送 + 持久化
 */
export async function runSimulate(
  accountKey: string,
  input: SimulateInput,
): Promise<{ dispatched: number; captured: number }> {
  const key = String(accountKey || '').trim();
  if (!key) throw new Error('缺少账号');

  const persisted: TranscriptEntry[] = [];

  // 1. 用户输入
  const userEntry: TranscriptEntry = {
    kind: 'user',
    id: randomUUID(),
    time: Date.now(),
    chatType: input.chatType,
    groupId: input.groupId != null ? String(input.groupId) : undefined,
    userId: String(input.userId),
    nickname: input.nickname,
    message: input.message,
  };
  persisted.push(userEntry);
  emitOutput(key, userEntry);
  logSimEvent(
    `[模拟输入:${key}]`,
    `${input.chatType === 'group' ? `群${input.groupId}` : '私聊'} ${input.nickname || input.userId}: ${segmentsToRaw(input.message)}`,
  );

  const onCapture = (call: { pluginId: string; action: string; params: Record<string, unknown> }): void => {
    const captured: CapturedCall = {
      id: randomUUID(),
      time: Date.now(),
      pluginId: call.pluginId,
      action: call.action,
      params: call.params,
    };
    const entry: TranscriptEntry = {
      kind: 'plugin',
      id: captured.id,
      time: captured.time,
      pluginId: captured.pluginId,
      action: captured.action,
      params: captured.params,
    };
    persisted.push(entry);
    emitOutput(key, entry);
    logCapturedAction(key, call);
  };

  // 2. 按账号类别构造事件并派发到对应插件管理器
  const kind = accountKindOf(key);
  let dispatched = 0;
  if (kind === 'official') {
    const { event } = buildOfficialMessageEvent(key, input);
    ({ dispatched } = await kakakeApp.gfPluginManager.dispatchSimulated(key, event, onCapture));
  } else {
    const event = buildOb11MessageEvent(key, input);
    ({ dispatched } = await kakakeApp.pluginManager.dispatchSimulated(key, event, onCapture));
  }

  // 3. 持久化（用户输入 + 全部插件输出）
  appendEntries(key, persisted);

  return { dispatched, captured: persisted.length - 1 };
}

/**
 * 执行一次事件上报（notice / request）。
 * 用户侧记录为灰字事件，插件侧输出照常捕获。
 */
export async function runSimulateEvent(
  accountKey: string,
  input: SimulateEventInput,
): Promise<{ dispatched: number; captured: number }> {
  const key = String(accountKey || '').trim();
  if (!key) throw new Error('缺少账号');

  const persisted: TranscriptEntry[] = [];
  const kind = accountKindOf(key);

  // 官方事件类型以 gf_ 前缀区分，走官方事件工厂
  const isOfficialEvent = String(input.eventType).startsWith('gf_');
  const { event, summary } = (kind === 'official' || isOfficialEvent)
    ? buildOfficialEventEvent(key, input)
    : buildOb11EventEvent(key, input);

  const eventEntry: TranscriptEntry = {
    kind: 'event',
    id: randomUUID(),
    time: Date.now(),
    eventType: input.eventType,
    summary,
  };
  persisted.push(eventEntry);
  emitOutput(key, eventEntry);
  logSimEvent(`[模拟上报:${key}]`, `${input.eventType} · ${summary}`);

  const onCapture = (call: { pluginId: string; action: string; params: Record<string, unknown> }): void => {
    const entry: TranscriptEntry = {
      kind: 'plugin',
      id: randomUUID(),
      time: Date.now(),
      pluginId: call.pluginId,
      action: call.action,
      params: call.params,
    };
    persisted.push(entry);
    emitOutput(key, entry);
    logCapturedAction(key, call);
  };

  const { dispatched } = kind === 'official'
    ? await kakakeApp.gfPluginManager.dispatchSimulated(key, event, onCapture)
    : await kakakeApp.pluginManager.dispatchSimulated(key, event, onCapture);

  appendEntries(key, persisted);
  return { dispatched, captured: persisted.length - 1 };
}

export function getHistory(accountKey: string) {
  return loadTranscript(accountKey);
}

export function clearHistory(accountKey: string): void {
  clearTranscript(accountKey);
}
