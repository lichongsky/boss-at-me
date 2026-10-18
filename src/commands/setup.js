import fs from 'node:fs';
import * as steps from '../setup/steps.js';
import { loadConfig, saveConfig, ensureHome, configExists } from '../lib/store.js';
import { setLarkBin } from '../lib/lark.js';
import { c, title, ok } from '../setup/util.js';

const STEPS = [
  ['preflight', '检查环境', steps.preflight],
  ['lark-app', '飞书应用', steps.larkApp],
  ['lark-auth', '飞书授权', steps.larkAuth],
  ['watch', '监听名单', steps.watch],
  ['provider', '模型供应商', steps.provider],
  ['sources', '分析来源（项目目录 / 文档）', steps.sources],
  ['reply', '回复设置', steps.reply],
  ['selftest', '自检', steps.selftest],
  ['service', '后台服务', steps.service],
];

async function loadPreset(src) {
  if (!src) return null;
  const text = /^https?:\/\//.test(src) ? await (await fetch(src)).text() : fs.readFileSync(src, 'utf8');
  return JSON.parse(text);
}

export default async function setup(opts) {
  ensureHome();
  const cfg = loadConfig();
  const ctx = { preset: await loadPreset(opts.preset) };
  if (cfg.bins.lark) setLarkBin(cfg.bins.lark);

  let list = STEPS;
  if (opts.step) {
    list = STEPS.filter(([id]) => id === opts.step);
    if (!list.length) throw new Error(`没有这个步骤：${opts.step}。可选：${STEPS.map(([id]) => id).join(' ')}`);
    if (opts.step !== 'preflight' && !cfg.bins.lark) await steps.preflight(cfg, ctx);
  } else {
    console.log(c.bold('\nboss-at-me 初始化：有人在飞书群里 @你 时，AI 帮你起草回复，私聊你确认后以你的身份发出。\n'));
    if (!configExists()) await steps.migrate(cfg, ctx);
  }

  for (const [i, [, name, fn]] of list.entries()) {
    title(i + 1, list.length, name);
    await fn(cfg, ctx);
    saveConfig(cfg); // 每步保存，中途退出下次可以接着来
  }
  if (!opts.step) {
    console.log();
    ok(c.bold('全部完成。之后有人 @你，飞书里的机器人会私聊你草稿。'));
    console.log(`  常用命令：${c.cyan('boss-at-me status')}  ${c.cyan('boss-at-me logs -f')}  ${c.cyan('boss-at-me pause')}  ${c.cyan('boss-at-me doctor')}`);
  }
}

export const STEP_IDS = STEPS.map(([id]) => id);
