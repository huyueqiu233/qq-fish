// mood.js — 小鲸鱼的心情（桥侧，2026-11-04）
//
// 为什么不用 dsh-feiyu-mood 那个插件：它是桌面插件，注入目标和 QQ 的唤醒提示词是两套，
// 实测从来没注入过（lastInjectedAt=0）。桥里自己做，和精力/零花钱同一套模式：
//   事件驱动 → 状态 → 唤醒提示里一句话 → 影响她的语气和主动程度
//
// 状态：state/mood.json { mood, dims, updatedAt, lastReason, events }
//   mood 0~100，基线 65；dims 是六个维度的累积强度（会随时间衰减）
//
// 设计原则：
//   · 有惯性：一条消息不该让心情翻篇；超过 ±15 才算"大事"
//   · 会回落：长时间没人理 → 慢慢回到基线（不是越来越丧）
//   · 可自述：她可以自己说"我现在有点不开心"，走 qq_mood_set

import fs from 'node:fs';
import path from 'node:path';

const DIMS = ['happy', 'calm', 'sweet', 'worry', 'sad', 'jealous'];

const PRAISE = ['好棒', '厉害', '可爱', '喜欢你', '爱你', '好听', '聪明', '乖', '贴心', '暖暖好', '夸'];
const INSULT = ['笨', '烦', '闭嘴', '滚', '讨厌', '垃圾', '蠢', '弱智', '别说话', '吵'];
const SWEET = ['晚安', '早安', '想你', '抱抱', '亲亲', '么么', '辛苦'];
const WORRY = ['不舒服', '难受', '生病', '加班', '累了', '难过', 'emo', '哭'];

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

export function createMood({ file, baseline = 65, sensitivity = 'medium', log = () => {} }) {
  const scale = sensitivity === 'sensitive' ? 1.6 : sensitivity === 'dull' ? 0.5 : 1;
  let state = {
    mood: baseline,
    dims: Object.fromEntries(DIMS.map((d) => [d, 0])),
    updatedAt: Date.now(),
    lastReason: '',
    events: [],
  };

  function load() {
    try {
      if (!fs.existsSync(file)) return;
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      state.mood = clamp(Number(raw?.mood ?? baseline), 0, 100);
      for (const d of DIMS) state.dims[d] = clamp(Number(raw?.dims?.[d] ?? 0), 0, 100);
      state.updatedAt = Number(raw?.updatedAt) || Date.now();
      state.lastReason = String(raw?.lastReason || '').slice(0, 80);
      state.events = Array.isArray(raw?.events) ? raw.events.slice(-40) : [];
    } catch (error) {
      log(`[mood] 读取失败：${error?.message ?? error}`);
    }
  }

  let saveTimer = null;
  function saveSoon() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
      } catch (error) {
        log(`[mood] 写入失败：${error?.message ?? error}`);
      }
    }, 4000);
    saveTimer.unref?.();
  }

  /** 按小时向基线回落；dims 半衰期 12 小时 */
  function decay(hours) {
    if (!(hours > 0)) return;
    const k = Math.min(1, hours / 24);
    state.mood = clamp(state.mood + (baseline - state.mood) * k, 0, 100);
    const half = Math.exp(-hours / 12);
    for (const d of DIMS) state.dims[d] *= half;
    state.updatedAt = Date.now();
  }

  function decaySinceLastTouch() {
    const hours = (Date.now() - state.updatedAt) / 3600000;
    if (hours >= 0.5) decay(hours);
  }

  /** 改心情：delta 为 -100~100，dim 决定累积到哪个维度 */
  function apply({ delta = 0, dim = 'calm', reason = '', by = '', weight = 1 } = {}) {
    decaySinceLastTouch();
    const d = clamp(Number(delta) * scale * weight, -30, 30);
    state.mood = clamp(state.mood + d, 0, 100);
    const key = DIMS.includes(dim) ? dim : 'calm';
    state.dims[key] = clamp(state.dims[key] + Math.abs(d) * 1.6, 0, 100);
    if (reason) state.lastReason = String(reason).slice(0, 80);
    state.updatedAt = Date.now();
    state.events.push({ at: new Date().toISOString(), delta: Math.round(d * 10) / 10, dim: key, reason: String(reason).slice(0, 40), by: String(by).slice(0, 32) });
    if (state.events.length > 40) state.events = state.events.slice(-40);
    saveSoon();
    return status();
  }

  /** 从一条收到的消息里读情绪信号（返回 null = 没信号） */
  function readMessage(text, { fromSelf = false } = {}) {
    const t = String(text || '');
    if (!t) return null;
    if (fromSelf) return { delta: 0.6, dim: 'calm', reason: '说了句话' };
    if (INSULT.some((w) => t.includes(w))) return { delta: -8, dim: 'sad', reason: '被凶了' };
    if (PRAISE.some((w) => t.includes(w))) return { delta: 6, dim: 'happy', reason: '被夸了' };
    if (SWEET.some((w) => t.includes(w))) return { delta: 4, dim: 'sweet', reason: '被关心了' };
    if (WORRY.some((w) => t.includes(w))) return { delta: -2, dim: 'worry', reason: '有人不太开心' };
    if (/[?？]/.test(t)) return { delta: 1, dim: 'calm', reason: '被搭话了' };
    return { delta: 0.3, dim: 'calm', reason: '' };
  }

  function dominantDim() {
    let best = 'calm';
    let bestVal = 0;
    for (const d of DIMS) {
      if (state.dims[d] > bestVal) { bestVal = state.dims[d]; best = d; }
    }
    return bestVal < 15 ? null : best;
  }

  const DIM_CN = { happy: '开心', calm: '平静', sweet: '甜', worry: '担心', sad: '低落', jealous: '吃醋' };

  function label() {
    const m = state.mood;
    if (m >= 85) return '心情很好';
    if (m >= 70) return '有点开心';
    if (m >= 55) return '还不错';
    if (m >= 40) return '一般';
    if (m >= 25) return '有点低落';
    return '心情很差';
  }

  function status() {
    decaySinceLastTouch();
    const dim = dominantDim();
    return {
      mood: Math.round(state.mood * 10) / 10,
      label: label(),
      dim: dim || null,
      dimLabel: dim ? DIM_CN[dim] : null,
      lastReason: state.lastReason,
      updatedAt: state.updatedAt,
      events: state.events.slice(-8).reverse(),
    };
  }

  /** 唤醒提示里的一行 */
  function describe() {
    const s = status();
    const bits = [`${s.label}（${s.mood}）`];
    if (s.dimLabel) bits.push(`情绪偏${s.dimLabel}`);
    if (s.lastReason) bits.push(`最近：${s.lastReason}`);
    return bits.join('｜');
  }

  load();
  return { apply, readMessage, status, describe, decay };
}
