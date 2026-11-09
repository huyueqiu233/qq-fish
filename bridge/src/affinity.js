// affinity.js — 好感度（2026-11-04）
//
// 想法来自 Vespera：她说"喜欢/关心/夸奖"会涨，长时间不回会慢慢降。
// 存每个会话对"对方"的好感，0~100，基线 50，一周不互动 -1/天（最多降到 20）。
// 这不是讨好机制：好感低的时候她会更短、更冷，但不至于不理人。

import fs from 'node:fs';
import path from 'node:path';

const BASELINE = 50;

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

export function createAffinity({ file, log = () => {} }) {
  let state = { people: {} }; // key -> { score, lastAt, note }

  function load() {
    try {
      if (!fs.existsSync(file)) return;
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw && typeof raw.people === 'object') state.people = raw.people;
    } catch (error) {
      log(`[affinity] 读取失败：${error?.message ?? error}`);
    }
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
    } catch (error) {
      log(`[affinity] 写入失败：${error?.message ?? error}`);
    }
  }

  function entry(key) {
    const k = String(key || '').trim();
    if (!k) return null;
    if (!state.people[k]) state.people[k] = { score: BASELINE, lastAt: Date.now(), note: '' };
    return state.people[k];
  }

  /** 调整好感：delta 正负均可；带原因 */
  function add(key, delta, note = '') {
    const e = entry(key);
    if (!e) return null;
    const d = Number(delta) || 0;
    e.score = clamp((Number(e.score) || BASELINE) + d, 0, 100);
    e.lastAt = Date.now();
    if (note) e.note = String(note).slice(0, 40);
    save();
    return e;
  }

  /** 聊天里读到的话：夸/关心 +2，被怼 -1，普通 +0.2 */
  function fromMessage(key, text) {
    const t = String(text || '');
    if (!t) return null;
    let delta = 0.2;
    if (/(喜欢你|爱你|想你了|谢谢|辛苦|抱抱|么么|可爱|厉害|真棒|乖)/.test(t)) delta = 2;
    else if (/(滚|闭嘴|烦|讨厌|废物|傻|蠢)/.test(t)) delta = -1;
    return add(key, delta, delta >= 2 ? '被好好对待了' : '');
  }

  /** 每天降一点：一周不联系从 50 掉到 43 左右，地板 20 */
  function decay(now = Date.now()) {
    let changed = false;
    for (const [k, e] of Object.entries(state.people)) {
      const days = (now - (Number(e.lastAt) || now)) / 86400000;
      if (days < 7) continue;
      const target = Math.max(20, (Number(e.score) || BASELINE) - Math.floor(days - 6) * 0.2);
      if (target < (Number(e.score) || BASELINE)) {
        e.score = clamp(target, 0, 100);
        changed = true;
      }
    }
    if (changed) save();
  }

  function get(key) {
    const e = state.people[String(key || '').trim()];
    return e ? { ...e } : { score: BASELINE, lastAt: null, note: '' };
  }

  function describe(key) {
    const e = get(key);
    const s = Math.round(Number(e.score) || BASELINE);
    const label = s >= 80 ? '很喜欢你' : s >= 65 ? '挺喜欢' : s >= 45 ? '还行' : s >= 30 ? '有点冷淡' : '不太想理';
    return `${label}（好感 ${s}）`;
  }

  load();
  return { add, fromMessage, decay, get, describe };
}
