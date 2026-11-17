// 一次性：把黑话学习工作区里那些已经退役的会话归档（只隐藏，不删文件）。
// 用法：node scripts/archive-slang-sessions.mjs [--dry]
import fs from 'node:fs';
import path from 'node:path';
import { NodeApiClient, unwrap } from '../src/dsh-client.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
const dry = process.argv.includes('--dry');
const slangDir = path.join(root, 'state', 'slang-agent');

const api = new NodeApiClient(cfg.dsh.baseUrl, undefined, {
  token: cfg.dsh.authToken || undefined,
  tokenExplicit: Boolean(cfg.dsh.authToken),
  header: cfg.dsh.authHeader,
  prefix: cfg.dsh.authPrefix
});

const norm = (p) => path.normalize(String(p ?? '').replace(/\//g, path.sep)).toLowerCase();
const wants = norm(slangDir);
const list = unwrap(await api.sessions.list({}), 'sessions.list');
const rows = (list.items ?? []).filter((it) => norm(it.cwd).startsWith(wants) && !it.parentSessionId && it.origin !== 'subagent');
console.log(`黑话学习工作区会话 ${rows.length} 个`);
let archived = 0;
for (const it of rows) {
  const label = `${it.sessionId}  ${it.title ?? ''}  ${it.updatedAt ? new Date(it.updatedAt).toLocaleString('zh-CN', { hour12: false }) : ''}`;
  if (dry) { console.log('[dry]', label); continue; }
  try {
    await api.workspace.archiveSession({ sessionId: it.sessionId });
    archived += 1;
    console.log('已归档', label);
  } catch (error) {
    console.log('失败', label, '→', error?.message ?? error);
  }
}
console.log(dry ? '（dry run，没有动）' : `完成：归档 ${archived} 个`);
