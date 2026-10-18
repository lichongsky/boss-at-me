import os from 'node:os';
import path from 'node:path';

export const HOME = process.env.BOSS_AT_ME_HOME || path.join(os.homedir(), '.boss-at-me');
export const CONFIG_PATH = path.join(HOME, 'config.json');
export const STATE_PATH = path.join(HOME, 'state.json');
export const LOCK_PATH = path.join(HOME, '.lock');
export const LOG_PATH = path.join(HOME, 'logs', 'agent.log');

export const LABEL = 'com.boss-at-me.agent';
export const LAUNCH_AGENTS_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents');
export const PLIST_PATH = path.join(LAUNCH_AGENTS_DIR, `${LABEL}.plist`);

export const KEYCHAIN_SERVICE = 'boss-at-me';

export const CCSWITCH_DIR = path.join(os.homedir(), '.cc-switch');

// 早期手工原型，setup 时可迁移
export const LEGACY_DIR = path.join(os.homedir(), '.local', 'share', 'lark-mention-agent');
