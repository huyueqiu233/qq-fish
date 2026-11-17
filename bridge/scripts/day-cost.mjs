#!/usr/bin/env node
/**
 * 按天、按会话看花费账单（控制台之外的离线口径）。
 *
 * 用法：
 *   node scripts/day-cost.mjs              # 今天
 *   node scripts/day-cost.mjs 2026-11-07   # 指定某天（北京时间）
 *
 * 口径：只统计 `state/token-usage.jsonl` 里的逐轮（turn）采样，按采样自带时间
 * 落到自然日，按 model-prices 的峰谷价表计价。投影基线（base）是「整条会话的
 * 累计值」，没有日内时间戳，所以不计入——这会让数字比控制台总账略低一点，
 * 但**会话之间**的比较不受影响（黑话学习占比就是看这个）。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { priceUsage } from '../src/model-prices.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const file = path.join(root, 'state', 'token-usage.jsonl');

const dayArg = process.argv[2];
const day = dayArg || new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const start = new Date(`${day}T00:00:00+08:00`).getTime();
const end = start + 24 * 3600e3;
if (!Number.isFinite(start)) {
  console.error(`日期不认识：${day}（要 YYYY-MM-DD）`);
  process.exit(2);
}

let lines;
try {
  lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
} catch (error) {
  console.error(`读不到账本：${file}（${error?.message ?? error}）`);
  process.exit(1);
}

const byKey = new Map();
let inDay = 0;
let all = 0;
for (const line of lines) {
  let r;
  try { r = JSON.parse(line); } catch { continue; }
  if (r.k !== 'turn') continue;
  all += 1;
  if (!(Number(r.t) >= start && Number(r.t) < end)) continue;
  inDay += 1;
  const priced = priceUsage(r.b, { model: r.model || 'deepseek-flash', at: r.t });
  const acc = byKey.get(r.key) ?? { cost: 0, peak: 0, off: 0, steps: 0, tokens: 0 };
  acc.cost += priced.cost.total;
  acc[priced.rates.tier] += priced.cost.total;
  acc.steps += 1;
  acc.tokens += (r.b.cacheMiss || 0) + (r.b.cacheHit || 0) + (r.b.cacheWrite || 0) + (r.b.output || 0);
  byKey.set(r.key, acc);
}

const rows = [...byKey.entries()].map(([key, v]) => ({ key, ...v })).sort((a, b) => b.cost - a.cost);
const total = rows.reduce((s, r) => s + r.cost, 0);
const yuan = (n) => `¥${n.toFixed(2)}`;
const M = (n) => `${(n / 1e6).toFixed(1)}M`;

console.log(`日期 ${day}（北京时间）  逐轮采样 ${inDay}/${all} 条`);
console.log(`合计 ${yuan(total)}   （高峰 ${yuan(rows.reduce((s, r) => s + r.peak, 0))} / 空闲 ${yuan(rows.reduce((s, r) => s + r.off, 0))}）`);
console.log('');
console.log('会话'.padEnd(24), '花费'.padStart(9), '占比'.padStart(7), '步骤'.padStart(6), 'token'.padStart(8));
for (const r of rows) {
  const share = total > 0 ? `${((r.cost / total) * 100).toFixed(1)}%` : '-';
  console.log(r.key.padEnd(24), yuan(r.cost).padStart(9), share.padStart(7), String(r.steps).padStart(6), M(r.tokens).padStart(8));
}
if (rows.length === 0) console.log('（这一天没有逐轮记录）');
