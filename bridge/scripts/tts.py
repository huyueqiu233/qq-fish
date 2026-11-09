"""tts.py — 把文本合成成语音文件。

两个引擎，自动降级：
  1) edge-tts（音质好，需要能连 speech.platform.bing.com）
  2) Windows SAPI（离线，音色 Microsoft Huihui，机械但一定能用）

用法：
  python tts.py --text "你好呀" --out C:\\path\\a.mp3 [--voice zh-CN-XiaoyiNeural] [--engine auto|edge|sapi]

退出码：0 成功；2 文本为空；1 其它失败（错误打到 stderr）。
输出：成功后 stdout 打印一行 JSON：{"ok":true,"out":"...","bytes":123,"engine":"edge|sapi"}
"""
import argparse
import asyncio
import json
import os
import shutil
import subprocess
import sys
import tempfile

DEFAULT_VOICE = "zh-CN-XiaoyiNeural"
SAPI_VOICE = "Microsoft Huihui Desktop"
FFMPEG_CANDIDATES = (
    os.path.expandvars(r"%USERPROFILE%\.dsh\tools\ffmpeg\bin\ffmpeg.exe"),
    "ffmpeg",
)


def find_ffmpeg() -> str | None:
    for p in FFMPEG_CANDIDATES:
        if p == "ffmpeg":
            found = shutil.which("ffmpeg")
            if found:
                return found
            continue
        if os.path.exists(p):
            return p
    return None


def synth_edge(text: str, out: str, voice: str) -> None:
    import edge_tts

    async def run():
        await edge_tts.Communicate(text, voice).save(out)

    asyncio.run(run())


def synth_sapi(text: str, out: str, ffmpeg: str | None) -> None:
    """离线兜底：PowerShell + System.Speech → wav → ffmpeg → mp3。"""
    wav = out + ".wav"
    # 文本通过 stdin 传给 PowerShell，避免引号/中文转义问题
    ps = (
        "Add-Type -AssemblyName System.Speech;"
        "$t = [Console]::In.ReadToEnd();"
        f"$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;"
        f"$s.SelectVoice('{SAPI_VOICE}');"
        f"$s.SetOutputToWaveFile('{wav}');"
        "$s.Speak($t);"
        "$s.Dispose();"
    )
    proc = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps],
        input=text.encode("utf-8"),
        capture_output=True,
        timeout=120,
    )
    if proc.returncode != 0 or not os.path.exists(wav):
        raise RuntimeError((proc.stderr or b"powershell failed").decode("utf-8", "replace")[:200])

    if ffmpeg:
        r = subprocess.run(
            [ffmpeg, "-y", "-loglevel", "error", "-i", wav, "-codec:a", "libmp3lame", "-q:a", "5", out],
            capture_output=True,
            timeout=120,
        )
        if r.returncode != 0 or not os.path.exists(out):
            raise RuntimeError((r.stderr or b"ffmpeg failed").decode("utf-8", "replace")[:200])
    else:
        shutil.move(wav, out)
        return
    try:
        os.remove(wav)
    except OSError:
        pass


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--text", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--voice", default=DEFAULT_VOICE)
    ap.add_argument("--engine", default="auto", choices=["auto", "edge", "sapi"])
    ap.add_argument("--rate", default="+0%")
    ap.add_argument("--pitch", default="+0Hz")
    args = ap.parse_args()

    text = (args.text or "").strip()
    if not text:
        print("text 为空", file=sys.stderr)
        return 2

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    errors = []

    if args.engine in ("auto", "edge"):
        try:
            synth_edge(text, args.out, args.voice)
            if os.path.getsize(args.out) > 0:
                print(json.dumps({"ok": True, "out": args.out, "bytes": os.path.getsize(args.out), "engine": "edge"}, ensure_ascii=False))
                return 0
        except Exception as exc:  # noqa: BLE001
            errors.append(f"edge: {exc}")
            if args.engine == "edge":
                print("Edge TTS 失败：" + str(exc), file=sys.stderr)
                return 1

    try:
        synth_sapi(text, args.out, find_ffmpeg())
        if os.path.getsize(args.out) > 0:
            print(json.dumps({"ok": True, "out": args.out, "bytes": os.path.getsize(args.out), "engine": "sapi", "edgeError": errors[:1]}, ensure_ascii=False))
            return 0
    except Exception as exc:  # noqa: BLE001
        errors.append(f"sapi: {exc}")

    print("；".join(errors)[:400], file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
