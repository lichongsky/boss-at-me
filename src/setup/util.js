import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const c = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

export const ok = (s) => console.log(`${c.green('✔')} ${s}`);
export const warn = (s) => console.log(`${c.yellow('!')} ${s}`);
export const fail = (s) => console.log(`${c.red('✘')} ${s}`);
export const info = (s) => console.log(`  ${s}`);
export const title = (n, total, s) => console.log(`\n${c.bold(c.cyan(`[${n}/${total}] ${s}`))}`);

/** 找到命令的稳定绝对路径：解析目录层的符号链接（例如 fnm 的临时 multishell 目录），但保留文件名本身。 */
export function which(bin) {
  const p = spawnSync('/bin/sh', ['-lc', `command -v ${bin}`], { encoding: 'utf8' });
  const found = p.status === 0 ? p.stdout.trim().split('\n').pop() : '';
  if (!found || !found.startsWith('/')) return null;
  try {
    return path.join(fs.realpathSync(path.dirname(found)), path.basename(found));
  } catch {
    return found;
  }
}

export function expandHome(p) {
  return p.replace(/^~(?=$|\/)/, os.homedir());
}

export function openUrl(url) {
  spawnSync('/usr/bin/open', [url]);
}

export function firstUrl(text, re = /https?:\/\/[^\s"'<>]+/) {
  return (text.match(re) || [])[0] || null;
}

/** 给目录生成一句默认说明：README 第一行有效文字 > package.json description > 空 */
export function guessDescription(dir) {
  for (const f of ['README.md', 'readme.md', 'README.zh.md', 'README']) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) continue;
    const line = fs.readFileSync(p, 'utf8').split('\n').map((l) => l.replace(/^[#>\s*-]+/, '').trim())
      .find((l) => l && !l.startsWith('[!') && !l.startsWith('<'));
    if (line) return line.slice(0, 80);
  }
  try {
    const d = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).description;
    if (d) return d.slice(0, 80);
  } catch {
    // ignore
  }
  return '';
}

export function runInherit(cmd, args) {
  return spawnSync(cmd, args, { stdio: 'inherit' }).status === 0;
}
