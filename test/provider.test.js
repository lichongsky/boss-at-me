import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

process.env.BOSS_AT_ME_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bam-test-'));
const { readCcSwitchProvider, resolveProviderEnv, writeSettingsFile, PRESETS } = await import('../src/lib/provider.js');

function makeCcSwitch({ current, rows }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-'));
  const sql = [
    'create table providers (id text, app_type text, name text, settings_config text, is_current integer);',
    ...rows.map((r) => `insert into providers values ('${r.id}', '${r.app || 'claude'}', '${r.name}', '${JSON.stringify(r.settings).replace(/'/g, "''")}', ${r.current ? 1 : 0});`),
  ].join('\n');
  const p = spawnSync('/usr/bin/sqlite3', [path.join(dir, 'cc-switch.db')], { input: sql, encoding: 'utf8' });
  assert.equal(p.status, 0, p.stderr);
  if (current !== undefined) fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ currentProviderClaude: current }));
  return dir;
}

const gw = { env: { ANTHROPIC_BASE_URL: 'https://gw.example.com', ANTHROPIC_AUTH_TOKEN: 'tok-a', ANTHROPIC_MODEL: 'm1', enableWorkflows: 'x' }, hooks: {} };

test('CC Switch：优先 settings.json 的 currentProviderClaude，只取模型相关 env', () => {
  const dir = makeCcSwitch({
    current: 'b',
    rows: [
      { id: 'a', name: 'A', settings: { env: { ANTHROPIC_BASE_URL: 'https://a.example.com', ANTHROPIC_AUTH_TOKEN: 'x' } }, current: true },
      { id: 'b', name: 'B', settings: gw },
      { id: 'b', app: 'codex', name: 'B-codex', settings: {} },
    ],
  });
  const p = readCcSwitchProvider(dir);
  assert.equal(p.name, 'B');
  assert.deepEqual(p.env, { ANTHROPIC_BASE_URL: 'https://gw.example.com', ANTHROPIC_AUTH_TOKEN: 'tok-a', ANTHROPIC_MODEL: 'm1' });
});

test('CC Switch：没有 settings.json 时回退 is_current', () => {
  const dir = makeCcSwitch({ rows: [{ id: 'a', name: 'A', settings: gw, current: true }, { id: 'b', name: 'B', settings: {} }] });
  assert.equal(readCcSwitchProvider(dir).name, 'A');
});

test('CC Switch：指向本地代理时报错，避免依赖 CC Switch 进程', () => {
  const dir = makeCcSwitch({ current: 'a', rows: [{ id: 'a', name: 'P', settings: { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:15721' } } }] });
  assert.throws(() => readCcSwitchProvider(dir), /本地代理/);
});

test('gateway：token 来自钥匙串，模型写满各档，并清空 API_KEY', () => {
  const { env, label } = resolveProviderEnv(
    { type: 'gateway', name: 'GLM', baseUrl: 'https://open.bigmodel.cn/api/anthropic', model: 'glm-x', env: { API_TIMEOUT_MS: '3000000' } },
    { secret: () => 'sk-test' },
  );
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'sk-test');
  assert.equal(env.ANTHROPIC_API_KEY, '');
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'glm-x');
  assert.equal(env.API_TIMEOUT_MS, '3000000');
  assert.match(label, /GLM/);
});

test('缺 token 时给出可操作的报错', () => {
  assert.throws(() => resolveProviderEnv({ type: 'gateway', baseUrl: 'https://x' }, { secret: () => null }), /setup --step provider/);
  assert.throws(() => resolveProviderEnv(null), /setup/);
});

test('anthropic-login 不注入任何 env', () => {
  assert.deepEqual(resolveProviderEnv({ type: 'anthropic-login' }).env, {});
});

test('settings 临时文件权限 0600，cleanup 后删除', () => {
  const s = writeSettingsFile({ A: '1' });
  assert.equal(fs.statSync(s.file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(s.file, 'utf8')), { env: { A: '1' } });
  s.cleanup();
  assert.equal(fs.existsSync(s.file), false);
});

test('预设都有 https 地址和默认模型', () => {
  for (const p of PRESETS) {
    assert.match(p.baseUrl, /^https:\/\//, p.id);
    assert.ok(p.model, p.id);
    assert.ok(p.keyUrl, p.id);
  }
});
