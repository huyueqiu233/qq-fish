// gen-cli.mjs — 豆包生图命令行（给桥调用；也给人手跑）。
//
// 用法：
//   node gen-cli.mjs --prompt "一只猫" --out C:\tmp\a.png [--size 640] [--no-crop]
//
// 行为：
//   1) 没有调试端口的 Edge 就拉起一个（独立 profile，登录态长期有效）
//   2) 打开/复用豆包页面，确保在「图像生成」模式
//   3) 输入提示词 → 等新图 → 下载原图
//   4) 默认裁掉右下角水印并缩放到 --size 的正方形
//
// 退出码：0 成功；2 需要登录；3 超时；1 其它错误。错误信息打到 stderr。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9333;
const PROFILE = join(HERE, 'edge-profile');
const PYTHON = process.env.DSH_PYTHON || 'python';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i++; } else { out[key] = true; }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const prompt = String(args.prompt || '').trim();
const imageList = (Array.isArray(args.image) ? args.image : String(args.image || '').split(','))
  .map((x) => String(x || '').trim()).filter(Boolean).slice(0, 4);   // 参考图（可多张，最多 4）
const outPath = String(args.out || join(HERE, 'gen-out.png'));
const size = Math.max(128, Math.min(2048, Number(args.size) || 640));
const doCrop = args['no-crop'] !== true;
const timeoutMs = Math.max(30, Math.min(600, Number(args.timeout) || 180)) * 1000;

if (!prompt) { console.error('缺少 --prompt'); process.exit(1); }
if (!existsSync(EDGE)) { console.error('没找到 Edge: ' + EDGE); process.exit(1); }
mkdirSync(PROFILE, { recursive: true });

const fail = (code, msg) => { console.error(msg); process.exit(code); };

/* ---------- 1. 浏览器 ---------- */
async function devtoolsUp() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1200) });
    return r.ok;
  } catch { return false; }
}
async function ensureBrowser() {
  if (await devtoolsUp()) return;
  spawn(EDGE, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--no-default-browser-check',
    'https://www.doubao.com/chat/',
  ], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    if (await devtoolsUp()) return;
  }
  fail(1, 'Edge 调试端口没起来');
}

async function getPage() {
  for (let i = 0; i < 20; i++) {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page' && /doubao\.com/.test(t.url));
    if (page) return page;
    // 没有豆包页面就开一个
    if (i === 0) {
      await fetch(`http://127.0.0.1:${PORT}/json/new?https://www.doubao.com/chat/`, { method: 'PUT' }).catch(() => {});
    }
    await sleep(700);
  }
  fail(1, '没有可用的豆包页面');
}

await ensureBrowser();
const page = await getPage();

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
  }
});
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result?.value;
};
const clickAt = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
};

// 关掉页面上的弹窗/引导层（2026-11-02：QQ 那边画图失败就是因为弹窗盖住了输入框）。
// 策略：Escape → 找"关闭/我知道了/以后再说/跳过"这类按钮点掉 → 再按一次 Escape。
async function dismissOverlays() {
  const esc = async () => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  };
  await esc();
  await sleep(250);
  const hit = await evalJs(`(() => {
    const labels = ['关闭','我知道了','知道了','以后再说','稍后再说','跳过','取消','下次再说','不再提示','关闭弹窗'];
    const els = [...document.querySelectorAll('button,[role="button"],a,span,div')];
    const visible = (e) => {
      const r = e.getBoundingClientRect();
      const s = getComputedStyle(e);
      return r.width > 4 && r.height > 4 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
    };
    const cand = els.filter(visible).find((e) => {
      const t = (e.textContent || '').trim();
      const al = (e.getAttribute && (e.getAttribute('aria-label') || '')) || '';
      if (labels.some((l) => t === l || al === l)) return true;
      if (/关闭|close/i.test(al) && al.length < 12) return true;
      return false;
    });
    if (!cand) return null;
    const r = cand.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, label: (cand.textContent || '').trim().slice(0, 12) };
  })()`).catch(() => null);
  if (hit && Number.isFinite(hit.x)) {
    await clickAt(hit.x, hit.y);
    await sleep(350);
  }
  await esc();
  await sleep(200);
  return hit?.label || '';
}

const hasInput = () => evalJs(`!!document.querySelector('[contenteditable="true"]')`).catch(() => false);

