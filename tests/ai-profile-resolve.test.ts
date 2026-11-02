/**
 * 「当前生效档案」解析规则单测。
 *
 * 回归背景：会话上记录的档案被删掉后，界面会一直空着「选择模型」，
 * 用户以为自己选好的模型「没被记住」；反过来，若档案列表尚未加载就直接否决会话级值，
 * 首帧又会闪成「未选择」。这两条边界都要钉住。
 */
import assert from 'node:assert/strict';
import { resolveCurrentProfileId } from '../src/web/lib/ai-profile.js';

const A = 'profile-a';
const B = 'profile-b';
const known = [A, B];

// 1) 会话自己指定了档案 → 会话级优先（哪怕全局当前指向另一个）
assert.equal(resolveCurrentProfileId(A, B, known), A, '会话级应优先于全局当前');
assert.equal(resolveCurrentProfileId(B, A, known), B, '会话级应优先于全局当前（反向）');

// 2) 会话没指定 → 回落到全局当前
assert.equal(resolveCurrentProfileId('', A, known), A, '会话未指定时回落全局');
assert.equal(resolveCurrentProfileId(undefined, A, known), A, '会话字段缺失时回落全局');

// 3) 会话指定的档案已被删除 → 不能死守着不存在的 id
assert.equal(resolveCurrentProfileId('gone', A, known), A, '会话档案已删除时回落全局');

// 4) 档案列表尚未加载（空数组）→ 不否决会话级值，避免首帧闪成「未选择」
assert.equal(resolveCurrentProfileId(A, B, []), A, '列表未加载时不否决会话级值');

// 5) 两边都没有 → 空串
assert.equal(resolveCurrentProfileId('', '', known), '', '都没有时返回空串');
assert.equal(resolveCurrentProfileId(undefined, '', known), '', '字段缺失且全局为空时返回空串');

// 6) 空白与首尾空格按「未指定」/「已指定」分别处理
assert.equal(resolveCurrentProfileId('   ', A, known), A, '纯空白的会话值按未指定处理');
assert.equal(resolveCurrentProfileId(`  ${A}  `, B, known), A, '会话值去除首尾空格后参与匹配');
