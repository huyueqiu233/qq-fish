"""asr.py — 把一条语音转成文字（给 QQ 桥用，openai-whisper）。

用法：
  python asr.py --in C:\\tmp\\a.mp3 [--model base] [--language zh]

输出：stdout 一行 JSON {"ok":true,"text":"...","seconds":1.2}
退出码：0 成功；1 失败（错误打到 stderr）。
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def find_ffmpeg():
    cand = os.path.expandvars(r"%USERPROFILE%\.dsh\tools\ffmpeg\bin\ffmpeg.exe")
    if os.path.exists(cand):
        return cand
    from shutil import which
    return which("ffmpeg")


def load_audio(path, ffmpeg):
    """转成 16k 单声道 numpy 数组，避开 whisper 自己找 ffmpeg 的问题。"""
    import soundfile as sf
    import numpy as np
    tmp = tempfile.mktemp(suffix=".wav")
    if ffmpeg:
        subprocess.run([ffmpeg, "-y", "-loglevel", "error", "-i", path, "-ac", "1", "-ar", "16000", tmp], check=True)
        data, sr = sf.read(tmp, dtype="float32")
        os.remove(tmp)
    else:
        data, sr = sf.read(path, dtype="float32")
    if getattr(data, "ndim", 1) > 1:
        data = data.mean(axis=1)
    return np.asarray(data, dtype=np.float32), int(sr)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="input", required=True)
    ap.add_argument("--model", default="base")
    ap.add_argument("--language", default="zh")
    args = ap.parse_args()

    if not os.path.exists(args.input):
        print("找不到音频文件", file=sys.stderr)
        return 1

    try:
        import whisper
    except ImportError:
        print("缺少 openai-whisper（pip install openai-whisper）", file=sys.stderr)
        return 1

    try:
        audio, sr = load_audio(args.input, find_ffmpeg())
        model = whisper.load_model(args.model)
        result = model.transcribe(
            audio,
            language=args.language,
            fp16=False,
            condition_on_previous_text=False,
            initial_prompt="以下是普通话的句子，请用简体中文输出。",
        )
        text = (result.get("text") or "").strip()
        # whisper 的中文经常输出繁体：统一转简体（没有 opencc 就原样返回）
        try:
            from opencc import OpenCC
            text = OpenCC("t2s").convert(text)
        except Exception:
            pass
        print(json.dumps({"ok": True, "text": text, "seconds": round(len(audio) / sr, 2)}, ensure_ascii=False))
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"转写失败：{exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
