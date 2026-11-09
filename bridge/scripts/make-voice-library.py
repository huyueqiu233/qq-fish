"""make-voice-library.py — 批量生成语音库文件（用 Windows SAPI，离线可用）。

用法：
  python make-voice-library.py [--dir audio] [--engine sapi|edge] [--force]

规则：
  · 每个短语生成 <dir>/<名字>.mp3；已存在且不是 --force 就跳过（方便以后替换成更好听的录音）
  · 文件名就是她在 qq_list_voices 里看到的名字，所以名字要能一眼看出什么时候用
"""
import argparse
import os
import subprocess
import sys

PHRASES = {
    # 名字: 要说的文本
    "晚安": "晚安，做个好梦。",
    "早安": "早安，今天也要开开心心的。",
    "在吗": "在吗？我有点想你了。",
    "好耶": "好耶！",
    "哼": "哼，不理你了。",
    "对不起": "对不起嘛，我错了。",
    "谢谢": "谢谢你呀。",
    "想你": "有点想你了。",
    "我错啦": "我错啦，别生气好不好。",
    "不要嘛": "不要嘛。",
    "夸我": "夸夸我嘛。",
    "摸摸头": "摸摸头，不难过了。",
    "吃了吗": "吃饭了吗？别饿着。",
    "等我": "等等我，马上就来。",
    "我回来啦": "我回来啦！",
    "先睡啦": "我先睡啦，你也早点休息。",
    "你真好": "你真好。",
    "真的假的": "真的假的？",
    "笑死": "笑死我了。",
    "呜呜": "呜呜呜。",
    "加油": "加油！我支持你。",
    "辛苦啦": "辛苦啦，歇一会儿吧。",
    "生日快乐": "生日快乐！",
    "晚安好梦": "晚安，好梦。",
}


def sapi(text: str, out: str, ffmpeg: str | None) -> None:
    wav = out + ".wav"
    ps = (
        "Add-Type -AssemblyName System.Speech;"
        "$t = [Console]::In.ReadToEnd();"
        "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;"
        "$s.SelectVoice('Microsoft Huihui Desktop');"
        f"$s.SetOutputToWaveFile('{wav}');"
        "$s.Speak($t);"
        "$s.Dispose();"
    )
    r = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps],
                       input=text.encode("utf-8"), capture_output=True, timeout=120)
    if r.returncode != 0 or not os.path.exists(wav):
        raise RuntimeError((r.stderr or b"sapi failed").decode("utf-8", "replace")[:200])
    if ffmpeg:
        r2 = subprocess.run([ffmpeg, "-y", "-loglevel", "error", "-i", wav,
                             "-codec:a", "libmp3lame", "-q:a", "5", out],
                            capture_output=True, timeout=120)
        if r2.returncode != 0:
            raise RuntimeError((r2.stderr or b"ffmpeg failed").decode("utf-8", "replace")[:200])
        os.remove(wav)
    else:
        os.replace(wav, out)


def edge(text: str, out: str) -> None:
    import asyncio
    import edge_tts

    async def run():
        await edge_tts.Communicate(text, "zh-CN-XiaoyiNeural").save(out)

    asyncio.run(run())


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default="audio")
    ap.add_argument("--engine", default="sapi", choices=["sapi", "edge"])
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    os.makedirs(args.dir, exist_ok=True)
    ffmpeg = os.path.expandvars(r"%USERPROFILE%\.dsh\tools\ffmpeg\bin\ffmpeg.exe")
    ffmpeg = ffmpeg if os.path.exists(ffmpeg) else None

    made = skipped = failed = 0
    for name, text in PHRASES.items():
        out = os.path.join(args.dir, f"{name}.mp3")
        if os.path.exists(out) and not args.force:
            skipped += 1
            continue
        try:
            if args.engine == "edge":
                edge(text, out)
            else:
                sapi(text, out, ffmpeg)
            size = os.path.getsize(out)
            print(f"  {name}.mp3  {size} bytes")
            made += 1
        except Exception as exc:  # noqa: BLE001
            print(f"  {name} 失败: {exc}", file=sys.stderr)
            failed += 1

    print(f"完成：新增 {made}，跳过 {skipped}，失败 {failed}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
