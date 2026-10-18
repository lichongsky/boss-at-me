import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LABEL, PLIST_PATH, LISTENER_LABEL, LISTENER_PLIST_PATH, LAUNCH_AGENTS_DIR, LOG_PATH, LEGACY_DIR } from './paths.js';

const CLI_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'boss-at-me.js');
const domain = () => `gui/${process.getuid()}`;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// 两个后台服务：agent 定时拉取 @ / 私聊并起草；listener 常驻接收确认指令，秒级响应
export const SERVICES = {
  agent: { label: LABEL, plist: PLIST_PATH, args: ['run'] },
  listener: { label: LISTENER_LABEL, plist: LISTENER_PLIST_PATH, args: ['listen'] },
};

export function buildPlist(cfg, name = 'agent') {
  const svc = SERVICES[name];
  const dirs = [cfg.bins.node, cfg.bins.lark, cfg.bins.claude].filter(Boolean).map((b) => path.dirname(b));
  const PATH = [...new Set([...dirs, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':');
  const schedule = name === 'listener'
    ? `    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>`
    : `    <key>StartInterval</key>
    <integer>${Number(cfg.reply.intervalSec) || 120}</integer>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${svc.label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${esc(cfg.bins.node || process.execPath)}</string>
        <string>${esc(fs.realpathSync(CLI_PATH))}</string>
${svc.args.map((a) => `        <string>${a}</string>`).join('\n')}
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${esc(PATH)}</string>
    </dict>
${schedule}
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

export function serviceInfo(name = 'agent') {
  const p = launchctl(['print', `${domain()}/${SERVICES[name].label}`]);
  if (p.status !== 0) return { loaded: false };
  const get = (re) => (p.stdout.match(re) || [])[1];
  return {
    loaded: true,
    state: get(/^\s*state = (\S+)/m),
    pid: get(/^\s*pid = (\d+)/m),
    runs: Number(get(/^\s*runs = (\d+)/m) || 0),
    lastExit: get(/last exit code = ([^\n]+)/),
  };
}

function bootstrap(svc) {
  const p = launchctl(['bootstrap', domain(), svc.plist]);
  if (p.status !== 0) throw new Error(`launchctl bootstrap ${svc.label} 失败：${p.stderr}`);
}

export function install(cfg) {
  fs.mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true });
  for (const [name, svc] of Object.entries(SERVICES)) {
    if (isLoaded(svc.label)) launchctl(['bootout', `${domain()}/${svc.label}`]);
    fs.writeFileSync(svc.plist, buildPlist(cfg, name));
    bootstrap(svc);
  }
}

export function pause() {
  for (const svc of Object.values(SERVICES)) {
    if (isLoaded(svc.label)) launchctl(['bootout', `${domain()}/${svc.label}`]);
  }
}

export function resume() {
  if (!fs.existsSync(PLIST_PATH)) throw new Error('还没安装后台服务，请运行 boss-at-me setup --step service');
  for (const svc of Object.values(SERVICES)) {
    if (fs.existsSync(svc.plist) && !isLoaded(svc.label)) bootstrap(svc);
  }
}

export function uninstall() {
  pause();
  for (const svc of Object.values(SERVICES)) fs.rmSync(svc.plist, { force: true });
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
