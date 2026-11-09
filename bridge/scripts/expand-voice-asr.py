"""expand-voice-asr.py — 从没有字幕的 B 站视频里扩语音库（whisper 转写版）。

两段式（因为两个 venv 各缺一半依赖）：
  1) 下载：用 bili-duty venv 跑，抓音轨到临时目录，写 index.json
       python expand-voice-asr.py --stage download --bvid BV1ey4y1e7oD --pages 3 --tag B
  2) 转写+切片：用 dsh-tts venv 跑（有 whisper），转写后按句切 mp3 进 audio/
       python expand-voice-asr.py --stage process --work <临时目录> --tag B --max 40
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
AUDIO = os.path.join(ROOT, "audio")
FFMPEG = os.path.expandvars(r"%USERPROFILE%\.dsh\tools\ffmpeg\bin\ffmpeg.exe")


def sanitize(text: str) -> str:
    t = re.sub(r"[\\/:*?\"<>|\s]+", "", text)
    return t[:12] or "clip"


def stage_download(args):
    import asyncio
    import httpx
    from bilibili_api import Credential, video

    cred_path = os.path.expanduser("~/.dsh/bili-duty/bili_credential.json")
    c = json.load(open(cred_path, encoding="utf-8"))
    cred = Credential(sessdata=c["sessdata"], bili_jct=c["bili_jct"], buvid3=c.get("buvid3"), dedeuserid=c.get("dedeuserid"))

    work = args.work or tempfile.mkdtemp(prefix="voice-asr-")
    os.makedirs(work, exist_ok=True)

    async def run():
        v = video.Video(bvid=args.bvid, credential=cred)
        info = await v.get_info()
        print(f"视频：{info['title'][:36]}｜分P {len(info['pages'])}")
        saved = []
        for p in info["pages"][: args.pages]:
            try:
                dl = await v.get_download_url(p["page"] - 1)
                audios = (dl.get("dash") or {}).get("audio") or []
                if not audios:
                    print(f"P{p['page']:02d} 无音频流")
                    continue
                a = sorted(audios, key=lambda x: x.get("bandwidth", 0))[-1]
                dst = os.path.join(work, f"p{p['page']:02d}.m4s")
                with httpx.stream("GET", a["baseUrl"], headers={"User-Agent": "Mozilla/5.0", "Referer": "https://www.bilibili.com/"}, timeout=180, follow_redirects=True) as r:
                    with open(dst, "wb") as f:
                        for chunk in r.iter_bytes():
                            f.write(chunk)
                saved.append({"page": p["page"], "part": p["part"], "file": dst})
                print(f"P{p['page']:02d} 下载完成 {os.path.getsize(dst)//1024}KB")
            except Exception as exc:  # noqa: BLE001
                print(f"P{p['page']:02d} 下载失败：{exc}")
        json.dump({"bvid": args.bvid, "tag": args.tag, "pages": saved}, open(os.path.join(work, "index.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        print("WORK=" + work)

    asyncio.run(run())
    return 0


def stage_process(args):
    import numpy as np
    import soundfile as sf
    import whisper

    work = args.work
    idx = json.load(open(os.path.join(work, "index.json"), encoding="utf-8"))
    tag = args.tag or idx.get("tag") or ""
    os.makedirs(AUDIO, exist_ok=True)
    model = whisper.load_model(args.model)

    manifest_path = os.path.join(AUDIO, "voice-manifest.json")
    manifest = []
    if os.path.exists(manifest_path):
        try:
            manifest = json.load(open(manifest_path, encoding="utf-8"))
        except Exception:
            manifest = []
    existing = {m.get("file") for m in manifest}

    total = 0
    for page in idx["pages"]:
        if total >= args.max:
            break
        src = page["file"]
        # 转 16k wav 给 whisper
        wav = src + ".wav"
        subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-i", src, "-ac", "1", "-ar", "16000", wav], check=False)
        if not os.path.exists(wav):
            print(f"P{page['page']:02d} 转码失败")
            continue
        data, sr = sf.read(wav, dtype="float32")
        if getattr(data, "ndim", 1) > 1:
            data = data.mean(axis=1)
        res = model.transcribe(np.asarray(data, dtype=np.float32), language="zh", fp16=False, condition_on_previous_text=False)
        segs = res.get("segments") or []
        kept = 0
        for i, s in enumerate(segs):
            if total >= args.max:
                break
            text = (s.get("text") or "").strip()
            if not re.search(r"[\u4e00-\u9fa5]", text):
                continue
            dur = float(s["end"]) - float(s["start"])
            if dur < 0.6 or dur > 8.0:
                continue
            key = re.sub(r"[^\u4e00-\u9fa5]", "", text)
            if len(key) < 2:
                continue
            prefix = f"暖{tag}" if tag else "暖"
            name = f"{prefix}{page['page']:02d}A{i:02d}-{sanitize(text)}.mp3"
            if name in existing:
                continue
            dst = os.path.join(AUDIO, name)
            ok = subprocess.run([
                FFMPEG, "-y", "-loglevel", "error", "-ss", f"{s['start']:.2f}", "-to", f"{s['end']:.2f}",
                "-i", src, "-vn", "-ac", "1", "-ar", "24000", "-b:a", "96k", dst,
            ]).returncode == 0
            if ok and os.path.exists(dst):
                kept += 1
                total += 1
                existing.add(name)
                manifest.append({
                    "source": idx.get("bvid"),
                    "file": name,
                    "text": text,
                    "bvid": idx.get("bvid"),
                    "page": page["page"],
                    "part": page["part"],
                    "start": round(float(s["start"]), 2),
                    "end": round(float(s["end"]), 2),
                    "asr": True,
                })
        print(f"P{page['page']:02d} 转写 {len(segs)} 句 → 切片 {kept}")
        try:
            os.remove(wav)
        except OSError:
            pass

    json.dump(manifest, open(manifest_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"完成：新增 {total} 条，累计 {len(manifest)} 条")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", choices=["download", "process"], required=True)
    ap.add_argument("--bvid", default="")
    ap.add_argument("--pages", type=int, default=3)
    ap.add_argument("--tag", default="")
    ap.add_argument("--work", default="")
    ap.add_argument("--max", type=int, default=40)
    ap.add_argument("--model", default="base")
    args = ap.parse_args()

    if args.stage == "download":
        if not args.bvid:
            print("download 需要 --bvid", file=sys.stderr)
            return 1
        return stage_download(args)
    if not args.work:
        print("process 需要 --work", file=sys.stderr)
        return 1
    return stage_process(args)


if __name__ == "__main__":
    sys.exit(main())
