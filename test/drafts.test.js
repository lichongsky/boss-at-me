import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bam-test-'));
process.env.BOSS_AT_ME_HOME = home;
const store = await import('../src/lib/store.js');
const { handleDmMessage } = await import('../src/lib/poller.js');

test('0.3.x 的草稿从 state.json 迁移到 drafts.json', () => {
  fs.writeFileSync(path.join(home, 'state.json'), JSON.stringify({
    lastSearchEnd: 'x', seen: {}, drafts: { 1: { status: 'pending' } }, nextCode: 2, dmChatId: 'oc_dm', dmSeen: ['m0'],
  }));
  const d = store.loadDrafts();
  assert.deepEqual(d, { drafts: { 1: { status: 'pending' } }, nextCode: 2, dmChatId: 'oc_dm', dmSeen: ['m0'] });
  store.withDrafts((x) => {
    x.nextCode++;
  });
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'drafts.json'), 'utf8')).nextCode, 3);
  assert.equal(fs.existsSync(path.join(home, '.drafts.lock')), false, '用完释放锁');
});

test('withDrafts：残留的死锁文件会被清理，异常时也释放锁', () => {
  fs.writeFileSync(path.join(home, '.drafts.lock'), '999999'); // 不存在的 pid
  store.withDrafts(() => {});
  assert.throws(() => store.withDrafts(() => {
    throw new Error('boom');
  }), /boom/);
  assert.equal(fs.existsSync(path.join(home, '.drafts.lock')), false);
});

test('handleDmMessage：同一条指令只处理一次；seedOnly 只记录不执行', () => {
  const cfg = { me: { open_id: 'ou_me' }, reply: { signature: '' } };
  const d = { drafts: { 5: { status: 'pending', draft: '好的', messageId: 'om_t' } }, nextCode: 6, dmChatId: 'oc', dmSeen: [] };
  const msg = { message_id: 'om_cmd', sender: { id: 'ou_me' }, msg_type: 'text', content: '不发 5' };
  handleDmMessage(cfg, d, msg, { seedOnly: true, dry: true });
  assert.equal(d.drafts[5].status, 'pending');
  assert.deepEqual(d.dmSeen, ['om_cmd']);
  handleDmMessage(cfg, d, { ...msg, message_id: 'om_cmd2' }, { dry: true });
  assert.equal(d.drafts[5].status, 'dropped');
  d.drafts[5].status = 'pending';
  handleDmMessage(cfg, d, { ...msg, message_id: 'om_cmd2' }, { dry: true }); // 重复投递
  assert.equal(d.drafts[5].status, 'pending');
});

test('handleDmMessage：忽略别人发的和非文本消息', () => {
  const cfg = { me: { open_id: 'ou_me' }, reply: {} };
  const d = { drafts: { 1: { status: 'pending', draft: 'x' } }, nextCode: 2, dmSeen: [] };
  handleDmMessage(cfg, d, { message_id: 'a', sender: { id: 'ou_other' }, msg_type: 'text', content: '不发 1' }, { dry: true });
  handleDmMessage(cfg, d, { message_id: 'b', sender: { id: 'ou_me' }, msg_type: 'image', content: '不发 1' }, { dry: true });
  assert.equal(d.drafts[1].status, 'pending');
});
