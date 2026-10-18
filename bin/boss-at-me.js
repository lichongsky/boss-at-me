#!/usr/bin/env node
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

const HELP = `boss-at-me ${version}
飞书里被指定的人 @ 时，AI 读代码、文档和聊天记录起草回复，机器人私聊你确认后，以你本人身份回复。

用法：
  boss-at-me setup [--step <步骤>] [--preset <文件|URL>]   交互式初始化（可重复运行）
  boss-at-me status                     查看配置、服务状态和待确认草稿
  boss-at-me logs [-f]                  查看日志
  boss-at-me pause | resume             暂停 / 恢复后台服务
  boss-at-me doctor                     诊断常见问题
  boss-at-me run [--dry-run]            手动跑一轮（后台服务调用的就是它）
  boss-at-me uninstall                  卸载

setup 步骤：preflight lark-app lark-auth watch provider sources reply selftest service
`;

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--step') opts.step = rest[++i];
    else if (a === '--preset') opts.preset = rest[++i];
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '-f' || a === '--follow') opts.follow = true;
    else if (a === '--once') opts.once = true;
    else throw new Error(`未知参数：${a}`);
  }
  return { cmd, opts };
}

async function main() {
  const { cmd, opts } = parseArgs(process.argv.slice(2));
  if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') return console.log(HELP);
  if (cmd === '-v' || cmd === '--version') return console.log(version);
  if (cmd === 'setup') return (await import('../src/commands/setup.js')).default(opts);
  const misc = await import('../src/commands/misc.js');
  const fn = { run: misc.run, status: misc.status, logs: misc.logs, pause: misc.pause, resume: misc.resume, doctor: misc.doctor, uninstall: misc.uninstall }[cmd];
  if (!fn) throw new Error(`未知命令：${cmd}\n\n${HELP}`);
  return fn(opts);
}

main().catch((e) => {
  if (e?.name === 'ExitPromptError') {
    console.log('\n已取消。已完成的步骤会保留，下次运行 boss-at-me setup 继续。');
    process.exit(130);
  }
  console.error(`\x1b[31m✘\x1b[0m ${e?.message || e}`);
  if (process.env.DEBUG) console.error(e);
  process.exit(1);
});
