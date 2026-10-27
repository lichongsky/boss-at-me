import fs from 'node:fs';
import * as lark from './lark.js';
import { analyze, hasEvidence, looksSuspicious } from './analyzer.js';
import { buildDraftCard, buildDoneCard } from './card.js';
import { loadState, saveState, loadDrafts, withDrafts, rollUsage, bumpUsage, recordUsage, readUsage, log } from './store.js';
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
const CMD_RESEND = /^\s*(重发|重试)\s*#?(\d+)\s*$/;
const CMD_DROP_ALL = /^\s*(全部忽略|忽略全部)\s*$/;
const CMD_LIST = /^\s*(待确认|待处理|列表)\s*$/;
const CMD_NUDGE = /^\s*(提醒|催一下)\s*$/;
const CMD_REASON = /^\s*原因\s*#?(\d+)\s+(\S.*)$/;

/** 解析私聊里的确认指令，返回 { kind, code?, text? } 或 null（普通聊天）。 */
export function parseCommand(text) {
  let m = CMD_SEND.exec(text);
  if (m) return { kind: 'send', code: m[2] || null };
  m = CMD_RESEND.exec(text);
  if (m) return { kind: 'resend', code: m[2] };
  m = CMD_EDIT.exec(text);
  if (m) return { kind: 'edit', code: m[1], text: m[2].trim() };
  m = CMD_DROP_ALL.exec(text);
  if (m) return { kind: 'dropAll' };
  m = CMD_DROP.exec(text);
  if (m) return { kind: 'drop', code: m[2] || null };
  m = CMD_LIST.exec(text);
  if (m) return { kind: 'list' };
  m = CMD_NUDGE.exec(text);
  if (m) return { kind: 'nudge' };
  m = CMD_REASON.exec(text);
  if (m) return { kind: 'reason', code: m[1], text: m[2].trim() };
  return null;
}

