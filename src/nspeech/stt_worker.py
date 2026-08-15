"""
nSpeech STT Worker — standalone transcription + forced alignment service.

Own process, own venv (venv/stt), CPU-only. Independent of nVoice and of the
TTS engine workers — engine switching in nSpeech or nVoice can never disturb
it. Spawned by the Node layer with --port 0 using the same port-file
convention as worker_server.py (%TEMP%/nspeech-<engine>-<pid>.port).

Endpoints:
    GET  /health                — ready once both models are loaded
    POST /v1/audio/transcriptions — speech-to-text, word timestamps optional
    POST /v1/audio/align        — TRUE forced alignment (text-constrained)

Engines:
    - faster-whisper large-v3 int8 (CPU): transcription. Word timestamps
      from cross-attention DTW over decoded tokens (unconstrained — ASR).
    - torchaudio MMS_FA (CTC forced alignment): the align endpoint. The
      Viterbi path is CONSTRAINED to the given text — it cannot drop,
      add, or hallucinate words. Word count is guaranteed to match
      the input text's whitespace-split count. This is the property the
      chunk-stitching trim logic depends on.

Input contract: multipart, fields `file` (WAV; Node sends 24kHz mono s16le
in a WAV container) + `text` (align only) + optional `language`.
Output contract mirrors nVoice's align shape:
    { text, duration, words: [{word, start, end, probability}] }
so Node-side callers need no changes beyond the base URL.
"""
import sys
import os
import argparse
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf


def _setup_path():
    """Ensure src/ is on sys.path so `nspeech` is importable."""
    src_dir = str(Path(__file__).parent.parent)
    if src_dir not in sys.path:
        sys.path.insert(0, src_dir)


def _write_port_file(engine, port):
    temp_dir = tempfile.gettempdir()
    pid = os.getpid()
    filename = f"nspeech-{engine}-{pid}.port"
    path = Path(temp_dir) / filename
    path.write_text(str(port), encoding="utf-8")
    return path


# ── Model singletons (loaded once, reused) ─────────────────────────────────

_whisper = None
_mms = None            # (model, tokenizer, aligner)
_uroman = None

# CPU politeness: cap inference threads so a single alignment never pins
# every core (measured 170W full-tilt without this). Default 12 threads:
# measured 1.6-1.8x faster than 4 on the 3950X (61.5s audio: 18.7s -> 11.5s),
# and alignment windows are short (~2-12s per chunk) so coexistence is fine.
THREAD_CAP = int(os.environ.get("NSPEECH_STT_THREADS", "12"))

# Parent liveness: if the spawning Node process dies, this worker must not
# outlive it (the 2026-08-14 leak: test harnesses exit, orphaned workers
# kept burning CPU forever). Node passes NSPEECH_PARENT_PID on spawn.
_PARENT_PID = int(os.environ["NSPEECH_PARENT_PID"]) if os.environ.get("NSPEECH_PARENT_PID") else None


def _watch_parent():
    """Background thread: exit the process when the parent is gone."""
    import threading
    if not _PARENT_PID:
        return

    def _loop():
        import time as _time
        while True:
            _time.sleep(5)
            try:
                parent_alive = _pid_alive(_PARENT_PID)
            except Exception:
                parent_alive = False
            if not parent_alive:
                os._exit(1)

    t = threading.Thread(target=_loop, daemon=True)
    t.start()


def _pid_alive(pid):
    """Windows/posix-native parent liveness check, zero deps."""
    if sys.platform == "win32":
        import ctypes
        kernel32 = ctypes.windll.kernel32
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        STILL_ACTIVE = 259
        handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            return False
        try:
            code = ctypes.c_ulong()
            if kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
                return code.value == STILL_ACTIVE
            return False
        finally:
            kernel32.CloseHandle(handle)
    else:
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False


def get_whisper():
    global _whisper
    if _whisper is None:
        import torch as _torch
        _torch.set_num_threads(THREAD_CAP)
        from faster_whisper import WhisperModel
        model_dir = os.environ.get("NSPEECH_STT_MODEL_DIR", "large-v3")
        # Reuse the project-local HF cache (venv/stt/models) — Node sets
        # NSPEECH_MODEL_DIR per engine; fall back to the explicit override.
        download_root = (os.environ.get("NSPEECH_STT_DOWNLOAD_ROOT")
                         or os.environ.get("NSPEECH_MODEL_DIR"))
        _whisper = WhisperModel(
            model_dir,
            device="cpu",
            compute_type="int8",
            download_root=download_root,
        )
    return _whisper


