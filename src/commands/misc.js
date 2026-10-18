import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { confirm } from '@inquirer/prompts';
import { loadConfig, loadState, configExists, log } from '../lib/store.js';
import { HOME, LOG_PATH, PLIST_PATH } from '../lib/paths.js';
import { setLarkBin, authCheck, configShow, whoami } from '../lib/lark.js';
import { resolveProviderEnv, TOKEN_ACCOUNT } from '../lib/provider.js';
import { deleteSecret } from '../lib/keychain.js';
import { runOnce } from '../lib/poller.js';
import { maybeNotifyUpdate, compareVersions, CURRENT_VERSION } from '../lib/update.js';
import * as launchd from '../lib/launchd.js';
import { requiredScopes } from '../setup/steps.js';
import { c, ok, warn, fail, info } from '../setup/util.js';

function requireConfig() {
  if (!configExists()) throw new Error('还没初始化，请先运行：boss-at-me setup');
  const cfg = loadConfig();
  if (cfg.bins.lark) setLarkBin(cfg.bins.lark);
  return cfg;
}

const MAX_LOG = 5 * 1024 * 1024;

export async function run(opts) {
  const cfg = requireConfig();
  if (!cfg.me || !cfg.watch.length || !cfg.provider) throw new Error('配置不完整，请运行 boss-at-me setup');
  try {
    if (fs.statSync(LOG_PATH).size > MAX_LOG) fs.renameSync(LOG_PATH, `${LOG_PATH}.1`);
  } catch {
    // 日志不存在
  }
  runOnce(cfg, { dry: !!opts.dryRun });
  if (opts.dryRun) {
    log('dry-run 结束，未发送任何消息、未写状态');
    return;
  }
  await maybeNotifyUpdate(cfg);
}

export function status() {
  const cfg = requireConfig();
  const st = loadState();
  const svc = launchd.serviceInfo();
  let providerLabel;
  try {
    providerLabel = resolveProviderEnv(cfg.provider).label;
  } catch (e) {
    providerLabel = c.red(e.message);
  }
  const newer = st.latestVersion && compareVersions(st.latestVersion, CURRENT_VERSION) > 0;
  console.log(`${c.bold('版本')}      v${CURRENT_VERSION}${newer ? c.yellow(`（有新版本 v${st.latestVersion}，运行 boss-at-me update）`) : ''}`);
  console.log(`${c.bold('用户')}      ${cfg.me?.name ?? '-'}`);
  console.log(`${c.bold('监听')}      ${cfg.watch.map((w) => w.name).join('、') || '-'}（群里 @你${cfg.p2p.enabled ? ` + 私聊，等待 ${cfg.p2p.quietMin} 分钟` : ''}）`);
  console.log(`${c.bold('模型')}      ${providerLabel}`);
  console.log(`${c.bold('项目')}      ${cfg.sources.projects.map((p) => p.path).join('\n          ') || '-'}`);
  console.log(`${c.bold('文档')}      ${cfg.sources.docs.map((p) => p.path).join('\n          ') || '-'}${cfg.sources.feishuDocs ? '（+ 飞书文档）' : ''}`);
  console.log(`${c.bold('服务')}      ${svc.loaded ? c.green(`运行中，每 ${cfg.reply.intervalSec}s，已跑 ${svc.runs} 次，上次退出码 ${svc.lastExit}`) : c.yellow('已暂停 / 未安装')}`);
  console.log(`${c.bold('上次检查')}  ${st.lastSearchEnd ? new Date(st.lastSearchEnd).toLocaleString('sv-SE') : '-'}`);
  const pending = Object.entries(st.drafts).filter(([, d]) => d.status === 'pending');
  console.log(`${c.bold('待确认')}    ${pending.length ? '' : '无'}`);
  for (const [code, d] of pending) console.log(`  #${code} ${d.sender} @你 · ${d.chatName} · ${(d.draft || '（无草稿）').replace(/\s+/g, ' ').slice(0, 40)}`);
}

export function logs(opts) {
  if (!fs.existsSync(LOG_PATH)) {
    info('还没有日志');
    return;
  }
  const args = opts.follow ? ['-n', '50', '-f', LOG_PATH] : ['-n', '80', LOG_PATH];
  spawn('/usr/bin/tail', args, { stdio: 'inherit' });
}

export function pause() {
  launchd.pause();
  ok('后台服务已暂停（boss-at-me resume 恢复）');
}

export function resume() {
  launchd.resume();
  ok('后台服务已恢复');
}

export function doctor() {
  const cfg = requireConfig();
  let bad = 0;
  const check = (cond, good, badMsg) => {
    if (cond) ok(good);
    else {
      fail(badMsg);
      bad++;
    }
  };
  for (const [k, p] of Object.entries(cfg.bins)) check(p && fs.existsSync(p), `${k}：${p}`, `${k} 不存在：${p}（换过 Node 版本？运行 boss-at-me setup --step preflight 后再 --step service）`);
  const shown = configShow();
  check(shown?.appId, `飞书应用：${shown?.appId}`, '飞书应用未配置（boss-at-me setup --step lark-app）');
  const me = shown?.appId ? whoami() : null;
  check(me?.open_id === cfg.me?.open_id, `飞书用户：${me?.name}`, `飞书登录用户与配置不一致或未登录（boss-at-me setup --step lark-auth）`);
  const chk = authCheck(requiredScopes(cfg));
  check(chk.ok, '飞书权限齐全', `缺少权限：${chk.missing.join(' ')}（boss-at-me setup --step lark-auth）`);
  try {
    check(true, `模型供应商：${resolveProviderEnv(cfg.provider).label}`);
  } catch (e) {
    check(false, '', `模型供应商：${e.message}`);
  }
  for (const d of [...cfg.sources.projects, ...cfg.sources.docs]) check(fs.existsSync(d.path), `目录：${d.path}`, `目录不存在：${d.path}`);
  const svc = launchd.serviceInfo();
  check(svc.loaded, `后台服务运行中（已跑 ${svc.runs} 次）`, '后台服务未运行（boss-at-me resume 或 setup --step service）');
  for (const legacy of launchd.findLegacyServices()) {
    if (legacy.loaded) warn(`旧版服务 ${legacy.label} 仍在运行，会和新版重复处理（boss-at-me setup --step service 会停掉它）`);
  }
  if (fs.existsSync(LOG_PATH)) {
    const tail = fs.readFileSync(LOG_PATH, 'utf8').trim().split('\n').slice(-5);
    info(`最近日志：\n${tail.map((l) => `    ${l}`).join('\n')}`);
  }
  console.log(bad ? c.yellow(`\n发现 ${bad} 个问题`) : c.green('\n一切正常'));
  info(c.dim('模型是否真的可用，可以运行 boss-at-me setup --step provider 实测一次（会产生一次调用费用）'));
}

export async function uninstall() {
  if (!(await confirm({ message: `将停止后台服务，删除 ${PLIST_PATH}、${HOME} 和钥匙串里的模型 token。继续吗？`, default: false }))) return;
  launchd.uninstall();
  deleteSecret(TOKEN_ACCOUNT);
  fs.rmSync(HOME, { recursive: true, force: true });
  ok('已卸载');
  info('lark-cli 及其飞书应用、登录授权保留未动；如需清除：lark-cli auth logout');
  info('最后可执行：npm uninstall -g boss-at-me');
}
