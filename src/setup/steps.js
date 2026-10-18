import fs from 'node:fs';
import path from 'node:path';
import { input, select, confirm, password, number } from '@inquirer/prompts';
import * as lark from '../lib/lark.js';
import { PRESETS, TOKEN_ACCOUNT, ccSwitchAvailable, readCcSwitchProvider, resolveProviderEnv } from '../lib/provider.js';
import { setSecret } from '../lib/keychain.js';
import { runClaude } from '../lib/analyzer.js';
import { isoLocal } from '../lib/poller.js';
import * as launchd from '../lib/launchd.js';
import { loadState, saveState, DEFAULT_SIGNATURE } from '../lib/store.js';
import { LEGACY_DIR, LOG_PATH } from '../lib/paths.js';
import { envProxy } from '../lib/update.js';
import { c, ok, warn, fail, info, which, expandHome, openUrl, firstUrl, guessDescription, runInherit } from './util.js';

export const REQUIRED_SCOPES = [
  'search:message',
  'im:message:readonly',
  'im:message.group_msg:get_as_user',
  'im:message.p2p_msg:get_as_user',
  'im:message.reactions:read',
  'im:chat:read',
  'contact:user:search',
  'im:message',
  'im:message.send_as_user',
];
export const DOC_SCOPES = ['docx:document:readonly', 'wiki:node:read'];

export function requiredScopes(cfg) {
  return cfg.sources.feishuDocs ? [...REQUIRED_SCOPES, ...DOC_SCOPES] : REQUIRED_SCOPES;
}

// ---------------------------------------------------------------- 1. 环境检查

export async function preflight(cfg) {
  if (process.platform !== 'darwin') throw new Error('目前只支持 macOS');
  ok(`macOS，Node ${process.version}`);
  cfg.bins.node = process.execPath;
  // 只用于后台检查新版本（访问 GitHub）；飞书和模型请求不走它
  const proxy = envProxy();
  cfg.network = { ...cfg.network, proxy };
  if (proxy) ok(`检查更新将使用代理：${proxy}`);

  let claude = which('claude');
  if (!claude) {
    warn('没找到 claude（Claude Code 命令行），它是分析消息的执行引擎');
    if (await confirm({ message: '现在用 npm 安装 @anthropic-ai/claude-code 吗？', default: true })) {
      runInherit('npm', ['install', '-g', '@anthropic-ai/claude-code']);
      claude = which('claude');
    }
    if (!claude) throw new Error('请先安装 Claude Code：https://docs.claude.com/claude-code ，然后重新运行 setup');
  }
  cfg.bins.claude = claude;
  ok(`claude：${claude}`);

  let larkCli = which('lark-cli');
  if (!larkCli) {
    warn('没找到 lark-cli（飞书官方命令行）');
    if (await confirm({ message: '现在用 npm 安装 @larksuite/cli 吗？', default: true })) {
      runInherit('npm', ['install', '-g', '@larksuite/cli']);
      larkCli = which('lark-cli');
    }
    if (!larkCli) throw new Error('请先安装：npm install -g @larksuite/cli');
  }
  cfg.bins.lark = larkCli;
  lark.setLarkBin(larkCli);
  ok(`lark-cli：${larkCli}`);

  if (await confirm({ message: '顺带给本机的 AI agent（Claude Code、Codex 等）装上飞书 skills 吗？装了以后它们也能直接操作飞书', default: false })) {
    runInherit('npx', ['-y', 'skills', 'add', 'larksuite/cli', '-y', '-g']);
  }
}

// ---------------------------------------------------------------- 2. 飞书应用