def get_mms():
    """Lazily load the MMS_FA bundle (wav2vec2 CTC, ~380MB, 1100+ languages).

    get_model() returns a model that emits log-probs directly (log_softmax
    applied internally). get_tokenizer() maps lowercase romanized chars to
    ids. get_aligner() runs CTC Viterbi + merge_tokens.
    """
    global _mms
    if _mms is None:
        import torch as _torch
        _torch.set_num_threads(THREAD_CAP)
        from torchaudio.pipelines import MMS_FA
        model = MMS_FA.get_model()
        tokenizer = MMS_FA.get_tokenizer()
        aligner = MMS_FA.get_aligner()
        _mms = (model, tokenizer, aligner)
    return _mms


def get_uroman():
    global _uroman
    if _uroman is None:
        from uroman import Uroman
        _uroman = Uroman()
    return _uroman


# ── Forced alignment (CTC, text-constrained) ────────────────────────────────

def _normalize_for_mms(text):
    """Preprocess text for MMS_FA tokenization (torchaudio tutorial recipe).

    1. uroman romanize (ä→ae, ß→ss, non-Latin → Latin)
    2. lowercase, straighten apostrophes
    3. strip everything outside [a-z' ]
    Returns the cleaned string (words may vanish — e.g. pure digits/emoji).
    """
    import re
    roman = get_uroman().romanize_string(text)
    roman = roman.lower().replace("\u2019", "'")
    roman = re.sub(r"[^a-z' ]", "", roman)
    return roman.strip()


def forced_align(pcm_f32, sample_rate, text):
    """Align known text to audio via torchaudio MMS_FA (CTC Viterbi).

    The alignment path is CONSTRAINED to the given text — words cannot be
    dropped, added, or hallucinated. Word order and count come from
    text.split(); words whose normalized form is empty (pure punctuation/
    digits) collapse onto neighbors but still get a span so the output count
    ALWAYS matches the input count. This 1:1 guarantee is what the chunk
    stitching trim logic depends on.

    Returns words: [{word, start, end, probability}, ...] in text order.
    """
    import torch

    model, tokenizer, aligner = get_mms()

    pcm16 = _resample(pcm_f32, sample_rate, 16000)

    words_in = text.split()
    if not words_in:
        raise ValueError("align: text is empty")

    # Tokenize each word. Empty-after-normalize words get no tokens; they
    # inherit the previous word's end (or the next word's start) so the
    # caller's word counting stays aligned.
    token_lists = tokenizer([_normalize_for_mms(w) for w in words_in])
    # tokenizer() returns [[]] for empty strings — keep word-slot mapping:
    word_slots = []  # (word_index, token_list) for words WITH tokens
    for wi, tl in enumerate(token_lists):
        if tl:
            word_slots.append((wi, tl))

    if not word_slots:
        raise ValueError("align: no romanizable tokens in text")

    # Emission (T, C) log-probs; model applies log_softmax internally.
    # model(waveform) returns (B, T, C); [0] drops batch → 2D as the
    # aligner requires.
    waveform = torch.from_numpy(np.ascontiguousarray(pcm16, dtype=np.float32)).unsqueeze(0)
    with torch.no_grad():
        out = model(waveform)
        emission = out[0] if isinstance(out, tuple) else out
        emission = emission[0]

    spans_nested = aligner(emission, [tl for (_, tl) in word_slots])

    FRAME_SEC = 0.02
    # Map aligned spans back onto full word list
    results = [None] * len(words_in)
    for (wi, _), spans in zip(word_slots, spans_nested):
        frames_start = spans[0].start
        frames_end = spans[-1].end
        results[wi] = {
            "word": words_in[wi],
            "start": round(frames_start * FRAME_SEC, 3),
            "end": round(frames_end * FRAME_SEC, 3),
            "probability": round(float(np.mean([s.score for s in spans])), 3),
        }

    # Fill tokenless words: previous end, else first aligned start
    fill_value = None
    for wi in range(len(words_in)):
        if results[wi] is None:
            if fill_value is not None:
                results[wi] = {
                    "word": words_in[wi],
                    "start": fill_value["end"],
                    "end": fill_value["end"],
                    "probability": 1.0,
                }
            else:
                results[wi] = None  # leading punct — fill from first real word below
        else:
            fill_value = results[wi]
    # leading tokenless words (rare): give them the first real word's start
    first_real = next((r for r in results if r is not None), None)
    for wi in range(len(words_in)):
        if results[wi] is None and first_real is not None:
            results[wi] = {
                "word": words_in[wi],
                "start": first_real["start"],
                "end": first_real["start"],
                "probability": 1.0,
            }
    return results