/** allowManual=true 时「manual（自动发送失败，待手动）」的草稿也能被重发。 */
export function resolveCode(st, code, { allowManual = false } = {}) {
  const ok = allowManual ? ['pending', 'manual'] : ['pending'];
  if (code) {
    return ok.includes(st.drafts[code]?.status) ? { code } : { err: `没有可${allowManual ? '重发' : '确认'}的 #${code}` };
  }
  const pending = Object.entries(st.drafts).filter(([, d]) => ok.includes(d.status)).map(([c]) => c);
  if (pending.length === 1) return { code: pending[0] };
  if (!pending.length) return { err: allowManual ? '当前没有可重发的草稿' : '当前没有待确认的草稿' };
  return { err: `有多条（${pending.map((c) => `#${c}`).join('、')}），请带上编号，如「发 ${pending[0]}」` };
}

const SEND_AS_USER_HINT = '「以本人身份发消息」权限还没生效（可能在等管理员审批）';
const DROP_REASON_HINT = '（可选：回「原因 N 已回 / 不用 / 不好」帮我判断得更准）';

/** 把草稿卡片更新为最终状态（尽力而为，失败不影响结果）。 */
function refreshCard(draft, code, note) {
  if (!draft.cardMessageId) return;
  try {
    lark.updateCard(draft.cardMessageId, buildDoneCard({ ...draft.card, code, status: draft.status, finalText: draft.sentText, note }));
  } catch (e) {
    log('update card failed', code, e.message);
  }
}

/**
 * 执行一条草稿的处理决定。kind: send（按草稿原样，加署名）/ edit（发 text，不加署名）/
 * resend（重发 manual 草稿）/ drop。调用方需持有草稿锁。文字指令和卡片按钮共用。
 */
export function executeDraft(cfg, d, code, { kind, text }, { dry = false, ackText = true } = {}) {
  const draft = d.drafts[code];
  const signature = cfg.reply.signature || '';
  const dm = (msg) => (dry ? log('[dry] dm:', msg) : lark.botDm(cfg.me.open_id, msg));

  if (kind === 'drop') {
    draft.status = 'dropped';
    bumpUsage(d, { monthDropped: 1 });
    if (!dry) refreshCard(draft, code);
    if (ackText && !draft.cardMessageId) dm(`已忽略 #${code}${DROP_REASON_HINT}`);
    return { status: draft.status };
  }

  let final;
  if (kind === 'edit') final = text;
  else if (kind === 'resend') final = draft.sentText || (draft.draft ? draft.draft + signature : '');
  else if (kind === 'send' && text) final = text + signature;
  else final = draft.draft ? draft.draft + signature : '';

  if (!final) {
    dm(`⚠️ #${code} 没有草稿内容，请用「改 ${code} 你的回复」`);
    return { status: draft.status };
  }
  if (dry) {
    log('[dry] would reply', draft.messageId, clip(final, 80));
    return { status: 'dry', final };
  }
  try {
    lark.replyAsMe(draft.messageId, final);
    draft.status = 'sent';
    draft.sentText = final;
    bumpUsage(d, { monthSent: 1 });
    log('sent', code, draft.messageId);
    refreshCard(draft, code);
    if (ackText && !draft.cardMessageId) dm(`✅ #${code} 已回复到「${draft.chatName}」`);
    return { status: 'sent', final };
  } catch (e) {
    draft.status = 'manual';
    draft.sentText = final;
    const reason = /send_as_user/.test(String(e.message) + JSON.stringify(e.payload || {})) ? SEND_AS_USER_HINT : clip(e.message, 200);
    log('send failed', code, e.message);
    refreshCard(draft, code, reason);
    if (!draft.cardMessageId) dm(`❌ #${code} 自动发送失败：${reason}\n请复制下面内容手动回复：\n\n${final}\n\n${draft.link || ''}`);
    return { status: 'manual', final, error: e.message };
  }
}

const notifyMe = (cfg, text, dry = false) => (dry ? log('[dry] dm:', text) : lark.botDm(cfg.me.open_id, text));

// ---------------------------------------------------------------- 待确认草稿收口

/** 汇总未处理草稿，用于每日提醒 / 「待确认」「提醒」指令。 */
export function buildPendingDigest(pending, now = Date.now()) {
  const lines = [`还有 ${pending.length} 条待确认：`];
  for (const [code, x] of pending) {
    const age = Math.max(0, (now - new Date(x.created).getTime()) / HOUR);
    const ageText = age < 1 ? '刚刚' : `${age.toFixed(1)}h`;
    const where = x.chatName ? ` · ${x.chatName}` : '';
    lines.push(`#${code} ${x.action === 'notify' ? '需你处理' : '草稿'} · ${x.sender}${where} · ${ageText}`);
  }
  lines.push('', '回「发 N / 改 N 内容 / 不发 N」，也可以「全部忽略」。');
  return lines.join('\n');
}

function sendPendingDigest(cfg, d, { dry = false, force = false } = {}) {
  const pending = Object.entries(d.drafts)
    .filter(([, x]) => x.status === 'pending')
    .sort((a, b) => new Date(a[1].created) - new Date(b[1].created));
  if (!pending.length) {
    if (force) notifyMe(cfg, '当前没有待确认的草稿', dry);
    return 0;
  }
  notifyMe(cfg, buildPendingDigest(pending), dry);
  d.usage = rollUsage(d.usage);
  d.usage.lastNudgeAt = new Date().toISOString();
  return pending.length;
}

function normalizeReason(text) {
  const s = String(text || '');
  if (/已回|自己回|我回|回了/.test(s)) return '自己回了';
  if (/不用|不需|无需|没必要|不需要/.test(s)) return '不用回';
  if (/不好|不对|不合适|不像|质量|不准/.test(s)) return '草稿不合适';
  return clip(s, 20);
}

/**
 * 处理私聊里我发给机器人的一条消息（文字指令）。d 是 drafts.json 的内容，调用方需持有草稿锁。
 * 轮询和实时监听可能收到同一条消息，靠 dmSeen 去重。
 */
export function handleDmMessage(cfg, d, m, { dry = false, seedOnly = false } = {}) {
  if (d.dmSeen.includes(m.message_id)) return;
  d.dmSeen.push(m.message_id);
  d.dmSeen = d.dmSeen.slice(-500);
  if (seedOnly || m.sender?.id !== cfg.me.open_id || m.msg_type !== 'text') return;
  const cmd = parseCommand(m.content || '');
  if (!cmd) return;

  // 草稿收口类指令
  if (cmd.kind === 'list' || cmd.kind === 'nudge') {
    sendPendingDigest(cfg, d, { dry, force: true });
    return;
  }
  if (cmd.kind === 'dropAll') {
    const pending = Object.entries(d.drafts).filter(([, x]) => x.status === 'pending');
    if (!pending.length) {
      notifyMe(cfg, '当前没有待确认的草稿', dry);
      return;
    }
    for (const [code] of pending) executeDraft(cfg, d, code, { kind: 'drop' }, { dry, ackText: false });
    notifyMe(cfg, `已忽略 ${pending.length} 条待确认的草稿`, dry);
    return;
  }
  if (cmd.kind === 'reason') {
    if (!d.drafts[cmd.code]) {
      notifyMe(cfg, `没有 #${cmd.code}`, dry);
      return;
    }
    const reason = normalizeReason(cmd.text);
    d.usage = rollUsage(d.usage);
    d.usage.dropReasons[reason] = (d.usage.dropReasons[reason] || 0) + 1;
    notifyMe(cfg, '记下了，谢谢', dry);
    return;
  }

  const resend = cmd.kind === 'resend';
  const { code, err } = resolveCode(d, cmd.code, { allowManual: resend });
  if (err) {
    notifyMe(cfg, `⚠️ ${err}`, dry);
    return;
  }
  // 卡片会变成最终状态，文字指令再补一句回执，方便在私聊流里确认
  executeDraft(cfg, d, code, cmd, { dry, ackText: true });
  const draft = d.drafts[code];
  if (!dry && draft.cardMessageId && draft.status !== 'pending') {
    lark.botDm(cfg.me.open_id, draft.status === 'sent' ? `✅ #${code} 已回复到「${draft.chatName}」` : draft.status === 'dropped' ? `已忽略 #${code}` : `❌ #${code} 发送失败，见卡片`);
  }
}

/** 处理卡片按钮回调（card.action.trigger）。调用方需持有草稿锁。 */
export function handleCardAction(cfg, d, ev) {
  if (ev.operator_id !== cfg.me.open_id) return;
  const code = Object.keys(d.drafts).find((c) => d.drafts[c].cardMessageId === ev.message_id);
  if (!code) return;
  const draft = d.drafts[code];
  if (draft.status !== 'pending') {
    refreshCard(draft, code); // 重复点击：把卡片刷成最终状态即可
    return;
  }
  if (ev.action_name === 'drop') {
    executeDraft(cfg, d, code, { kind: 'drop' });
    return;
  }
  // 快捷回复：选项文字直接作为回复内容发送（带署名）
  const opt = /^opt_(\d+)$/.exec(ev.action_name || '');
  if (opt) {
    const options = Array.isArray(draft.card?.options) ? draft.card.options : [];
    const text = String(options[Number(opt[1])] || '').trim();
    if (text) executeDraft(cfg, d, code, { kind: 'send', text });
    return;
  }
  if (ev.action_name !== 'send') return;
  let text = '';
  try {
    text = String(JSON.parse(ev.form_value || '{}').reply || '').trim();
  } catch {
    // 没有表单值：按原草稿发送
  }
  const kind = !text || text === draft.draft ? 'send' : 'edit';
  executeDraft(cfg, d, code, { kind, text });
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

export function notifyDraft(cfg, job, res) {
  return withDrafts((d) => {
    const code = String(d.nextCode++);
    return sendDraftCard(cfg, d, job, res, code);
  });
}

function sendDraftCard(cfg, d, job, res, code) {
  const m = job.target;
  const sender = m.sender?.name;
  const t = (m.create_time || '').slice(5);
  const draft = (res.draft || '').trim();
  const options = Array.isArray(res.options) ? res.options.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 3) : [];
  const suspicious = looksSuspicious(batchText(job));
  const evidence = res.action === 'skip' ? true : hasEvidence(res.analysis);
  const card = {
    sender, where: jobWhere(job), chatName: job.kind === 'p2p' ? '' : m.chat_name, time: t, action: res.action,
    original: clip(batchText(job), 600), summary: res.summary, analysis: clip(res.analysis, 1500), confidence: res.confidence,
    link: m.message_app_link, options, suspicious, evidence,
  };
  const entry = {
    status: 'pending', kind: job.kind, messageId: m.message_id, chatId: m.chat_id, chatName: jobChat(job), sender,
    draft, action: res.action, created: new Date().toISOString(), link: m.message_app_link,
  };
  bumpUsage(d, { monthDrafts: 1 });
  let data = null;
  if (cfg.reply.cards !== false) {
    try {
      data = lark.botCard(cfg.me.open_id, buildDraftCard({ ...card, code, draft }));
      Object.assign(entry, { cardMessageId: data?.message_id, card });
    } catch (e) {
      log('send card failed, fallback to text', e.message);
    }
  }
  if (!data) data = lark.botDm(cfg.me.open_id, draftText(code, job, res, draft, { options, suspicious, evidence }));
  d.dmChatId = d.dmChatId || data?.chat_id || null;
  d.drafts[code] = entry;
  return code;
}

/** 文字版草稿通知（卡片不可用时） */
function draftText(code, job, res, draft, { options = [], suspicious = false, evidence = true } = {}) {
  const m = job.target;
  const where = job.kind === 'p2p' ? '' : `${m.chat_name} · `;
  const t = (m.create_time || '').slice(5);
  const head = res.action === 'reply'
    ? `【#${code} ${m.sender?.name} ${jobWhere(job)}】${where}${t}`
    : `【#${code} 需你处理 · ${m.sender?.name} ${jobWhere(job)}】${where}${t}`;
  const lines = [head, '', `原文：${clip(batchText(job), 300)}`, '', `要点：${res.summary}`,
    `依据：${clip(res.analysis, 600)}（把握：${res.confidence}）`];
  if (suspicious) lines.push('', '⚠️ 这条消息可能包含「让你执行指令」的内容，发送前请核对草稿。');
  if (evidence === false) lines.push('', '⚠️ 草稿没有引用具体代码 / 文档 / 聊天依据，建议核对。');
  if (draft) lines.push('', '✏️ 草稿：', draft);
  if (options.length) lines.push('', '快捷回复：', ...options.map((o, i) => `${i + 1}. ${o}`));
  if (draft || options.length) lines.push('', '———', `回「发 ${code}」原样发送 ·「改 ${code} 你的内容」改后发送 ·「不发 ${code}」忽略`);
  else lines.push('', '———', `无草稿。可回「改 ${code} 你的内容」直接回复，或「不发 ${code}」`);
  if (m.message_app_link) lines.push(m.message_app_link);
  return lines.join('\n');
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
const ACK_WORDS = new Set([
  '是的', '是', '是的呀', '对的', '对', '对啊', '嗯', '嗯嗯', '嗯呢', '好', '好的', '好滴', '好嘞', '好呀', '好吧',
  '收到', '收到啦', '收到收到', '可以', '行', 'ok', 'okay', '没问题', '没错', '确实', '了解', '明白', '知道了',
  '辛苦了', '谢谢', '感谢', '👍', '👌', '🆗', '✅',
]);

/** 去掉 @ 和标点后，整条消息是不是只是「是的/好的/收到/嗯/谢谢」这类确认或附和。 */
export function ackOnly(content) {
  const text = String(content || '')
    .replace(/@\S+/g, ' ')
    .replace(/[，。！？、,.!?~～…\s]+/g, '')
    .trim()
    .toLowerCase();
  return !!text && ACK_WORDS.has(text);
}

/** 目标消息之后我有没有发过言（按会话顺序判断，同一分钟也准；目标不在本页时按时间兜底）。 */
export function repliedAfter(msgs, target, myId) {
  const index = msgs.findIndex((x) => x.message_id === target.message_id);
  const isMine = (x) => !x.deleted && x.sender?.id === myId && x.message_id !== target.message_id;
  if (index >= 0) return msgs.slice(index + 1).some(isMine);
  return msgs.some((x) => isMine(x) && (x.create_time || '') > (target.create_time || ''));
}

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

// ---------------------------------------------------------------- 分析（锁外异步）

function notifyBudget(cfg, usage, budget) {
  if (usage.budgetAlertAt) return; // 每月只提醒一次
  recordUsage((u) => { u.budgetAlertAt = new Date().toISOString(); });
  try {
    lark.botDm(cfg.me.open_id, `⚠️ 本月分析费用已达上限 $${budget}（估算已用 $${Number(usage.monthCost || 0).toFixed(2)}），暂停自动分析。调整后运行 boss-at-me setup --step reply，或把 config.json 的 reply.monthlyBudgetUsd 设为 0。`);
  } catch (e) {
    log('budget notify failed', e.message);
  }
}

function recordFailure(cfg, ref, err) {
  const alert = recordUsage((u) => {
    u.failStreak = (u.failStreak || 0) + 1;
    u.lastFailAt = new Date().toISOString();
    u.lastError = clip(`${ref}: ${err?.message || err}`, 300);
    if (u.failStreak >= 3 && (!u.lastFailAlertAt || Date.now() - new Date(u.lastFailAlertAt).getTime() > 6 * HOUR)) {
      u.lastFailAlertAt = new Date().toISOString();
      u.failStreak = 0;
      return u.lastError;
    }
    return null;
  });
  if (alert) {
    try {
      lark.botDm(cfg.me.open_id, `⚠️ boss-at-me 连续分析失败，最近一次：${alert}`);
    } catch (e) {
      log('failure alert failed', e.message);
    }
  }
}

/** 分析完成后再查一次会话：分析期间你已经在飞书里回了，就不发草稿。 */
function repliedSince(cfg, job) {
  const m = job.target;
  try {
    const t = parseLarkTime(m.create_time);
    const msgs = lark.chatMessages({
      chatId: m.chat_id,
      start: isoLocal(new Date(t.getTime() - MIN)),
      end: isoLocal(new Date()),
      pageLimit: 2,
    });
    return repliedAfter(msgs, m, cfg.me.open_id);
  } catch (e) {
    log('reply recheck failed', m.message_id, e.message);
    return false;
  }
}

async function processJob(cfg, job) {
  let m = job.target;
  try {
    const usage = readUsage();
    const budget = Number(cfg.reply.monthlyBudgetUsd) || 0;
    if (budget > 0 && usage.monthCost >= budget) {
      log('monthly budget reached, skip', m.message_id, usage.monthCost, budget);
      notifyBudget(cfg, usage, budget);
      return;
    }
    const t = parseLarkTime(job.batch[0].create_time);
    const ctx = lark.chatMessages({
      chatId: m.chat_id,
      start: isoLocal(new Date(t - cfg.tuning.contextLookbackHours * HOUR)),
      end: isoLocal(new Date()),
    });
    if (ackOnly(batchText(job))) {
      log('skip ack-only message', m.message_id);
      return;
    }
    if (job.kind === 'p2p') {
      const tail = unansweredTail(ctx, job, cfg.me.open_id);
      if (!tail.length) {
        log('skip p2p (already replied)', m.message_id);
        return;
      }
      job = { ...job, batch: tail, target: tail[tail.length - 1] };
      m = job.target;
    } else if (repliedAfter(ctx, m, cfg.me.open_id)) {
      log('skip group (already replied)', m.message_id);
      return;
    }
    const res = await analyze(cfg, job, ctx);
    recordUsage((u) => {
      u.monthAnalyses += 1;
      u.dayAnalyses += 1;
      u.monthCost += res._cost || 0;
      u.dayCost += res._cost || 0;
      u.failStreak = 0;
    });
    log('analyzed', job.kind, m.message_id, res.action, res.confidence, 'cost', res._cost);
    if (res.action !== 'skip') {
      if (repliedSince(cfg, job)) {
        log('skip draft (already replied)', m.message_id);
        return;
      }
      log(`drafted #${notifyDraft(cfg, job, res)}`);
    }
  } catch (e) {
    log('analyze failed', m.message_id, e.message);
    recordFailure(cfg, m.message_id, e);
    try {
      lark.botDm(cfg.me.open_id, `【${m.sender?.name} ${jobWhere(job)}】${jobChat(job)} · ${m.create_time}\n原文：${clip(batchText(job), 300)}\n\n⚠️ 自动分析失败：${clip(e.message, 300)}\n${m.message_app_link || ''}`);
    } catch (e2) {
      log('notify failed', e2.message);
    }
  }
}

// ---------------------------------------------------------------- 草稿收口 / 清理

/** 到期前提醒 + 定期汇总未处理草稿。网络调用放在锁外。 */
function maybeNudge(cfg) {
  const hours = Number(cfg.reply.nudgeHours ?? 12);
  const ttl = Number(cfg.tuning.draftTtlHours) || 48;
  const plan = withDrafts((d) => {
    d.usage = rollUsage(d.usage);
    const now = Date.now();
    const pending = Object.entries(d.drafts)
      .filter(([, x]) => x.status === 'pending')
      .sort((a, b) => new Date(a[1].created) - new Date(b[1].created));
    const warns = [];
    for (const [code, x] of pending) {
      if (x.expiryWarned) continue;
      const left = new Date(x.created).getTime() + ttl * HOUR - now;
      if (left > 0 && left <= 2 * HOUR) {
        x.expiryWarned = true;
        warns.push({ code, x, left });
      }
    }
    let digest = null;
    if (hours > 0 && pending.length) {
      const last = d.usage.lastNudgeAt ? new Date(d.usage.lastNudgeAt).getTime() : 0;
      if (now - last >= hours * HOUR) {
        digest = buildPendingDigest(pending, now);
        d.usage.lastNudgeAt = new Date().toISOString();
      }
    }
    return { warns, digest };
  });
  for (const w of plan.warns) {
    notifyMe(cfg, `⏳ #${w.code}（${w.x.sender} @你 · ${w.x.chatName}）将在 ${Math.max(1, Math.ceil(w.left / HOUR))} 小时内过期，回「发 ${w.code} / 不发 ${w.code}」处理。`);
  }
  if (plan.digest) notifyMe(cfg, plan.digest);
}

function gc(cfg, st) {
  const now = Date.now();
  const week = 7 * 24 * HOUR;
  st.seen = Object.fromEntries(Object.entries(st.seen).filter(([, v]) => now - new Date(v) < week));
  const toRefresh = [];
  withDrafts((d) => {
    d.usage = rollUsage(d.usage);
    for (const [code, x] of Object.entries(d.drafts)) {
      if (x.status === 'pending' && now - new Date(x.created) > cfg.tuning.draftTtlHours * HOUR) {
        x.status = 'expired';
        d.usage.monthExpired += 1;
        if (x.cardMessageId) toRefresh.push({ x, code });
      }
    }
    d.drafts = Object.fromEntries(Object.entries(d.drafts).filter(([, x]) => x.status === 'pending' || now - new Date(x.created) < week));
  });
  // 卡片更新是网络调用，放在草稿锁外，避免阻塞确认指令
  for (const { x, code } of toRefresh) refreshCard(x, code);
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

/** 只做「拉取 + 占位」，把要分析的消息返回给调用方；分析在锁外异步跑，避免阻塞下一轮轮询。 */
function collectJobs(cfg, st, { dry }) {
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
  if (dry) {
    for (const job of jobs) log('[dry] new:', job.kind, job.target.create_time, jobChat(job), job.target.sender?.name, clip(batchText(job), 120).replace(/\n/g, ' '));
    return [];
  }
  // 先占位，避免分析期间下一轮把这些消息再处理一遍
  for (const job of jobs) for (const x of job.batch) st.seen[x.message_id] = new Date().toISOString();
  st.lastSearchEnd = end.toISOString();
  return jobs;
}

export async function runOnce(cfg, { dry = false } = {}) {
  if (!acquireLock()) {
    log('another run in progress, skip');
    return;
  }
  let jobs = [];
  try {
    const st = loadState();
    try {
      handleConfirmations(cfg, { dry });
    } catch (e) {
      log('confirmations failed', e.message);
      if (!dry) recordFailure(cfg, 'confirmations', e);
    }
    jobs = collectJobs(cfg, st, { dry });
    if (!dry) {
      try {
        maybeNudge(cfg);
      } catch (e) {
        log('nudge failed', e.message);
      }
      try {
        gc(cfg, st);
      } catch (e) {
        log('gc failed', e.message);
      }
      saveState(st);
    }
  } finally {
    fs.rmSync(LOCK_PATH, { force: true });
  }
  // 锁已释放：分析期间下一轮轮询可以正常进行（消息已占位，不会重复分析）
  for (const job of jobs) await processJob(cfg, job);
}
