// profile.js — 用户画像（2026-11-04）
//
// 想法来自"她不必记住每次闲聊，但要知道你在意什么"：
// 记忆是流水，画像是"这个人是谁、在意什么、希望被怎样对待"。
// 每次唤醒把画像注入，比多塞 20 条聊天记录更省 token，也更懂人。

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT = {
  version: 1,
  name: '',                 // 主人在她心里怎么称呼
  values: [],               // 在意的东西（家庭、朋友、创作、自由…）
  preferences: [],          // 喜好（说话方式、被对待方式、忌讳）
  boundaries: [],           // 不要做的事
  facts: [],                // 稳定事实（职业、作息、常玩什么）
  updatedAt: '',
};

function cleanList(list, max = 12) {
  return (Array.isArray(list) ? list : [])
    .map((x) => String(x ?? '').trim())
    .filter(Boolean)
    .slice(0, max);
}

export function createProfile({ file, log = () => {} }) {
  let state = { ...DEFAULT, values: [], preferences: [], boundaries: [], facts: [] };

  function load() {
    try {
      if (!fs.existsSync(file)) return;
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      state = {
        ...DEFAULT,
        ...raw,
        values: cleanList(raw.values),
        preferences: cleanList(raw.preferences),
        boundaries: cleanList(raw.boundaries, 8),
        facts: cleanList(raw.facts),
      };
    } catch (error) {
      log(`[profile] 读取失败：${error?.message ?? error}`);
    }
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      state.updatedAt = new Date().toISOString();
      fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
    } catch (error) {
      log(`[profile] 写入失败：${error?.message ?? error}`);
    }
  }

  /** 覆盖式设置（缺省字段保留） */
  function set(patch = {}) {
    if (typeof patch.name === 'string') state.name = patch.name.trim().slice(0, 20);
    for (const k of ['values', 'preferences', 'boundaries', 'facts']) {
      if (patch[k] !== undefined) state[k] = cleanList(patch[k], k === 'boundaries' ? 8 : 12);
    }
    save();
    return state;
  }

  /** 追加一条（去重，最多 12 条） */
  function add(kind, text) {
    const k = ['values', 'preferences', 'boundaries', 'facts'].includes(kind) ? kind : 'facts';
    const t = String(text ?? '').trim().slice(0, 80);
    if (!t) return state;
    const list = state[k] || [];
    if (!list.some((x) => x === t || x.includes(t) || t.includes(x))) {
      state[k] = cleanList([...list, t], k === 'boundaries' ? 8 : 12);
      save();
    }
    return state;
  }

  function get() {
    return { ...state };
  }

  /** 唤醒提示里的一行（空画像返回空串） */
  function describe() {
    const parts = [];
    if (state.name) parts.push(`称呼：${state.name}`);
    if (state.values.length) parts.push(`在意：${state.values.join('、')}`);
    if (state.preferences.length) parts.push(`喜欢：${state.preferences.join('、')}`);
    if (state.boundaries.length) parts.push(`不要：${state.boundaries.join('、')}`);
    if (state.facts.length) parts.push(`知道：${state.facts.join('、')}`);
    return parts.length ? parts.join('｜') : '';
  }

  load();
  return { get, set, add, describe };
}
