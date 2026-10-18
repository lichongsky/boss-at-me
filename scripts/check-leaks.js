#!/usr/bin/env node
// 发布前检查：打包内容里不能出现个人 / 公司信息。
// 通用规则写在这里；公司名、内部域名等私有关键词写在 .leakwords（每行一个正则，已 gitignore，不进仓库）。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const patterns = [
  /ou_[0-9a-f]{20,}/, // 飞书 open_id
  /oc_[0-9a-f]{20,}/, // 飞书 chat_id
  /om_[0-9a-z]{20,}/, // 飞书 message_id
  /cli_[0-9a-f]{12,}/, // 飞书 App ID
  /sk-[A-Za-z0-9_-]{16,}/, // 常见 API key
  /\/Users\/(?!<)[A-Za-z0-9._-]+\//, // 本机绝对路径
];
const extra = path.join(root, '.leakwords');
if (fs.existsSync(extra)) {
  for (const line of fs.readFileSync(extra, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)) patterns.push(new RegExp(line, 'i'));
}

const files = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' }))[0].files.map((f) => f.path);
let hits = 0;
for (const f of files) {
  const lines = fs.readFileSync(path.join(root, f), 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const re of patterns) {
      if (re.test(line)) {
        hits++;
        console.log(`${f}:${i + 1}  命中 ${re}  ${line.trim().slice(0, 120)}`);
      }
    }
  });
}
console.log(hits ? `\n✘ 发现 ${hits} 处疑似泄漏（共检查 ${files.length} 个文件）` : `✔ 未发现泄漏（共检查 ${files.length} 个文件，规则 ${patterns.length} 条）`);
process.exit(hits ? 1 : 0);
