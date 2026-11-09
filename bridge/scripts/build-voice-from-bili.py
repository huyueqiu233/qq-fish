"""build-voice-from-bili.py — 从 B 站视频按 AI 字幕时间轴切片，生成语音库。

用途：把《闪耀暖暖 卡面语音合集》这类视频里的一句句台词切出来，放进
      桥的语音库（audio/），让 AI 直接挑着发。

依赖：bilibili_api、httpx（在 ~/.dsh/bili-duty/.venv 里）、ffmpeg。

规则：
  · 相邻字幕若间隔 < 0.8s 且合并后 < 8s → 合成一句（字幕常把一句话拆两行）
  · 只保留 0.6~8 秒、含中文的片段
  · 文本去重（同一句话只留最清楚的一条）
  · 文件名 = 预案 -> `暖{分P}-{序号}-{台词前12字}.mp3`，她在 qq_list_voices 里能看懂
  · 生成 audio/voice-manifest.json 记录来源（BV号/分P/时间轴/原文）
"""
import argparse
import asyncio
import json
import os
import re
import subprocess
import sys
import tempfile

import httpx
from bilibili_api import Credential, video

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

BVID = "BV1wgLWzZE3N"
TMP = tempfile.mkdtemp(prefix="bili-voice-")


def load_cred() -> Credential:
    path = os.path.expanduser("~/.dsh/bili-duty/bili_credential.json")
    c = json.load(open(path, encoding="utf-8"))
    return Credential(
        sessdata=c["sessdata"],
        bili_jct=c["bili_jct"],
        buvid3=c.get("buvid3"),
        dedeuserid=c.get("dedeuserid"),
    )


def merge_lines(body, gap=0.8, max_len=8.0):
    """把字幕行合并成"一句话"级别的片段。"""
    out = []
    for x in body:
        text = (x.get("content") or "").strip()
        if not text:
            continue
        start, end = float(x["from"]), float(x["to"])
        if out and start - out[-1]["end"] < gap and (end - out[-1]["start"]) < max_len:
            out[-1]["text"] += text
            out[-1]["end"] = end
        else:
            out.append({"text": text, "start": start, "end": end})
    return out


def sanitize(text: str, limit: int = 12) -> str:
    t = re.sub(r'[\\/:*?"<>|\r\n\t]', "", text)
    t = re.sub(r"\s+", "", t)
    t = re.sub(r"[^\u4e00-\u9fa5A-Za-z0-9]", "", t)
    return t[:limit] or "语句"


def cut(src: str, dst: str, start: float, end: float, ffmpeg: str) -> bool:
    # 前后各留 0.15/0.25 秒，避免削掉首尾音
    ss = max(0.0, start - 0.15)
    dur = max(0.5, (end + 0.25) - ss)
    cmd = [
        ffmpeg, "-y", "-loglevel", "error",
        "-ss", f"{ss:.3f}", "-t", f"{dur:.3f}", "-i", src,
        "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
        "-codec:a", "libmp3lame", "-q:a", "4", "-ar", "24000", "-ac", "1",
        dst,
    ]
    r = subprocess.run(cmd, capture_output=True)
    return r.returncode == 0 and os.path.exists(dst) and os.path.getsize(dst) > 0


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "audio"))
    ap.add_argument("--max-per-part", type=int, default=24)
    ap.add_argument("--max-total", type=int, default=400)
    ap.add_argument("--bvid", default=BVID, help="素材来源 BV 号")
    ap.add_argument("--tag", default="", help="文件名前缀，区分不同素材源（如 B）")
    args = ap.parse_args()

    out_dir = os.path.abspath(args.out)
    os.makedirs(out_dir, exist_ok=True)
    ffmpeg = os.path.expandvars(r"%USERPROFILE%\.dsh\tools\ffmpeg\bin\ffmpeg.exe")
    if not os.path.exists(ffmpeg):
        print("找不到 ffmpeg", file=sys.stderr)
        return 1

    cred = load_cred()
    v = video.Video(bvid=args.bvid, credential=cred)
    info = await v.get_info()
    pages = info["pages"]
    print(f"视频：{info['title'][:40]}｜{len(pages)} 个分P")

    manifest = []
    seen_text = set()
    total = 0

    for p in pages:
        if total >= args.max_total:
            break
        page = p["page"]
        try:
            pi = await v.get_player_info(cid=p["cid"])
            subs = (pi.get("subtitle") or {}).get("subtitles") or []
            if not subs:
                print(f"P{page:02d} 无字幕，跳过")
                continue
            url = subs[0]["subtitle_url"]
            if url.startswith("//"):
                url = "https:" + url
            r = httpx.get(url, headers={"User-Agent": "Mozilla/5.0", "Referer": "https://www.bilibili.com/"}, timeout=30, follow_redirects=True)
            body = r.json().get("body") or []

            dl = await v.get_download_url(p["page"] - 1)
            audios = (dl.get("dash") or {}).get("audio") or []
            if not audios:
                print(f"P{page:02d} 没有音频流")
                continue
            a = sorted(audios, key=lambda x: x.get("bandwidth", 0))[-1]
            audio_path = os.path.join(TMP, f"p{page:02d}.m4s")
            with httpx.stream("GET", a["baseUrl"], headers={"User-Agent": "Mozilla/5.0", "Referer": "https://www.bilibili.com/"}, timeout=120, follow_redirects=True) as resp:
                with open(audio_path, "wb") as f:
                    for chunk in resp.iter_bytes():
                        f.write(chunk)

            merged = merge_lines(body)
            kept = 0
            for i, line in enumerate(merged):
                if kept >= args.max_per_part or total >= args.max_total:
                    break
                text = line["text"].strip()
                if not re.search(r"[\u4e00-\u9fa5]", text):
                    continue
                dur = line["end"] - line["start"]
                if dur < 0.6 or dur > 8.0:
                    continue
                key = re.sub(r"[^\u4e00-\u9fa5]", "", text)
                if len(key) < 2 or key in seen_text:
                    continue
                prefix = f"暖{args.tag}" if args.tag else "暖"
                name = f"{prefix}{page:02d}-{i:02d}-{sanitize(text)}.mp3"
                dst = os.path.join(out_dir, name)
                if cut(audio_path, dst, line["start"], line["end"], ffmpeg):
                    seen_text.add(key)
                    kept += 1
                    total += 1
                    manifest.append({
                        "source": args.bvid,
                        "file": name,
                        "text": text,
                        "bvid": BVID,
                        "page": page,
                        "part": p["part"],
                        "start": round(line["start"], 2),
                        "end": round(line["end"], 2),
                    })
            print(f"P{page:02d} {p['part'][:16]:18s} 字幕 {len(body):3d} 条 → 切片 {kept}")

            try:
                os.remove(audio_path)
            except OSError:
                pass
        except Exception as exc:  # noqa: BLE001
            print(f"P{page:02d} 失败：{exc}", file=sys.stderr)
        await asyncio.sleep(0.4)

    mpath = os.path.join(out_dir, "voice-manifest.json")
    old = []
    if os.path.exists(mpath):
        try:
            old = json.load(open(mpath, encoding="utf-8"))
        except Exception:
            old = []
    existing = {x.get("file") for x in old}
    merged_manifest = old + [m for m in manifest if m["file"] not in existing]
    json.dump(merged_manifest, open(mpath, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"完成：新增 {len(manifest)} 条，累计 {len(merged_manifest)} 条 → {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