export async function larkApp() {
  const shown = lark.configShow();
  if (shown?.appId) {
    ok(`本机已配置飞书应用：${shown.appId}`);
    if (await confirm({ message: '复用这个应用吗？', default: true })) return;
    warn('重新创建会清掉 lark-cli 里现有的应用和所有登录授权，其他用到 lark-cli 的工具也会受影响');
    if (!(await confirm({ message: '确定要新建吗？', default: false }))) return;
  }
  info('将为你创建一个个人飞书应用（机器人），浏览器会打开确认页面…');
  let opened = false;
  const r = await lark.larkInteractive(['config', 'init', '--new'], {
    onOutput: (chunk) => {
      const url = firstUrl(chunk, /https:\/\/\S*(feishu|larksuite)\S*/);
      if (url && !opened) {
        opened = true;
        info(`如果浏览器没自动打开，请手动访问：\n  ${c.cyan(url)}`);
        openUrl(url);
        info('等待你在浏览器里完成…（最长 10 分钟）');
      }
    },
  });
  if (r.code !== 0) throw new Error(`创建飞书应用失败：${(r.stderr || '').slice(-400)}`);
  const appId = (r.stdout.match(/"appId":\s*"([^"]+)"/) || [])[1];
  ok(`飞书应用创建成功${appId ? `：${appId}` : ''}`);
}

// ---------------------------------------------------------------- 3. 飞书授权

export async function larkAuth(cfg) {
  const scopes = requiredScopes(cfg);
  let chk = lark.authCheck(scopes);
  if (!chk.ok) {
    info(`需要授权 ${chk.missing.length} 项权限：${c.dim(chk.missing.join(' '))}`);
    let opened = false;
    let output = '';
    const r = await lark.larkInteractive(['auth', 'login', '--scope', chk.missing.join(' ')], {
      onOutput: (chunk) => {
        output += chunk;
        const url = firstUrl(output, /https:\/\/accounts\.\S+/);
        if (url && !opened) {
          opened = true;
          info(`如果浏览器没自动打开，请手动访问：\n  ${c.cyan(url)}`);
          openUrl(url);
          info('请在浏览器里勾选全部权限并点「授权」…');
        }
      },
    });
    output += r.stdout + r.stderr;
    chk = lark.authCheck(scopes);
    if (!chk.ok) {
      if (output.includes('待审核')) {
        warn(`以下权限要等企业管理员审批：${chk.missing.join(' ')}`);
        info('审批通过后飞书「开发者小助手」会通知你，到时运行：boss-at-me setup --step lark-auth');
        if (chk.missing.every((s) => s === 'im:message.send_as_user')) {
          info('在此之前仍可正常收到草稿，只是「发 N」时需要你手动复制回复');
        }
      } else {
        fail(`仍缺少权限：${chk.missing.join(' ')}`);
        info('可能是授权页没有全部勾选，稍后运行 boss-at-me setup --step lark-auth 重试');
      }
    }
  }
  if (chk.ok) ok('飞书权限齐全');
  const me = lark.whoami();
  if (!me) throw new Error('获取当前飞书用户失败，请检查授权');
  cfg.me = me;
  ok(`当前飞书用户：${me.name}（${me.open_id}）`);
}

// ---------------------------------------------------------------- 4. 监听名单

async function pickUser(name) {
  let users;
  try {
    users = lark.searchUser(name);
  } catch (e) {
    fail(`搜索失败：${e.message}`);
    return null;
  }
  if (!users.length) {
    warn(`通讯录里没搜到「${name}」`);
    return null;
  }
  const choices = users.slice(0, 10).map((u) => ({
    name: [u.localized_name, u.department, u.enterprise_email || u.email].filter(Boolean).join(' · '),
    value: u,
  }));
  choices.push({ name: '都不是', value: null });
  const u = await select({ message: `「${name}」是哪一位？`, choices });
  return u ? { open_id: u.open_id, name: u.localized_name } : null;
}

async function addWatch(cfg, name) {
  const u = await pickUser(name);
  if (!u) return;
  if (cfg.watch.some((w) => w.open_id === u.open_id)) info(`${u.name} 已在名单里`);
  else {
    cfg.watch.push(u);
    ok(`已添加：${u.name}`);
  }
}

