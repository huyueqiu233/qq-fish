// 用 token-usage.jsonl + 官方价目表，算总花费与每条消息成本（一次性分析脚本）
import fs from 'node:fs';
import { ratesAt } from './src/model-prices.js';

const file = 'state/token-usage.jsonl';
const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
let cost = 0;
let turns = 0;
let tokens = { cacheMiss: 0, cacheHit: 0, cacheWrite: 0, output: 0, reasoning: 0 };
const byKey = new Map();
let first = Infinity;
let last = 0;

for (const line of lines) {
  let r;
  try { r = JSON.parse(line); } catch { continue; }
  const b = r.b || {};
  const at = Number(r.t) || 0;
  if (at) { first = Math.min(first, at); last = Math.max(last, at); }
  const model = r.model || 'deepseek-flash';
  const rate = ratesAt(model, at);
  const c = ((b.cacheHit || 0) * rate.cacheHit
    + (b.cacheMiss || 0) * rate.cacheMiss
    + (b.cacheWrite || 0) * rate.cacheWrite
    + (b.output || 0) * rate.output) / 1e6;
  cost += c;
  turns += 1;
  for (const k of Object.keys(tokens)) tokens[k] += Number(b[k] || 0);
  const kk = r.key || '?';
  const cur = byKey.get(kk) || { cost: 0, turns: 0 };
  cur.cost += c; cur.turns += 1;
  byKey.set(kk, cur);
}

console.log('记录数(轮):', turns);
console.log('时间跨度:', new Date(first).toLocaleString(), '→', new Date(last).toLocaleString());
console.log('token 桶:', JSON.stringify(tokens));
console.log('总花费(元):', cost.toFixed(4));
for (const [k, v] of byKey) console.log('  ', k, v.turns, '轮', v.cost.toFixed(4), '元');
