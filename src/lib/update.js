import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadState, saveState, log } from './store.js';
import { botDm } from './lark.js';

const require = createRequire(import.meta.url);
const PKG = require('../../package.json');
export const RELEASES = require('../releases.json');
export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const CURRENT_VERSION = PKG.version;
/** "github:owner/repo" → "owner/repo" */
export const REPO = String(PKG.repository?.url || PKG.repository || '').replace(/^(github:|git\+https:\/\/github\.com\/|https:\/\/github\.com\/)/, '').replace(/\.git$/, '');

const DAY = 24 * 3600_000;

export function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/, '').split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

/** 介于 from（不含）和 to（含）之间的版本说明，按版本升序。 */
export function releasesBetween(releases, from, to) {
  return releases
    .filter((r) => compareVersions(r.version, from) > 0 && compareVersions(r.version, to) <= 0)
    .sort((x, y) => compareVersions(x.version, y.version));
}

export function envProxy(env = process.env) {
  return env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy || null;
}

/** 用 curl 取 JSON：会走 shell 里的代理环境变量；后台（launchd 没有这些变量）时用 setup 记下的 proxy。 */
function fetchJson(url, proxy) {
  const args = ['-fsSL', '-m', '15', '-H', 'Cache-Control: no-cache'];
  if (proxy && !envProxy()) args.push('--proxy', proxy);
  const p = spawnSync('/usr/bin/curl', [...args, url], { encoding: 'utf8' });
  if (p.status !== 0) throw new Error(`获取 ${url} 失败：${(p.stderr || '').trim() || `curl exit ${p.status}`}`);
  return JSON.parse(p.stdout);
}

/** 读 GitHub main 分支上的最新版本号和版本说明。 */
export async function fetchLatest({ repo = REPO, proxy } = {}) {
  const base = `https://raw.githubusercontent.com/${repo}/main`;
  const pkg = fetchJson(`${base}/package.json`, proxy);
  let releases = [];
  try {
    releases = fetchJson(`${base}/src/releases.json`, proxy);
  } catch {
    // 没有版本说明也不影响提醒
  }
  return { version: pkg.version, releases };
}

/** 判断当前是怎么装的，返回更新方式。 */
export function installSource() {
  const root = fs.realpathSync(PKG_ROOT);
  if (fs.existsSync(path.join(root, '.git'))) return { kind: 'git', dir: root };
  const p = spawnSync('npm', ['ls', '-g', '--json', '--depth=0', PKG.name], { encoding: 'utf8' });
  let resolved = '';
  try {
    resolved = JSON.parse(p.stdout).dependencies?.[PKG.name]?.resolved || '';
  } catch {
    // 拿不到就按 GitHub 处理
  }
  if (/registry\.npmjs|^https?:\/\/.*\.tgz$/.test(resolved) && !/github/.test(resolved)) return { kind: 'npm' };
  return { kind: 'github' };
}

export function formatNotes(releases) {
  return releases.map((r) => {
    const lines = [`v${r.version}`, ...(r.notes || []).map((n) => `  · ${n}`)];
    if (r.steps?.length) lines.push(`  需要重跑：${r.steps.map((s) => `boss-at-me setup --step ${s}`).join('、')}`);
    return lines.join('\n');
  }).join('\n');
}

/** 后台每轮调用：每天最多查一次，发现新版本时私聊提醒一次。失败静默。 */
export async function maybeNotifyUpdate(cfg) {
  const st = loadState();
  if (st.lastUpdateCheck && Date.now() - new Date(st.lastUpdateCheck) < DAY) return;
  st.lastUpdateCheck = new Date().toISOString();
  saveState(st);
  let latest;
  try {
    latest = await fetchLatest({ proxy: cfg.network?.proxy });
  } catch (e) {
    log('update check failed', e.message);
    return;
  }
  const fresh = loadState();
  fresh.latestVersion = latest.version;
  if (compareVersions(latest.version, CURRENT_VERSION) > 0 && fresh.notifiedVersion !== latest.version) {
    const notes = formatNotes(releasesBetween(latest.releases, CURRENT_VERSION, latest.version));
    try {
      botDm(cfg.me.open_id, `【boss-at-me 有新版本 v${latest.version}】当前 v${CURRENT_VERSION}\n\n${notes || '（无版本说明）'}\n\n在终端运行：boss-at-me update`);
      fresh.notifiedVersion = latest.version;
      log('update available', latest.version, 'notified');
    } catch (e) {
      log('update notify failed', e.message);
    }
  }
  saveState(fresh);
}
