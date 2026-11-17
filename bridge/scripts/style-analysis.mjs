// 语感分析：她 vs 群友的发言特征 + 被接住率/冷场率基线
import fs from 'node:fs';
import path from 'node:path';

const dir = 'state/review';
const files = fs.readdirSync(dir).filter((f) => /^2026-11-\d\d\.jsonl$/.test(f)).sort();
const rows = [];
for (const f of files) {
  const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const r = JSON.parse(line);
      if (!String(r.key || '').startsWith('group:')) continue;
      if (!r.text) continue;
      rows.push({ ...r, day: f.slice(0, 10) });
    } catch {}
  }
}

const clean = (t) => String(t).replace(/\[[^\]]{1,12}\]/g, '').replace(/\s+/g, ' ').trim();
const stats = (list) => {
  const lens = [];
  let endPeriod = 0, endExcl = 0, endQ = 0, endNone = 0;
  let hasTone = 0, hasLaugh = 0, atOrQuote = 0, question = 0;
  const toneRe = /[啊吧呗嘛捏哈嘿诶欸哦喔呀吗呢咧咯啦]/;
  const laughRe = /(笑死|草|卧槽|哈哈哈|hhhh|绷不住|绝了|离谱)/i;
  for (const r of list) {
    const t = clean(r.text);
    if (!t) continue;
    lens.push(t.length);
    const last = t[t.length - 1];
    if (last === '。') endPeriod++;
    else if (last === '！' || last === '!') endExcl++;
    else if (last === '？' || last === '?') { endQ++; question++; }
    else endNone++;
    if (toneRe.test(t)) hasTone++;
    if (laughRe.test(t)) hasLaugh++;
    if (/^@|^\[引用/.test(t)) atOrQuote++;
    if (/[?？]/.test(t)) question += 0;
  }
  const n = lens.length;
  const avg = lens.reduce((a, b) => a + b, 0) / Math.max(1, n);
  const sorted = [...lens].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 0;
  return {
    n,
    avg: +avg.toFixed(1),
    median,
    p90: sorted[Math.floor(sorted.length * 0.9)] || 0,
    endPeriodPct: +(100 * endPeriod / n).toFixed(0),
    endExclPct: +(100 * endExcl / n).toFixed(0),
    endQPct: +(100 * endQ / n).toFixed(0),
    endNonePct: +(100 * endNone / n).toFixed(0),
    tonePct: +(100 * hasTone / n).toFixed(0),
    laughPct: +(100 * hasLaugh / n).toFixed(0),
    atQuotePct: +(100 * atOrQuote / n).toFixed(0)
  };
};

const self = rows.filter((r) => r.self);
const others = rows.filter((r) => !r.self);
console.log('样本：她', self.length, '条 | 群友', others.length, '条 | 天数', files.length);
console.log('她  ', JSON.stringify(stats(self)));
console.log('群友', JSON.stringify(stats(others)));

// 连发：同一会话 90 秒内的连续自己消息
const byKey = new Map();
for (const r of self) {
  if (!byKey.has(r.key)) byKey.set(r.key, []);
  byKey.get(r.key).push(r);
}
let bursts = [];
for (const list of byKey.values()) {
  list.sort((a, b) => a.t - b.t);
  let cur = 0, prev = 0;
  for (const r of list) {
    if (prev && r.t - prev < 90_000) cur++;
    else { if (cur) bursts.push(cur); cur = 1; }
    prev = r.t;
  }
  if (cur) bursts.push(cur);
}
const burstAvg = bursts.reduce((a, b) => a + b, 0) / Math.max(1, bursts.length);
console.log('连发：平均', burstAvg.toFixed(2), '条/次，样本', bursts.length, '次，最多', Math.max(...bursts));

// 被接住率 / 冷场率：她一条（连发算一轮）后 2 分钟内有人说话 = 被接住；6 分钟内没人 = 冷场
const all = [...rows].sort((a, b) => a.t - b.t);
let engaged = 0, cold = 0, total = 0;
for (let i = 0; i < all.length; i++) {
  const r = all[i];
  if (!r.self) continue;
  // 跳过连发中间的那几条，只看一轮的最后一条
  const next = all[i + 1];
  if (next && next.self && next.key === r.key && next.t - r.t < 90_000) continue;
  total++;
  const follow = all.find((x) => x.t > r.t && x.t - r.t <= 360_000 && x.key === r.key && !x.self);
  if (follow && follow.t - r.t <= 120_000) engaged++;
  else if (!follow) cold++;
}
console.log(`被接住率 ${(100 * engaged / total).toFixed(1)}%  冷场率 ${(100 * cold / total).toFixed(1)}%  样本 ${total} 轮`);
