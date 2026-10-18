import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LABEL, PLIST_PATH, LAUNCH_AGENTS_DIR, LOG_PATH, LEGACY_DIR } from './paths.js';

const CLI_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'boss-at-me.js');
const domain = () => `gui/${process.getuid()}`;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function buildPlist(cfg) {
  const dirs = [cfg.bins.node, cfg.bins.lark, cfg.bins.claude].filter(Boolean).map((b) => path.dirname(b));
  const PATH = [...new Set([...dirs, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${esc(cfg.bins.node || process.execPath)}</string>
        <string>${esc(fs.realpathSync(CLI_PATH))}</string>
        <string>run</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${esc(PATH)}</string>
    </dict>
    <key>StartInterval</key>
    <integer>${Number(cfg.reply.intervalSec) || 120}</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${esc(LOG_PATH)}</string>
    <key>StandardErrorPath</key>
    <string>${esc(LOG_PATH)}</string>
</dict>
</plist>
`;
}

function launchctl(args) {
  return spawnSync('/bin/launchctl', args, { encoding: 'utf8' });
}

export function isLoaded(label = LABEL) {
  return launchctl(['print', `${domain()}/${label}`]).status === 0;
}

export function serviceInfo() {
  const p = launchctl(['print', `${domain()}/${LABEL}`]);
  if (p.status !== 0) return { loaded: false };
  const get = (re) => (p.stdout.match(re) || [])[1];
  return {
    loaded: true,
    state: get(/^\s*state = (\S+)/m),
    runs: Number(get(/^\s*runs = (\d+)/m) || 0),
    lastExit: get(/last exit code = ([^\n]+)/),
  };
}

export function install(cfg) {
  fs.mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true });
  if (isLoaded()) launchctl(['bootout', `${domain()}/${LABEL}`]);
  fs.writeFileSync(PLIST_PATH, buildPlist(cfg));
  const p = launchctl(['bootstrap', domain(), PLIST_PATH]);
  if (p.status !== 0) throw new Error(`launchctl bootstrap 失败：${p.stderr}`);
}

export function pause() {
  if (isLoaded()) launchctl(['bootout', `${domain()}/${LABEL}`]);
}

export function resume() {
  if (!fs.existsSync(PLIST_PATH)) throw new Error('还没安装后台服务，请运行 boss-at-me setup --step service');
  if (!isLoaded()) {
    const p = launchctl(['bootstrap', domain(), PLIST_PATH]);
    if (p.status !== 0) throw new Error(`launchctl bootstrap 失败：${p.stderr}`);
  }
}

export function uninstall() {
  pause();
  fs.rmSync(PLIST_PATH, { force: true });
}

/** 找出调用早期原型 agent.py 的 launchd 任务：[{ label, plist, loaded }] */
export function findLegacyServices() {
  if (!fs.existsSync(LAUNCH_AGENTS_DIR)) return [];
  const out = [];
  for (const f of fs.readdirSync(LAUNCH_AGENTS_DIR)) {
    if (!f.endsWith('.plist')) continue;
    const plist = path.join(LAUNCH_AGENTS_DIR, f);
    let text = '';
    try {
      text = fs.readFileSync(plist, 'utf8');
    } catch {
      continue;
    }
    if (!text.includes(path.join(LEGACY_DIR, 'agent.py'))) continue;
    const label = (text.match(/<key>Label<\/key>\s*<string>([^<]+)<\/string>/) || [])[1];
    if (label) out.push({ label, plist, loaded: isLoaded(label) });
  }
  return out;
}

export function stopLegacy(svc) {
  launchctl(['bootout', `${domain()}/${svc.label}`]);
}
