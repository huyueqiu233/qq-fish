// wallet.js — 小鲸鱼的"零花钱"（纯记账，不碰真钱）2026-11-03
//
// 为什么要这个东西：QQ 红包走支付协议，网关没有接口，她既发不了也点不了；
// 但"我有多少钱、能不能请你喝奶茶"这种人味可以靠一本假账撑起来。
//
// 设计：
//   · 状态存在 state/wallet.json：{ balance, entries: [...] }
//   · 每条流水记 { id, at, delta, note, by }，by 是触发者的会话 key
//   · 余额不能为负；单次金额限制 0.01~1000，流水最多留 200 条
//   · 所有操作都是记账，没有任何支付能力

import fs from 'node:fs';
import path from 'node:path';

const MAX_ENTRIES = 200;
const MAX_AMOUNT = 1000;

const round2 = (n) => Math.round(Number(n) * 100) / 100;

export function createWallet({ file, initial = 10, log = () => {} }) {
  let state = { balance: round2(initial) || 0, entries: [] };

  function load() {
    try {
      if (fs.existsSync(file)) {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        const balance = Number(raw?.balance);
        state = {
          balance: Number.isFinite(balance) ? round2(balance) : round2(initial) || 0,
          entries: Array.isArray(raw?.entries) ? raw.entries.slice(-MAX_ENTRIES) : [],
        };
      }
    } catch (error) {
      log(`[wallet] 读取失败，按初始值处理：${error?.message ?? error}`);
    }
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
    } catch (error) {
      log(`[wallet] 写入失败：${error?.message ?? error}`);
    }
  }

  function pushEntry(delta, note, by) {
    const entry = {
      id: state.entries.length ? String(Number(state.entries[state.entries.length - 1].id) + 1) : '1',
      at: new Date().toISOString(),
      delta: round2(delta),
      note: String(note || '').slice(0, 60),
      by: String(by || '').slice(0, 40),
    };
    state.entries.push(entry);
    if (state.entries.length > MAX_ENTRIES) state.entries = state.entries.slice(-MAX_ENTRIES);
    return entry;
  }

  /** 查余额 + 最近几条流水 */
  function status({ limit = 5 } = {}) {
    const n = Math.max(1, Math.min(20, Number(limit) || 5));
    return {
      balance: state.balance,
      text: `¥${state.balance.toFixed(2)}`,
      entries: state.entries.slice(-n).reverse(),
    };
  }

  /** 收钱（记一笔收入） */
  function credit({ amount, note, by } = {}) {
    const amt = round2(amount);
    if (!Number.isFinite(amt) || amt <= 0 || amt > MAX_AMOUNT) {
      return { ok: false, error: `金额要是 0.01~${MAX_AMOUNT} 之间的正数` };
    }
    state.balance = round2(state.balance + amt);
    const entry = pushEntry(amt, note || '收到一笔钱', by);
    save();
    return { ok: true, entry, ...status() };
  }

  /** 花钱（记一笔支出，余额不足直接拒绝） */
  function spend({ amount, note, by } = {}) {
    const amt = round2(amount);
    if (!Number.isFinite(amt) || amt <= 0 || amt > MAX_AMOUNT) {
      return { ok: false, error: `金额要是 0.01~${MAX_AMOUNT} 之间的正数` };
    }
    if (amt > state.balance) {
      return { ok: false, error: `余额不够（现在 ${state.balance.toFixed(2)}，想花 ${amt.toFixed(2)}）` };
    }
    state.balance = round2(state.balance - amt);
    const entry = pushEntry(-amt, note || '花掉一笔', by);
    save();
    return { ok: true, entry, ...status() };
  }

  load();

  return { status, credit, spend, reload: load };
}
