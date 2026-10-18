import { spawn, spawnSync } from 'node:child_process';

const QUIET_ENV = {
  LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
  LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
};

let binOverride = null;
export function setLarkBin(bin) {
  binOverride = bin;
}
export function larkBin() {
  return binOverride || process.env.LARK_BIN || 'lark-cli';
}

export class LarkError extends Error {
  constructor(message, { exitCode, payload, stderr } = {}) {
    super(message);
    this.exitCode = exitCode;
    this.payload = payload;
    this.stderr = stderr;
  }
  get missingScopes() {
    return this.payload?.error?.missing_scopes || this.payload?.missing || [];
  }
}

function parseJson(text) {
  const s = (text || '').trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** 同步调用 lark-cli，返回解析后的 JSON；退出码非 0 或 ok:false 抛 LarkError。 */
export function lark(args, { timeoutMs = 120_000 } = {}) {
  const p = spawnSync(larkBin(), args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...process.env, ...QUIET_ENV },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (p.error) throw new LarkError(`无法执行 lark-cli：${p.error.message}`, { exitCode: -1 });
  const out = parseJson(p.stdout);
  const errPayload = parseJson(p.stderr);
  if (p.status !== 0 || out?.ok === false) {
    const payload = out || errPayload;
    const msg = payload?.error?.message || payload?.error || (p.stderr || p.stdout || '').slice(-600);
    throw new LarkError(`lark-cli ${args.slice(0, 2).join(' ')} 失败（exit ${p.status}）：${typeof msg === 'string' ? msg : JSON.stringify(msg)}`, {
      exitCode: p.status,
      payload,
      stderr: p.stderr,
    });
  }
  return out ?? {};
}

/** 异步调用会阻塞等待浏览器操作的命令（config init / auth login），实时把输出交给 onOutput。 */
export function larkInteractive(args, { onOutput, timeoutMs = 11 * 60_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(larkBin(), args, { env: { ...process.env, ...QUIET_ENV } });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (d) => {
      stdout += d;
      onOutput?.(String(d), 'stdout');
    });
    child.stderr.on('data', (d) => {
      stderr += d;
      onOutput?.(String(d), 'stderr');
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + e.message });
    });
  });
}

// ---------------------------------------------------------------- 业务封装

export function whoami() {
  const r = lark(['whoami']);
  const u = r.onBehalfOf || {};
  return u.openId ? { open_id: u.openId, name: u.userName } : null;
}

export function configShow() {
  try {
    return lark(['config', 'show']);
  } catch {
    return null;
  }
}

export function authCheck(scopes) {
  const p = spawnSync(larkBin(), ['auth', 'check', '--scope', scopes.join(' ')], {
    encoding: 'utf8',
    env: { ...process.env, ...QUIET_ENV },
  });
  const out = parseJson(p.stdout) || {};
  return { ok: out.ok === true, granted: out.granted || [], missing: out.missing || scopes };
}

export function searchUser(query) {
  const r = lark(['contact', '+search-user', '--as', 'user', '--query', query, '--format', 'json']);
  return r.data?.users || [];
}

/** 搜索指定人发的消息：atMe 只要 @我 的；chatType 限定 group / p2p。 */
export function searchMessages({ senders, start, end, atMe = false, chatType }) {
  const args = ['im', '+messages-search', '--as', 'user', '--sender', senders.join(','),
    '--start', start, '--end', end, '--page-all', '--no-reactions', '--format', 'json'];
  if (atMe) args.push('--is-at-me');
  if (chatType) args.push('--chat-type', chatType);
  return lark(args, { timeoutMs: 300_000 }).data?.messages || [];
}

export function searchMentions({ senders, start, end }) {
  return searchMessages({ senders, start, end, atMe: true });
}

export function chatMessages({ chatId, start, end, pageLimit = 4 }) {
  const r = lark(
    ['im', '+chat-messages-list', '--as', 'user', '--chat-id', chatId, '--start', start, '--end', end,
      '--order', 'asc', '--page-all', '--page-limit', String(pageLimit), '--no-reactions', '--format', 'json'],
    { timeoutMs: 300_000 },
  );
  return r.data?.messages || [];
}

export function replyAsMe(messageId, text) {
  return lark(['im', '+messages-reply', '--as', 'user', '--message-id', messageId, '--text', text]).data;
}

export function botDm(openId, text) {
  return lark(['im', '+messages-send', '--as', 'bot', '--user-id', openId, '--text', text]).data;
}

export function botCard(openId, card) {
  return lark(['im', '+messages-send', '--as', 'bot', '--user-id', openId, '--msg-type', 'interactive', '--content', JSON.stringify(card)]).data;
}

/** 更新机器人发出的卡片（整卡替换） */
export function updateCard(messageId, card) {
  return lark(['api', 'PATCH', `/open-apis/im/v1/messages/${messageId}`, '--as', 'bot', '--data', JSON.stringify({ content: JSON.stringify(card) })]);
}

/** 卡片回调是否已在开发者后台开通；未开通时返回一键开通链接。 */
export function cardCallbackStatus() {
  const p = spawnSync(larkBin(), ['event', 'consume', 'card.action.trigger', '--as', 'bot', '--timeout', '1s'], {
    encoding: 'utf8',
    env: { ...process.env, ...QUIET_ENV },
    input: '',
    timeout: 30_000,
  });
  if (p.status === 0) return { ok: true };
  const err = parseJson(p.stderr)?.error || {};
  return { ok: false, url: (String(err.hint || '').match(/https:\/\/\S+/) || [])[0] || null, message: err.message || (p.stderr || '').slice(-300) };
}
