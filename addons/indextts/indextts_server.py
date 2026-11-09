"""indextts_server.py — 本地 IndexTTS-2.5 HTTP 服务（给 QQ 桥用）。

对比 CosyVoice 的优势：**情绪控制**（8 维向量）+ 多语言。
用法：
    .venv\\Scripts\\python.exe indextts_server.py --port 9881

接口：
    GET  /health  → {ok, loading, error, ref}
    POST /tts     → {text, emo?, alpha?, speed?, ref?, out?} → {ok, file, seconds, ms}
"""

import argparse
import json
import os
import re
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
INDEX_DIR = os.path.join(ROOT, 'index-tts')
OUT_DIR = os.path.join(ROOT, 'ref')
os.makedirs(OUT_DIR, exist_ok=True)

DEFAULT_REF = os.path.join(OUT_DIR, 'ref_vocals_trim.mp3')
FFMPEG = os.path.expandvars(r'%USERPROFILE%\.dsh\tools\ffmpeg\bin\ffmpeg.exe')

# 8 维顺序：happy, angry, sad, afraid, disgusted, melancholic, surprised, calm
EMO = {
    'happy':     [1.0, 0, 0, 0, 0, 0, 0, 0],
    'angry':     [0, 1.0, 0, 0, 0, 0, 0, 0],
    'sad':       [0, 0, 1.0, 0, 0, 0, 0, 0],
    'afraid':    [0, 0, 0, 1.0, 0, 0, 0, 0],
    'disgusted': [0, 0, 0, 0, 1.0, 0, 0, 0],
    'melancholy': [0, 0, 0, 0, 0, 1.0, 0, 0],
    'surprised': [0, 0, 0, 0, 0, 0, 1.0, 0],
    'calm':      [0, 0, 0, 0, 0, 0, 0, 1.0],
}

state = {'model': None, 'loading': True, 'error': '', 'ref': DEFAULT_REF}
lock = threading.Lock()


def detect_lang(text: str) -> str:
    if re.search(r'[\u3040-\u30ff]', text):
        return 'JA'
    zh = len(re.findall(r'[\u4e00-\u9fff]', text))
    en = len(re.findall(r'[A-Za-z]', text))
    if en > zh * 3 and zh == 0:
        return 'EN'
    return 'ZH'


def load_model():
    try:
        sys.path.insert(0, INDEX_DIR)
        os.chdir(INDEX_DIR)
        from indextts.infer_v2_5 import IndexTTS2

        model_dir = os.path.join(INDEX_DIR, 'checkpoints')
        cfg = os.path.join(model_dir, 'config.yaml')
        print(f'[indextts] loading from {model_dir}', flush=True)
        t0 = time.time()
        model = IndexTTS2(cfg_path=cfg, model_dir=model_dir, use_bf16=True)
        print(f'[indextts] loaded in {time.time() - t0:.1f}s', flush=True)
        state['model'] = model
        state['error'] = ''
    except Exception as exc:  # noqa: BLE001
        state['error'] = f'{type(exc).__name__}: {exc}'
        traceback.print_exc()
    finally:
        state['loading'] = False


def to_mp3(wav_path: str, out_path: str) -> bool:
    import subprocess
    if os.path.exists(out_path):
        try:
            os.remove(out_path)
        except OSError:
            pass
    if os.path.exists(FFMPEG):
        r = subprocess.run([FFMPEG, '-y', '-loglevel', 'error', '-i', wav_path, '-ac', '1', '-ar', '24000', '-b:a', '96k', out_path], capture_output=True)
        return r.returncode == 0 and os.path.exists(out_path)
    return False


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # 安静一点
        pass

    def _json(self, obj, code=200):
        data = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith('/health'):
            self._json({
                'ok': state['model'] is not None and not state['error'],
                'loading': state['loading'],
                'error': state['error'],
                'ref': os.path.basename(state['ref']),
            })
            return
        self._json({'ok': False, 'error': 'not found'}, 404)

    def do_POST(self):
        if not self.path.startswith('/tts'):
            self._json({'ok': False, 'error': 'not found'}, 404)
            return
        try:
            length = int(self.headers.get('Content-Length') or 0)
            body = json.loads(self.rfile.read(length).decode('utf-8') or '{}')
        except Exception as exc:  # noqa: BLE001
            self._json({'ok': False, 'error': f'bad json: {exc}'}, 400)
            return
        text = str(body.get('text') or '').strip()
        if not text:
            self._json({'ok': False, 'error': '文本为空'}, 400)
            return
        if state['model'] is None:
            self._json({'ok': False, 'error': state['error'] or '模型还在加载'}, 503)
            return

        ref = str(body.get('ref') or state['ref'])
        if not os.path.exists(ref):
            self._json({'ok': False, 'error': f'参考音不存在：{ref}'}, 400)
            return
        emo = str(body.get('emo') or '').strip().lower()
        emo_vector = EMO.get(emo)
        # 用一段「情绪参考音频」代替向量（更像真人、能出真怒音）2026-11-06
        emo_audio = str(body.get('emo_audio') or '').strip()
        if emo_audio and not os.path.exists(emo_audio):
            emo_audio = ''
        if emo_audio:
            emo_vector = None
        alpha = body.get('alpha')
        alpha = 1.0 if alpha is None else max(0.0, min(1.0, float(alpha)))
        speed = float(body.get('speed') or 1.0)
        speed = max(0.5, min(2.0, speed))
        lang = detect_lang(text)
        stamp = f'{int(time.time() * 1000)}-{os.getpid()}'
        wav = os.path.join(OUT_DIR, f'itt-{stamp}.wav')
        out = str(body.get('out') or os.path.join(OUT_DIR, f'itt-{stamp}.mp3'))

        t0 = time.time()
        try:
            with lock:
                state['model'].infer(
                    spk_audio_prompt=ref,
                    text=text,
                    output_path=wav,
                    lang=lang,
                    emo_vector=emo_vector,
                    emo_audio_prompt=emo_audio or None,
                    emo_alpha=alpha if (emo_vector or emo_audio) else 1.0,
                    duration_factor=speed,
                    verbose=False,
                )
            ms = int((time.time() - t0) * 1000)
            if not os.path.exists(wav):
                self._json({'ok': False, 'error': '没有生成音频'}, 500)
                return
            final = out
            if not final.lower().endswith('.mp3') or not to_mp3(wav, final):
                final = wav
            seconds = 0.0
            try:
                import soundfile as sf
                info = sf.info(final)
                seconds = round(info.frames / info.samplerate, 2)
            except Exception:
                pass
            self._json({'ok': True, 'file': os.path.basename(final), 'path': final, 'seconds': seconds, 'ms': ms, 'emo': emo or 'none', 'lang': lang})
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            self._json({'ok': False, 'error': f'{type(exc).__name__}: {exc}', 'ms': int((time.time() - t0) * 1000)}, 500)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=9881)
    ap.add_argument('--ref', default=DEFAULT_REF)
    args = ap.parse_args()
    state['ref'] = args.ref
    threading.Thread(target=load_model, daemon=True).start()
    srv = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    print(f'[indextts] HTTP 监听 127.0.0.1:{args.port}', flush=True)
    srv.serve_forever()


if __name__ == '__main__':
    main()