export async function watch(cfg, ctx) {
  if (!cfg.watch.length) {
    for (const name of ctx.preset?.watch || []) await addWatch(cfg, name);
  }
  for (;;) {
    info(`当前监听：${cfg.watch.length ? cfg.watch.map((w) => w.name).join('、') : '（空）'}`);
    const choices = [{ name: '添加', value: 'add' }];
    if (cfg.watch.length) choices.push({ name: '删除', value: 'remove' }, { name: '完成', value: 'done' });
    const action = await select({ message: '监听名单：', choices, default: cfg.watch.length ? 'done' : 'add' });
    if (action === 'done') break;
    if (action === 'add') {
      const name = (await input({ message: '输入飞书姓名：' })).trim();
      if (name) await addWatch(cfg, name);
    } else {
      const id = await select({
        message: '删除谁？',
        choices: [...cfg.watch.map((w) => ({ name: w.name, value: w.open_id })), { name: '取消', value: null }],
      });
      if (id) {
        const w = cfg.watch.find((x) => x.open_id === id);
        cfg.watch = cfg.watch.filter((x) => x.open_id !== id);
        ok(`已删除：${w.name}`);
      }
    }
  }

  cfg.p2p.enabled = await confirm({
    message: '他们私聊你的消息也处理吗？（不加的话只处理群里 @你 的）',
    default: true,
  });
  if (cfg.p2p.enabled) {
    cfg.p2p.quietMin = await number({
      message: '对方发完消息后等几分钟再分析？（期间对方还在连发会合并处理，你自己回了就跳过）',
      default: cfg.p2p.quietMin,
      min: 1,
      max: 30,
    });
  }
}

// ---------------------------------------------------------------- 5. 模型供应商

async function askToken(message) {
  for (;;) {
    const t = (await password({ message, mask: '*' })).trim();
    if (t.length >= 8) return t;
    warn('看起来不完整，请重新粘贴');
  }
}

