import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

process.env.BOSS_AT_ME_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bam-test-'));
const lark = await import('../src/lib/lark.js');

// 假的 lark-cli：按第一个参数决定输出和退出码
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-lark-'));
const bin = path.join(dir, 'lark-cli');
fs.writeFileSync(bin, `#!/bin/sh
case "$1" in
  ok) echo '{"ok":true,"data":{"messages":[{"message_id":"m1"}]}}' ;;
  bizfail) echo '{"ok":false,"error":{"message":"denied"}}'; exit 0 ;;
  scope) echo '{"ok":false,"error":{"type":"auth","subtype":"missing_scope","missing_scopes":["im:message.send_as_user"]}}' >&2; exit 3 ;;
  auth) echo '{"ok":false,"granted":["a"],"missing":["b"]}'; exit 1 ;;
  whoami) echo '{"onBehalfOf":{"userName":"小王","openId":"ou_x"}}' ;;
  env) echo "{\\"ok\\":true,\\"data\\":{\\"v\\":\\"$LARKSUITE_CLI_NO_UPDATE_NOTIFIER\\"}}" ;;
esac
`, { mode: 0o755 });
lark.setLarkBin(bin);

test('成功时返回解析后的 JSON，并关闭更新提示', () => {
  assert.equal(lark.lark(['ok']).data.messages[0].message_id, 'm1');
  assert.equal(lark.lark(['env']).data.v, '1');
});

test('ok:false 即使退出码 0 也抛错', () => {
  assert.throws(() => lark.lark(['bizfail']), /denied/);
});

test('退出码非 0 时从 stderr 取错误，暴露 missingScopes', () => {
  try {
    lark.lark(['scope']);
    assert.fail('should throw');
  } catch (e) {
    assert.equal(e.exitCode, 3);
    assert.deepEqual(e.missingScopes, ['im:message.send_as_user']);
  }
});

test('authCheck 解析 granted / missing', () => {
  // authCheck 固定传 auth check …，假脚本按 $1=auth 响应
  assert.deepEqual(lark.authCheck(['a', 'b']), { ok: false, granted: ['a'], missing: ['b'] });
});

test('whoami 取 open_id 和姓名', () => {
  assert.deepEqual(lark.whoami(), { open_id: 'ou_x', name: '小王' });
});
