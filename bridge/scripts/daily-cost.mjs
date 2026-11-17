// 用量与花费日报：按北京时间切天，用桥接自己的价目表算钱。
import fs from 'node:fs';
import { costOfBuckets, ratesAt } from '../src/model-prices.js';

const file = 'state/token-usage.jsonl';
const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);

const days = new Map();
for (const line of lines) {
  let r;
  try { r = JSON.parse(line); } catch { continue; }
  if (r.k !== 'turn' || !r.t) continue;
  const d = new Date(r.t);
  const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(d); // YYYY-MM-DD
  const b = r.b || {};
  const buckets = {
    cacheHit: Number(b.cacheHit) || 0,
    cacheMiss: Number(b.cacheMiss) || 0,
    cacheWrite: Number(b.cacheWrite) || 0,
    output: Number(b.output) || 0,
    reasoning: Number(b.reasoning) || 0
  };
  const rates = ratesAt(r.model || 'deepseek-flash', r.t);
  const { total: cost } = costOfBuckets(buckets, rates);
  let agg = days.get(day);
  if (!agg) {
    agg = { cost: 0, steps: 0, turns: new Set(), hit: 0, miss: 0, write: 0, out: 0 };
    days.set(day, agg);
  }
  agg.cost += cost;
  agg.steps += 1;
  if (r.sid) agg.turns.add(r.sid + '|' + r.seq + '|' + r.turn);
  agg.hit += buckets.cacheHit;
  agg.miss += buckets.cacheMiss;
  agg.write += buckets.cacheWrite;
  agg.out += buckets.output;
}

const target = process.argv[2];
const keys = [...days.keys()].sort();
for (const day of keys.slice(-8)) {
  const a = days.get(day);
  const mark = target && day === target ? '  <==' : '';
  console.log(`${day}  ¥${a.cost.toFixed(2)}  步骤${a.steps}  轮次${a.turns.size}  ` +
    `输入命中${(a.hit / 1e6).toFixed(2)}M 未命中${(a.miss / 1e6).toFixed(2)}M 输出${(a.out / 1e6).toFixed(2)}M${mark}`);
}
