#!/usr/bin/env node
/**
 * 聊天复盘：看她今天说的哪些话被接住了、哪些冷场了。
 *
 * 用法：
 *   node scripts/review-report.mjs            # 今天
 *   node scripts/review-report.mjs 2026-11-08 # 指定某天
 *
 * 数据来自 state/review/<日期>.jsonl（bridge 每 5 分钟从内存 recentMessages 增量追加一次）。
 * 口径：
 *   · 她说的话按「一波」算：连续 ≤60 秒的自我消息合并成一次发言（分条说话不算冷场）
 *   · 一波结束后 180 秒内有人说话 = 被接住；否则算冷场
 * 只是粗筛，用来找出值得回看的片段，不当作精确指标。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const day = process.argv[2] || new Date().toLocaleDateString('sv-SE');
const file = path.join(root, 'state', 'review', `${day}.jsonl`);
const WINDOW_MS = 180 * 1000;
const BURST_GAP_MS = 60 * 1000;

if (!fs.existsSync(file)) {
  console.log(`没有 ${day} 的归档（${file}）`);
  process.exit(0);
}

const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
  try { return JSON.parse(l); } catch { return null; }
}).filter(Boolean).sort((a, b) => a.t - b.t);

const byKey = new Map();
for (const r of rows) {
  if (!byKey.has(r.key)) byKey.set(r.key, []);
  byKey.get(r.key).push(r);
}

const hhmm = (t) => new Date(t).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, hour: '2-digit', minute: '2-digit' });
const clip = (s, n = 46) => (s.length > n ? `${s.slice(0, n)}…` : s);

let bursts = 0;
let answered = 0;
let lines = 0;
const cold = [];
const hit = [];
const perKey = new Map();

for (const [key, list] of byKey) {
  let i = 0;
  let keyBursts = 0;
  let keyAnswered = 0;
  while (i < list.length) {
    if (!list[i].self) { i += 1; continue; }
    // 合并连续自我消息为一波
    let end = i;
    while (end + 1 < list.length && list[end + 1].self && list[end + 1].t - list[end].t <= BURST_GAP_MS) end += 1;
    const burstLines = list.slice(i, end + 1);
    const lastT = burstLines[burstLines.length - 1].t;
    bursts += 1;
    keyBursts += 1;
    lines += burstLines.length;
    const replies = [];
    for (let j = end + 1; j < list.length; j += 1) {
      if (list[j].t - lastT > WINDOW_MS) break;
      if (!list[j].self) replies.push(list[j]);
    }
    const item = {
      key,
      t: lastT,
      text: burstLines.map((m) => m.text).join(' / '),
      replies: replies.length,
      who: replies[0]?.sender ?? ''
    };
    if (replies.length) { answered += 1; keyAnswered += 1; hit.push(item); } else cold.push(item);
    i = end + 1;
  }
  if (keyBursts) perKey.set(key, `${keyAnswered}/${keyBursts}`);
}

console.log(`日期 ${day}  归档 ${rows.length} 条  她发了 ${bursts} 波（${lines} 句）`);
if (bursts === 0) process.exit(0);
console.log(`被接住 ${answered} 波（${((answered / bursts) * 100).toFixed(0)}%），冷场 ${cold.length} 波`);
console.log('');
for (const [key, v] of [...perKey.entries()].sort()) console.log(`  ${key.padEnd(22)} ${v}`);
console.log('');
console.log('--- 冷场（按时间）');
for (const c of cold.slice(-8)) console.log(`${hhmm(c.t)} ${c.key.padEnd(20)} “${clip(c.text)}”`);
console.log('');
console.log('--- 被接住的（示例）');
for (const h of hit.slice(-5)) console.log(`${hhmm(h.t)} ${h.who} 接了：“${clip(h.text)}”`);
