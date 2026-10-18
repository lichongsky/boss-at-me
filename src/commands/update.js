import { spawnSync } from 'node:child_process';
import { confirm } from '@inquirer/prompts';
import { CURRENT_VERSION, REPO, RELEASES, fetchLatest, compareVersions, releasesBetween, installSource, formatNotes } from '../lib/update.js';
import { loadState, saveState, configExists, loadConfig } from '../lib/store.js';
import { c, ok, warn, info, runInherit } from '../setup/util.js';

export async function update(opts) {
  info(`当前版本 v${CURRENT_VERSION}，检查 ${REPO} …`);
  const latest = await fetchLatest({ proxy: configExists() ? loadConfig().network?.proxy : null });
  if (configExists()) {
    const st = loadState();
    st.latestVersion = latest.version;
    st.lastUpdateCheck = new Date().toISOString();
    saveState(st);
  }
  if (compareVersions(latest.version, CURRENT_VERSION) <= 0) {
    ok(`已是最新版本 v${CURRENT_VERSION}`);
    return;
  }
  console.log(`\n${c.bold(`新版本 v${latest.version}`)}\n${formatNotes(releasesBetween(latest.releases, CURRENT_VERSION, latest.version))}\n`);
  if (opts.check) return;

  const src = installSource();
  let okInstall;
  if (src.kind === 'git') {
    info(`检测到源码安装（${src.dir}），执行 git pull …`);
    okInstall = runInherit('git', ['-C', src.dir, 'pull', '--ff-only']) && runInherit('npm', ['install', '--prefix', src.dir, '--omit=dev']);
  } else {
    const spec = src.kind === 'npm' ? 'boss-at-me@latest' : `github:${REPO}`;
    info(`执行 npm install -g ${spec} …`);
    okInstall = runInherit('npm', ['install', '-g', spec]);
  }
  if (!okInstall) throw new Error('更新失败，请检查上面的输出');

  // 交给新版本代码做后续处理（版本说明、需要重跑的步骤）
  const p = spawnSync(process.execPath, [process.argv[1], 'post-update', '--from', CURRENT_VERSION], { stdio: 'inherit' });
  process.exitCode = p.status ?? 0;
}

/** 由新版本执行：列出 from 之后需要重跑的 setup 步骤并引导执行。 */
export async function postUpdate(opts) {
  const from = opts.from || '0.0.0';
  ok(`已更新到 v${CURRENT_VERSION}`);
  if (configExists()) {
    const st = loadState();
    st.notifiedVersion = null;
    saveState(st);
  }
  const steps = [...new Set(releasesBetween(RELEASES, from, CURRENT_VERSION).flatMap((r) => r.steps || []))];
  if (!steps.length) {
    info('无需额外操作，后台服务下一轮会自动使用新版本');
    return;
  }
  if (!configExists()) return;
  warn(`这次更新需要重跑设置步骤：${steps.join('、')}`);
  if (!(await confirm({ message: '现在运行吗？', default: true }))) {
    info(`稍后可手动运行：${steps.map((s) => `boss-at-me setup --step ${s}`).join('；')}`);
    return;
  }
  const setup = (await import('./setup.js')).default;
  for (const step of steps) await setup({ step });
}
