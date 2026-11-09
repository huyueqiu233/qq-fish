// long-memory.js — 长期记忆存储（P1：事件/事实/自我笔记 + 热度 + 检索 + 证据）
//
// 设计来自 MEMORY-CHAIN.md v2（揉进 C1 的分层遗忘 + V6 的证据回查）：
//   · 一条记忆 = 一个记忆点，有 id / 标题 / 正文 / 标签 / 证据 / 热度
//   · 热度 = priority(0-100) + hits(被检索次数) + lastSeen
//   · 每天结算：没被碰到的慢慢降，反复出现的升
//   · 正文永远不进上下文，只给标题；要全文就按 id 取（工具调用即累计热度）
//
// 存储：<root>/events.jsonl（事件）、facts.jsonl（事实）、selfnotes.jsonl（自我笔记）、index.json（索引）

import fs from 'node:fs';
import path from 'node:path';

const KINDS = {
  event: '事件',
  fact: '事实',
  selfnote: '自我笔记',
  impression: '印象',
};

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const nowIso = () => new Date().toISOString();

// 分层：1=核心(>=80) 2=常驻(60-79) 3=普通(40-59) 4=深处(<40)
const layerOf = (priority) => (priority >= 80 ? 1 : priority >= 60 ? 2 : priority >= 40 ? 3 : 4);

