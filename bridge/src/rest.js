// rest.js — 困意与作息（2026-11-04）
//
// 需求（老板原话）：她自己也该会犯困，半夜别老叫她。
// 所以这不是"安静时段"开关，而是她自己的作息：
//   · 23:30 之后困意上升，凌晨最高；早上自然清醒
//   · 困了的时候：概率唤醒 / 主动冒泡 / 自省 / 刷B站 一律不叫醒她
//   · @ 她、拍一拍 仍然会叫醒（被吵醒的语气她自己决定），admin 永远放行
//   · 她可以主动说"我先睡了" → 进入睡眠，到点（或早上）自然醒
//
// 状态存 state/rest.json：{ asleepUntil, sleepStartedAt, note }

import fs from 'node:fs';
import path from 'node:path';

const NIGHT_BLOCKABLE = new Set([
  'probability',
  'proactiveCheck',
  'reflect',
  'bili_scan',
  'timeout',
  'replyCheck',
  'stale',
  'idle',
]);

const ALWAYS_ALLOW = new Set(['atMention', 'poke', 'admin', 'bootstrap', 'question']);

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/** 按时间算困意 0~100（分段线性，比正弦曲线好调） */
const CURVE = [
  [0, 25], [0.5, 55], [2, 78], [4, 90], [5, 88], [6.5, 70], [8, 30], [9, 18],
  [10, 12], [14, 8], [18, 12], [20, 18], [22, 24], [23.5, 30],
];

export function sleepinessAt(date = new Date(), cfg = {}) {
  const startHour = Number(cfg.startHour ?? 23.5);
  const endHour = Number(cfg.endHour ?? 8);
  const h = date.getHours() + date.getMinutes() / 60;
  // 白天直接查表
  if (h >= endHour && h < startHour) return interp(h);
  // 夜里：把 [startHour, startHour+6] 拉成 30→90 的抬升段（入睡后 6 小时最困）
  const elapsed = h >= startHour ? h - startHour : 24 - startHour + h;
  if (elapsed <= 6) return clamp(30 + (elapsed / 6) * 60, 0, 100);      // 30 → 90
  const rest = Math.min(6, ((24 - startHour) + endHour) - 6);            // 到起床的剩余小时
  const t = (elapsed - 6) / Math.max(0.1, rest);
  return clamp(90 - t * 60, 0, 100);
}

function interp(h) {
  const c = CURVE;
  for (let i = 0; i < c.length - 1; i++) {
    const [x1, y1] = c[i];
    const [x2, y2] = c[i + 1];
    if (h >= x1 && h <= x2 && x2 > x1) return clamp(y1 + ((h - x1) / (x2 - x1)) * (y2 - y1), 0, 100);
  }
  return 10;
}

export function createRest({ file, cfg = {}, log = () => {} }) {
  let state = { asleepUntil: 0, sleepStartedAt: 0, note: '' };

  function load() {
    try {
      if (!fs.existsSync(file)) return;
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      state.asleepUntil = Number(raw?.asleepUntil) || 0;
      state.sleepStartedAt = Number(raw?.sleepStartedAt) || 0;
      state.note = String(raw?.note || '').slice(0, 80);
    } catch (error) {
      log(`[rest] 读取失败：${error?.message ?? error}`);
    }
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
    } catch (error) {
      log(`[rest] 写入失败：${error?.message ?? error}`);
    }
  }

  const enabled = () => cfg.enabled !== false;

  function inNightWindow(now = new Date()) {
    return sleepinessAt(now, cfg) >= 50;
  }

  function asleepNow(now = Date.now()) {
    return state.asleepUntil > now;
  }

  /** 该不该被这个原因叫醒 */
  function mayWake(reason, now = new Date()) {
    if (!enabled()) return { allowed: true };
    const wakeAt = Date.parse(String(now));
    if (ALWAYS_ALLOW.has(reason)) {
      return { allowed: true, tired: inNightWindow(now) };
    }
    if (asleepNow(now.getTime())) {
      if (NIGHT_BLOCKABLE.has(reason) || reason === 'reflect') {
        return { allowed: false, why: `睡着了（${new Date(state.asleepUntil).toLocaleTimeString()} 醒）` };
      }
    }
    if (inNightWindow(now) && (NIGHT_BLOCKABLE.has(reason) || reason === 'reflect')) {
      return { allowed: false, why: `夜里了（困意 ${Math.round(sleepinessAt(now, cfg))}）` };
    }
    return { allowed: true, tired: inNightWindow(now) };
  }

  /** 她去睡觉：hours 小时之后自然醒（默认到早上） */
  function goToSleep({ hours = 0, note = '' } = {}) {
    const now = Date.now();
    let until;
    if (hours > 0) {
      until = now + hours * 3600000;
    } else {
      const d = new Date();
      const wake = new Date(d);
      wake.setHours(Number(cfg.endHour ?? 8), 0, 0, 0);
      if (wake.getTime() <= now) wake.setDate(wake.getDate() + 1);
      until = wake.getTime();
    }
    state.asleepUntil = until;
    state.sleepStartedAt = now;
    state.note = String(note || '').slice(0, 80);
    save();
    return status();
  }

  function wakeUp() {
    state.asleepUntil = 0;
    state.sleepStartedAt = 0;
    save();
    return status();
  }

  function status(now = new Date()) {
    const sleepiness = Math.round(sleepinessAt(now, cfg));
    const asleep = asleepNow(now.getTime());
    return {
      enabled: enabled(),
      sleepiness,
      asleep,
      asleepUntil: state.asleepUntil || null,
      night: inNightWindow(now),
      label: asleep ? '在睡' : sleepiness >= 75 ? '很困' : sleepiness >= 50 ? '有点困' : sleepiness >= 25 ? '还行' : '清醒',
    };
  }

  /** 唤醒提示里的一行 */
  function describe(now = new Date()) {
    const s = status(now);
    if (!s.enabled) return '';
    const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const bits = [`${s.label}（困意 ${s.sleepiness}）`, `现在 ${time}`];
    if (s.asleep) bits.push(`你正在睡，${new Date(s.asleepUntil).toLocaleTimeString()} 左右自然醒`);
    else if (s.night) bits.push('夜里了，你想睡觉');
    return bits.join('｜');
  }

  load();
  return { mayWake, goToSleep, wakeUp, status, describe, sleepiness: () => sleepinessAt(new Date(), cfg) };
}
