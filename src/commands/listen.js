import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { loadConfig, configExists, withDrafts, log } from '../lib/store.js';
import { setLarkBin, larkBin } from '../lib/lark.js';
import { handleDmMessage } from '../lib/poller.js';

/**
 * 常驻进程：实时接收我发给机器人的私聊（im.message.receive_v1，机器人身份），
 * 收到「发 N / 改 N / 不发 N」立即处理。由 launchd 保活，进程退出后会被自动拉起。
 */
export function listen() {
  if (!configExists()) throw new Error('还没初始化，请先运行：boss-at-me setup');
  const cfg = loadConfig();
  if (cfg.bins.lark) setLarkBin(cfg.bins.lark);
  if (!cfg.me?.open_id) throw new Error('配置不完整，请运行 boss-at-me setup');

  const child = spawn(larkBin(), ['event', 'consume', 'im.message.receive_v1', '--as', 'bot'], {
    // stdin 保持打开：lark-cli 把 stdin EOF 当作退出信号
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' },
  });

  readline.createInterface({ input: child.stderr }).on('line', (line) => {
    if (/ready|error|exited|connected|disconnect|reconnect/i.test(line)) log('[listen]', line);
  });

  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (ev.chat_type !== 'p2p' || ev.sender_id !== cfg.me.open_id) return;
    try {
      withDrafts((d) => {
        d.dmChatId = d.dmChatId || ev.chat_id;
        handleDmMessage(cfg, d, {
          message_id: ev.message_id,
          sender: { id: ev.sender_id },
          msg_type: ev.message_type,
          content: ev.content,
        });
      });
    } catch (e) {
      log('[listen] handle failed', e.message);
    }
  });

  const stop = () => child.kill('SIGTERM');
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  child.on('close', (code, signal) => {
    log('[listen] lark-cli exited', code ?? signal);
    process.exit(code === 0 ? 0 : 1);
  });
  log('[listen] started');
}
