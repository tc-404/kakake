/**
 * 会话存储 JSONL 迁移单测：
 *  1) 旧 <id>.json 单文件会话在首次访问时自动迁移为 <id>.jsonl（首行 meta、每行一条消息），
 *     旧文件改名 <id>.json.migrated（防重复迁移，保留原始字节供人工恢复）；
 *  2) 迁移后可继续追加消息，新消息进 .jsonl；
 *  3) 旧 .json 与新 .jsonl 并存（模拟迁移中途崩溃）时以 .jsonl 为准，旧文件被归置；
 *  4) meta 更新走 sidecar，getSession 读到一致状态；列表与删除覆盖全部文件形态。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  createSession, deleteSession, getSession, listSessions, updateSessionMeta, appendMessage,
  type AiSession,
} from '../src/ai/ai-session.js';
import { PATHS } from '../src/paths.js';

const SESSIONS_DIR = path.join(PATHS.data, 'ai', 'sessions');
const madeIds: string[] = [];

/** 直接落一个旧格式会话文件（绕过新存储层，模拟历史进程写下的数据） */
function writeLegacy(id: string, messages: AiSession['messages'], withProfile = true): void {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const s = {
    id, title: '旧会话标题', profileId: withProfile ? 'legacy-profile' : '',
    createdAt: 1111, updatedAt: 2222, status: 'idle', messages,
  };
  fs.writeFileSync(path.join(SESSIONS_DIR, `${id}.json`), JSON.stringify(s), 'utf-8');
}

const mkMsg = (content: string) => ({ role: 'user' as const, content, time: 1 });

try {
  // ── 1) 旧 json 会话自动迁移 + 继续追加 ──
  {
    const id = 'legacy-migrate-basic';
    madeIds.push(id);
    writeLegacy(id, [mkMsg('历史消息一'), mkMsg('历史消息二')]);

    const s = getSession(id);
    assert.ok(s, '旧格式会话应能读到');
    assert.equal(s.title, '旧会话标题');
    assert.deepEqual(s.messages.map((m) => m.content), ['历史消息一', '历史消息二'], '迁移不丢消息');

    assert.equal(fs.existsSync(path.join(SESSIONS_DIR, `${id}.jsonl`)), true, '已生成 .jsonl');
    assert.equal(fs.existsSync(path.join(SESSIONS_DIR, `${id}.meta.json`)), true, '已生成 meta sidecar');
    assert.equal(fs.existsSync(path.join(SESSIONS_DIR, `${id}.json`)), false, '旧 .json 已改名');
    assert.equal(fs.existsSync(path.join(SESSIONS_DIR, `${id}.json.migrated`)), true, '旧文件保留为 .json.migrated');

    const jsonl = fs.readFileSync(path.join(SESSIONS_DIR, `${id}.jsonl`), 'utf-8');
    const lines = jsonl.split('\n').filter((l) => l.trim());
    assert.equal(lines.length, 3, '首行 meta + 两行消息');
    const metaLine = JSON.parse(lines[0]);
    assert.equal(metaLine.id, id, '首行为 meta');
    assert.equal(metaLine.role, undefined, 'meta 行不含消息字段');
    assert.deepEqual(JSON.parse(lines[1]).content, '历史消息一', '消息逐行存放');

    // 迁移后继续追加：新消息进 .jsonl，读取顺序保持
    appendMessage(id, mkMsg('迁移后新消息'));
    const after = getSession(id);
    assert.deepEqual(after?.messages.map((m) => m.content), ['历史消息一', '历史消息二', '迁移后新消息'], '追加语义不变');

    // 防重复迁移：再次读取不重建、不报错，migrated 备份原样保留
    const backupBefore = fs.statSync(path.join(SESSIONS_DIR, `${id}.json.migrated`)).mtimeMs;
    getSession(id);
    getSession(id);
    assert.equal(fs.statSync(path.join(SESSIONS_DIR, `${id}.json.migrated`)).mtimeMs, backupBefore, '备份未被再次触碰');
    assert.equal(getSession(id)?.messages.length, 3, '重复访问读取稳定');
  }

  // ── 2) 迁移中途崩溃现场：.json 与 .jsonl 并存 → 以 .jsonl 为准并归置旧文件 ──
  {
    const id = 'legacy-migrate-crash';
    madeIds.push(id);
    writeLegacy(id, [mkMsg('旧数据')]);
    // 伪造一份已迁移完成但旧文件没来得及改名的现场（.jsonl 内容比 .json 新）
    fs.writeFileSync(
      path.join(SESSIONS_DIR, `${id}.jsonl`),
      `${JSON.stringify({ id, title: '新格式', profileId: 'p', createdAt: 1, updatedAt: 2, status: 'idle' })}\n${JSON.stringify(mkMsg('新数据'))}\n`,
      'utf-8',
    );
    const s = getSession(id);
    assert.deepEqual(s?.messages.map((m) => m.content), ['新数据'], '并存时以 .jsonl 为准');
    assert.equal(fs.existsSync(path.join(SESSIONS_DIR, `${id}.json.migrated`)), true, '残留旧文件被归置为备份');
    assert.equal(s?.title, '新格式', 'meta 取自 .jsonl 首行');
  }

  // ── 3) meta 更新走 sidecar：改名/状态对 getSession 与 listSessions 一致可见 ──
  {
    const sess = createSession('迁移-meta-测试', 'p-meta');
    madeIds.push(sess.id);
    appendMessage(sess.id, mkMsg('第一条'));
    updateSessionMeta(sess.id, { title: '改名后的标题', status: 'error' });
    const s = getSession(sess.id);
    assert.equal(s?.title, '改名后的标题', '标题更新即时可见');
    assert.equal(s?.status, 'error', '状态更新即时可见');
    assert.equal(s?.messages.length, 1, 'meta 更新不动消息');
    const listed = listSessions().find((x) => x.id === sess.id);
    assert.equal(listed?.title, '改名后的标题', '列表读到 sidecar meta');
    assert.equal(listed?.status, 'error');
  }

  // ── 4) 删除清理全部文件形态（.jsonl / sidecar / 残留旧格式）──
  {
    const id = 'legacy-migrate-delete';
    madeIds.push(id);
    writeLegacy(id, [mkMsg('待删除')]);
    getSession(id); // 触发迁移
    appendMessage(id, mkMsg('再补一条'));
    assert.equal(deleteSession(id), true, '删除成功');
    for (const suffix of ['.jsonl', '.meta.json', '.json', '.json.migrated']) {
      assert.equal(fs.existsSync(path.join(SESSIONS_DIR, `${id}${suffix}`)), false, `删除后不留 ${suffix}`);
    }
    assert.equal(deleteSession(id), false, '再删返回 false（与旧语义一致）');
    madeIds.pop(); // 已清理，避免 finally 重复删
  }
} finally {
  for (const id of madeIds) { try { deleteSession(id); } catch { /* ignore */ } }
}

console.log('会话 JSONL 迁移 4 项场景全部通过');