async function chooseProvider(cfg, ctx) {
  const pre = ctx.preset?.provider;
  const choices = [];
  if (ccSwitchAvailable()) {
    let label = '跟随 CC Switch 当前供应商';
    try {
      label += `（现在是「${readCcSwitchProvider().name}」，切换后自动跟随）`;
    } catch (e) {
      label += `（读取失败：${e.message}）`;
    }
    choices.push({ name: label, value: { type: 'ccswitch' } });
  }
  if (pre?.baseUrl) choices.push({ name: `${pre.name || '预设网关'}（${pre.baseUrl}）`, value: { type: 'gateway', ...pre } });
  for (const p of PRESETS) choices.push({ name: p.name, value: { type: 'gateway', presetId: p.id } });
  choices.push(
    { name: 'Anthropic 官方（用本机 claude 已登录的账号）', value: { type: 'anthropic-login' } },
    { name: 'Anthropic 官方（API Key）', value: { type: 'anthropic-key' } },
    { name: '自定义（兼容 Anthropic 接口的地址 + token）', value: { type: 'gateway', presetId: 'custom' } },
  );
  const picked = await select({ message: '分析消息用哪个模型供应商？', choices, pageSize: 14 });

  if (picked.type === 'ccswitch' || picked.type === 'anthropic-login') return picked;
  if (picked.type === 'anthropic-key') {
    setSecret(TOKEN_ACCOUNT, await askToken('粘贴 Anthropic API Key：'));
    return picked;
  }
  let p;
  if (picked.presetId === 'custom') {
    p = {
      type: 'gateway',
      name: (await input({ message: '给这个供应商起个名字：', default: '自定义' })).trim(),
      baseUrl: (await input({ message: 'ANTHROPIC_BASE_URL：', validate: (v) => /^https?:\/\//.test(v.trim()) || '需要 http(s) 地址' })).trim(),
      model: (await input({ message: '模型名（留空用服务端默认）：' })).trim() || undefined,
      env: {},
    };
  } else if (picked.presetId) {
    const preset = PRESETS.find((x) => x.id === picked.presetId);
    info(`API Key 在这里获取：${c.cyan(preset.keyUrl)}`);
    p = {
      type: 'gateway', presetId: preset.id, name: preset.name, baseUrl: preset.baseUrl,
      model: (await input({ message: '模型名：', default: preset.model })).trim(),
      env: preset.env,
    };
  } else {
    p = { ...picked, env: picked.env || {} };
  }
  setSecret(TOKEN_ACCOUNT, await askToken(`粘贴「${p.name}」的 token / API Key（不会显示，存进钥匙串）：`));
  return p;
}

export async function provider(cfg, ctx) {
  if (cfg.provider) {
    let label = cfg.provider.type;
    try {
      label = resolveProviderEnv(cfg.provider).label;
    } catch (e) {
      label += `（${e.message}）`;
    }
    info(`当前供应商：${label}`);
    if (!(await confirm({ message: '要更换吗？', default: false }))) return testProvider(cfg);
  }
  for (;;) {
    cfg.provider = await chooseProvider(cfg, ctx);
    if (await testProvider(cfg)) return;
    if (!(await confirm({ message: '要重新选择供应商吗？', default: true }))) return;
  }
}

async function testProvider(cfg) {
  info('正在调用一次模型验证…');
  try {
    const r = runClaude(cfg, '只回复 ok', {
      schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
      timeoutMs: 180_000,
    });
    ok(`模型可用（${resolveProviderEnv(cfg.provider).label}，本次 $${(r._cost ?? 0).toFixed(3)}）`);
    return true;
  } catch (e) {
    fail(`模型调用失败：${e.message}`);
    return false;
  }
}

// ---------------------------------------------------------------- 6. 分析来源

async function collectDirs(list, { what, example }) {
  if (list.length) {
    info(`当前${what}：\n${list.map((x) => `    ${x.path}  ${c.dim(x.desc)}`).join('\n')}`);
    if (!(await confirm({ message: `要修改${what}吗？`, default: false }))) return list;
    list = [];
  }
  for (;;) {
    const raw = (await input({ message: `粘贴${what}路径（${example}，直接回车结束）：` })).trim().replace(/^['"]|['"]$/g, '');
    if (!raw) break;
    const dir = path.resolve(expandHome(raw));
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      warn(`不是有效目录：${dir}`);
      continue;
    }
    if (list.some((x) => x.path === dir)) continue;
    const desc = (await input({ message: '一句话说明它是什么（AI 靠这个判断该查哪里）：', default: guessDescription(dir) })).trim();
    list.push({ path: dir, desc });
    ok(`已添加：${dir}`);
  }
  return list;
}

export async function sources(cfg, ctx) {
  info('岗位：后端研发。AI 会从下面这些地方找依据来起草回复（只读）。');
  cfg.sources.projects = await collectDirs(cfg.sources.projects, { what: '项目代码目录', example: '如 ~/code/order-service' });
  cfg.sources.docs = await collectDirs(cfg.sources.docs, { what: '本地文档目录', example: '如需求文档、运维手册所在文件夹' });
  const before = cfg.sources.feishuDocs;
  cfg.sources.feishuDocs = await confirm({
    message: '聊天里出现飞书文档 / 知识库链接时，允许 AI 读取吗？（需要额外的文档读取权限）',
    default: before || true,
  });
  if (cfg.sources.feishuDocs && !before) {
    info('补充文档读取权限…');
    await larkAuth(cfg, ctx);
  }
}

// ---------------------------------------------------------------- 7. 回复设置

export async function reply(cfg, ctx) {
  const pre = ctx.preset || {};
  const sig = await input({
    message: '确认发送的草稿末尾加什么标识？（输入 none 表示不加）',
    default: (pre.signature ?? cfg.reply.signature ?? DEFAULT_SIGNATURE).trim(),
  });
  cfg.reply.signature = sig.trim().toLowerCase() === 'none' ? '' : `\n${sig.trim()}`;
  cfg.reply.intervalSec = await number({ message: '每隔多少秒检查一次新消息？', default: pre.intervalSec ?? cfg.reply.intervalSec, min: 30, max: 3600 });
  cfg.reply.budgetUsd = await number({ message: '单条消息分析的费用上限（美元）？', default: pre.budgetUsd ?? cfg.reply.budgetUsd, min: 0.1, max: 20, step: 'any' });
}

// ---------------------------------------------------------------- 8. 自检

export async function selftest(cfg) {
  const data = lark.botDm(cfg.me.open_id, '【boss-at-me 测试】这是草稿通道：以后有人 @你，分析结果和回复草稿会发到这里，你在这里回「发 N / 改 N 内容 / 不发 N」即可。');
  const st = loadState();
  st.dmChatId = data?.chat_id || st.dmChatId;
  saveState(st);
  if (await confirm({ message: '飞书里收到机器人发来的【boss-at-me 测试】私聊了吗？', default: true })) {
    ok('草稿通道正常');
  } else {
    warn('没收到的话，检查飞书应用的「可用范围」是否包含你本人，以及机器人能力是否开启');
  }
  const now = new Date();
  const msgs = lark.searchMentions({
    senders: cfg.watch.map((w) => w.open_id),
    start: isoLocal(new Date(now - 24 * 3600_000)),
    end: isoLocal(now),
  });
  ok(`最近 24 小时，监听名单里的人 @你 ${msgs.length} 次（这些不会被补处理，只处理之后的新消息）`);
}

// ---------------------------------------------------------------- 9. 后台服务

export async function service(cfg) {
  for (const svc of launchd.findLegacyServices()) {
    if (svc.loaded) {
      launchd.stopLegacy(svc);
      ok(`已停用旧版服务 ${svc.label}（${svc.plist} 保留，可手动删除）`);
    }
  }
  launchd.install(cfg);
  ok(`后台服务已启动，每 ${cfg.reply.intervalSec} 秒检查一次`);
  await new Promise((r) => setTimeout(r, 8000));
  const s = launchd.serviceInfo();
  info(`服务状态：${s.loaded ? `已加载，已运行 ${s.runs} 次，上次退出码 ${s.lastExit ?? '-'}` : '未加载'}`);
  info(`日志：${LOG_PATH}`);
}

// ---------------------------------------------------------------- 迁移早期原型

export function legacyConfig() {
  const p = path.join(LEGACY_DIR, 'config.json');
  if (!fs.existsSync(p)) return null;
  try {
    return { cfg: JSON.parse(fs.readFileSync(p, 'utf8')), state: JSON.parse(fs.readFileSync(path.join(LEGACY_DIR, 'state.json'), 'utf8')) };
  } catch {
    return null;
  }
}

export async function migrate(cfg) {
  const legacy = legacyConfig();
  if (!legacy) return false;
  if (!(await confirm({ message: `检测到旧版配置（${LEGACY_DIR}），导入监听名单、项目目录和待确认草稿吗？`, default: true }))) return false;
  const old = legacy.cfg;
  cfg.watch = Object.entries(old.watch_senders || {}).map(([open_id, name]) => ({ open_id, name }));
  cfg.sources.projects = Object.entries(old.repos || {}).map(([p, desc]) => ({ path: p, desc }));
  if (typeof old.signature === 'string') cfg.reply.signature = old.signature;
  const os = legacy.state;
  const st = loadState();
  st.dmChatId = os.dm_chat_id || st.dmChatId;
  st.dmSeen = os.dm_seen || [];
  st.seen = os.seen || {};
  st.lastSearchEnd = os.last_search_end ? new Date(os.last_search_end).toISOString() : null;
  st.nextCode = os.next_code || 1;
  st.drafts = Object.fromEntries(Object.entries(os.drafts || {}).map(([code, d]) => [code, {
    status: d.status, messageId: d.message_id, chatId: d.chat_id, chatName: d.chat_name, sender: d.sender,
    draft: d.draft, action: d.action, created: new Date(d.created).toISOString(), link: d.link,
  }]));
  saveState(st);
  ok(`已导入：监听 ${cfg.watch.length} 人，项目 ${cfg.sources.projects.length} 个，草稿 ${Object.keys(st.drafts).length} 条`);
  return true;
}
