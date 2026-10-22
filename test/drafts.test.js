import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bam-test-'));
process.env.BOSS_AT_ME_HOME = home;
const store = await import('../src/lib/store.js');
const { handleDmMessage, executeDraft, buildPendingDigest } = await import('../src/lib/poller.js');

test('0.3.x 的草稿从 state.json 迁移到 drafts.json', () => {
  fs.writeFileSync(path.join(home, 'state.json'), JSON.stringify({
    lastSearchEnd: 'x', seen: {}, drafts: { 1: { status: 'pending' } }, nextCode: 2, dmChatId: 'oc_dm', dmSeen: ['m0'],
  }));
  const d = store.loadDrafts();
  assert.deepEqual(d.drafts, { 1: { status: 'pending' } });
  assert.equal(d.nextCode, 2);
  assert.equal(d.dmChatId, 'oc_dm');
  assert.deepEqual(d.dmSeen, ['m0']);
  assert.ok(d.usage, '迁移后带默认 usage');
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

test('usage：跨天/跨月归零，bumpUsage 累加数字字段', () => {
  const old = {
    ...store.defaultUsage(),
    month: '2020-01', day: '2020-01-01',
    monthAnalyses: 5, monthCost: 1.5, monthSent: 3, monthDropped: 2, monthExpired: 1,
    dayAnalyses: 2, dayCost: 0.3,
  };
  const u = store.rollUsage(old);
  assert.equal(u.monthAnalyses, 0);
  assert.equal(u.monthCost, 0);
  assert.equal(u.monthSent, 0);
  assert.equal(u.monthDropped, 0);
  assert.equal(u.monthExpired, 0);
  assert.equal(u.dayAnalyses, 0);
  assert.equal(u.dayCost, 0);
  const d = { drafts: {} };
  store.bumpUsage(d, { monthAnalyses: 1, monthCost: 0.4 });
  store.bumpUsage(d, { monthAnalyses: 1, monthCost: 0.2 });
  assert.equal(d.usage.monthAnalyses, 2);
  assert.ok(Math.abs(d.usage.monthCost - 0.6) < 1e-9);
  assert.equal(d.usage.monthSent, 0);
});

test('handleDmMessage：同一条指令只处理一次；seedOnly 只记录不执行', () => {
  const cfg = { me: { open_id: 'ou_me' }, reply: { signature: '' } };
  const d = { drafts: { 5: { status: 'pending', draft: '好的', messageId: 'om_t' } }, nextCode: 6, dmChatId: 'oc', dmSeen: [], usage: store.defaultUsage() };
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

test('全部忽略：一次清空所有待确认草稿，不影响已发送的', () => {
  const cfg = { me: { open_id: 'ou_me' }, reply: { signature: '' } };
  const d = {
    drafts: {
      1: { status: 'pending', draft: 'a' },
      2: { status: 'pending', draft: 'b' },
      3: { status: 'sent', draft: 'c' },
    },
    dmSeen: [], usage: store.defaultUsage(),
  };
  handleDmMessage(cfg, d, { message_id: 'm1', sender: { id: 'ou_me' }, msg_type: 'text', content: '全部忽略' }, { dry: true });
  assert.equal(d.drafts[1].status, 'dropped');
  assert.equal(d.drafts[2].status, 'dropped');
  assert.equal(d.drafts[3].status, 'sent');
  assert.equal(d.usage.monthDropped, 2);
});

test('原因：记录忽略原因到 usage.dropReasons', () => {
  const cfg = { me: { open_id: 'ou_me' }, reply: {} };
  const d = { drafts: { 1: { status: 'dropped' } }, dmSeen: [], usage: store.defaultUsage() };
  handleDmMessage(cfg, d, { message_id: 'r1', sender: { id: 'ou_me' }, msg_type: 'text', content: '原因 1 自己回了' }, { dry: true });
  handleDmMessage(cfg, d, { message_id: 'r2', sender: { id: 'ou_me' }, msg_type: 'text', content: '原因 1 不用' }, { dry: true });
  assert.equal(d.usage.dropReasons['自己回了'], 1);
  assert.equal(d.usage.dropReasons['不用回'], 1);
});

test('executeDraft：快捷选项按 text 发送并带署名；重发 manual 草稿用 sentText', () => {
  const cfg = { me: { open_id: 'ou_me' }, reply: { signature: '\n（AI 起草）' } };
  const d = {
    drafts: {
      1: { status: 'pending', draft: '好的', messageId: 'om_1' },
      2: { status: 'manual', draft: '原草稿', sentText: '原草稿\n（AI 起草）', messageId: 'om_2' },
    },
    usage: store.defaultUsage(),
  };
  const opt = executeDraft(cfg, d, '1', { kind: 'send', text: '今天给' }, { dry: true });
  assert.equal(opt.final, '今天给\n（AI 起草）');
  const resend = executeDraft(cfg, d, '2', { kind: 'resend' }, { dry: true });
  assert.equal(resend.final, '原草稿\n（AI 起草）');
  const drop = executeDraft(cfg, d, '1', { kind: 'drop' }, { dry: true, ackText: false });
  assert.equal(drop.status, 'dropped');
  assert.equal(d.usage.monthDropped, 1);
});

test('buildPendingDigest 列出编号、来源和年龄', () => {
  const now = new Date('2026-10-21T12:00:00+08:00').getTime();
  const text = buildPendingDigest([
    ['7', { action: 'notify', sender: '老板', chatName: '项目群', created: '2026-10-21T08:00:00+08:00' }],
    ['8', { action: 'reply', sender: '同事', chatName: '另一个群', created: '2026-10-21T11:30:00+08:00' }],
  ], now);
  assert.match(text, /还有 2 条待确认/);
  assert.match(text, /#7 需你处理 · 老板 · 项目群 · 4\.0h/);
  assert.match(text, /#8 草稿 · 同事 · 另一个群 · 刚刚/);
  assert.match(text, /全部忽略/);
});

const { buildDraftCard, buildDoneCard } = await import('../src/lib/card.js');

test('草稿卡片：Card 2.0，表单里有可编辑草稿和发送/不发按钮；完成卡片去掉表单', () => {
  const p = { code: '7', sender: '老板', where: '@你', chatName: '项目群', time: '10-18 10:00', action: 'notify',
    original: '原文', summary: '要点', analysis: '依据', confidence: 'high', draft: '好的', link: 'https://x' };
  const card = buildDraftCard(p);
  assert.equal(card.schema, '2.0');
  const form = card.body.elements.find((e) => e.tag === 'form');
  assert.equal(form.elements[0].default_value, '好的');
  assert.equal(form.elements[0].required, false, '不强制填输入框，没有草稿时也能点不发');
  const names = JSON.stringify(form).match(/"name":"(send|drop)"/g);
  assert.deepEqual(names, ['"name":"send"', '"name":"drop"']);
  assert.equal(card.header.template, 'orange');
  const done = buildDoneCard({ ...p, status: 'sent', finalText: '好的' });
  assert.ok(!JSON.stringify(done).includes('"tag":"form"'));
  assert.equal(done.header.template, 'green');
});

test('草稿卡片：快捷回复选项生成 opt_N 按钮，可疑指令/无依据给出警示', () => {
  const card = buildDraftCard({
    code: '9', sender: '老板', where: '@你', summary: 's', analysis: 'a', confidence: 'low', original: 'o',
    draft: '好的', options: ['今天给', '明天给', '我先确认下'], suspicious: true, evidence: false,
  });
  const form = card.body.elements.find((e) => e.tag === 'form');
  const names = JSON.stringify(form).match(/"name":"(opt_\d|send|drop)"/g);
  assert.deepEqual(names, ['"name":"opt_0"', '"name":"opt_1"', '"name":"opt_2"', '"name":"send"', '"name":"drop"']);
  const all = JSON.stringify(card);
  assert.match(all, /指令注入/);
  assert.match(all, /没有引用具体/);
});

test('草稿超过输入框上限时只读展示，改用文字指令', () => {
  const card = buildDraftCard({ code: '8', sender: 'a', where: '@你', summary: 's', analysis: 'a', confidence: 'low', original: 'o', draft: 'x'.repeat(1200) });
  assert.ok(!JSON.stringify(card).includes('"tag":"form"'));
});
