/**
 * 回归测试：Telegram 上报预览必须覆盖全部消息/事件类型。
 *
 * 旧实现只在 dispatch 里取 text / callback_query.data，导致图片、语音、贴纸、
 * 位置、名片、群服务消息、成员变动、表情回应等全部留白——监控页里只有纯文本能看。
 * 本测试断言 formatTelegramUpdate 对每种类型都产出带类型标签的可读预览，不再空白。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatTelegramUpdate } from '../src/connection/telegram.types.js';

function upd(id: number, body: Record<string, unknown>): unknown {
  return { update_id: id, ...body };
}

function msg(over: Record<string, unknown>): Record<string, unknown> {
  return {
    message_id: 1,
    date: 0,
    chat: { id: -100, type: 'group', title: '测试群' },
    from: { id: 42, first_name: '小明', username: 'xiaoming' },
    ...over,
  };
}

const cases: Array<{ name: string; update: unknown; mustInclude: string }> = [
  { name: '纯文本', update: upd(1, { message: msg({ text: '你好世界' }) }), mustInclude: '你好世界' },
  { name: '图片+配文', update: upd(2, { message: msg({ photo: [{ file_id: 'x' }], caption: '看这张' }) }), mustInclude: '[图片]' },
  { name: '视频', update: upd(3, { message: msg({ video: { file_id: 'v' } }) }), mustInclude: '[视频]' },
  { name: '圆形视频', update: upd(4, { message: msg({ video_note: { file_id: 'vn' } }) }), mustInclude: '[圆形视频]' },
  { name: '语音', update: upd(5, { message: msg({ voice: { file_id: 'vo' } }) }), mustInclude: '[语音]' },
  { name: '音频', update: upd(6, { message: msg({ audio: { file_id: 'au', title: '歌' } }) }), mustInclude: '[音频]' },
  { name: '文件', update: upd(7, { message: msg({ document: { file_id: 'd', file_name: 'a.pdf' } }) }), mustInclude: '[文件' },
  { name: '动画', update: upd(8, { message: msg({ animation: { file_id: 'an' } }) }), mustInclude: '[动画]' },
  { name: '贴纸', update: upd(9, { message: msg({ sticker: { file_id: 's', emoji: '😀' } }) }), mustInclude: '[贴纸' },
  { name: '位置', update: upd(10, { message: msg({ location: { latitude: 1, longitude: 2 } }) }), mustInclude: '[位置]' },
  { name: '地点', update: upd(11, { message: msg({ venue: { title: '咖啡店', address: 'xx路' } }) }), mustInclude: '[地点' },
  { name: '联系人', update: upd(12, { message: msg({ contact: { first_name: '小红', phone_number: '123' } }) }), mustInclude: '[联系人' },
  { name: '投票', update: upd(13, { message: msg({ poll: { question: '几点?', options: [] } }) }), mustInclude: '[投票]' },
  { name: '骰子', update: upd(14, { message: msg({ dice: { emoji: '🎲', value: 4 } }) }), mustInclude: '[骰子' },
  { name: '游戏', update: upd(15, { message: msg({ game: { title: '飞行棋' } }) }), mustInclude: '[游戏' },
  { name: '商品', update: upd(16, { message: msg({ invoice: { title: '会员' } }) }), mustInclude: '[商品' },
  { name: '支付成功', update: upd(17, { message: msg({ successful_payment: { currency: 'XTR' } }) }), mustInclude: '[支付成功]' },
  { name: '转发', update: upd(18, { message: msg({ text: '转发的', forward_from: { id: 9, first_name: '他人' } }) }), mustInclude: '[转发]' },
  { name: '回复', update: upd(19, { message: msg({ text: '回复内容', reply_to_message: { message_id: 7 } }) }), mustInclude: '[回复]' },
  { name: '新成员', update: upd(20, { message: msg({ new_chat_members: [{ id: 5, first_name: '阿强' }] }) }), mustInclude: '[新成员' },
  { name: '退群', update: upd(21, { message: msg({ left_chat_member: { id: 6, first_name: '阿离' } }) }), mustInclude: '[退群' },
  { name: '改群名', update: upd(22, { message: msg({ new_chat_title: '新群名' }) }), mustInclude: '[改群名' },
  { name: '置顶消息', update: upd(23, { message: msg({ pinned_message: msg({ text: '置顶' }) }) }), mustInclude: '[置顶消息]' },
  { name: '群服务·创建群', update: upd(24, { message: msg({ group_chat_created: true }) }), mustInclude: '[创建群]' },
  { name: '频道消息', update: upd(25, { channel_post: msg({ text: '频道说', chat: { id: -200, type: 'channel', title: '官频' } }) }), mustInclude: '频道' },
  { name: '编辑消息', update: upd(26, { edited_message: msg({ text: '改过了' }) }), mustInclude: '✎' },
  { name: '私聊', update: upd(27, { message: msg({ text: '私信', chat: { id: 42, type: 'private', first_name: '小明', username: 'xiaoming' } }) }), mustInclude: '私聊' },
  {
    name: '回调查询',
    update: upd(28, { callback_query: { id: 'c1', from: { id: 42, first_name: '小明' }, data: 'ACT:1' } }),
    mustInclude: '[回调数据]',
  },
  {
    name: '内联查询',
    update: upd(29, { inline_query: { id: 'q1', from: { id: 42, first_name: '小明' }, query: '搜' } }),
    mustInclude: '[查询]',
  },
  {
    name: '成员变动',
    update: upd(30, {
      chat_member: {
        chat: { id: -100, type: 'group', title: '测试群' },
        from: { id: 42, first_name: '小明' },
        old_chat_member: { status: 'member' },
        new_chat_member: { status: 'administrator' },
      },
    }),
    mustInclude: 'member → administrator',
  },
  {
    name: '表情回应',
    update: upd(31, {
      message_reaction: {
        chat: { id: -100, type: 'group', title: '测试群' },
        user: { id: 42, first_name: '小明' },
        new_reaction: [{ emoji: '👍' }, { type: 'custom_emoji', custom_emoji_id: 'x' }],
      },
    }),
    mustInclude: '👍',
  },
  {
    name: '投票事件',
    update: upd(32, { poll: { question: '喜欢哪款?', type: 'regular' } }),
    mustInclude: '[投票]',
  },
];

test('formatTelegramUpdate 覆盖全部消息/事件类型且不留白', () => {
  for (const c of cases) {
    const out = formatTelegramUpdate(c.update, 'mybot');
    assert.ok(typeof out.message === 'string', `${c.name}: message 应为字符串`);
    assert.ok(out.message.trim().length > 0, `${c.name}: 预览不应为空白`);
    assert.ok(out.message.includes(c.mustInclude), `${c.name}: 预览应包含「${c.mustInclude}」，实际：${out.message}`);
    assert.ok(typeof out.raw === 'string' && out.raw.includes('update_id'), `${c.name}: raw 应保留原 Update`);
  }
});

test('纯媒体无文本时不退化为空括号', () => {
  const out = formatTelegramUpdate(upd(100, { message: msg({ photo: [{ file_id: 'x' }] }) }), 'mybot');
  assert.ok(out.message.includes('[图片]'), '应带 [图片] 标签');
  assert.ok(!out.message.includes('(非文本)'), '纯媒体不应显示 (非文本) 兜底');
});
