// qq-fish 状态备份：把"她的记忆"同步到一个私有 GitHub 仓库。
// 只备份可恢复人格/记忆的部分；不碰 token、日志、账单。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const SRC = 'C:/Users/Lenovo/Documents/deepseek-harness/tools/qq-bridge/qq-bridge-main';
const DST = 'D:/qq-state-backup';
const REMOTE = 'git@github.com:huyueqiu233/qq-fish-state.git';

const FILES = [
  'state/slang.json',
  'state/stickers.json',
  'state/observe.json',
  'state/current-role.json',
  'state/mood.json',
  'state/rest.json',
  'state/affinity.json',
  'state/profile.json',
  'state/sessions.json',
  'state/image-gen.json',
];
const DIRS = ['state/long-memory', 'state/review', 'roles'];

const log = (m) => console.log(`[backup] ${m}`);

function copyFile(rel) {
  const from = path.join(SRC, rel);
  if (!fs.existsSync(from)) return false;
  const to = path.join(DST, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  return true;
}

function copyDir(rel) {
  const from = path.join(SRC, rel);
  if (!fs.existsSync(from)) return false;
  for (const name of fs.readdirSync(from)) {
    const src = path.join(from, name);
    if (!fs.statSync(src).isFile()) continue;
    const to = path.join(DST, rel, name);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(src, to);
  }
  return true;
}

// social-v2.json 里带每个会话的 agentToken，必须剥掉才能进仓库
function copySocialSanitized() {
  const from = path.join(SRC, 'state/social-v2.json');
  if (!fs.existsSync(from)) return false;
  let data;
  try { data = JSON.parse(fs.readFileSync(from, 'utf8')); } catch { return false; }
  const convs = data.conversations || data;
  for (const key of Object.keys(convs)) {
    const st = convs[key];
    if (st && typeof st === 'object') {
      delete st.agentToken;
      delete st.token;
    }
  }
  fs.mkdirSync(path.join(DST, 'state'), { recursive: true });
  fs.writeFileSync(path.join(DST, 'state/social-v2.json'), JSON.stringify(data, null, 1), 'utf8');
  return true;
}

function git(args) {
  return execFileSync('git', args, { cwd: DST, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function main() {
  fs.mkdirSync(DST, { recursive: true });
  if (!fs.existsSync(path.join(DST, '.git'))) {
    git(['init', '-q']);
    git(['remote', 'add', 'origin', REMOTE]);
    git(['config', 'user.name', 'huyueqiu233']);
    git(['config', 'user.email', 'huyueqiu233@users.noreply.github.com']);
    log('本地仓库已初始化');
  }

  let n = 0;
  for (const rel of FILES) if (copyFile(rel)) n += 1;
  for (const rel of DIRS) if (copyDir(rel)) n += 1;
  if (copySocialSanitized()) n += 1;
  log(`同步 ${n} 个路径`);

  git(['add', '-A']);
  const stamp = new Date().toLocaleString('zh-CN', { hour12: false });
  try {
    git(['commit', '-q', '-m', `backup: ${stamp}`]);
    log('已提交');
  } catch {
    log('没有变化，跳过提交');
  }
  for (let i = 0; i < 3; i += 1) {
    try {
      const out = git(['push', '-q', 'origin', 'HEAD:main']);
      log('推送成功');
      return;
    } catch (e) {
      log(`推送失败（第 ${i + 1} 次）：${String(e.stderr || e.message).slice(0, 200)}`);
      execFileSync('sleep', ['5']);
    }
  }
  process.exitCode = 1;
}

main();
