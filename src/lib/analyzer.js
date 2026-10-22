import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
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
    options: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  // options 不设 required：第三方网关对 schema 的强制力不一，缺失时卡片降级为只显示草稿
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

const clip = (s, n) => {
  const t = String(s || '').trim();
  return t.length <= n ? t : `${t.slice(0, n)}…`;
};

/** job: { kind: 'group' | 'p2p', target: 要回复的那条消息, batch: 本次要处理的消息（私聊可能连发多条） } */
export function buildPrompt(cfg, job, ctx, now = new Date()) {
  const tpl = fs.readFileSync(path.join(ROLES_DIR, `${cfg.role || 'backend'}.md`), 'utf8');
  const m = job.target;
  const me = cfg.me?.name || '我';
  const sender = m.sender?.name || '对方';
  const ids = new Set(job.batch.map((x) => x.message_id));
  const firstTime = job.batch[0].create_time;
  const others = ctx.filter((x) => !ids.has(x.message_id));
  const before = others.filter((x) => x.create_time <= firstTime).slice(-80);
  const after = others.filter((x) => x.create_time > m.create_time).slice(0, 20);
  // 我在同一会话里最近说过的话：给模型学语气，比任何“请像我一样说话”的指令都有效
  const isMe = (x) => (cfg.me?.open_id && x.sender?.id ? x.sender.id === cfg.me.open_id : x.sender?.name === cfg.me?.name);
  const myRecent = others
    .filter((x) => isMe(x) && x.create_time <= firstTime)
    .slice(-8)
    .map((x) => `- ${x.create_time} 我：${clip(x.content, 300)}`)
    .join('\n');
  const p2p = job.kind === 'p2p';
  const vars = {
    me,
    situation: p2p
      ? `${sender} 私聊了${me}${job.batch.length > 1 ? `（连发 ${job.batch.length} 条）` : ''}`
      : `${sender} 在群「${m.chat_name || ''}」里 @了${me}`,
    targetTitle: p2p ? '需要回复的私聊消息' : '被 @ 的消息',
    chatId: m.chat_id || '',
    now: fmtNow(now),
    message: job.batch.map((x) => fmtMsg(x, Math.floor(4000 / job.batch.length))).join('\n'),
    before: before.map((x) => fmtMsg(x)).join('\n') || '（无）',
    after: after.map((x) => fmtMsg(x)).join('\n') || '（无）',
    myStyle: myRecent || '（没有找到你在这个会话里的历史发言）',
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

/** 通用的 claude -p 调用（分析和 setup 自检共用）。异步，避免长时间分析阻塞轮询。 */
export function runClaude(cfg, prompt, { schema = SCHEMA, tools = [], timeoutMs = 900_000, cwd, addDirs = [] } = {}) {
  return new Promise((resolve, reject) => {
    const { env: providerEnv } = resolveProviderEnv(cfg.provider);
    const settings = writeSettingsFile(providerEnv);
    let settled = false;
    let timedOut = false;
    let child = null;
    let timer = null;

    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      settings.cleanup();
      fn(val);
    };

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

      child = spawn(cfg.bins.claude || 'claude', args, {
        cwd: cwd || os.homedir(),
        env: childEnv(cfg),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      finish(reject, new Error(`claude 执行失败：${e.message}`));
      return;
    }

    let stdout = '';
    let stderr = '';
    timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // 兜底：SIGTERM 不生效时强制结束，避免整个 run 挂死
      const force = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // 已退出
        }
        finish(reject, new Error(`claude 超时（${Math.round(timeoutMs / 1000)} 秒）`));
      }, 5000);
      if (force.unref) force.unref();
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => finish(reject, new Error(`claude 执行失败：${e.message}`)));
    child.on('close', (code) => {
      if (timedOut) {
        finish(reject, new Error(`claude 超时（${Math.round(timeoutMs / 1000)} 秒）`));
        return;
      }
      let out;
      try {
        out = JSON.parse(stdout);
      } catch {
        finish(reject, new Error(`claude 输出无法解析（exit ${code}）：${(stdout || '').slice(-300)} ${(stderr || '').slice(-300)}`));
        return;
      }
      if (out.is_error || !out.structured_output) {
        const detail = out.result ?? out.errors ?? '';
        finish(reject, new Error(`claude 返回错误（${out.subtype || 'unknown'}，$${out.total_cost_usd ?? 0}）：${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400)}`));
        return;
      }
      finish(resolve, { ...out.structured_output, _cost: out.total_cost_usd });
    });
  });
}

export async function analyze(cfg, job, ctx) {
  const dirs = [...cfg.sources.projects, ...cfg.sources.docs].map((x) => x.path).filter((p) => fs.existsSync(p));
  const [cwd, ...rest] = dirs;
  return runClaude(cfg, buildPrompt(cfg, job, ctx), {
    tools: allowedTools(cfg),
    cwd,
    addDirs: rest,
  });
}

// ---------------------------------------------------------------- 结果质检

const EVIDENCE_RE = new RegExp([
  String.raw`[\w.@-]+\.(?:js|mjs|cjs|ts|tsx|jsx|java|py|go|kt|rb|php|md|json|ya?ml|sql|xml|sh|html|css)(?::\d+)?`,
  String.raw`\b\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}`,
  String.raw`lark-cli\s`,
  String.raw`message_id|chat_id`,
].join('|'));

/** analysis 里是否引用了具体依据（文件路径/行号、聊天时间、lark-cli 命令）。 */
export function hasEvidence(text) {
  return EVIDENCE_RE.test(String(text || ''));
}

const INJECTION_PATTERNS = [
  /忽略.{0,8}(之前|以上|上面|前面).{0,8}(指令|要求|提示|规则)/,
  /ignore\s+(all\s+)?(previous|above|prior)\s+instructions/i,
  /(system|系统)\s*(prompt|提示词)/i,
  /(把|将).{0,12}(发|转|告诉|同步).{0,12}(出去|给他|给她|给对方|给群|群里|外部)/,
  /(以|用).{0,6}(我|他|她)的?(身份|名义).{0,8}(发|回)/,
];

/** 聊天内容里是否出现「让模型执行操作」的可疑指令（提示注入）。 */
export function looksSuspicious(text) {
  return INJECTION_PATTERNS.some((re) => re.test(String(text || '')));
}