// 窗口被最小化时页面会挤成窄条，先恢复
try {
  const win = await send('Browser.getWindowForTarget', {});
  if (win?.bounds?.windowState === 'minimized') {
    await send('Browser.setWindowBounds', { windowId: win.windowId, bounds: { windowState: 'normal' } });
    await sleep(400);
  }
} catch { /* 忽略 */ }

/* ---------- 2. 登录与模式 ---------- */
await sleep(1500);
const pageText = await evalJs('document.body.innerText.slice(0, 500)');
if (/(^|\n)\s*登录\s*($|\n)/.test(pageText) && !/用户\d/.test(pageText)) {
  fail(2, '豆包未登录：请管理员在那个 Edge 窗口里扫码登录一次');
}

const rectOf = (needle, exact = true) => evalJs(`(() => {
  const els = [...document.querySelectorAll('button,div,span,a,p')];
  const el = els.find((e) => {
    const t = (e.textContent || '').trim();
    return ${exact ? 't === ' : 't.includes('}${JSON.stringify(needle)}${exact ? '' : ')'} && e.getBoundingClientRect().width > 0;
  });
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
})()`);

// 确保在图像生成模式
/* ---------- 3. 发提示词（带模式自愈） ---------- */
// 页面上的"图像生成"chip 位置/状态不好判断（页面改版过），所以不用选择器猜模式，
// 改成行为式：先按当前模式发一次 → 等不到图就点一下 chip 切模式 → 重发，最多 3 次。
async function chipRect() {
  return evalJs(`(() => {
    const cands = [...document.querySelectorAll('button,[role="button"],div,span')]
      .filter((e) => {
        const t = (e.textContent || '').trim();
        const r = e.getBoundingClientRect();
        return t === '图像生成' && r.width > 30 && r.width < 140 && r.height > 16 && r.height < 44;
      })
      .map((e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    if (!cands.length) return null;
    // 取最靠下的那个：真正的 chip 在输入框下面那排
    cands.sort((a, b) => b.y - a.y);
    return cands[0];
  })()`).catch(() => null);
}

async function ensureInput() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const box = await evalJs(`(() => {
      const el = document.querySelector('[contenteditable="true"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 10) return null;
      return { x: r.x + r.width / 2, y: r.y + Math.min(r.height / 2, 30) };
    })()`).catch(() => null);
    if (box) return box;
    if (attempt === 2) {
      await send('Page.navigate', { url: 'https://www.doubao.com/chat/' }).catch(() => {});
      await sleep(2500);
    }
    await dismissOverlays();
    await sleep(700);
  }
  return null;
}

// 以图生图：用 CDP 拖拽把本地图片塞进输入框（2026-11-04 实测可用）
async function uploadImage(filePath) {
  if (!filePath || !existsSync(filePath)) throw new Error('参考图不存在：' + filePath);
  const box = await evalJs(`(() => {
    const el = document.querySelector('[contenteditable="true"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + 24) };
  })()`);
  if (!box) throw new Error('上传前找不到输入框');
  const before = await evalJs(`document.querySelectorAll('img[src^="blob:"]').length`);
  const data = { items: [], files: [filePath], dragOperationsMask: 1 };
  for (const type of ['dragEnter', 'dragOver', 'drop']) {
    await send('Input.dispatchDragEvent', { type, x: box.x, y: box.y, data }).catch(() => {});
    await sleep(200);
  }
  // 等缩略图出现（最多 8 秒）
  for (let i = 0; i < 16; i++) {
    await sleep(500);
    const now = await evalJs(`document.querySelectorAll('img[src^="blob:"]').length`);
    if (now > before) return true;
  }
  throw new Error('图片没上传成功（没等到缩略图）');
}

async function typeAndSend(box, text) {
  // 清空输入框再写（重试时别把上一条拼在一起）
  await clickAt(box.x, box.y);
  await sleep(250);
  await evalJs(`(() => { const el = document.querySelector('[contenteditable="true"]'); if (el) { el.textContent = ''; } return true; })()`).catch(() => {});
  await sleep(150);
  await send('Input.insertText', { text });
  await sleep(400);
  const typed = await evalJs(`(() => { const el = document.querySelector('[contenteditable="true"]'); return el ? el.textContent.trim() : ''; })()`);
  if (!typed || !typed.includes(text.slice(0, 6))) {
    return { ok: false, typed: String(typed).slice(0, 40) };
  }
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  return { ok: true };
}

