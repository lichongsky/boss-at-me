import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

process.env.BOSS_AT_ME_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bam-test-'));
const { parseCommand, resolveCode, isoLocal, parseLarkTime } = await import('../src/lib/poller.js');

test('parseCommand 识别三种指令', () => {
  assert.deepEqual(parseCommand('发 3'), { kind: 'send', code: '3' });
  assert.deepEqual(parseCommand(' 发送#12 '), { kind: 'send', code: '12' });
  assert.deepEqual(parseCommand('发'), { kind: 'send', code: null });
  assert.deepEqual(parseCommand('send 2'), { kind: 'send', code: '2' });
  assert.deepEqual(parseCommand('改 4 好的，\n明天给你'), { kind: 'edit', code: '4', text: '好的，\n明天给你' });
  assert.deepEqual(parseCommand('不发 5'), { kind: 'drop', code: '5' });
  assert.deepEqual(parseCommand('忽略'), { kind: 'drop', code: null });
});

test('parseCommand 识别草稿收口类指令', () => {
  assert.deepEqual(parseCommand('重发 3'), { kind: 'resend', code: '3' });
  assert.deepEqual(parseCommand('重试#3'), { kind: 'resend', code: '3' });
  assert.deepEqual(parseCommand('全部忽略'), { kind: 'dropAll' });
  assert.deepEqual(parseCommand('忽略全部'), { kind: 'dropAll' });
  assert.deepEqual(parseCommand('待确认'), { kind: 'list' });
  assert.deepEqual(parseCommand('提醒'), { kind: 'nudge' });
  assert.deepEqual(parseCommand('原因 3 自己回了'), { kind: 'reason', code: '3', text: '自己回了' });
});

test('parseCommand 不误伤普通聊天', () => {
  for (const s of ['发一下那个文档', '改天再说', '不发了吧我自己回', '好的', '', '重新发一下', '提醒我一下', '待确认下再发']) {
    assert.equal(parseCommand(s), null, s);
  }
});

test('resolveCode：省略编号仅在唯一待确认时生效；allowManual 时可重发 manual 草稿', () => {
  const st = { drafts: { 1: { status: 'pending' }, 2: { status: 'sent' }, 3: { status: 'manual' } } };
  assert.deepEqual(resolveCode(st, null), { code: '1' });
  assert.deepEqual(resolveCode(st, '1'), { code: '1' });
  assert.ok(resolveCode(st, '2').err);
  assert.deepEqual(resolveCode(st, '3', { allowManual: true }), { code: '3' });
  assert.match(resolveCode(st, null, { allowManual: true }).err, /#1、#3/);
  assert.ok(resolveCode(st, '2', { allowManual: true }).err);
  st.drafts[4] = { status: 'pending' };
  assert.match(resolveCode(st, null).err, /#1、#4/);
  assert.match(resolveCode({ drafts: {} }, null).err, /没有待确认/);
  assert.match(resolveCode({ drafts: {} }, null, { allowManual: true }).err, /可重发/);
});

test('buildPendingDigest 汇总待确认草稿', async () => {
  const { buildPendingDigest } = await import('../src/lib/poller.js');
  const text = buildPendingDigest([['5', { action: 'notify', sender: '老板', chatName: '群', created: new Date().toISOString() }]]);
  assert.match(text, /还有 1 条待确认/);
  assert.match(text, /#5/);
});

test('isoLocal 带本地时区偏移，parseLarkTime 按本地时间解析', () => {
  const d = parseLarkTime('2026-10-17 14:53');
  assert.equal(d.getHours(), 14);
  assert.equal(d.getMinutes(), 53);
  assert.match(isoLocal(d), /^2026-10-17T14:53:00[+-]\d{2}:\d{2}$/);
  assert.equal(new Date(isoLocal(d)).getTime(), d.getTime());
});

const { planP2p, unansweredTail, repliedAfter } = await import('../src/lib/poller.js');
const pm = (id, chat, t, sender = 'ou_boss') => ({ message_id: id, chat_id: chat, create_time: t, sender: { id: sender } });

test('planP2p：按会话合并，对方最后一条未满静默时间的先等待', () => {
  const now = parseLarkTime('2026-10-18 10:10');
  const { ready, waiting } = planP2p([
    pm('a2', 'c1', '2026-10-18 10:02'), pm('a1', 'c1', '2026-10-18 10:00'),
    pm('b1', 'c2', '2026-10-18 10:08'),
  ], now, 5);
  assert.equal(waiting, 1);
  assert.equal(ready.length, 1);
  assert.deepEqual(ready[0].batch.map((m) => m.message_id), ['a1', 'a2']);
  assert.equal(ready[0].target.message_id, 'a2');
  assert.equal(ready[0].kind, 'p2p');
});

test('repliedAfter：目标消息之后我发过言就算已回复', () => {
  const msg = (id, t, sender) => ({ message_id: id, create_time: t, sender: { id: sender } });
  const target = msg('a', '2026-10-18 10:00', 'ou_boss');
  assert.equal(repliedAfter([msg('x', '2026-10-18 09:59', 'ou_me'), target], target, 'ou_me'), false, '我之前发言不算');
  assert.equal(repliedAfter([target, msg('y', '2026-10-18 10:01', 'ou_me')], target, 'ou_me'), true);
  assert.equal(repliedAfter([target, msg('y', '2026-10-18 10:01', 'ou_other')], target, 'ou_me'), false, '别人发言不算');
  // 目标不在当前页时按时间兜底
  assert.equal(repliedAfter([msg('y', '2026-10-18 10:02', 'ou_me')], target, 'ou_me'), true);
  assert.equal(repliedAfter([msg('y', '2026-10-18 09:58', 'ou_me')], target, 'ou_me'), false);
});

test('unansweredTail：只留我最后一次发言之后的消息，同一分钟也按会话顺序区分', () => {
  const a1 = pm('a1', 'c', '2026-10-18 16:44');
  const a2 = pm('a2', 'c', '2026-10-18 16:44');
  const b1 = pm('b1', 'c', '2026-10-18 16:54');
  const b2 = pm('b2', 'c', '2026-10-18 16:54');
  const mine = (id, t = '2026-10-18 16:45') => pm(id, 'c', t, 'ou_me');
  const job = { batch: [a1, a2, b1, b2] };
  const ids = (xs) => xs.map((x) => x.message_id);
  assert.deepEqual(ids(unansweredTail([mine('m0', '2026-10-18 10:00'), a1, a2, b1, b2], job, 'ou_me')), ['a1', 'a2', 'b1', 'b2']);
  assert.deepEqual(ids(unansweredTail([a1, a2, mine('m1'), b1, b2], job, 'ou_me')), ['b1', 'b2']);
  assert.deepEqual(unansweredTail([a1, a2, b1, b2, mine('m2', '2026-10-18 16:54')], job, 'ou_me'), []);
  assert.deepEqual(ids(unansweredTail([], job, 'ou_me')), ['a1', 'a2', 'b1', 'b2']);
});
