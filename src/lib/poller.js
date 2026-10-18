import fs from 'node:fs';
import * as lark from './lark.js';
import { analyze } from './analyzer.js';
import { loadState, saveState, loadDrafts, withDrafts, log } from './store.js';
import { LOCK_PATH } from './paths.js';

// ---------------------------------------------------------------- 时间

export function isoLocal(d) {
  const pad = (n) => String(Math.abs(n)).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    + `${sign}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`;
}

/** lark-cli 输出的时间形如 "2026-10-17 14:53"（本地时区） */
export function parseLarkTime(s) {
  return new Date(`${s.replace(' ', 'T')}:00`);
}

const MIN = 60_000;
const HOUR = 60 * MIN;

function clip(s, n) {
  s = (s || '').trim();
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

// ---------------------------------------------------------------- 确认指令

const CMD_SEND = /^\s*(发|发送|send)\s*#?(\d+)?\s*$/i;
const CMD_EDIT = /^\s*改\s*#?(\d+)\s+([\s\S]+)$/;
const CMD_DROP = /^\s*(不发|忽略|跳过)\s*#?(\d+)?\s*$/;

/** 解析私聊里的确认指令，返回 { kind: 'send'|'edit'|'drop', code?, text? } 或 null（普通聊天）。 */
export function parseCommand(text) {
  let m = CMD_SEND.exec(text);
  if (m) return { kind: 'send', code: m[2] || null };
  m = CMD_EDIT.exec(text);
  if (m) return { kind: 'edit', code: m[1], text: m[2].trim() };
  m = CMD_DROP.exec(text);
  if (m) return { kind: 'drop', code: m[2] || null };
  return null;
}

export function resolveCode(st, code) {
  const pending = Object.entries(st.drafts).filter(([, d]) => d.status === 'pending').map(([c]) => c);
  if (code) {
    return st.drafts[code]?.status === 'pending' ? { code } : { err: `没有待确认的 #${code}` };
  }
  if (pending.length === 1) return { code: pending[0] };
  if (!pending.length) return { err: '当前没有待确认的草稿' };
  return { err: `有多条待确认草稿（${pending.map((c) => `#${c}`).join('、')}），请带上编号，如「发 ${pending[0]}」` };
}

/**
 * 处理私聊里我发给机器人的一条消息（确认指令）。d 是 drafts.json 的内容，调用方需持有草稿锁。
 * 轮询和实时监听可能收到同一条消息，靠 dmSeen 去重。
 */
export function handleDmMessage(cfg, d, m, { dry = false, seedOnly = false } = {}) {
  if (d.dmSeen.includes(m.message_id)) return;
  d.dmSeen.push(m.message_id);
  d.dmSeen = d.dmSeen.slice(-500);
  if (seedOnly || m.sender?.id !== cfg.me.open_id || m.msg_type !== 'text') return;
  const cmd = parseCommand(m.content || '');
  if (!cmd) return;
  const dm = (text) => (dry ? log('[dry] dm:', text) : lark.botDm(cfg.me.open_id, text));
  const { code, err } = resolveCode(d, cmd.code);
  if (err) {
    dm(`⚠️ ${err}`);
    return;
  }
  const draft = d.drafts[code];
  if (cmd.kind === 'drop') {
    draft.status = 'dropped';
    dm(`已忽略 #${code}`);
    return;
  }
  const final = cmd.kind === 'edit' ? cmd.text : draft.draft ? draft.draft + (cfg.reply.signature || '') : '';
  if (!final) {
    dm(`⚠️ #${code} 没有草稿内容，请用「改 ${code} 你的回复」`);
    return;
  }
  if (dry) {
    log('[dry] would reply', draft.messageId, clip(final, 80));
    return;
  }
  try {
    lark.replyAsMe(draft.messageId, final);
    draft.status = 'sent';
    draft.sentText = final;
    dm(`✅ #${code} 已回复到「${draft.chatName}」`);
    log('sent', code, draft.messageId);
  } catch (e) {
    draft.status = 'manual';
    const reason = /send_as_user/.test(String(e.message) + JSON.stringify(e.payload || {}))
      ? '「以本人身份发消息」权限还没生效（可能在等管理员审批）'
      : clip(e.message, 200);
    dm(`❌ #${code} 自动发送失败：${reason}\n请复制下面内容手动回复：\n\n${final}\n\n${draft.link || ''}`);
    log('send failed', code, e.message);
  }
}

/** 轮询兜底：实时监听没跑或断线时，靠这里补处理确认指令。 */
function handleConfirmations(cfg, { dry }) {
  const { dmChatId } = loadDrafts();
  if (!dmChatId) return;
  const now = new Date();
  const msgs = lark.chatMessages({ chatId: dmChatId, start: isoLocal(new Date(now - 72 * HOUR)), end: isoLocal(now), pageLimit: 2 });
  const run = (d) => {
    const seedOnly = d.dmSeen.length === 0; // 第一次只记录历史，不执行旧指令
    for (const m of msgs) handleDmMessage(cfg, d, m, { dry, seedOnly });
  };
  if (dry) run(loadDrafts());
  else withDrafts(run);
}

// ---------------------------------------------------------------- 拉取与起草

const batchText = (job) => job.batch.map((x) => (x.content || '').trim()).join('\n');
const jobWhere = (job) => (job.kind === 'p2p' ? '私聊你' : '@你');
const jobChat = (job) => (job.kind === 'p2p' ? `与${job.target.sender?.name}的私聊` : job.target.chat_name);

function notifyDraft(cfg, job, res) {
  return withDrafts((d) => {
    const code = String(d.nextCode++);
    return sendDraftCard(cfg, d, job, res, code);
  });
}

function sendDraftCard(cfg, d, job, res, code) {
  const m = job.target;
  const sender = m.sender?.name;
  const t = (m.create_time || '').slice(5);
  const where = job.kind === 'p2p' ? '' : `${m.chat_name} · `;
  const head = res.action === 'reply'
    ? `【#${code} ${sender} ${jobWhere(job)}】${where}${t}`
    : `【#${code} 需你处理 · ${sender} ${jobWhere(job)}】${where}${t}`;
  const draft = (res.draft || '').trim();
  const lines = [head, '', `原文：${clip(batchText(job), 300)}`, '',
    `要点：${res.summary}`,
    `依据：${clip(res.analysis, 600)}（把握：${res.confidence}）`];
  if (draft) {
    lines.push('', '✏️ 草稿：', draft, '', '———', `回「发 ${code}」原样发送 ·「改 ${code} 你的内容」改后发送 ·「不发 ${code}」忽略`);
  } else {
    lines.push('', '———', `无草稿。可回「改 ${code} 你的内容」直接回复，或「不发 ${code}」`);
  }
  if (m.message_app_link) lines.push(m.message_app_link);
  const data = lark.botDm(cfg.me.open_id, lines.join('\n'));
  d.dmChatId = d.dmChatId || data?.chat_id || null;
  d.drafts[code] = {
    status: 'pending', kind: job.kind, messageId: m.message_id, chatId: m.chat_id, chatName: jobChat(job), sender,
    draft, action: res.action, created: new Date().toISOString(), link: m.message_app_link,
  };
  return code;
}

/**
 * 把私聊新消息按会话分组。对方最后一条消息距今不足 quietMin 分钟的会话先不处理（可能还在连发，或者你正在回），
 * 留到下一轮；返回 { ready: [job], waiting: 会话数 }。
 */
export function planP2p(msgs, now, quietMin) {
  const byChat = new Map();
  for (const m of msgs) {
    if (!byChat.has(m.chat_id)) byChat.set(m.chat_id, []);
    byChat.get(m.chat_id).push(m);
  }
  const ready = [];
  let waiting = 0;
  for (const batch of byChat.values()) {
    batch.sort((a, b) => (a.create_time || '').localeCompare(b.create_time || ''));
    const target = batch[batch.length - 1];
    if (now - parseLarkTime(target.create_time) < quietMin * MIN) waiting++;
    else ready.push({ kind: 'p2p', target, batch });
  }
  return { ready, waiting };
}

/**
 * 私聊里我最后一次发言之后、对方还没被回复的那几条（按会话顺序判断，不依赖分钟级时间戳）。
 * 例如对方 16:44 发两条、我 16:45 回了、对方 16:54 又发两条，只留下 16:54 的两条；全部回过则返回空数组。
 */
export function unansweredTail(ctx, job, myId) {
  const ids = new Set(job.batch.map((x) => x.message_id));
  if (!ctx.some((x) => ids.has(x.message_id))) return job.batch;
  let lastMine = -1;
  ctx.forEach((x, i) => {
    if (x.sender?.id === myId && !ids.has(x.message_id)) lastMine = i;
  });
  // 用会话里的顺序（同一分钟内的先后也准确）
  return ctx.slice(lastMine + 1).filter((x) => ids.has(x.message_id));
}

function processJob(cfg, st, job) {
  let m = job.target;
  for (const x of job.batch) st.seen[x.message_id] = new Date().toISOString();
  saveState(st); // 先占位，避免分析崩溃后反复重跑
  try {
    const t = parseLarkTime(job.batch[0].create_time);
    const ctx = lark.chatMessages({
      chatId: m.chat_id,
      start: isoLocal(new Date(t - cfg.tuning.contextLookbackHours * HOUR)),
      end: isoLocal(new Date()),
    });
    if (job.kind === 'p2p') {
      const tail = unansweredTail(ctx, job, cfg.me.open_id);
      if (!tail.length) {
        log('skip p2p (already replied)', m.message_id);
        return;
      }
      job = { ...job, batch: tail, target: tail[tail.length - 1] };
      m = job.target;
    }
    const res = analyze(cfg, job, ctx);
    log('analyzed', job.kind, m.message_id, res.action, res.confidence, 'cost', res._cost);
    if (res.action !== 'skip') log(`drafted #${notifyDraft(cfg, job, res)}`);
  } catch (e) {
    log('analyze failed', m.message_id, e.message);
    try {
      lark.botDm(cfg.me.open_id, `【${m.sender?.name} ${jobWhere(job)}】${jobChat(job)} · ${m.create_time}\n原文：${clip(batchText(job), 300)}\n\n⚠️ 自动分析失败：${clip(e.message, 300)}\n${m.message_app_link || ''}`);
    } catch (e2) {
      log('notify failed', e2.message);
    }
  } finally {
    saveState(st);
  }
}

function poll(cfg, st, { dry }) {
  const end = new Date();
  const p2pOn = !!cfg.p2p?.enabled;
  // 私聊有静默等待，回看窗口要盖住等待时间，否则等待中的消息会掉出窗口
  const overlap = Math.max(cfg.tuning.searchOverlapMin, p2pOn ? cfg.p2p.quietMin + 10 : 0);
  const start = st.lastSearchEnd
    ? new Date(new Date(st.lastSearchEnd) - overlap * MIN)
    : new Date(end - cfg.tuning.firstRunLookbackMin * MIN);
  const senders = cfg.watch.map((w) => w.open_id);
  const watchIds = new Set(senders);
  const isFresh = (m) => !st.seen[m.message_id] && watchIds.has(m.sender?.id) && !m.deleted;
  const range = { senders, start: isoLocal(start), end: isoLocal(end) };

  const jobs = lark.searchMessages({ ...range, atMe: true })
    .filter((m) => isFresh(m) && m.chat_type !== 'p2p')
    .map((m) => ({ kind: 'group', target: m, batch: [m] }));
  let waiting = 0;
  if (p2pOn) {
    const plan = planP2p(lark.searchMessages({ ...range, chatType: 'p2p' }).filter(isFresh), end, cfg.p2p.quietMin);
    jobs.push(...plan.ready);
    waiting = plan.waiting;
  }
  jobs.sort((a, b) => (a.target.create_time || '').localeCompare(b.target.create_time || ''));
  log(`search ${range.start} ~ ${range.end}: ${jobs.length} new${p2pOn ? `（私聊等待中 ${waiting}）` : ''}`);
  for (const job of jobs) {
    if (dry) {
      log('[dry] new:', job.kind, job.target.create_time, jobChat(job), job.target.sender?.name, clip(batchText(job), 120).replace(/\n/g, ' '));
      continue;
    }
    processJob(cfg, st, job);
  }
  if (!dry) st.lastSearchEnd = end.toISOString();
}

function gc(cfg, st) {
  const now = Date.now();
  const week = 7 * 24 * HOUR;
  st.seen = Object.fromEntries(Object.entries(st.seen).filter(([, v]) => now - new Date(v) < week));
  withDrafts((d) => {
    for (const x of Object.values(d.drafts)) {
      if (x.status === 'pending' && now - new Date(x.created) > cfg.tuning.draftTtlHours * HOUR) x.status = 'expired';
    }
    d.drafts = Object.fromEntries(Object.entries(d.drafts).filter(([, x]) => x.status === 'pending' || now - new Date(x.created) < week));
  });
}

// ---------------------------------------------------------------- 一轮

function acquireLock() {
  try {
    const fd = fs.openSync(LOCK_PATH, 'wx');
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch {
    // 锁文件存在：看持有者是否还活着
    try {
      const pid = Number(fs.readFileSync(LOCK_PATH, 'utf8'));
      process.kill(pid, 0);
      return false;
    } catch {
      fs.rmSync(LOCK_PATH, { force: true });
      return acquireLock();
    }
  }
}

export function runOnce(cfg, { dry = false } = {}) {
  if (!acquireLock()) {
    log('another run in progress, skip');
    return;
  }
  try {
    const st = loadState();
    try {
      handleConfirmations(cfg, { dry });
    } catch (e) {
      log('confirmations failed', e.message);
    }
    poll(cfg, st, { dry });
    if (!dry) {
      gc(cfg, st);
      saveState(st);
    }
  } finally {
    fs.rmSync(LOCK_PATH, { force: true });
  }
}
