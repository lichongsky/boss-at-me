import os from 'node:os';
import path from 'node:path';

export const HOME = process.env.BOSS_AT_ME_HOME || path.join(os.homedir(), '.boss-at-me');
export const CONFIG_PATH = path.join(HOME, 'config.json');
export const STATE_PATH = path.join(HOME, 'state.json');
export const LOCK_PATH = path.join(HOME, '.lock');
// 草稿和确认指令单独存放：轮询进程和实时监听进程都会改它，用短锁串行化
export const DRAFTS_PATH = path.join(HOME, 'drafts.json');
export const DRAFTS_LOCK_PATH = path.join(HOME, '.drafts.lock');
export const LOG_PATH = path.join(HOME, 'logs', 'agent.log');

export const LABEL = 'com.boss-at-me.agent';
export const LAUNCH_AGENTS_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents');
export const PLIST_PATH = path.join(LAUNCH_AGENTS_DIR, `${LABEL}.plist`);
export const LISTENER_LABEL = 'com.boss-at-me.listener';
export const LISTENER_PLIST_PATH = path.join(LAUNCH_AGENTS_DIR, `${LISTENER_LABEL}.plist`);

export const KEYCHAIN_SERVICE = 'boss-at-me';

export const CCSWITCH_DIR = path.join(os.homedir(), '.cc-switch');

// 早期手工原型，setup 时可迁移
export const LEGACY_DIR = path.join(os.homedir(), '.local', 'share', 'lark-mention-agent');
