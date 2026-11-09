// 按天统计 QQ 用量：回合数、步数、每步 token、成本（剔除累计快照与重复行）
import fs from 'node:fs';
import { ratesAt } from './src/model-prices.js';

const raw = fs.readFileSync('state/token-usage.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const seen = new Set();
const rows = [];
for (const r of raw) {
  const b = r.b || {};
  if ((b.cacheHit || 0) > 1_000_000) continue;
  const id = r.key + '#' + r.seq;
  if (seen.has(id)) continue;
  seen.add(id);
  rows.push(r);
}
rows.sort((a, b) => a.t - b.t);

const cost = (r) => {
  const b = r.b || {};
  const rt = ratesAt(r.model || 'deepseek-flash', Number(r.t) || 0);
  return ((b.cacheHit || 0) * rt.cacheHit + (b.cacheMiss || 0) * rt.cacheMiss
    + (b.cacheWrite || 0) * rt.cacheWrite + (b.output || 0) * rt.output) / 1e6;
};

const dayOf = (ms) => new Date(ms).toLocaleDateString('zh-CN');
const days = new Map();
for (const r of rows) {
  const d = dayOf(Number(r.t));
  if (!days.has(d)) days.set(d, { turns: 0, steps: 0, cost: 0, hit: 0, miss: 0, out: 0, lastKey: null, lastT: 0 });
  const s = days.get(d);
  s.steps += 1;
  s.cost += cost(r);
  s.hit += r.b.cacheHit || 0;
  s.miss += r.b.cacheMiss || 0;
  s.out += r.b.output || 0;
  // 回合：同会话间隔 >2 分钟算新回合
  if (r.key !== s.lastKey || Number(r.t) - s.lastT > 120000) s.turns += 1;
  s.lastKey = r.key;
  s.lastT = Number(r.t);
}

console.log('日期        回合   步数  步/回合   每步上下文   每步输出   $/回合      $/天');
for (const [d, s] of days) {
  console.log(
    d.padEnd(11),
    String(s.turns).padStart(4),
    String(s.steps).padStart(6),
    (s.steps / s.turns).toFixed(1).padStart(7),
    (s.hit / s.steps / 1000).toFixed(0).padStart(10) + 'K',
    (s.out / s.steps).toFixed(0).padStart(9),
    ('¥' + (s.cost / s.turns).toFixed(3)).padStart(9),
    ('¥' + s.cost.toFixed(2)).padStart(8),
  );
}
const total = [...days.values()].reduce((a, s) => a + s.cost, 0);
console.log('合计 ¥' + total.toFixed(2), '| 样本', rows.length);