def _resample(pcm, sr_from, sr_to):
    """Polyphase resample using torchaudio (exact, no scipy)."""
    import torch
    import torchaudio
    t = torch.from_numpy(np.ascontiguousarray(pcm, dtype=np.float32)).unsqueeze(0)
    if sr_from != sr_to:
        t = torchaudio.functional.resample(t, sr_from, sr_to)
    return t.squeeze(0).numpy()


# ── App factory ─────────────────────────────────────────────────────────────

def create_app():
    from fastapi import FastAPI, UploadFile, File, Form, HTTPException
    from fastapi.middleware.cors import CORSMiddleware

    app = FastAPI(title="nSpeech STT worker")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/health")
    async def health():
        loaded = _whisper is not None or _mms is not None
        return {"status": "ready" if loaded else "warming",
                "engine": "stt", "version": "3.0.0"}

    @app.post("/v1/audio/align")
    async def align(
        file: UploadFile = File(...),
        text: str = Form(""),
        language: str = Form(None),
    ):
        if not text.strip():
            raise HTTPException(400, "text required for alignment")

        audio_bytes = await file.read()
        pcm, sr = _decode_audio(audio_bytes)
        try:
            words = forced_align(pcm, sr, text)
        except Exception as e:
            raise HTTPException(500, f"alignment failed: {e}")

        duration = len(pcm) / sr if sr else 0
        return {
            "text": text,
            "duration": round(duration, 2),
            "words": words,
        }

    @app.post("/v1/audio/transcriptions")
    async def transcriptions(
        file: UploadFile = File(...),
        language: str = Form(None),
        word_timestamps: bool = Form(False),
    ):
        audio_bytes = await file.read()
        pcm, sr = _decode_audio(audio_bytes)
        pcm16 = _resample(pcm, sr, 16000)

        model = get_whisper()
        # faster-whisper takes a path or numpy float32 @16k
        import tempfile as _tf
        with _tf.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            sf.write(tmp.name, pcm16, 16000, subtype="PCM_16")
            tmp_path = tmp.name
        try:
            segments_gen, info = model.transcribe(
                tmp_path,
                language=language,
                word_timestamps=word_timestamps or None,
                vad_filter=True,
            )
            segments = []
            words_total = []
            for seg in segments_gen:
                seg_words = []
                if seg.words:
                    for w in seg.words:
                        seg_words.append({
                            "word": w.word.strip(),
                            "start": round(w.start, 3),
                            "end": round(w.end, 3),
                        })
                        words_total.append(seg_words[-1])
                segments.append({
                    "text": seg.text.strip(),
                    "start": round(seg.start, 3),
                    "end": round(seg.end, 3),
                    "words": seg_words,
                })
            return {
                "text": "".join(s["text"] for s in segments).strip(),
                "language": info.language,
                "duration": round(info.duration, 2),
                "segments": segments,
                "words": words_total,
            }
        finally:
            os.unlink(tmp_path)

    def _decode_audio(audio_bytes):
        """Decode WAV bytes (from Node: 24kHz mono s16le WAV) to float32."""
        import io
        pcm, sr = sf.read(io.BytesIO(audio_bytes), dtype="float32")
        if pcm.ndim > 1:
            pcm = pcm.mean(axis=1)
        return pcm, sr

    return app


def main():
    parser = argparse.ArgumentParser(description="nSpeech STT worker")
    parser.add_argument("--engine", default="stt")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()

    _setup_path()
    _watch_parent()

    from nspeech.logger import init as init_logger, get as get_logger
    init_logger(
        logs_dir=Path(__file__).parent.parent.parent / "logs",
        process_name=f"worker-{args.engine}",
    )
    log = get_logger()
    log.info(f"stt worker starting: port={args.port}")

    app = create_app()

    import uvicorn
    import socket
    if args.port == 0:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.bind((args.host, 0))
        actual_port = sock.getsockname()[1]
        sock.close()
    else:
        actual_port = args.port

    port_file = _write_port_file(args.engine, actual_port)
    print(f"NSPEECH_WORKER_PORT={actual_port}", flush=True)
    print(f"NSPEECH_WORKER_PORT_FILE={port_file}", flush=True)
    log.info(f"stt worker bound: port={actual_port}")

    config = uvicorn.Config(app, host=args.host, port=actual_port,
                            reload=False, timeout_graceful_shutdown=0,
                            log_level="warning")
    server = uvicorn.Server(config)
    try:
        server.run()
    finally:
        try:
            port_file.unlink()
        except Exception:
            pass
        log.info("stt worker stopped")


if __name__ == "__main__":
    main()
