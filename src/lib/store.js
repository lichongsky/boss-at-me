import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_PATH, STATE_PATH, HOME, LOG_PATH, DRAFTS_PATH, DRAFTS_LOCK_PATH } from './paths.js';

export const DEFAULT_SIGNATURE = '';

export function defaultConfig() {
  return {
    version: 1,
    role: 'backend',
    me: null, // { open_id, name }
    watch: [], // [{ open_id, name }]
    provider: null, // 见 provider.js
    sources: { projects: [], docs: [], feishuDocs: false }, // projects/docs: [{ path, desc }]
    reply: {
      signature: DEFAULT_SIGNATURE,
      intervalSec: 120,
      budgetUsd: 2, // 单条分析的 claude --max-budget-usd 上限
      monthlyBudgetUsd: 0, // 本月累计估算费用上限；0 表示不限
      effort: 'medium',
      cards: false,
      nudgeHours: 12, // 有未处理草稿时每隔多少小时主动提醒；0 表示不提醒
    },
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
  return { drafts: {}, nextCode: 1, dmChatId: null, dmSeen: [], usage: defaultUsage() };
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

// ---------------------------------------------------------------- 使用统计（跨进程共享，跟着草稿锁走）

const pad2 = (n) => String(n).padStart(2, '0');
export const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
export const monthKey = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;

export function defaultUsage() {
  return {
    month: monthKey(), monthAnalyses: 0, monthCost: 0, monthDrafts: 0, monthSent: 0, monthDropped: 0, monthExpired: 0,
    day: dayKey(), dayAnalyses: 0, dayCost: 0,
    dropReasons: {},
    failStreak: 0, lastFailAt: null, lastError: null, lastFailAlertAt: null,
    budgetAlertAt: null, lastNudgeAt: null,
  };
}

/** 跨天/跨月时把统计归零；成本来自 claude 返回的 total_cost_usd（按所选供应商的估算）。 */
export function rollUsage(u) {
  if (!u || typeof u !== 'object') u = defaultUsage();
  const now = new Date();
  if (u.month !== monthKey(now)) {
    u.month = monthKey(now);
    u.monthAnalyses = 0;
    u.monthCost = 0;
    u.monthDrafts = 0;
    u.monthSent = 0;
    u.monthDropped = 0;
    u.monthExpired = 0;
    u.budgetAlertAt = null;
  }
  if (u.day !== dayKey(now)) {
    u.day = dayKey(now);
    u.dayAnalyses = 0;
    u.dayCost = 0;
  }
  if (!u.dropReasons) u.dropReasons = {};
  return u;
}

/** 在已持有草稿锁的上下文中累加统计（数字字段是加上去，其余字段是覆盖）。 */
export function bumpUsage(d, patch = {}) {
  d.usage = rollUsage(d.usage);
  for (const [k, v] of Object.entries(patch)) {
    if (typeof v === 'number' && typeof d.usage[k] === 'number') d.usage[k] += v;
    else d.usage[k] = v;
  }
  return d.usage;
}

/** 在草稿锁内读-改-写 usage，返回 fn 的返回值。 */
export function recordUsage(fn) {
  return withDrafts((d) => {
    d.usage = rollUsage(d.usage);
    return fn(d.usage, d);
  });
}

/** 只读取一份快照（会顺带做跨天/跨月归零并落盘）。 */
export function readUsage() {
  return withDrafts((d) => ({ ...rollUsage(d.usage) }));
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
