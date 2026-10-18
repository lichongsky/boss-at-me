import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveProviderEnv, writeSettingsFile } from './provider.js';

const ROLES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'roles');

export const SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['reply', 'notify', 'skip'] },
    summary: { type: 'string' },
    analysis: { type: 'string' },
    draft: { type: 'string' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: ['action', 'summary', 'analysis', 'draft', 'confidence'],
};

export function allowedTools(cfg) {
  const tools = [
    'Read', 'Grep', 'Glob',
    'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git blame:*)',
    'Bash(lark-cli im +chat-messages-list:*)',
    'Bash(lark-cli im +threads-messages-list:*)',
    'Bash(lark-cli im +messages-mget:*)',
    'Bash(lark-cli im +messages-search:*)',
  ];
  if (cfg.sources.feishuDocs) tools.push('Bash(lark-cli docs +fetch:*)');
  return tools;
}

export function fmtMsg(m, limit = 800) {
  const s = m.sender || {};
  let c = (m.content || '').trim();
  if (c.length > limit) c = `${c.slice(0, limit)}…（截断）`;
  return `[${m.create_time}] ${s.name || s.id} (${m.message_id}):\n${c}`;
}

function fmtNow(d = new Date()) {
  const wk = '日一二三四五六'[d.getDay()];
  return `${d.toLocaleString('sv-SE', { hour12: false }).slice(0, 16)}（周${wk}）`;
}

function fmtList(items) {
  return items.length ? items.map((x) => `- ${x.path} ：${x.desc || '（无说明）'}`).join('\n') : '（无）';
}

export function buildPrompt(cfg, m, ctx, now = new Date()) {
  const tpl = fs.readFileSync(path.join(ROLES_DIR, `${cfg.role || 'backend'}.md`), 'utf8');
  const others = ctx.filter((x) => x.message_id !== m.message_id);
  const before = others.filter((x) => x.create_time <= m.create_time).slice(-80);
  const after = others.filter((x) => x.create_time > m.create_time).slice(0, 20);
  const vars = {
    me: cfg.me?.name || '我',
    sender: m.sender?.name || '对方',
    chat: m.chat_name || '',
    chatId: m.chat_id || '',
    now: fmtNow(now),
    message: fmtMsg(m, 4000),
    before: before.map((x) => fmtMsg(x)).join('\n') || '（无）',
    after: after.map((x) => fmtMsg(x)).join('\n') || '（无）',
    projects: fmtList(cfg.sources.projects),
    docs: fmtList(cfg.sources.docs),
    feishuDocs: cfg.sources.feishuDocs
      ? '聊天里出现飞书文档/知识库链接时，可以用 `lark-cli docs +fetch --as user --doc <链接> --doc-format markdown` 读取。'
      : '',
  };
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in vars ? vars[k] : ''));
}

/** 子进程环境：去掉父进程（可能是另一个 Claude Code 会话）注入的变量，补齐 PATH。 */
export function childEnv(cfg) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('CLAUDE_CODE_') || k.startsWith('ANTHROPIC_') || k === 'CLAUDECODE' || k === 'CLAUDE_AGENT_SDK_VERSION') continue;
    env[k] = v;
  }
  const dirs = [cfg.bins.lark, cfg.bins.claude, cfg.bins.node].filter(Boolean).map((b) => path.dirname(b));
  env.PATH = [...new Set([...dirs, ...(env.PATH || '/usr/bin:/bin').split(':')])].join(':');
  env.LARKSUITE_CLI_NO_UPDATE_NOTIFIER = '1';
  env.LARKSUITE_CLI_NO_SKILLS_NOTIFIER = '1';
  return env;
}

/** 通用的 claude -p 调用（分析和 setup 自检共用）。 */
export function runClaude(cfg, prompt, { schema = SCHEMA, tools = [], timeoutMs = 900_000, cwd, addDirs = [] } = {}) {
  const { env: providerEnv } = resolveProviderEnv(cfg.provider);
  const settings = writeSettingsFile(providerEnv);
  try {
    const args = ['-p', prompt,
      '--settings', settings.file,
      '--setting-sources', 'project',
      '--output-format', 'json',
      '--json-schema', JSON.stringify(schema),
      '--permission-mode', 'dontAsk',
      '--strict-mcp-config',
      '--no-session-persistence',
      '--max-budget-usd', String(cfg.reply.budgetUsd ?? 2),
      '--effort', cfg.reply.effort || 'medium'];
    if (tools.length) args.push('--allowedTools', tools.join(','));
    for (const d of addDirs) args.push('--add-dir', d);
    const p = spawnSync(cfg.bins.claude || 'claude', args, {
      encoding: 'utf8',
      cwd: cwd || os.homedir(),
      env: childEnv(cfg),
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (p.error) throw new Error(`claude 执行失败：${p.error.message}`);
    let out;
    try {
      out = JSON.parse(p.stdout);
    } catch {
      throw new Error(`claude 输出无法解析（exit ${p.status}）：${(p.stdout || '').slice(-300)} ${(p.stderr || '').slice(-300)}`);
    }
    if (out.is_error || !out.structured_output) {
      const detail = out.result ?? out.errors ?? '';
      throw new Error(`claude 返回错误（${out.subtype || 'unknown'}，$${out.total_cost_usd ?? 0}）：${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400)}`);
    }
    return { ...out.structured_output, _cost: out.total_cost_usd };
  } finally {
    settings.cleanup();
  }
}

export function analyze(cfg, m, ctx) {
  const dirs = [...cfg.sources.projects, ...cfg.sources.docs].map((x) => x.path).filter((p) => fs.existsSync(p));
  const [cwd, ...rest] = dirs;
  return runClaude(cfg, buildPrompt(cfg, m, ctx), {
    tools: allowedTools(cfg),
    cwd,
    addDirs: rest,
  });
}
