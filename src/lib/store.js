import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_PATH, STATE_PATH, HOME, LOG_PATH, DRAFTS_PATH, DRAFTS_LOCK_PATH } from './paths.js';

export const DEFAULT_SIGNATURE = '\n（AI 助手起草，本人已确认）';

export function defaultConfig() {
  return {
    version: 1,
    role: 'backend',
    me: null, // { open_id, name }
    watch: [], // [{ open_id, name }]
    provider: null, // 见 provider.js
    sources: { projects: [], docs: [], feishuDocs: false }, // projects/docs: [{ path, desc }]
    reply: { signature: DEFAULT_SIGNATURE, intervalSec: 120, budgetUsd: 2, effort: 'medium' },
    bins: { node: process.execPath, lark: null, claude: null },
    network: { proxy: null }, // 仅用于检查新版本
    p2p: { enabled: false, quietMin: 5 }, // 是否处理监听人的私聊
    tuning: { firstRunLookbackMin: 10, searchOverlapMin: 15, contextLookbackHours: 36, draftTtlHours: 48 },
  };
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeJsonAtomic(p, obj, mode = 0o600) {
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode });
  fs.renameSync(tmp, p);
}

export function configExists() {
  return fs.existsSync(CONFIG_PATH);
}

export function loadConfig() {
  const base = defaultConfig();
  if (!configExists()) return base;
  const cfg = readJson(CONFIG_PATH);
  return {
    ...base,
    ...cfg,
    sources: { ...base.sources, ...cfg.sources },
    reply: { ...base.reply, ...cfg.reply },
    bins: { ...base.bins, ...cfg.bins },
    tuning: { ...base.tuning, ...cfg.tuning },
    p2p: { ...base.p2p, ...cfg.p2p },
  };
}

export function saveConfig(cfg) {
  writeJsonAtomic(CONFIG_PATH, cfg);
}

export function defaultState() {
  return { lastSearchEnd: null, seen: {} };
}

export function loadState() {
  if (!fs.existsSync(STATE_PATH)) return defaultState();
  return { ...defaultState(), ...readJson(STATE_PATH) };
}

export function saveState(st) {
  writeJsonAtomic(STATE_PATH, st);
}

// ---------------------------------------------------------------- 草稿（跨进程共享）

export function defaultDrafts() {
  return { drafts: {}, nextCode: 1, dmChatId: null, dmSeen: [] };
}

export function loadDrafts() {
  if (fs.existsSync(DRAFTS_PATH)) return { ...defaultDrafts(), ...readJson(DRAFTS_PATH) };
  // 0.3.x 及以前草稿存在 state.json 里
  const old = fs.existsSync(STATE_PATH) ? readJson(STATE_PATH) : {};
  const d = defaultDrafts();
  for (const k of Object.keys(d)) if (old[k] !== undefined) d[k] = old[k];
  return d;
}

export function saveDrafts(d) {
  writeJsonAtomic(DRAFTS_PATH, d);
}

function tryLock(p) {
  try {
    const fd = fs.openSync(p, 'wx');
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch {
    try {
      process.kill(Number(fs.readFileSync(p, 'utf8')), 0);
      return false; // 持有者还活着
    } catch {
      fs.rmSync(p, { force: true }); // 持有者已退出，清掉残留锁
      return tryLock(p);
    }
  }
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** 在草稿锁内读-改-写 drafts.json；fn 同步执行，返回值透传。 */
export function withDrafts(fn, { timeoutMs = 30_000 } = {}) {
  fs.mkdirSync(path.dirname(DRAFTS_LOCK_PATH), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  while (!tryLock(DRAFTS_LOCK_PATH)) {
    if (Date.now() > deadline) throw new Error('等待草稿锁超时');
    sleepSync(100);
  }
  try {
    const d = loadDrafts();
    const r = fn(d);
    saveDrafts(d);
    return r;
  } finally {
    fs.rmSync(DRAFTS_LOCK_PATH, { force: true });
  }
}

export function ensureHome() {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true, mode: 0o700 });
  fs.chmodSync(HOME, 0o700);
}

export function log(...args) {
  const ts = new Date().toLocaleString('sv-SE', { hour12: false });
  console.log(ts, ...args);
}