function tokenize(text) {
  const raw = String(text || '').toLowerCase();
  const out = [];
  for (const chunk of raw.split(/[\s,，。.!！?？;；:：、"'()（）\[\]【】]+/)) {
    if (!chunk) continue;
    if (/[一-鿿]/.test(chunk)) {
      // 中文没有空格：按二字滑窗切，否则整句会被当成一个词，相似度和检索都失效
      if (chunk.length === 1) out.push(chunk);
      for (let i = 0; i < chunk.length - 1; i += 1) out.push(chunk.slice(i, i + 2));
    } else {
      out.push(chunk);
    }
  }
  return [...new Set(out)].slice(0, 80);
}

export function createLongMemory({ root, log = () => {} }) {
  const dir = root;
  fs.mkdirSync(dir, { recursive: true });

  const files = {
    event: path.join(dir, 'events.jsonl'),
    fact: path.join(dir, 'facts.jsonl'),
    selfnote: path.join(dir, 'selfnotes.jsonl'),
  };
  const indexFile = path.join(dir, 'index.json');

  /** 索引：id -> {kind,title,text,tags,evidence,priority,hits,lastSeen,createdAt,pinned,superseded} */
  let index = new Map();
  let seq = 0;

  function load() {
    index.clear();
    seq = 0;
    for (const [kind, file] of Object.entries(files)) {
      if (!fs.existsSync(file)) continue;
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      for (const line of lines) {
        const s = line.trim();
        if (!s) continue;
        let rec;
        try {
          rec = JSON.parse(s);
        } catch {
          continue;
        }
        if (!rec?.id) continue;
        index.set(rec.id, rec);
        const n = Number(String(rec.id).replace(/\D/g, ''));
        if (Number.isFinite(n)) seq = Math.max(seq, n);
      }
    }
    log(`[memory] 载入 ${index.size} 条长期记忆`);
    // 老记录迁移（2026-11-04）：按 convKey 推断来源，避免全被当成低可信
    for (const rec of index.values()) {
      if (rec.trust == null) {
        const k = String(rec.convKey || '');
        rec.source = rec.source || (k.startsWith('private:') ? 'owner' : 'group');
        rec.trust = rec.source === 'owner' ? 95 : 55;
      }
    }

  }

  function persistIndex() {
    try {
      const dump = { savedAt: nowIso(), seq, records: [...index.values()] };
      fs.writeFileSync(indexFile, JSON.stringify(dump, null, 0), 'utf8');
    } catch (error) {
      log(`[memory] 写索引失败：${error?.message ?? error}`);
    }
  }

  function appendRecord(kind, rec) {
    try {
      fs.appendFileSync(files[kind], JSON.stringify(rec) + '\n', 'utf8');
    } catch (error) {
      log(`[memory] 追加失败：${error?.message ?? error}`);
    }
  }

  /** 新增一条记忆。 */
  const SOURCE_TRUST = { owner: 95, self: 85, group: 55, web: 35 };

  function note({ kind = 'event', text, tags = [], evidence = null, priority = 55, dueAt = null, convKey = '', source = 'group', trust = null, summary = null, meaning = null }) {
    const clean = String(text || '').trim();
    if (!clean) return { ok: false, error: '内容不能为空' };
    const k = KINDS[kind] ? kind : 'event';
    seq += 1;
    const id = `${k === 'event' ? 'ev' : k === 'fact' ? 'fa' : k === 'selfnote' ? 'sn' : 'im'}-${String(seq).padStart(5, '0')}`;
    const rec = {
      id,
      kind: k,
      title: clean.slice(0, 40),
      text: clean.slice(0, 2000),
      summary: String(summary || clean).slice(0, 80),
      meaning: String(meaning || '').slice(0, 160),
      tags: (Array.isArray(tags) ? tags : []).map((t) => String(t).slice(0, 20)).slice(0, 8),
      evidence: evidence && typeof evidence === 'object' ? evidence : null,
      priority: clamp(Number(priority) || 55, 1, 100),
      hits: 0,
      lastSeen: nowIso(),
      createdAt: nowIso(),
      pinned: false,
      superseded: false,
      dueAt: Number(dueAt) > 0 ? Number(dueAt) : null,
      fired: false,
      convKey: String(convKey || '').slice(0, 40),
      source: SOURCE_TRUST[source] ? source : 'group',
      trust: clamp(Number(trust) || SOURCE_TRUST[source] || 55, 0, 100),
    };
    index.set(id, rec);
    appendRecord(k, rec);
    persistIndex();
    return { ok: true, record: rec };
  }

  /** 检索：关键词命中 × 热度，返回标题列表（不给正文）。 */
  /** 只返回低可信条目（给控制台审阅用） */
  function lowTrust(threshold = 45, limit = 20) {
    const out = [];
    for (const rec of index.values()) {
      if (rec.superseded) continue;
      if ((rec.trust ?? 55) < threshold) out.push(rec);
    }
    out.sort((a, b) => (a.trust ?? 55) - (b.trust ?? 55));
    return out.slice(0, Math.max(1, limit));
  }

  function search(query, { limit = 8, kind = null } = {}) {
    const terms = tokenize(query);
    if (!terms.length) return [];
    const scored = [];
    for (const rec of index.values()) {
      if (rec.superseded) continue;
      if (kind && rec.kind !== kind) continue;
      const hay = `${rec.title} ${rec.text} ${(rec.tags || []).join(' ')}`.toLowerCase();
      let score = 0;
      for (const t of terms) if (hay.includes(t)) score += t.length;
      if (!score) continue;
      const heat = rec.priority * 0.5 + Math.min(50, rec.hits * 3);
      scored.push({ rec, score: score * 10 + heat });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, clamp(limit, 1, 30)).map(({ rec }) => ({
      id: rec.id,
      kind: rec.kind,
      title: rec.title,
      // 三层披露：这里先给「摘要」和「意义/情境」，正文要 get 才能看（2026-11-04）
      summary: rec.summary || rec.title,
      meaning: rec.meaning || '',
      tags: rec.tags,
      hits: rec.hits,
      priority: Math.round(rec.priority),
      layer: layerOf(rec.priority),
      hasMore: true,
    }));
  }

  /** 取全文（同时累计热度）。 */
  function get(id) {
    const rec = index.get(String(id || '').trim());
    if (!rec) return null;
    rec.hits += 1;
    rec.lastSeen = nowIso();
    rec.priority = clamp(rec.priority + 1.5, 1, 100);
    persistIndex();
    return rec;
  }

  /** 到点且没提醒过的（按时间正序） */
  function due(now = Date.now(), { limit = 10 } = {}) {
    const out = [];
    for (const rec of index.values()) {
      if (rec.fired || !rec.dueAt || rec.superseded) continue;
      if (rec.dueAt <= now) out.push(rec);
    }
    out.sort((a, b) => a.dueAt - b.dueAt);
    return out.slice(0, Math.max(1, limit));
  }

  /** 未来 N 小时内的提醒（给提示词用） */
  function upcoming(now = Date.now(), { hours = 24, limit = 5 } = {}) {
    const until = now + hours * 3600000;
    const out = [];
    for (const rec of index.values()) {
      if (rec.fired || !rec.dueAt || rec.superseded) continue;
      if (rec.dueAt > now && rec.dueAt <= until) out.push(rec);
    }
    out.sort((a, b) => a.dueAt - b.dueAt);
    return out.slice(0, Math.max(1, limit));
  }

  /** 记下来但还没问出口的问题（tag 含「疑问」），按时间正序 */
  function questions({ limit = 5, includeAsked = false } = {}) {
    const out = [];
    for (const rec of index.values()) {
      if (rec.superseded) continue;
      const tags = Array.isArray(rec.tags) ? rec.tags : [];
      if (!tags.some((t) => String(t).includes('疑问') || String(t).includes('问题'))) continue;
      if (!includeAsked && rec.fired) continue;
      out.push(rec);
    }
    out.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    return out.slice(0, Math.max(1, limit));
  }

  /** 把 b 合并进 a：权重相加、被合并者进归档（可追溯、可撤回） */
  function mergeInto(a, b, reason = 'dream') {
    if (!a || !b || a.id === b.id) return { ok: false };
    a.hits = (Number(a.hits) || 0) + (Number(b.hits) || 0);
    a.priority = clamp((Number(a.priority) || 55) + Math.round((Number(b.priority) || 55) * 0.25), 1, 100);
    a.mergedFrom = Array.isArray(a.mergedFrom) ? a.mergedFrom.concat([b.id]) : [b.id];
    a.updatedAt = nowIso();
    b.superseded = true;
    b.mergedInto = a.id;
    appendRecord('archive', { ts: nowIso(), reason, into: a.id, from: b.id, fromTitle: b.title });
    persistIndex();
    return { ok: true, into: a.id, from: b.id };
  }

  /** 把一段时间没人提的低价值事件淡出（不删，保留 30 天可捞） */
  function expireEvents({ days = 7, maxPriority = 40, limit = 20 } = {}) {
    const cutoff = Date.now() - days * 86400000;
    const out = [];
    for (const rec of index.values()) {
      if (rec.kind !== 'event' || rec.superseded || rec.pinned) continue;
      if ((rec.priority ?? 55) > maxPriority) continue;
      const t = Date.parse(rec.lastSeen || rec.createdAt || '') || 0;
      if (t && t < cutoff) { rec.superseded = true; rec.archived = 'expired'; appendRecord('archive', { ts: nowIso(), reason: 'expire', from: rec.id, fromTitle: rec.title }); out.push(rec.id); }
      if (out.length >= limit) break;
    }
    if (out.length) persistIndex();
    return out;
  }

  /** 撤回一次合并：把被合并的记录恢复，并从合并方减掉它的热度（2026-11-05） */
  function unmerge(fromId) {
    const rec = index.get(String(fromId || '').trim());
    if (!rec) return { ok: false, error: '没有这条记忆' };
    if (!rec.superseded || !rec.mergedInto) return { ok: false, error: '这条不是被合并掉的' };
    const into = index.get(rec.mergedInto);
    if (into) {
      into.hits = Math.max(0, (Number(into.hits) || 0) - (Number(rec.hits) || 0));
      if (Array.isArray(into.mergedFrom)) into.mergedFrom = into.mergedFrom.filter((x) => x !== rec.id);
      if (Array.isArray(into.text) && false) { /* noop */ }
    }
    rec.superseded = false;
    rec.mergedInto = null;
    rec.updatedAt = nowIso();
    appendRecord('archive', { ts: nowIso(), reason: 'unmerge', from: rec.id, fromTitle: rec.title, into: into ? into.id : null });
    persistIndex();
    return { ok: true, restored: rec.id, from: into ? into.id : null };
  }

  function markFired(id) {
    const rec = index.get(String(id || '').trim());
    if (!rec) return { ok: false, error: '没有这条记忆' };
    rec.fired = true;
    rec.firedAt = nowIso();
    persistIndex();
    return { ok: true, record: rec };
  }

  function pin(id) {
    const rec = index.get(String(id || '').trim());
    if (!rec) return null;
    rec.pinned = true;
    rec.priority = 100;
    persistIndex();
    return rec;
  }

  /** 列表：按热度排序的标题（用于注入），pinned 与 L1 优先。 */
  function topTitles(n = 3) {
    const all = [...index.values()].filter((r) => !r.superseded);
    all.sort((a, b) => (b.pinned - a.pinned) || (layerOf(b.priority) - layerOf(a.priority))
      || (b.priority - a.priority) || (b.hits - a.hits));
    return all.slice(0, clamp(n, 1, 20)).map((r) => ({
      id: r.id,
      title: r.title,
      kind: r.kind,
      layer: layerOf(r.priority),
      pinned: !!r.pinned,
      hasEvidence: !!r.evidence,
      verified: !!(r.evidence && r.evidence.verified),
    }));
  }

  /** 每日结算：没碰到的降温、掉层；沉到底层的软删（可恢复）。 */
  function decay({ decay = 0.97, floor = 6, archiveDays = 30 } = {}) {
    let dropped = 0;
    let demoted = 0;
    for (const rec of index.values()) {
      if (rec.pinned || rec.superseded) continue;
      const ageDays = (Date.now() - Date.parse(rec.lastSeen || rec.createdAt)) / 86400000;
      if (ageDays < 1) continue;
      const before = layerOf(rec.priority);
      rec.priority = rec.priority * decay;
      rec.hits = Math.floor((rec.hits || 0) * 0.6);
      const after = layerOf(rec.priority);
      if (after > before) demoted += 1;
      // 沉到最深处且长期没人提 → 软删（保留文件，可恢复）
      if (after === 4 && ageDays > archiveDays) {
        rec.superseded = true;
        rec.supersededAt = nowIso();
        dropped += 1;
        continue;
      }
      if (rec.priority < floor) {
        rec.superseded = true;
        rec.supersededAt = nowIso();
        dropped += 1;
      }
    }
    persistIndex();
    return { dropped, demoted, total: index.size };
  }

  /**
   * dream 整理（空闲时跑）：
   *   1) 合并近乎重复的事件（同一个 kind、词重合度高）
   *   2) 反复被取用的往上升层
   *   3) 重算层号
   */
  function dream({ similarity = 0.72, promoteHits = 3 } = {}) {
    const live = [...index.values()].filter((r) => !r.superseded);
    const merged = [];
    const mergedInto = new Set();
    for (let i = 0; i < live.length; i += 1) {
      const a = live[i];
      if (mergedInto.has(a.id)) continue;
      const ta = new Set(tokenize(`${a.title} ${a.text}`));
      for (let j = i + 1; j < live.length; j += 1) {
        const b = live[j];
        if (b.kind !== a.kind || mergedInto.has(b.id)) continue;
        const tb = new Set(tokenize(`${b.title} ${b.text}`));
        if (!ta.size || !tb.size) continue;
        let inter = 0;
        for (const t of ta) if (tb.has(t)) inter += 1;
        const ratio = inter / Math.min(ta.size, tb.size);
        if (ratio < similarity) continue;
        // 合并到更早的那条上
        const [keep, drop] = Date.parse(a.createdAt) <= Date.parse(b.createdAt) ? [a, b] : [b, a];
        keep.text = `${keep.text}｜${drop.text}`.slice(0, 2000);
        keep.hits += drop.hits || 0;
        keep.priority = Math.min(100, Math.max(keep.priority, drop.priority) + 3);
        keep.tags = [...new Set([...(keep.tags || []), ...(drop.tags || [])])].slice(0, 8);
        drop.superseded = true;
        drop.supersededAt = nowIso();
        drop.mergedInto = keep.id;
        // 归档：谁被并进了谁（可追溯、可撤回）2026-11-04
        appendRecord('archive', { ts: nowIso(), reason: 'dream', into: keep.id, from: drop.id, fromTitle: drop.title });
        mergedInto.add(drop.id);
        merged.push({ from: drop.id, into: keep.id });
      }
    }

    let promoted = 0;
    for (const rec of index.values()) {
      if (rec.superseded || rec.pinned) continue;
      if ((rec.hits || 0) >= promoteHits && layerOf(rec.priority) > 2) {
        rec.priority = Math.max(rec.priority, 68);
        promoted += 1;
      }
    }
    persistIndex();
    return { merged: merged.length, promoted, total: index.size, pairs: merged.slice(0, 5) };
  }

  function stats() {
    const byKind = {};
    const byLayer = { 1: 0, 2: 0, 3: 0, 4: 0 };
    let live = 0;
    for (const rec of index.values()) {
      if (rec.superseded) continue;
      live += 1;
      byKind[rec.kind] = (byKind[rec.kind] || 0) + 1;
      byLayer[layerOf(rec.priority)] += 1;
    }
    return { total: index.size, live, byKind, byLayer, root: dir };
  }

  load();

  return { note, search, get, pin, topTitles, decay, dream, stats, due, upcoming, questions, markFired, lowTrust, mergeInto, expireEvents, unmerge, reload: load, _index: index };
}
