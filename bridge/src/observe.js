// observe.js — 观察层（记忆链 P4）：给"自省"提供原料。
//
// 思路：AI 想"回想今天群里发生了什么"，不该靠翻消息（贵、且会被内容带跑），
// 而应该看一份**统计摘要**：今天多少条、谁在说话、反复出现哪些词。
// 这份摘要在「自省」唤醒时塞进提示词，她据此决定要不要写 selfnote / impression。
//
// 存储：state/observe.json
//   { days: { "2026-11-03": { "group:123": { msgs, senders:{名:次}, words:{词:次} } } } }
// 只保留最近 7 天，文件很小。

import fs from 'node:fs';
import path from 'node:path';

const KEEP_DAYS = 7;
const MAX_WORDS = 40;
const MAX_SENDERS = 12;

// 常见的无意义双字组合（粗略过滤，宁可漏也别把噪音词堆给模型）
const STOP = new Set([
  '哈哈', '嘿嘿', '哈哈', '什么', '这个', '那个', '就是', '不是', '可以', '我们', '你们',
  '他们', '自己', '现在', '然后', '真的', '一个', '没有', '知道', '觉得', '还是', '已经',
  '今天', '明天', '昨天', '时候', '东西', '事情', '一下', '有点', '这么', '那么', '怎样',
  '图片', '表情', '语音', '视频',
]);

function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function createObserver({ file, log = () => {} }) {
  let state = { days: {}, totals: {} };

  function load() {
    try {
      if (fs.existsSync(file)) {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (raw && typeof raw.days === 'object' && raw.days) state = { days: raw.days, totals: raw.totals || {} };
      }
    } catch (error) {
      log(`[observe] 读取失败：${error?.message ?? error}`);
    }
  }

  let saveTimer = null;
  function saveSoon() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        // 只留最近 KEEP_DAYS 天
        const keys = Object.keys(state.days).sort();
        while (keys.length > KEEP_DAYS) delete state.days[keys.shift()];
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(state), 'utf8');
      } catch (error) {
        log(`[observe] 写入失败：${error?.message ?? error}`);
      }
    }, 5000);
    saveTimer.unref?.();
  }

  function bucket(day, key) {
    state.days[day] ||= {};
    state.days[day][key] ||= { msgs: 0, senders: {}, words: {} };
    return state.days[day][key];
  }

  /** 记录一条消息（只记统计，不记原文） */
  function record(key, { sender, text } = {}) {
    const raw = String(text ?? '').trim();
    if (!raw) return;
    const b = bucket(dayKey(), key);
    b.msgs += 1;
    state.totals[key] = (Number(state.totals[key]) || 0) + 1;
    const name = String(sender ?? '').trim().slice(0, 16);
    if (name) b.senders[name] = (b.senders[name] || 0) + 1;

    // 中文按双字滑窗计数，英文/数字按词
    const cjk = raw.replace(/[^\u4e00-\u9fa5]/g, ' ');
    for (let i = 0; i + 1 < cjk.length; i++) {
      const w = cjk.slice(i, i + 2);
      if (!w.trim() || STOP.has(w)) continue;
      b.words[w] = (b.words[w] || 0) + 1;
    }
    for (const m of raw.match(/[A-Za-z][A-Za-z0-9_+-]{2,}/g) || []) {
      const w = m.toLowerCase();
      if (STOP.has(w)) continue;
      b.words[w] = (b.words[w] || 0) + 1;
    }
    // 防止词表无限增长
    const entries = Object.entries(b.words);
    if (entries.length > 400) {
      entries.sort((a, c) => c[1] - a[1]);
      b.words = Object.fromEntries(entries.slice(0, MAX_WORDS * 4));
    }
    saveSoon();
  }

  function topOf(map, n) {
    return Object.entries(map || {}).sort((a, b) => b[1] - a[1]).slice(0, n);
  }

  /** 汇总：今天 + 最近 N 天（默认 7） */
  function summary(key, { days = KEEP_DAYS } = {}) {
    const today = dayKey();
    const out = { today: { msgs: 0, senders: [], words: [] }, week: { msgs: 0, senders: [], words: [], days: 0 } };
    const weekSenders = {};
    const weekWords = {};
    let dayCount = 0;
    for (const [day, keys] of Object.entries(state.days)) {
      const b = keys?.[key];
      if (!b) continue;
      dayCount += 1;
      if (day === today) {
        out.today.msgs = b.msgs;
        out.today.senders = topOf(b.senders, MAX_SENDERS);
        out.today.words = topOf(b.words, MAX_WORDS);
      }
      out.week.msgs += b.msgs;
      for (const [k, v] of Object.entries(b.senders)) weekSenders[k] = (weekSenders[k] || 0) + v;
      for (const [k, v] of Object.entries(b.words)) weekWords[k] = (weekWords[k] || 0) + v;
    }
    out.week.days = dayCount;
    out.week.senders = topOf(weekSenders, MAX_SENDERS);
    out.week.words = topOf(weekWords, MAX_WORDS);
    return out;
  }

  /** 给提示词用的一小段文字（没数据返回空串） */
  function describe(key, { days = 7 } = {}) {
    const s = summary(key, { days });
    if (!s.week.msgs) return '';
    const fmt = (pairs) => pairs.map(([w, n]) => `${w}×${n}`).slice(0, 8).join('、');
    const parts = [];
    parts.push(`最近 ${s.week.days} 天这家共 ${s.week.msgs} 条${s.today.msgs ? `（今天 ${s.today.msgs} 条）` : ''}`);
    if (s.week.senders.length) parts.push(`常说话的人：${fmt(s.week.senders)}`);
    if (s.week.words.length) parts.push(`反复出现的词：${fmt(s.week.words)}`);
    return parts.join('；');
  }

  load();
  /** 该会话累计收到多少条（跨天，用于按量总结） */
  function total(key) {
    return Number(state.totals[key]) || 0;
  }

  return { record, summary, describe, total };
}
