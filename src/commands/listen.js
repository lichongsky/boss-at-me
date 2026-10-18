import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { loadConfig, configExists, withDrafts, log } from '../lib/store.js';
import { setLarkBin, larkBin } from '../lib/lark.js';
import { handleDmMessage, handleCardAction } from '../lib/poller.js';

const QUIET_ENV = { LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' };

/** 启动一个 lark-cli 事件消费进程，每行一个事件交给 onEvent。 */
function consume(eventKey, onEvent) {
  const child = spawn(larkBin(), ['event', 'consume', eventKey, '--as', 'bot'], {
    // stdin 保持打开：lark-cli 把 stdin EOF 当作退出信号
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...QUIET_ENV },
  });
  let stderr = '';
  readline.createInterface({ input: child.stderr }).on('line', (line) => {
    stderr += `${line}\n`;
    if (/ready|exited|connected|disconnect|reconnect/i.test(line)) log(`[listen:${eventKey}]`, line);
  });
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    try {
      onEvent(ev);
    } catch (e) {
      log(`[listen:${eventKey}] handle failed`, e.message);
    }
  });
  child.stderrText = () => stderr;
  return child;
}

/**
 * 常驻进程：实时接收我发给机器人的文字指令（im.message.receive_v1）和草稿卡片的按钮点击（card.action.trigger），
 * 立即处理。由 launchd 保活。卡片回调没开通时只跑文字指令，不影响使用。
 */
export function listen() {
  if (!configExists()) throw new Error('还没初始化，请先运行：boss-at-me setup');
  const cfg = loadConfig();
  if (cfg.bins.lark) setLarkBin(cfg.bins.lark);
  if (!cfg.me?.open_id) throw new Error('配置不完整，请运行 boss-at-me setup');

  const messages = consume('im.message.receive_v1', (ev) => {
    if (ev.chat_type !== 'p2p' || ev.sender_id !== cfg.me.open_id) return;
    withDrafts((d) => {
      d.dmChatId = d.dmChatId || ev.chat_id;
      handleDmMessage(cfg, d, { message_id: ev.message_id, sender: { id: ev.sender_id }, msg_type: ev.message_type, content: ev.content });
    });
  });

  const children = [messages];
  if (cfg.reply.cards !== false) {
    const cards = consume('card.action.trigger', (ev) => {
      log('[listen] card action', ev.action_name, ev.message_id);
      withDrafts((d) => handleCardAction(cfg, d, ev));
    });
    children.push(cards);
    cards.on('close', (code) => {
      // 回调没开通（exit 2）等情况：只记录，不拖垮文字指令通道
      if (code) log('[listen] card callbacks unavailable', code, cards.stderrText().slice(-300).replace(/\s+/g, ' '));
    });
  }

  const stop = () => children.forEach((c) => c.kill('SIGTERM'));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  messages.on('close', (code, signal) => {
    log('[listen] message consumer exited', code ?? signal);
    stop();
    process.exit(code === 0 ? 0 : 1);
  });
  log('[listen] started');
}
