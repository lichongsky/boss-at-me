import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { CCSWITCH_DIR } from './paths.js';
import { getSecret } from './keychain.js';

const require = createRequire(import.meta.url);
export const PRESETS = require('../providers.json');

export const TOKEN_ACCOUNT = 'provider-token';

// provider 配置形态：
//   { type: 'ccswitch' }                     每轮读取 CC Switch 当前生效的 Claude 供应商
//   { type: 'anthropic-login' }              用本机 claude 已登录的账号
//   { type: 'anthropic-key' }                Anthropic API Key（存钥匙串）
//   { type: 'gateway', name, presetId?, baseUrl, model, env }   兼容 Anthropic 接口的网关/厂商（token 存钥匙串）

export function ccSwitchAvailable(dir = CCSWITCH_DIR) {
  return fs.existsSync(path.join(dir, 'cc-switch.db'));
}

/** 读取 CC Switch 当前生效的 Claude Code 供应商（只读）。返回 { id, name, env }。 */
export function readCcSwitchProvider(dir = CCSWITCH_DIR) {
  const db = path.join(dir, 'cc-switch.db');
  if (!fs.existsSync(db)) throw new Error(`没找到 CC Switch 数据库：${db}`);
  let currentId = null;
  try {
    currentId = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).currentProviderClaude || null;
  } catch {
    // 老版本没有 settings.json，回退到 is_current
  }
  const p = spawnSync('/usr/bin/sqlite3', ['-readonly', '-json', db,
    "select id, name, settings_config, is_current from providers where app_type = 'claude'"], { encoding: 'utf8' });
  if (p.status !== 0) throw new Error(`读取 CC Switch 数据库失败：${p.stderr}`);
  const rows = p.stdout.trim() ? JSON.parse(p.stdout) : [];
  const row = rows.find((r) => r.id === currentId) || rows.find((r) => Number(r.is_current) === 1);
  if (!row) throw new Error('CC Switch 里没有当前生效的 Claude 供应商');
  let settings = {};
  try {
    settings = JSON.parse(row.settings_config || '{}');
  } catch {
    throw new Error(`CC Switch 供应商「${row.name}」配置无法解析`);
  }
  const env = {};
  for (const [k, v] of Object.entries(settings.env || {})) {
    if (/^(ANTHROPIC_|CLAUDE_CODE_|API_TIMEOUT_MS$)/.test(k) && typeof v === 'string') env[k] = v;
  }
  if (env.ANTHROPIC_BASE_URL && /\/\/(127\.0\.0\.1|localhost)[:/]/.test(env.ANTHROPIC_BASE_URL)) {
    throw new Error(`CC Switch 供应商「${row.name}」指向本地代理，无法直连上游`);
  }
  return { id: row.id, name: row.name, env };
}

function modelEnv(model) {
  if (!model) return {};
  return {
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
  };
}

/** 生成交给 `claude --settings` 的 env，以及一句给人看的描述。 */
export function resolveProviderEnv(provider, { secret = getSecret, ccSwitchDir } = {}) {
  if (!provider) throw new Error('还没配置模型供应商，请运行 boss-at-me setup --step provider');
  switch (provider.type) {
    case 'ccswitch': {
      const p = readCcSwitchProvider(ccSwitchDir);
      return { env: p.env, label: `CC Switch：${p.name}` };
    }
    case 'anthropic-login':
      return { env: {}, label: 'Anthropic（本机 claude 登录态）' };
    case 'anthropic-key': {
      const key = secret(TOKEN_ACCOUNT);
      if (!key) throw new Error('钥匙串里没有 API Key，请运行 boss-at-me setup --step provider');
      return { env: { ANTHROPIC_API_KEY: key, ANTHROPIC_AUTH_TOKEN: '' }, label: 'Anthropic API Key' };
    }
    case 'gateway': {
      const token = secret(TOKEN_ACCOUNT);
      if (!token) throw new Error('钥匙串里没有供应商 token，请运行 boss-at-me setup --step provider');
      return {
        env: {
          ANTHROPIC_BASE_URL: provider.baseUrl,
          ANTHROPIC_AUTH_TOKEN: token,
          ANTHROPIC_API_KEY: '',
          ...modelEnv(provider.model),
          ...(provider.env || {}),
        },
        label: `${provider.name || provider.baseUrl}${provider.model ? `（${provider.model}）` : ''}`,
      };
    }
    default:
      throw new Error(`未知的供应商类型：${provider.type}`);
  }
}

/** 把 env 写成 0600 的临时 settings 文件，返回 { file, cleanup }。 */
export function writeSettingsFile(env) {
  const file = path.join(os.tmpdir(), `boss-at-me-${process.pid}-${crypto.randomBytes(6).toString('hex')}.json`);
  fs.writeFileSync(file, JSON.stringify({ env }), { mode: 0o600 });
  return { file, cleanup: () => fs.rmSync(file, { force: true }) };
}