async function snapshotImages() {
  const list = await evalJs(`(() => [...document.querySelectorAll('img')]
    .map((im) => im.currentSrc || im.src).filter((s) => /^https?:/.test(s)))()`).catch(() => []);
  return new Set(Array.isArray(list) ? list : []);
}

async function waitForImage(before, ms) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    await sleep(2000);
    const info = await evalJs(`(() => {
      const imgs = [...document.querySelectorAll('img')]
        .filter((im) => im.naturalWidth >= 512 && /^https?:/.test(im.currentSrc || im.src))
        .filter((im) => /rc_gen_image|flow-imagex-sign|byteimg\.com/.test(im.currentSrc || im.src))
        .map((im) => ({ src: im.currentSrc || im.src, w: im.naturalWidth, h: im.naturalHeight }));
      const busy = document.body.innerText.includes('生成中') || document.body.innerText.includes('正在生成');
      return { imgs, busy };
    })()`).catch(() => ({ imgs: [], busy: false }));
    const fresh = (info.imgs || []).filter((im) => !before.has(im.src));
    if (fresh.length && !info.busy) return fresh[fresh.length - 1];
  }
  return null;
}

let found = null;
for (let attempt = 1; attempt <= 3 && !found; attempt++) {
  if (attempt > 1) {
    const chip = await chipRect();
    if (chip) { await clickAt(chip.x, chip.y); await sleep(1300); }
    else { await dismissOverlays(); await sleep(600); }
  }
  const box = await ensureInput();
  if (!box) {
    try {
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(HERE, 'last-fail.png'), Buffer.from(shot.data, 'base64'));
    } catch { /* 忽略 */ }
    fail(1, '找不到输入框（弹窗或页面异常，已留 last-fail.png）');
  }
  if (imageList.length && attempt === 1) {
    try {
      for (const img of imageList) { await uploadImage(img); await sleep(500); }
      await sleep(600);
      console.error(`（参考图 ${imageList.length} 张已上传）`);
    } catch (error) {
      console.error('（参考图上传失败：' + error.message + '）');
      fail(1, '参考图上传失败：' + error.message);
    }
  }
  const before = await snapshotImages();
  const sent = await typeAndSend(box, prompt);
  if (!sent.ok) {
    console.error(`（第 ${attempt} 次提示词没写进去：${sent.typed}）`);
    continue;
  }
  // 控制总时长：三次尝试加起来要留在桥那侧 240s 超时之内
  const waitMs = Math.min(timeoutMs, attempt === 1 ? 35000 : 60000);
  found = await waitForImage(before, waitMs);
  if (!found) console.error(`（第 ${attempt} 次没等到图${attempt < 3 ? '，切换模式重试' : ''}）`);
}

if (!found) fail(3, '等图超时');
ws.close();

/* ---------- 5. 下载 + 裁切 ---------- */
const res = await fetch(found.src, { headers: { referer: 'https://www.doubao.com/', 'user-agent': 'Mozilla/5.0' } });
if (!res.ok) fail(1, '下载失败 HTTP ' + res.status);
const buf = Buffer.from(await res.arrayBuffer());
writeFileSync(outPath, buf);
console.log(JSON.stringify({ ok: true, raw: outPath, bytes: buf.length, w: found.w, h: found.h }));

if (doCrop) {
  const avatarPath = outPath.replace(/\.[a-z]+$/i, '') + '-avatar.png';
  const code = [
    'from PIL import Image',
    `im = Image.open(r"${outPath}").convert("RGB")`,
    'w, h = im.size',
    'im = im.crop((0, 0, int(w*0.91), int(h*0.91)))',
    'side = min(im.size)',
    'left = (im.width - side)//2',
    'top = (im.height - side)//2',
    `im = im.crop((left, top, left+side, top+side)).resize((${size}, ${size}), Image.LANCZOS)`,
    `im.save(r"${avatarPath}")`,
  ].join('\n');
  const r = spawn(PYTHON, ['-c', code], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  r.stderr.on('data', (d) => { err += d; });
  const code2 = await new Promise((resolve) => r.on('close', resolve));
  if (code2 === 0) console.log(JSON.stringify({ ok: true, cropped: avatarPath, size }));
  else console.log(JSON.stringify({ ok: true, cropped: null, error: err.slice(0, 200) }));
}
