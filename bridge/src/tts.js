// tts.js — 文本转语音（Edge TTS，免费无需 key）
//
// 为什么放桥里：QQ 语音条要 SILK，但 SnowLuma 的 record 段会自动把 mp3 编码成 SILK，
// 所以这边只要产出一个 mp3 丢进语音库（socialV2.voice.dir/tts/），再用现成的
// sendVoiceForV2 发出去即可。
//
// 安全：语音库只允许读库内文件（resolveVoicePathForV2 会校验），所以产物必须落在库内。

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAX_TEXT = 200;

export function createTts({
  libraryDir,
  pythonPath,
  scriptPath,
  defaultVoice = 'zh-CN-XiaoyiNeural',
  rate = '+0%',
  pitch = '+0Hz',
  timeoutMs = 45000,
  cosyUrl = '',
  indexttsUrl = '',
  indexttsRef = '',
  engine = 'auto',
  ffmpegPath = '',
  log = () => {},
}) {
  const outDir = path.join(libraryDir, 'tts');

  const KEY_VERSION = 'v4'; // 改合成策略就 +1，避免吃到旧缓存
  function keyOf(text, voice, r, p, emotion = '', alpha = '') {
    return createHash('sha1').update(`${KEY_VERSION}|${voice}|${r}|${p}|${emotion}|${alpha}|${text}`).digest('hex').slice(0, 16);
  }

  // ── CosyVoice2 本地服务（克隆音色）──────────────────────────────────
  // 服务端：%USERPROFILE%\dsh-tts\cosy_server.py，默认 127.0.0.1:9880
  // 不可用时静默返回 null，让上层退回 Edge/SAPI，绝不因为服务没起就把语音功能弄挂。
  async function tryCosy(text, absOut) {
    const base = String(cosyUrl || '').trim().replace(/\/+$/, '');
    if (!base) return false;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    try {
      const health = await fetch(`${base}/health`, { signal: ctrl.signal }).then((r) => r.json());
      clearTimeout(t);
      if (!health?.ok) return false;
      const res = await fetch(`${base}/tts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, out: absOut }),
        signal: AbortSignal.timeout ? AbortSignal.timeout(180000) : undefined,
      }).then((r) => r.json());
      if (res?.ok && fs.existsSync(absOut) && fs.statSync(absOut).size > 0) {
        log(`[tts] CosyVoice2 合成 ${res.seconds}s 音频，耗时 ${res.elapsedMs}ms`);
        return true;
      }
      log(`[tts] CosyVoice2 返回异常：${res?.error || 'unknown'}`);
      return false;
    } catch {
      clearTimeout(t);
      return false;
    }
  }


  // ===== IndexTTS-2.5 本地服务（有情绪，2026-11-06）=====
  // 服务端：%USERPROFILE%\dsh-tts\indextts_server.py，默认 127.0.0.1:9881
  // 经验：情绪强度高了会把音色撑崩（听感是"破音"），所以 alpha 默认压到 0.3 左右；
  //       长句会越说越漂，按标点拆短分别合成，再用 ffmpeg 拼起来。
  function splitClauses(text) {
    const parts = String(text).split(/(?<=[，。！？；、,.!?;…~])\s*/).map((x) => x.trim()).filter(Boolean);
    const out = [];
    for (const p of parts) {
      if (p.length <= 22) { out.push(p); continue; }
      for (let i = 0; i < p.length; i += 18) out.push(p.slice(i, i + 18));
    }
    return out.length ? out.slice(0, 8) : [String(text)];
  }

  async function tryIndexTts(text, absOut, opts = {}) {
    const base = String(indexttsUrl || '').trim().replace(/\/+$/, '');
    if (!base) return false;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      const health = await fetch(`${base}/health`, { signal: ctrl.signal }).then((r) => r.json());
      clearTimeout(t);
      if (!health?.ok) { log('[tts] IndexTTS 未就绪：' + (health?.error || 'loading')); return false; }
      const emo = String(opts.emotion || '').trim().toLowerCase();
      const alpha = opts.alpha != null ? Number(opts.alpha) : (emo ? 0.2 : 0);
      // 拆句会打断气口（听感=念稿/断句怪）。只有强情绪(>=0.4)才拆；轻情绪整句一次生成。
      // 2026-11-06 实测：0.2 强度整句最自然。
      const clauses = emo && alpha >= 0.4 ? splitClauses(text) : [String(text)];
      // 太短的句子加情绪容易出电音（"哼"），至少 6 个字才套
      const emotionOk = emo && clauses[0].length >= 6;
      const tmpDir = path.join(outDir, `_tmp-${Date.now()}`);
      fs.mkdirSync(tmpDir, { recursive: true });
      const pieces = [];
      const started = Date.now();
      for (let i = 0; i < clauses.length; i += 1) {
        const segOut = path.join(tmpDir, `seg-${i}.mp3`);
        // 情绪只给第一小句：真人发怒/开心也是先冲一句，后面自然回落；
        // 每句都重起情绪会听成"颤音"（2026-11-06 实测）
        const segEmo = i === 0 && emotionOk ? emo : undefined;
        const segAlpha = i === 0 ? alpha : 0;
        const res = await fetch(`${base}/tts`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: clauses[i], out: segOut, emo: segEmo, alpha: segAlpha, ref: indexttsRef || undefined }),
          signal: AbortSignal.timeout ? AbortSignal.timeout(180000) : undefined,
        }).then((r) => r.json());
        if (!res?.ok || !fs.existsSync(segOut)) {
          log(`[tts] IndexTTS 第 ${i + 1} 段失败：${res?.error || 'unknown'}`);
          fs.rmSync(tmpDir, { recursive: true, force: true });
          return false;
        }
        pieces.push(segOut);
      }
      if (pieces.length === 1) {
        fs.copyFileSync(pieces[0], absOut);
      } else {
        const listFile = path.join(tmpDir, 'list.txt');
        fs.writeFileSync(listFile, pieces.map((p) => "file '" + p.replace(/'/g, "'\\''") + "'").join('\n'), 'utf8');
        const ff = ffmpegPath || 'ffmpeg';
        const code = await new Promise((resolve) => {
          const child = spawn(ff, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-c:a', 'libmp3lame', '-b:a', '96k', absOut], { windowsHide: true });
          child.on('close', (c) => resolve(c));
          child.on('error', () => resolve(-1));
        });
        if (code !== 0 || !fs.existsSync(absOut)) {
          log('[tts] 分段拼接失败，退回第一段');
          fs.copyFileSync(pieces[0], absOut);
        }
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
      if (fs.existsSync(absOut) && fs.statSync(absOut).size > 0) {
        log(`[tts] IndexTTS 合成 ${clauses.length} 段，耗时 ${Date.now() - started}ms，情绪 ${emo || '无'}`);
        return true;
      }
      return false;
    } catch (error) {
      log(`[tts] IndexTTS 异常：${error?.message ?? error}`);
      return false;
    }
  }

  /** 合成一段语音，返回库内相对路径（如 tts/ab12cd.mp3）。已有同文同参数的缓存直接复用。 */
  async function synthesize(text, opts = {}) {
    const raw = String(text ?? '').trim();
    if (!raw) throw new Error('要合成的文本为空');
    if (raw.length > MAX_TEXT) throw new Error(`语音文本太长（${raw.length} 字，上限 ${MAX_TEXT}），请拆短`);
    if (!fs.existsSync(scriptPath)) throw new Error(`找不到 TTS 脚本：${path.basename(scriptPath)}`);

    const voice = String(opts.voice || defaultVoice);
    const r = String(opts.rate || rate);
    const p = String(opts.pitch || pitch);
    const id = keyOf(raw, voice, r, p, String(opts.emotion || ''), String(opts.alpha ?? ''));
    const rel = path.join('tts', `${id}.mp3`);
    const abs = path.join(outDir, `${id}.mp3`);

    if (fs.existsSync(abs) && fs.statSync(abs).size > 0) {
      return { file: rel.split(path.sep).join('/'), path: abs, cached: true };
    }

    fs.mkdirSync(outDir, { recursive: true });

    // 引擎选择（2026-11-06）：indextts 有情绪但偶有漂移；cosy 稳但无情绪
    const want = String(engine || 'auto').toLowerCase();
    const tryOrder = want === 'cosy' ? ['cosy', 'indextts'] : ['indextts', 'cosy'];
    let lastErr = '';
    for (const name of tryOrder) {
      if (name === 'indextts') {
        if (!indexttsUrl) continue;
        const ok = await tryIndexTts(raw, abs, { emotion: opts.emotion, alpha: opts.alpha });
        if (ok) return { file: rel.split(path.sep).join('/'), path: abs, bytes: fs.statSync(abs).size, cached: false, engine: 'indextts' };
        lastErr = 'IndexTTS 合成失败';
      } else if (name === 'cosy') {
        if (!cosyUrl) continue;
        const ok = await tryCosy(raw, abs);
        if (ok) return { file: rel.split(path.sep).join('/'), path: abs, bytes: fs.statSync(abs).size, cached: false, engine: 'cosyvoice' };
        lastErr = 'CosyVoice 合成失败';
      }
    }

    // 配了克隆服务但都不可用：**不要**退回机械音（2026-11-04 踩过：服务挂了半天，全变 AI 音）
    if (indexttsUrl || cosyUrl) {
      throw new Error('克隆音色服务都没在跑（' + (lastErr || '未配置') + '），先别用现场合成——可以用 qq_send_voice 从语音库里挑一句');
    }

    const args = [scriptPath, '--text', raw, '--out', abs, '--voice', voice, '--rate', r, '--pitch', p];
    const result = await new Promise((resolve) => {
      const child = spawn(pythonPath, args, { windowsHide: true });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
        resolve({ ok: false, error: `TTS 超时（${timeoutMs}ms）` });
      }, timeoutMs);
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', (error) => { clearTimeout(timer); resolve({ ok: false, error: error.message }); });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve(code === 0 ? { ok: true, stdout } : { ok: false, error: (stderr || stdout || `exit ${code}`).slice(0, 200) });
      });
    });

    if (!result.ok) {
      log(`[tts] 合成失败：${result.error}`);
      throw new Error(`语音合成失败：${result.error}`);
    }
    if (!fs.existsSync(abs) || fs.statSync(abs).size === 0) throw new Error('语音合成结果为空');

    return {
      file: rel.split(path.sep).join('/'),
      path: abs,
      bytes: fs.statSync(abs).size,
      cached: false,
    };
  }

  return { synthesize };
}
