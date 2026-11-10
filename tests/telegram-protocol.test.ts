/**
 * Telegram Bot 连接协议：连接规范化、标签、指纹、辅助判定与
 * src/connection/telegram.types.ts 里的纯函数 / 常量。
 *
 * 风格对齐 tests/connection-import.test.ts（node:test + node:assert/strict，
 * import 路径用 ../src/...js，由 tsx 直接跑 .ts）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeConnection,
  connectionTypeLabel,
  connectionModeLabel,
  connectionFingerprint,
  hasResolvedAccount,
  isTelegramConnection,
  telegramConnectionReady,
  telegramConnectionSummary,
  parseTelegramMode,
} from '../src/core/types.js';
import {
  TELEGRAM_EVENT_NAME,
  TELEGRAM_ACTION_RESULT_NAME,
  TELEGRAM_ALL_UPDATE_TYPES,
  TELEGRAM_WEBHOOK_PORTS,
  escapeMarkdownV2,
  escapeHtml,
  normalizeTelegramApiBase,
  buildTelegramApiUrl,
  telegramUpdateType,
  telegramUpdateToEvent,
  parseTelegramCommand,
} from '../src/connection/telegram.types.js';

// normalizeConnection 的入参类型较宽，用 any 构造测试样本，避免测试文件被类型细节绑架
function tgConn(overrides: Record<string, unknown> = {}): any {
  return { id: 'tg1', name: 'TG 测试', type: 'telegram', enable: true, ...overrides };
}

// ───────────────────────── normalizeConnection ─────────────────────────

test('normalizeConnection：type telegram 规范化为 Telegram Bot 连接（webhook 模式 + 全字段保留）', () => {
  const c = normalizeConnection(tgConn({
    mode: 'webhook',
    telegramToken: '  123456:ABC-DEF  ',
    telegramApiBase: 'http://127.0.0.1:8081/',
    telegramTestEnv: true,
    telegramWebhookUrl: 'https://bot.example.com/tgbot/tg1',
    telegramWebhookSecret: 's3cr3t-_ABC',
    telegramWebhookMaxConnections: 80,
    telegramWebhookIpAddress: '1.2.3.4',
    telegramWebhookCertificatePath: '/certs/public.pem',
    telegramAllowedUpdates: ['message', 'callback_query', 'bad type!'],
    telegramDropPendingUpdates: true,
    telegramPollingTimeout: 25,
    telegramPollingLimit: 50,
    telegramOffset: 123,
    telegramProxyUrl: 'http://127.0.0.1:7897',
    telegramWebhookReplyInResponse: true,
    telegramParseMode: 'MarkdownV2',
    telegramBotUserId: '777000111',
    telegramBotUsername: 'demo_bot',
    telegramBotFirstName: 'Demo',
  }));

  assert.equal(c.type, 'telegram');
  assert.equal(c.mode, 'webhook');
  assert.equal(c.host, '');
  assert.equal(c.port, 0);
  assert.equal(c.enable, true);
  assert.equal(c.telegramToken, '123456:ABC-DEF');           // 去首尾空白
  assert.equal(c.telegramApiBase, 'http://127.0.0.1:8081'); // 去尾斜杠
  assert.equal(c.telegramTestEnv, true);
  assert.equal(c.telegramWebhookUrl, 'https://bot.example.com/tgbot/tg1');
  assert.equal(c.telegramWebhookSecret, 's3cr3t-_ABC');
  assert.equal(c.telegramWebhookMaxConnections, 80);
  assert.equal(c.telegramWebhookIpAddress, '1.2.3.4');
  assert.equal(c.telegramWebhookCertificatePath, '/certs/public.pem');
  assert.deepEqual(c.telegramAllowedUpdates, ['message', 'callback_query']); // 非法类型被过滤
  assert.equal(c.telegramDropPendingUpdates, true);
  assert.equal(c.telegramPollingTimeout, 25);
  assert.equal(c.telegramPollingLimit, 50);
  assert.equal(c.telegramOffset, 123);
  assert.equal(c.telegramProxyUrl, 'http://127.0.0.1:7897');
  assert.equal(c.telegramWebhookReplyInResponse, true);
  assert.equal(c.telegramParseMode, 'MarkdownV2');
  assert.equal(c.telegramBotUserId, '777000111');
  assert.equal(c.telegramBotUsername, 'demo_bot');
  assert.equal(c.telegramBotFirstName, 'Demo');
});

test('normalizeConnection：polling 是默认模式，布尔字段有确定默认值，非法 parseMode 被丢弃', () => {
  const c = normalizeConnection(tgConn({
    telegramToken: 'tok',
    telegramParseMode: 'NotAMode',
  }));
  assert.equal(c.mode, 'polling');
  assert.equal(c.telegramTestEnv, false);
  assert.equal(c.telegramDropPendingUpdates, false);
  assert.equal(c.telegramWebhookReplyInResponse, false);
  assert.equal(c.telegramParseMode, undefined);
  assert.equal(c.telegramApiBase, undefined);
  assert.equal(c.telegramAllowedUpdates, undefined);
});

test('normalizeConnection：mode=webhook 显式保留；数值字段按范围钳制', () => {
  const c = normalizeConnection(tgConn({
    mode: 'webhook',
    telegramToken: 'tok',
    telegramPollingLimit: 999,      // 上限 100
    telegramPollingTimeout: 999,    // 上限 50
    telegramWebhookMaxConnections: 0, // 下限 1
  }));
  assert.equal(c.mode, 'webhook');
  assert.equal(c.telegramPollingLimit, 100);
  assert.equal(c.telegramPollingTimeout, 50);
  assert.equal(c.telegramWebhookMaxConnections, 1);
});

test('normalizeConnection：未知 type 仍回落 onebot（不受 telegram 分支影响）', () => {
  const c = normalizeConnection({ id: 'x', name: '未知', type: 'some-future-protocol', enable: true } as any);
  assert.equal(c.type, 'onebot');
  assert.equal(c.mode, 'reverse');
  assert.equal(normalizeConnection({ id: 'y', name: '缺省', enable: false } as any).type, 'onebot');
});

// ───────────────────────── 标签 ─────────────────────────

test('connectionTypeLabel：telegram → Telegram Bot', () => {
  assert.equal(connectionTypeLabel('telegram'), 'Telegram Bot');
  assert.equal(connectionTypeLabel(), 'OneBot');
  assert.equal(connectionTypeLabel('qq_official'), 'QQ 官方机器人');
});

test('connectionModeLabel：polling / webhook 都有中文标签', () => {
  assert.equal(connectionModeLabel('polling'), '长轮询');
  assert.equal(connectionModeLabel('webhook'), 'Webhook 回调');
  // 确实含中文（而非纯英文占位）
  assert.match(connectionModeLabel('polling'), /[^\x00-\x7F]/);
  assert.match(connectionModeLabel('webhook'), /[^\x00-\x7F]/);
});

// ───────────────────────── 指纹 / 账号判定 ─────────────────────────

test('connectionFingerprint：telegram 按 telegram|<botUserId> 稳定，且不与其他协议撞号', () => {
  const fp = connectionFingerprint({ type: 'telegram', telegramBotUserId: '777' } as any);
  assert.equal(fp, 'telegram|777');
  // 与连接名 / 地址 / 端口 / 密钥无关（telegram 一个账号只有一条连接）
  assert.equal(fp, connectionFingerprint({
    type: 'telegram', telegramBotUserId: '777',
    host: 'h', port: 9999, accessToken: 't',
  } as any));
  assert.notEqual(fp, connectionFingerprint({ type: 'telegram', telegramBotUserId: '888' } as any));
  // 与其它协议同账号 id 也不撞
  assert.notEqual(fp, connectionFingerprint({ type: 'onebot', botUin: '777' } as any));
  assert.notEqual(fp, connectionFingerprint({ type: 'qq_official', appId: '777' } as any));
  assert.notEqual(fp, connectionFingerprint({ type: 'kook', kookBotUserId: '777' } as any));
  assert.notEqual(fp, connectionFingerprint({ type: 'weixin_bot', weixinAccountId: '777' } as any));
  assert.equal(connectionFingerprint({ type: 'telegram' } as any), 'telegram|');
});

test('hasResolvedAccount：telegram 认 telegramBotUserId', () => {
  assert.equal(hasResolvedAccount({ type: 'telegram', telegramBotUserId: '777' } as any), true);
  assert.equal(hasResolvedAccount({ type: 'telegram', telegramBotUserId: 777 } as any), true);
  assert.equal(hasResolvedAccount({ type: 'telegram', telegramBotUserId: '   ' } as any), false);
  assert.equal(hasResolvedAccount({ type: 'telegram' } as any), false);
  assert.equal(hasResolvedAccount({ type: 'telegram', botUin: '777' } as any), false); // 不认别的协议字段
});

// ───────────────────────── Telegram 辅助函数 ─────────────────────────

test('isTelegramConnection / telegramConnectionReady / parseTelegramMode', () => {
  assert.equal(isTelegramConnection({ type: 'telegram' } as any), true);
  assert.equal(isTelegramConnection({ type: 'onebot' } as any), false);
  assert.equal(isTelegramConnection({} as any), false); // 缺省回落 onebot
  assert.equal(telegramConnectionReady({ type: 'telegram', telegramToken: 'tok' } as any), true);
  assert.equal(telegramConnectionReady({ type: 'telegram', telegramToken: '  ' } as any), false);
  assert.equal(telegramConnectionReady({ type: 'telegram' } as any), false);
  assert.equal(parseTelegramMode('webhook'), 'webhook');
  assert.equal(parseTelegramMode('polling'), 'polling');
  assert.equal(parseTelegramMode(undefined), 'polling');
  assert.equal(parseTelegramMode('garbage'), 'polling');
});

test('telegramConnectionSummary：未配 token / 长轮询 / Webhook+测试环境+本地 API', () => {
  assert.equal(telegramConnectionSummary({ type: 'telegram' } as any), '未配置 Bot Token');
  assert.equal(telegramConnectionSummary({ type: 'onebot', telegramToken: 'tok' } as any), '');
  const polling = telegramConnectionSummary({
    type: 'telegram', telegramToken: 'tok', telegramBotUsername: 'demo_bot', mode: 'polling',
  } as any);
  assert.match(polling, /@demo_bot/);
  assert.match(polling, /长轮询/);
  const hook = telegramConnectionSummary({
    type: 'telegram', telegramToken: 'tok', mode: 'webhook',
    telegramTestEnv: true, telegramApiBase: 'http://127.0.0.1:8081',
  } as any);
  assert.match(hook, /Webhook/);
  assert.match(hook, /测试环境/);
  assert.match(hook, /本地 API/);
  const official = telegramConnectionSummary({
    type: 'telegram', telegramToken: 'tok', telegramApiBase: 'https://api.telegram.org',
  } as any);
  assert.doesNotMatch(official, /本地 API/); // 官方基址不显示「本地 API」
});

// ───────────────────────── 纯函数 ─────────────────────────

test('escapeMarkdownV2：18 个特殊字符全部转义，普通文本原样', () => {
  assert.equal(escapeMarkdownV2('plain text 123'), 'plain text 123');
  assert.equal(escapeMarkdownV2(''), '');
  assert.equal(escapeMarkdownV2('a_b*c'), 'a\\_b\\*c');
  for (const ch of '_*[]()~`>#+-=|{}.!\\') {
    assert.equal(escapeMarkdownV2(ch), `\\${ch}`, `特殊字符 ${ch} 应被转义`);
  }
  assert.equal(escapeMarkdownV2('a.b!c-d=e|f{g}h'), 'a\\.b\\!c\\-d\\=e\\|f\\{g\\}h');
});

test('escapeHtml：& < > " 转义', () => {
  assert.equal(escapeHtml('<b>a & "b"</b>'), '&lt;b&gt;a &amp; &quot;b&quot;&lt;/b&gt;');
  assert.equal(escapeHtml('plain'), 'plain');
  assert.equal(escapeHtml(''), '');
});

test('normalizeTelegramApiBase：空值/非法回落官方，去尾斜杠与 /bot 尾巴', () => {
  assert.equal(normalizeTelegramApiBase(), 'https://api.telegram.org');
  assert.equal(normalizeTelegramApiBase(''), 'https://api.telegram.org');
  assert.equal(normalizeTelegramApiBase('   '), 'https://api.telegram.org');
  assert.equal(normalizeTelegramApiBase('not-a-url'), 'https://api.telegram.org');
  assert.equal(normalizeTelegramApiBase('http://127.0.0.1:8081/'), 'http://127.0.0.1:8081');
  assert.equal(normalizeTelegramApiBase('http://127.0.0.1:8081///'), 'http://127.0.0.1:8081');
  assert.equal(normalizeTelegramApiBase('https://api.telegram.org/bot123:ABC'), 'https://api.telegram.org');
});

test('buildTelegramApiUrl：官方 / 测试环境 / 本地服务器 / 空 base', () => {
  assert.equal(
    buildTelegramApiUrl('https://api.telegram.org', '123:ABC', 'sendMessage'),
    'https://api.telegram.org/bot123:ABC/sendMessage',
  );
  assert.equal(
    buildTelegramApiUrl('https://api.telegram.org', '123:ABC', 'getMe', true),
    'https://api.telegram.org/bot123:ABC/test/getMe',
  );
  assert.equal(
    buildTelegramApiUrl('http://127.0.0.1:8081/', '123:ABC', 'getUpdates'),
    'http://127.0.0.1:8081/bot123:ABC/getUpdates',
  );
  assert.equal(
    buildTelegramApiUrl('', '123:ABC', 'getMe'),
    'https://api.telegram.org/bot123:ABC/getMe',
  );
  assert.equal(
    buildTelegramApiUrl('https://api.telegram.org', '123:ABC', '/sendMessage'),
    'https://api.telegram.org/bot123:ABC/sendMessage', // 去掉方法名前导斜杠
  );
});

test('telegramUpdateType：识别各类 Update，空值回落 unknown', () => {
  assert.equal(telegramUpdateType({ update_id: 1, message: { message_id: 9 } }), 'message');
  assert.equal(telegramUpdateType({ update_id: 2, callback_query: { id: 'x' } }), 'callback_query');
  assert.equal(telegramUpdateType({ update_id: 3, inline_query: { id: 'x' } }), 'inline_query');
  assert.equal(telegramUpdateType({ update_id: 4, chat_member: {} }), 'chat_member');
  assert.equal(telegramUpdateType({ update_id: 5, message_reaction: {} }), 'message_reaction');
  assert.equal(telegramUpdateType({ update_id: 6 }), 'unknown');
  assert.equal(telegramUpdateType(null), 'unknown');
  assert.equal(telegramUpdateType('not an object'), 'unknown');
});

test('telegramUpdateToEvent：消息 → OneBot 风格事件 + telegram 标记 + raw 原生 Update + 命令解析', () => {
  const ev = telegramUpdateToEvent({
    update_id: 42,
    message: {
      message_id: 9,
      date: 1700000000,
      chat: { id: -100123, type: 'supergroup', title: '测试群' },
      from: { id: 555, is_bot: false, first_name: '小明', username: 'xiaoming' },
      text: '/ping@demo_bot hello world',
    },
  }, 'demo_bot');

  assert.equal(ev.telegram, true);
  assert.equal(ev.platform, 'telegram');
  assert.equal(ev.protocol, 'telegram');
  assert.equal(ev.post_type, 'message');
  assert.equal(ev.update_type, 'message');
  assert.equal(ev.update_id, 42);
  assert.equal(ev.chat_id, -100123);
  assert.equal(ev.chat_type, 'supergroup');
  assert.equal(ev.message_id, 9);
  assert.equal(ev.user_id, 555);
  assert.equal(ev.message_type, 'group');
  assert.equal(ev.raw_message, '/ping@demo_bot hello world');
  assert.equal(ev.command, 'ping');
  assert.equal(ev.command_args, 'hello world');
  assert.equal(ev.command_target, 'demo_bot');
  assert.ok(Array.isArray(ev.message), 'message 应是 OneBot 风格段数组');
  assert.equal((ev.message as any[])[0].type, 'text');
  assert.equal((ev.message as any[])[0].data.text, '/ping@demo_bot hello world');
  assert.equal((ev.raw as any).message.text, '/ping@demo_bot hello world', 'raw 保留原生 Update');
  assert.equal((ev.sender as any).is_bot, false);
});

test('telegramUpdateToEvent：私聊 / 非命令文本 / callback_query / inline_query', () => {
  const pv = telegramUpdateToEvent({
    update_id: 45,
    message: {
      message_id: 1, date: 1,
      chat: { id: 888, type: 'private' },
      from: { id: 555, is_bot: false },
      text: '你好',
    },
  });
  assert.equal(pv.message_type, 'private');
  assert.equal(pv.group_id, undefined);
  assert.equal(pv.chat_id, 888);
  assert.equal(pv.raw_message, '你好');
  assert.equal(pv.command, undefined);
  assert.equal(pv.telegram, true);

  const cq = telegramUpdateToEvent({
    update_id: 46,
    callback_query: {
      id: 'cq1', from: { id: 555 }, data: 'ok:1',
      message: { message_id: 9, date: 1, chat: { id: -100123, type: 'supergroup' } },
    },
  });
  assert.equal(cq.telegram, true);
  assert.equal(cq.post_type, 'notice');
  assert.equal(cq.notice_type, 'callback_query');
  assert.equal(cq.callback_query_id, 'cq1');
  assert.equal(cq.callback_data, 'ok:1');
  assert.equal(cq.chat_id, -100123);
  assert.equal((cq.raw as any).callback_query.id, 'cq1');

  const iq = telegramUpdateToEvent({
    update_id: 47,
    inline_query: { id: 'iq1', from: { id: 555 }, query: 'abc', offset: '' },
  });
  assert.equal(iq.telegram, true);
  assert.equal(iq.post_type, 'request');
  assert.equal(iq.query_id, 'iq1');
  assert.equal(iq.query, 'abc');
  assert.equal((iq.raw as any).inline_query.query, 'abc');
});

test('telegramUpdateToEvent：空/异常入参不抛错且带 telegram 标记', () => {
  const ev = telegramUpdateToEvent(null);
  assert.equal(ev.telegram, true);
  assert.equal(ev.update_type, 'unknown');
  assert.equal(ev.post_type, 'notice');
});

test('parseTelegramCommand：/cmd@bot 解析、参数、非命令返回 null', () => {
  assert.deepEqual(parseTelegramCommand('/start'), { command: 'start', args: '' });
  assert.deepEqual(parseTelegramCommand('  /ping  '), { command: 'ping', args: '' });
  assert.deepEqual(parseTelegramCommand('/start ref_123'), { command: 'start', args: 'ref_123' });
  assert.deepEqual(parseTelegramCommand('/ping@demo_bot hello world', 'demo_bot'), {
    command: 'ping', args: 'hello world', target: 'demo_bot',
  });
  assert.deepEqual(parseTelegramCommand('/help@other_bot'), { command: 'help', args: '', target: 'other_bot' });
  assert.equal(parseTelegramCommand('你好'), null);
  assert.equal(parseTelegramCommand(''), null);
  assert.equal(parseTelegramCommand('/'), null);
});

// ───────────────────────── 常量与事件通道 ─────────────────────────

test('TELEGRAM_ALL_UPDATE_TYPES：是数组且含常用与需显式订阅的类型', () => {
  assert.ok(Array.isArray(TELEGRAM_ALL_UPDATE_TYPES));
  assert.ok(TELEGRAM_ALL_UPDATE_TYPES.length > 20);
  for (const t of ['message', 'callback_query', 'inline_query', 'chat_member', 'message_reaction', 'my_chat_member']) {
    assert.ok(TELEGRAM_ALL_UPDATE_TYPES.includes(t as any), `应包含 ${t}`);
  }
});

test('TELEGRAM_WEBHOOK_PORTS：官方只允许 443/80/88/8443', () => {
  assert.ok(Array.isArray(TELEGRAM_WEBHOOK_PORTS));
  assert.deepEqual([...TELEGRAM_WEBHOOK_PORTS], [443, 80, 88, 8443]);
});

test('事件通道常量：telegram/event 与 telegram/action_result', () => {
  assert.equal(TELEGRAM_EVENT_NAME, 'telegram/event');
  assert.equal(TELEGRAM_ACTION_RESULT_NAME, 'telegram/action_result');
  assert.notEqual(TELEGRAM_EVENT_NAME, TELEGRAM_ACTION_RESULT_NAME);
});
