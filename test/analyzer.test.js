import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

process.env.BOSS_AT_ME_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bam-test-'));
const { buildPrompt, allowedTools, childEnv } = await import('../src/lib/analyzer.js');
const { defaultConfig } = await import('../src/lib/store.js');

const cfg = {
  ...defaultConfig(),
  me: { open_id: 'ou_me', name: '小王' },
  sources: { projects: [{ path: '/tmp/svc', desc: '订单服务' }], docs: [], feishuDocs: false },
};
const msg = (id, t, name, content) => ({ message_id: id, create_time: t, sender: { name }, content, chat_id: 'oc_1', chat_name: '项目群' });

test('prompt 填入身份、时间、前后文和资料清单，无残留占位符', () => {
  const m = msg('m2', '2026-10-18 10:00', '老板', '@小王 接口好了吗');
  const ctx = [msg('m1', '2026-10-18 09:00', '同事', '之前的话'), m, msg('m3', '2026-10-18 10:05', '小王', '我看下')];
  const p = buildPrompt(cfg, { kind: 'group', target: m, batch: [m] }, ctx, new Date(2026, 9, 18, 21, 0));
  assert.match(p, /你是小王（后端研发）/);
  assert.match(p, /老板 在群「项目群」/);
  assert.match(p, /2026-10-18 21:00（周日）/);
  assert.match(p, /之前的话[\s\S]*## 之后的聊天[\s\S]*我看下/);
  assert.match(p, /\/tmp\/svc ：订单服务/);
  assert.doesNotMatch(p, /\{\{\w+\}\}/);
  assert.doesNotMatch(p, /docs \+fetch/);
});

test('只有开启飞书文档时才允许 docs +fetch，且不含任何写/发送工具', () => {
  assert.ok(!allowedTools(cfg).some((t) => t.includes('docs +fetch')));
  const tools = allowedTools({ ...cfg, sources: { ...cfg.sources, feishuDocs: true } });
  assert.ok(tools.includes('Bash(lark-cli docs +fetch:*)'));
  for (const t of tools) assert.doesNotMatch(t, /Edit|Write|send|reply|messages-send/);
});

test('子进程环境去掉父会话的 CLAUDE_CODE_* / ANTHROPIC_*，并补 PATH', () => {
  process.env.CLAUDE_CODE_SESSION_ID = 'x';
  process.env.ANTHROPIC_BASE_URL = 'http://leak';
  const env = childEnv({ ...cfg, bins: { node: '/opt/node/bin/node', lark: '/opt/lark/bin/lark-cli', claude: '/opt/c/bin/claude' } });
  assert.equal(env.CLAUDE_CODE_SESSION_ID, undefined);
  assert.equal(env.ANTHROPIC_BASE_URL, undefined);
  assert.ok(env.PATH.startsWith('/opt/lark/bin:/opt/c/bin:/opt/node/bin'));
});

test('私聊 prompt：说明连发条数，连发的几条都放进待回复区，不重复出现在前文', () => {
  const a = msg('p1', '2026-10-18 10:00', '老板', '在吗');
  const b = msg('p2', '2026-10-18 10:01', '老板', '接口什么时候好');
  const ctx = [msg('p0', '2026-10-18 09:00', '小王', '早'), a, b];
  const p = buildPrompt(cfg, { kind: 'p2p', target: b, batch: [a, b] }, ctx);
  assert.match(p, /老板 私聊了小王（连发 2 条）/);
  assert.match(p, /## 需要回复的私聊消息\n[\s\S]*在吗[\s\S]*接口什么时候好[\s\S]*## 之前的聊天/);
  const beforeSection = p.split('## 之前的聊天')[1].split('## 之后的聊天')[0];
  assert.match(beforeSection, /早/);
  assert.doesNotMatch(beforeSection, /在吗/);
});
