import { spawnSync } from 'node:child_process';
import { KEYCHAIN_SERVICE } from './paths.js';

const SECURITY = '/usr/bin/security';

/** 写入钥匙串。通过 `security -i` 的 stdin 传值，避免 token 出现在进程参数里。 */
export function setSecret(account, value) {
  if (!/^[\x21-\x7e]+$/.test(value) || /["'\\]/.test(value)) {
    throw new Error('token 含空白、引号或非 ASCII 字符，请检查是否粘贴完整');
  }
  const p = spawnSync(SECURITY, ['-i'], {
    input: `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${account} -w ${value}\n`,
    encoding: 'utf8',
  });
  if (p.status !== 0 || getSecret(account) !== value) {
    throw new Error(`写入钥匙串失败：${p.stderr || p.stdout}`);
  }
}

export function getSecret(account) {
  const p = spawnSync(SECURITY, ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w'], {
    encoding: 'utf8',
  });
  return p.status === 0 ? p.stdout.replace(/\n$/, '') : null;
}

export function deleteSecret(account) {
  spawnSync(SECURITY, ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account], { encoding: 'utf8' });
}
