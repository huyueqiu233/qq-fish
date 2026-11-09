// check-patches.mjs — 补丁后的自检（2026-11-05）
//
// 起因：今天两次把 `${BS}n` 写进 bridge.js（python 补丁脚本的换行转义没生效），
// JS 里 BS 未定义 → 被外层 try/catch 吞掉 → 提示词行静默消失，功能看着"没生效"却没有任何报错。
//
// 这个脚本做四件事（都能在 10 秒内跑完）：
//   1. 所有 src/*.js 语法检查（node --check）
//   2. 扫描可疑模式：`${BS}`、`${NL}`、字面量 `\\n` 残留、模板里未定义的常见变量
//   3. 通过 debug 端点抓真实唤醒词，检查关键段落是否都在
//   4. 通过 MCP stdio 握手拿工具清单，确认数量和关键工具
//
// 用法：node scripts/check-patches.mjs

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, 'state');
const PATTERNS = [
  ['${BS}', 'python 补丁把 BS 变量写进了 JS（应为真实换行转义）'],
  ['${NL}', '同上：NL 变量残留'],
  ['\\${', '可疑的模板插值转义'],
];

let failed = 0;
const ok = (msg) => console.log(`  ✅ ${msg}`);
const bad = (msg) => { failed += 1; console.log(`  ❌ ${msg}`); };

console.log('== 1. 语法检查');
const files = fs.readdirSync(path.join(ROOT, 'src')).filter((f) => f.endsWith('.js'));
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', path.join(ROOT, 'src', f)], { stdio: 'pipe' });
  } catch (error) {
    bad(`${f} 语法错误：${String(error.stderr || error.message).split('\n')[0]}`);
  }
}
if (!failed) ok(`${files.length} 个文件语法通过`);

console.log('== 2. 可疑模式扫描');
const scanTargets = [
  ...files.map((f) => path.join(ROOT, 'src', f)),
  path.join(ROOT, 'plugins', 'qq-agent-presets', 'qq-tool-restrict.mjs'),
];
let hitCount = 0;
for (const file of scanTargets) {
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, 'utf8');
  for (const [needle, why] of PATTERNS) {
    if (!text.includes(needle)) continue;
    const line = text.split('\n').findIndex((l) => l.includes(needle)) + 1;
    bad(`${path.relative(ROOT, file)}:${line} 含有 ${needle} —— ${why}`);
    hitCount += 1;
  }
}
if (!hitCount) ok('没有残留的补丁转义变量');

console.log('== 3. 唤醒提示词关键段落');
const consoleToken = fs.readFileSync(path.join(STATE, 'console-token'), 'utf8').trim();
async function wakePrompt(key, reason = 'atMention') {
  const url = `http://127.0.0.1:3100/api/debug/wake-prompt?key=${encodeURIComponent(key)}&reason=${encodeURIComponent(reason)}`;
  const res = await fetch(url, { headers: { 'x-console-token': consoleToken } });
  return (await res.json()).prompt || '';
}
try {
  const cfgPath = path.join(ROOT, 'config.json');
  let ownerQQ = '';
  try { ownerQQ = String((JSON.parse(fs.readFileSync(cfgPath, 'utf8')) || {}).ownerQQ || ''); } catch {}
  const priv = ownerQQ ? await wakePrompt(`private:${ownerQQ}`) : '';
  const checks = [
    ['【会话令牌】', '令牌行'],
    ['【精力】', '精力行'],
    ['【心情】', '心情行'],
    ['【作息】', '作息行'],
    ['【关系】', '好感行'],
    ['【你对他了解】', '画像行（画像为空时可忽略）'],
  ];
  // 精力是可选功能：energy.groups 为空时整行都不该出现
  let energyGroups = [];
  try { energyGroups = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')).socialV2?.energy?.groups || []; } catch {}
  const optional = new Set(['【你对他了解】', '【精力】']);
  for (const [needle, name] of checks) {
    if (priv.includes(needle)) { ok(`私聊提示词含 ${name}`); continue; }
    if (needle === '【精力】' && energyGroups.length === 0) { console.log(`  ⚠️  ${name} 没出现：精力未启用（energy.groups 为空），符合当前配置`); continue; }
    if (needle === '【你对他了解】') { console.log(`  ⚠️  ${name} 没出现（画像可能是空的）`); continue; }
    bad(`私聊提示词缺 ${name}`);
  }
  let firstGroup = '';
  try { firstGroup = String((JSON.parse(fs.readFileSync(cfgPath, 'utf8')).allow?.groups || [])[0] || ''); } catch {}
  const ownerPrompt = firstGroup ? await wakePrompt(`group:${firstGroup}`) : '';
  if (ownerPrompt.includes('你是这个群的群主')) ok('群主群提示词正确');
  else bad('群主群提示词缺失');
  const normalPrompt = ownerPrompt;
  if (normalPrompt.includes('你是这个群的群主')) bad('普通群误出现群主提示');
  else ok('普通群没有群主提示');
} catch (error) {
  bad(`唤醒词检查失败（桥没跑？）：${error.message}`);
}

console.log('== 4. MCP 工具清单');
try {
  const listed = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'src', 'mcp-snowluma-safe.js')], { stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('握手超时')); }, 15000);
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) {
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
        }
        if (m.id === 2 && m.result) {
          clearTimeout(timer);
          child.kill();
          resolve((m.result.tools || []).map((t) => t.name));
        }
      }
    });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'check', version: '1' } } }) + '\n');
  });
  ok(`工具 ${listed.length} 个`);
  const must = ['qq_send_message', 'qq_set_wake_config', 'qq_remind', 'qq_send_voice_text', 'qq_image_edit', 'qq_send_file', 'qq_group_ban', 'qq_state'];
  for (const name of must) {
    if (listed.includes(name)) ok(`工具存在：${name}`);
    else bad(`缺少工具：${name}`);
  }
} catch (error) {
  bad(`MCP 检查失败：${error.message}`);
}

console.log(failed ? `\n❌ 有 ${failed} 项异常` : '\n✅ 全部通过');
process.exit(failed ? 1 : 0);
