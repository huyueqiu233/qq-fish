// energy.js — 群"精力"限额（2026-11-01，按群管理给的规则）
//
// 规则（默认值）：
//   · 上限 100；非峰期每小时恢复 30 点
//   · 每发一句消耗 1 点
//   · 低于 20 点 = 疲惫
//   · 每小时最多 20 条、每分钟最多 5 条（计数跨重启保留）
//   · 精力上限每次启动重置为 100（恢复量不累计穿透，但发出的消耗会持久化）
//
// 这里只做纯计算，状态由调用方（桥）放在会话状态里持久化。

export const ENERGY_DEFAULTS = {
  enabled: true,
  groups: [],
  cap: 100,
  costPerMessage: 1,
  tiredBelow: 20,
  restorePerHour: 30,
  maxPerMinute: 5,
  maxPerHour: 20,
  resetOnStart: true,
};

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

/** 这个会话是否有精力限制（只对配置里列出的群生效）。 */
export function energyConfigFor(socialV2Cfg, key) {
  const raw = socialV2Cfg?.energy;
  if (!raw || raw.enabled === false) return null;
  const cfg = { ...ENERGY_DEFAULTS, ...raw };
  if (!Array.isArray(cfg.groups) || !cfg.groups.length) return null;
  const m = /^group:(\d+)$/.exec(String(key || ''));
  if (!m) return null;
  // 支持 "*" = 所有群（2026-11-05）
  const all = cfg.groups.map(String).includes('*');
  if (!all && !cfg.groups.map(Number).includes(Number(m[1]))) return null;
  cfg.cap = num(cfg.cap, 100);
  cfg.costPerMessage = num(cfg.costPerMessage, 1);
  cfg.tiredBelow = num(cfg.tiredBelow, 20);
  cfg.restorePerHour = num(cfg.restorePerHour, 30);
  cfg.maxPerMinute = num(cfg.maxPerMinute, 5);
  cfg.maxPerHour = num(cfg.maxPerHour, 20);
  return cfg;
}

/** 确保会话里有精力状态结构（不改已有值）。 */
export function ensureEnergyState(state, cfg, now = Date.now()) {
  if (!state.energy || typeof state.energy !== 'object') {
    state.energy = {
      value: cfg.cap,
      updatedAt: now,
      minuteStart: now,
      minuteCount: 0,
      hourStart: now,
      hourCount: 0,
    };
  }
  return state.energy;
}

/** 按经过的时间恢复精力（非峰期按小时折算，可以带小数）。 */
export function applyRestore(state, cfg, now = Date.now()) {
  const e = ensureEnergyState(state, cfg, now);
  const elapsedMs = Math.max(0, now - Number(e.updatedAt || now));
  if (elapsedMs > 0) {
    const gained = (cfg.restorePerHour * elapsedMs) / 3600000;
    e.value = Math.min(cfg.cap, Number(e.value || 0) + gained);
    e.updatedAt = now;
  }
  return e;
}

function refreshWindows(e, now) {
  if (now - Number(e.minuteStart || 0) >= 60000) {
    e.minuteStart = now;
    e.minuteCount = 0;
  }
  if (now - Number(e.hourStart || 0) >= 3600000) {
    e.hourStart = now;
    e.hourCount = 0;
  }
}

/** 当前状态（会自动做恢复和窗口滚动）。 */
export function energyStatus(state, cfg, now = Date.now()) {
  const e = applyRestore(state, cfg, now);
  refreshWindows(e, now);
  const value = Math.round(Number(e.value || 0) * 10) / 10;
  return {
    value,
    cap: cfg.cap,
    tired: value < cfg.tiredBelow,
    minuteCount: Number(e.minuteCount || 0),
    hourCount: Number(e.hourCount || 0),
    maxPerMinute: cfg.maxPerMinute,
    maxPerHour: cfg.maxPerHour,
    text: `${value.toFixed(1)} / ${cfg.cap}`,
  };
}

/**
 * 尝试消耗一次发言额度。
 * @returns {{ok:boolean, reason?:string, status?:object}}
 */
export function tryConsume(state, cfg, now = Date.now()) {
  const e = applyRestore(state, cfg, now);
  refreshWindows(e, now);
  if (Number(e.minuteCount || 0) >= cfg.maxPerMinute) {
    return { ok: false, reason: `一分钟最多 ${cfg.maxPerMinute} 句`, status: energyStatus(state, cfg, now) };
  }
  if (Number(e.hourCount || 0) >= cfg.maxPerHour) {
    return { ok: false, reason: `每小时最多 ${cfg.maxPerHour} 条`, status: energyStatus(state, cfg, now) };
  }
  if (Number(e.value || 0) < cfg.costPerMessage) {
    return { ok: false, reason: '精力见底了', status: energyStatus(state, cfg, now) };
  }
  e.value = Math.max(0, Number(e.value || 0) - cfg.costPerMessage);
  e.minuteCount = Number(e.minuteCount || 0) + 1;
  e.hourCount = Number(e.hourCount || 0) + 1;
  e.updatedAt = now;
  return { ok: true, status: energyStatus(state, cfg, now) };
}

/** 启动时把精力补满（计数窗口不动，限额仍跨重启保留）。 */
export function resetEnergyOnStart(state, cfg, now = Date.now()) {
  if (!cfg.resetOnStart) return null;
  const e = ensureEnergyState(state, cfg, now);
  e.value = cfg.cap;
  e.updatedAt = now;
  return energyStatus(state, cfg, now);
}
