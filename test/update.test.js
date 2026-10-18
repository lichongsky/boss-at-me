import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

process.env.BOSS_AT_ME_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bam-test-'));
const { compareVersions, releasesBetween, formatNotes, REPO, RELEASES, CURRENT_VERSION } = await import('../src/lib/update.js');

test('compareVersions 按数字比较', () => {
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('v1.2.0', '1.2'), 0);
  assert.equal(compareVersions('1.2.3', '1.3.0'), -1);
});

test('releasesBetween 取 (from, to]，升序', () => {
  const rs = [{ version: '0.3.0' }, { version: '0.1.0' }, { version: '0.2.0' }, { version: '0.4.0' }];
  assert.deepEqual(releasesBetween(rs, '0.1.0', '0.3.0').map((r) => r.version), ['0.2.0', '0.3.0']);
});

test('formatNotes 列出说明和需要重跑的步骤', () => {
  const s = formatNotes([{ version: '0.3.0', notes: ['新功能'], steps: ['sources'] }]);
  assert.match(s, /v0\.3\.0/);
  assert.match(s, /· 新功能/);
  assert.match(s, /setup --step sources/);
});

test('仓库地址从 package.json 解析成 owner/repo', () => {
  assert.match(REPO, /^[\w.-]+\/[\w.-]+$/);
});

test('releases.json 包含当前版本，步骤名都是合法的 setup 步骤', async () => {
  assert.ok(RELEASES.some((r) => r.version === CURRENT_VERSION), '发版前在 src/releases.json 里写上当前版本说明');
  const { STEP_IDS } = await import('../src/commands/setup.js');
  for (const r of RELEASES) for (const s of r.steps || []) assert.ok(STEP_IDS.includes(s), `${r.version}: ${s}`);
});
