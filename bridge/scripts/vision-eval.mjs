// 收集「群友发图 + 她随后回复」的样本，把图片抓到本地，供人工/模型对照
import fs from 'node:fs';

const state = JSON.parse(fs.readFileSync('state/social-v2.json', 'utf8'));
const out = [];
for (const [key, st] of Object.entries(state.conversations || {})) {
  const list = [...(st.recentMessages || [])];
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (m.isSelf || !m.hasMedia) continue;
    const img = (m.media || []).find((x) => x.kind === 'image' && x.url);
    if (!img) continue;
    const reply = list.slice(i + 1, i + 6).find((x) => x.isSelf && x.time - m.time <= 180_000);
    if (!reply) continue;
    out.push({ key, seq: m.seq, at: m.time, sender: m.sender, text: m.text, url: img.url, reply: reply.text, replyAt: reply.time });
  }
}
out.sort((a, b) => b.at - a.at);
const picked = out.slice(0, 6);
fs.mkdirSync('_vision_eval', { recursive: true });
let i = 0;
for (const p of picked) {
  i += 1;
  try {
    const r = await fetch(p.url, { headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://qun.qq.com/' } });
    const buf = Buffer.from(await r.arrayBuffer());
    const file = `_vision_eval/${i}.png`;
    fs.writeFileSync(file, buf);
    p.file = file;
    p.bytes = buf.length;
  } catch (e) {
    p.error = e.message;
  }
  delete p.url;
}
console.log(JSON.stringify(picked, null, 1));
