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

const { buildDraftCard, buildDoneCard } = await import('../src/lib/card.js');

test('草稿卡片：Card 2.0，表单里有可编辑草稿和发送/不发按钮；完成卡片去掉表单', () => {
  const p = { code: '7', sender: '老板', where: '@你', chatName: '项目群', time: '10-18 10:00', action: 'notify',
    original: '原文', summary: '要点', analysis: '依据', confidence: 'high', draft: '好的', link: 'https://x' };
  const card = buildDraftCard(p);
  assert.equal(card.schema, '2.0');
  const form = card.body.elements.find((e) => e.tag === 'form');
  assert.equal(form.elements[0].default_value, '好的');
  const names = JSON.stringify(form).match(/"name":"(send|drop)"/g);
  assert.deepEqual(names, ['"name":"send"', '"name":"drop"']);
  assert.equal(card.header.template, 'orange');
  const done = buildDoneCard({ ...p, status: 'sent', finalText: '好的' });
  assert.ok(!JSON.stringify(done).includes('"tag":"form"'));
  assert.equal(done.header.template, 'green');
});

test('草稿超过输入框上限时只读展示，改用文字指令', () => {
  const card = buildDraftCard({ code: '8', sender: 'a', where: '@你', summary: 's', analysis: 'a', confidence: 'low', original: 'o', draft: 'x'.repeat(1200) });
  assert.ok(!JSON.stringify(card).includes('"tag":"form"'));
});
