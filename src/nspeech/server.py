"""
FastAPI Server Core

Implements HTTP REST endpoints and strictly adheres to fail-fast principles
and lazy-loading of TTS engines.
"""
import io
import os
import wave
import time
import json
from pathlib import Path
from typing import Optional, List, Dict, Any

from fastapi import FastAPI, HTTPException, UploadFile, File, Form, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse, Response, JSONResponse, HTMLResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import torch
from nspeech import config

PROJECT_ROOT = Path(__file__).parent.parent.parent.resolve()
from nspeech.logger import get as get_logger, info, error, debug
from nspeech.tts import get_engine

from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="nSpeech", description="Pluggable Streaming TTS Service", docs_url=None)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def startup():
    import sys as _sys
    def _thread_excepthook(args):
        error("unhandled_thread_exception", {
            "thread": args.thread.name if args.thread else "unknown",
            "type": str(args.exc_type),
            "msg": str(args.exc_value),
        }, "server")
        if args.exc_traceback:
            import traceback
            traceback.print_exception(args.exc_type, args.exc_value, args.exc_traceback)
    _sys.excepthook = _thread_excepthook
    import threading
    threading.excepthook = _thread_excepthook
    get_logger().info("server_start", extra={"meta": {"engine": config.NSPEECH_ENGINE, "host": config.NSPEECH_HOST, "port": config.NSPEECH_PORT}, "category": "server"})
    previews_dir = _voice_dir() / "previews"
    if previews_dir.exists():
        import shutil
        shutil.rmtree(str(previews_dir))


@app.middleware("http")
async def log_requests(request, call_next):
    start = time.time()
    response = await call_next(request)
    ms = int((time.time() - start) * 1000)
    get_logger().info(
        f"{request.method} {request.url.path}",
        extra={"meta": {"status": response.status_code, "ms": ms}, "category": "http"}
    )
    return response

web_dir = Path(__file__).parent.parent.parent / "web"
lib_dir = Path(__file__).parent.parent.parent / "lib"

static_mounted = False
if web_dir.exists():
    app.mount("/web", StaticFiles(directory=str(web_dir), html=True), name="web-static")
    static_mounted = True
if lib_dir.exists():
    app.mount("/lib", StaticFiles(directory=str(lib_dir)), name="lib-static")


# ---------------------------------------------------------
# Utilities
# ---------------------------------------------------------

def generate_streaming_wav_header(sample_rate: int = 24000) -> bytes:
    """Generates a 44-byte WAV header with unknown/max length for streaming."""
    header = bytearray(44)
    header[0:4] = b"RIFF"
    header[4:8] = b"\xff\xff\xff\xff"  # Max ChunkSize
    header[8:12] = b"WAVE"
    header[12:16] = b"fmt "
    header[16:20] = (16).to_bytes(4, "little")  # Subchunk1Size
    header[20:22] = (1).to_bytes(2, "little")   # AudioFormat (PCM)
    header[22:24] = (1).to_bytes(2, "little")   # NumChannels (Mono)
    header[24:28] = sample_rate.to_bytes(4, "little")  # SampleRate
    header[28:32] = (sample_rate * 2).to_bytes(4, "little")  # ByteRate
    header[32:34] = (2).to_bytes(2, "little")   # BlockAlign
    header[34:36] = (16).to_bytes(2, "little")  # BitsPerSample
    header[36:40] = b"data"
    header[40:44] = b"\xff\xff\xff\xff"  # Max Subchunk2Size (data size)
    return bytes(header)


def _ensure_wav(audio_bytes: bytes, suffix: str = ".wav") -> bytes:
    """
    Convert any audio format to WAV (PCM 16-bit, mono, original sample rate).
    Engines like Chatterbox accept any soundfile-readable format, but the voice
    cache always stores .wav for consistency. Returns the raw WAV bytes.
    """
    suffix = suffix.lower()
    if suffix in (".wav",):
        return audio_bytes
    try:
        import soundfile as sf
        import io as _io
        data, sr = sf.read(_io.BytesIO(audio_bytes))
        # Convert to mono if stereo
        if data.ndim > 1:
            data = data.mean(axis=1)
        buf = _io.BytesIO()
        sf.write(buf, data, sr, format="WAV", subtype="PCM_16")
        return buf.getvalue()
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Cannot decode audio ({suffix}): {e}")


def _voice_dir() -> Path:
    return Path(config.NSPEECH_VOICE_DIR)


def get_all_voices() -> List[Dict[str, Any]]:
    """Scan NSPECH_VOICE_DIR to collect all voices."""
    voice_dir = _voice_dir()
    voice_dir.mkdir(parents=True, exist_ok=True)

    voices = []

    # Scan .wav files (cloned/uploaded voices)
    for wav_path in voice_dir.glob("*.wav"):
        base_name = wav_path.stem
        cache_files = list(voice_dir.glob(f"{base_name}.*.pt"))
        engines_info = [{"name": c.stem.split(".")[-1], "cached": True} for c in cache_files]
        voices.append({
            "name": base_name,
            "source_file": wav_path.name,
            "voice_type": "cloned",
            "engines": engines_info
        })

    # Scan .dots.json voice caches (dots.tts zero-shot voice sidecars)
    for json_path in voice_dir.glob("*.dots.json"):
        base_name = json_path.name[:-len(".dots.json")]
        if base_name not in existing_names:
            voices.append({
                "name": base_name,
                "source_file": json_path.name,
                "voice_type": "cloned",
                "engines": [{"name": "dots", "cached": True}]
            })
            existing_names.add(base_name)

    # Scan standalone .pt files with no .wav companion (blended voices)
    existing_names = {v["name"] for v in voices}
    for ext in (".chatterbox.pt", ".turbo.pt", ".kokoro.pt", ".cosyvoice.pt"):
        for pt_path in voice_dir.glob(f"*{ext}"):
            base_name = pt_path.stem.rsplit(".", 1)[0]
            if base_name not in existing_names:
                engine_name = pt_path.stem.rsplit(".", 1)[-1]
                voices.append({
                    "name": base_name,
                    "source_file": pt_path.name,
                    "voice_type": "blended",
                    "engines": [{"name": engine_name, "cached": True}]
                })
                existing_names.add(base_name)

    # Inject Kokoro built-in voices (only for kokoro engine)
    if getattr(config, "NSPEECH_ENGINE", "kokoro") == "kokoro":
        try:
            k_eng = get_engine("kokoro")
            for builtin in k_eng.pipeline.get_voices():
                voices.append({
                    "name": builtin,
                    "source_file": "builtin",
                    "voice_type": "builtin",
                    "engines": [{"name": "kokoro", "cached": True, "latency_tier": "fast"}]
                })
        except Exception as e:
            print(f"Failed to fetch kokoro voices: {e}")

    # Inject in-memory preview voices (CosyVoice spk2info)
    if getattr(config, "NSPEECH_ENGINE", "") == "cosyvoice":
        try:
            c_eng = get_engine("cosyvoice")
            for key in c_eng.model.frontend.spk2info:
                if key.startswith("__preview__"):
                    voices.append({
                        "name": key,
                        "source_file": "in-memory",
                        "voice_type": "preview",
                        "engines": [{"name": "cosyvoice", "cached": True}]
                    })
        except Exception:
            pass

    # Scan previews subdirectory (chatterbox & future engines)
    previews_dir = voice_dir / "previews"
    if previews_dir.exists():
        for pt_path in previews_dir.glob("*.pt"):
            base_name = pt_path.stem.rsplit(".", 1)[0]
            if base_name not in existing_names:
                engine_name = pt_path.stem.rsplit(".", 1)[-1]
                voices.append({
                    "name": base_name,
                    "source_file": pt_path.name,
                    "voice_type": "preview",
                    "engines": [{"name": engine_name, "cached": True}]
                })
                existing_names.add(base_name)

    return voices


def mark_engine_used(engine_name):
    pass


# ---------------------------------------------------------
# REST Models
# ---------------------------------------------------------

class TTSRequest(BaseModel):
    text: str
    voice_name: str = "default"
    engine: Optional[str] = None
    model: Optional[str] = None
    exaggeration: float = 0.5
    instruct_text: Optional[str] = None
    language: Optional[str] = None
    speed: float = 1.0
    seed: Optional[int] = None
    offline: bool = False
    output_format: str = "wav"
    transcode_sample_rate: int = config.NSPEECH_TRANSCODE_SAMPLE_RATE
    transcode_bitrate: str = config.NSPEECH_TRANSCODE_BITRATE


class MixVoiceRequest(BaseModel):
    name: str
    voice_a: str
    voice_b: str
    ratio: float = 0.5


class OpenAITTSRequest(BaseModel):
    model: str = "kokoro"
    input: str = ""
    voice: str = "af_heart"
    response_format: str = "mp3"
    speed: float = 1.0


# ---------------------------------------------------------
# Endpoints
# ---------------------------------------------------------

@app.get("/docs", response_class=HTMLResponse)
def api_docs():
    docs_path = Path(__file__).parent.parent.parent / "docs" / "API_REFERENCE.md"
    if not docs_path.exists():
        raise HTTPException(status_code=404, detail="API_REFERENCE.md not found")
    content = docs_path.read_text(encoding="utf-8")
    html = """<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>nSpeech API Reference</title>
<link rel="stylesheet" href="/lib/nui_wc2/NUI/css/nui-theme.css">
<link rel="stylesheet" href="/lib/nui_wc2/NUI/css/modules/nui-syntax-highlight.css">
<script type="module" src="/lib/nui_wc2/NUI/nui.js"></script>
</head>
<body style="max-width: 960px; margin: 0 auto; padding: var(--nui-space-double);">
<nui-markdown src="/api-docs.md"></nui-markdown>
</body></html>"""
    return HTMLResponse(html)


@app.get("/api-docs.md")
def api_docs_raw():
    docs_path = Path(__file__).parent.parent.parent / "docs" / "API_REFERENCE.md"
    if not docs_path.exists():
        raise HTTPException(status_code=404, detail="API_REFERENCE.md not found")
    return Response(docs_path.read_text(encoding="utf-8"), media_type="text/markdown")


@app.get("/health")
def health_endpoint():
    return {"status": "ok", "default_engine": config.NSPEECH_ENGINE}


@app.get("/engine")
def engine_info():
    return {"engine": config.NSPEECH_ENGINE}


@app.get("/", response_class=HTMLResponse)
def serve_dashboard():
    index = web_dir / "index.html"
    if index.exists():
        return FileResponse(str(index))
    return HTMLResponse("<h1>nSpeech API</h1><p>No dashboard installed.</p>")


@app.get("/tts")
def tts_get_endpoint(text: str, voice_name: str = "default", engine: Optional[str] = None, output_format: str = "mp3",
                     instruct_text: Optional[str] = None, language: Optional[str] = None, speed: float = 1.0,
                     exaggeration: float = 0.5, model: Optional[str] = None, seed: Optional[int] = None,
                     offline: bool = False):
    """Wrapper around POST /tts to allow native HTML <audio src="..."> streaming over GET."""
    req = TTSRequest(text=text, voice_name=voice_name, engine=engine, output_format=output_format,
                     instruct_text=instruct_text, language=language, speed=speed, exaggeration=exaggeration,
                     model=model, seed=seed, offline=offline)
    return tts_endpoint(req)


@app.get("/voices")
def list_voices():
    """Lists all available voices and their compiled engine caches."""
    return {"voices": get_all_voices()}


@app.get("/arena-samples")
def arena_samples():
    """
    Return random message snippets from archived LLM arena conversations.
    Used as meaningful test phrases for voice cloning and generation.
    """
    import random
    import re as _re

    archive_dir = PROJECT_ROOT / "docs" / "_Archive"
    arena_files = list(archive_dir.glob("arena-*.json"))
    if not arena_files:
        return {"error": "No arena archives found"}

    # Collect all assistant messages (skip moderator/system)
    all_messages = []
    for path in arena_files:
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            for msg in data.get("messages", []):
                if msg.get("role") == "assistant" and msg.get("content"):
                    all_messages.append({
                        "speaker": msg.get("speaker", "unknown"),
                        "content": msg["content"],
                        "topic": data.get("summary", {}).get("title", ""),
                    })
        except Exception:
            continue

    if not all_messages:
        return {"error": "No assistant messages found in archives"}

    # Pick a random message
    chosen = random.choice(all_messages)
    content = chosen["content"].strip()

    # Trim to a reasonable length (50-300 chars) for test phrase
    if len(content) > 300:
        # Try to cut at a sentence boundary
        truncated = content[:300]
        last_period = max(truncated.rfind(". "), truncated.rfind("? "), truncated.rfind("! "))
        if last_period > 50:
            content = truncated[:last_period + 1]
        else:
            content = truncated + "..."

    return {
        "text": content,
        "speaker": chosen["speaker"],
        "topic": chosen["topic"],
    }


@app.post("/voices/mix")
def mix_voices(req: MixVoiceRequest):
    """Blend two Kokoro voice styles and save as a new voice."""
    import traceback

    try:
        engine = get_engine(None)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Engine load failed: {e}")

    if not hasattr(engine, 'pipeline') or not hasattr(engine.pipeline, 'get_voice_style'):
        raise HTTPException(status_code=400, detail="Current engine does not support voice blending")

    try:
        style_a = engine.pipeline.get_voice_style(req.voice_a)
        style_b = engine.pipeline.get_voice_style(req.voice_b)
    except Exception as e:
        raise HTTPException(status_code=404, detail=f"Voice not found: {e}")

    try:
        blended = style_a * req.ratio + style_b * (1 - req.ratio)
        if not isinstance(blended, torch.Tensor):
            blended = torch.from_numpy(blended)
        voice_dir = _voice_dir()
        if req.name.startswith("_preview_"):
            voice_dir = voice_dir / "cache"
        voice_dir.mkdir(parents=True, exist_ok=True)
        cache_path = voice_dir / f"{req.name}.{engine.engine_name}.pt"
        torch.save(blended, str(cache_path))
    except Exception as e:
        print(f"[mix_voices] BLEND ERROR: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=f"Blend failed: {e}")

    return {"voice_name": req.name, "cache_file": str(cache_path), "voice_a": req.voice_a, "voice_b": req.voice_b, "ratio": req.ratio}


@app.websocket("/ws/tts")
async def websocket_tts_endpoint(websocket: WebSocket):
    """Streaming synthesis over WebSocket. Exchanges JSON requests for Binary frames."""
    await websocket.accept()
    try:
        data = await websocket.receive_json()
        text = data.get("text")
        if not text:
            await websocket.close(code=1003, reason="No text provided")
            return

        voice_name = data.get("voice_name", "default")
        engine_name = data.get("engine", None)
        output_format = data.get("output_format", "mp3")
        exaggeration = float(data.get("exaggeration", 0.5))
        instruct_text = data.get("instruct_text")
        language = data.get("language")
        speed = float(data.get("speed", 1.0))
        model = data.get("model")
        transcode_sample_rate = int(data.get("transcode_sample_rate", 24000))
        transcode_bitrate = data.get("transcode_bitrate", "128k")

        # Load engine
        try:
            import asyncio
            engine = await asyncio.to_thread(get_engine, engine_name)
            if voice_name and voice_name != "default":
                import inspect
                sig = inspect.signature(engine.load_voice)
                if 'model' in sig.parameters or any(p.kind == inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values()):
                    await asyncio.to_thread(engine.load_voice, voice_name, model=model)
                else:
                    await asyncio.to_thread(engine.load_voice, voice_name)
        except Exception as e:
            await websocket.send_json({"error": str(e)})
            await websocket.close()
            return

        print(f"[Backend] Starting WS request for text length {len(text)}")
        start_time = time.time()

        # Start generator
        generator = engine.generate(text, exaggeration=exaggeration, instruct_text=instruct_text, language=language, speed=speed)

        # Raw PCM streaming
        if output_format == "pcm":
            while True:
                try:
                    chunk_tensor, is_final = await asyncio.to_thread(next, generator)
                    mark_engine_used(engine_name)
                    audio_np = chunk_tensor.squeeze().cpu().numpy()
                    pcm_bytes = (audio_np * 32767.0).astype("int16").tobytes()
                    await websocket.send_bytes(pcm_bytes)
                    if is_final:
                        break
                except StopIteration:
                    break

            await websocket.send_json({"is_final": True})
            print(f"[Backend] WS Stream finished at {time.time() - start_time:.3f}s")
            return

        # Transcoding via PyAV
        import av
        output_io = io.BytesIO()
        container = av.open(output_io, mode='w', format=output_format)

        if output_format == "mp3":
            codec = "libmp3lame"
        elif output_format in ("ogg", "webm"):
            codec = "libopus"
        else:
            codec = "aac"

        try:
            stream = container.add_stream(codec, rate=transcode_sample_rate)
            stream.bit_rate = int(transcode_bitrate.replace('k', '000').replace('m', '000000'))
        except Exception:
            stream = container.add_stream('mp3', rate=transcode_sample_rate)

        last_pos = 0
        chunk_idx = 0

        while True:
            try:
                chunk_tensor, is_final = await asyncio.to_thread(next, generator)
                mark_engine_used(engine_name)

                audio_np = chunk_tensor.squeeze().cpu().numpy()
                audio_int16 = (audio_np * 32767.0).astype("int16")

                frame = av.AudioFrame.from_ndarray(audio_int16.reshape(1, -1), format='s16', layout='mono')
                frame.sample_rate = transcode_sample_rate

                for packet in stream.encode(frame):
                    container.mux(packet)

                current_pos = output_io.tell()
                output_io.seek(last_pos)
                data = output_io.read()
                output_io.seek(current_pos)
                last_pos = current_pos

                if data:
                    await websocket.send_bytes(data)

                chunk_idx += 1

                if is_final:
                    break
            except StopIteration:
                break

        # Flush
        for packet in stream.encode():
            container.mux(packet)
        container.close()

        output_io.seek(last_pos)
        data = output_io.read()
        if data:
            await websocket.send_bytes(data)

        await websocket.send_json({"is_final": True})
        print(f"[Backend] WS Stream finished at {time.time() - start_time:.3f}s")

    except WebSocketDisconnect:
        print("[Backend] Client disconnected! TTS WebSocket loop gracefully halted.")
        return
    except Exception as e:
        print(f"[Backend] WS Error: {e}")
        try:
            await websocket.close()
        except:
            pass


@app.post("/tts")
def tts_endpoint(req: TTSRequest):
    """Streaming synthesis. Returns chunked audio using Transfer-Encoding: chunked."""
    try:
        engine = get_engine(req.engine)
        if req.voice_name and req.voice_name != "default":
            try:
                import inspect
                # Some engines may not support the model argument for load_voice
                sig = inspect.signature(engine.load_voice)
                if 'model' in sig.parameters or any(p.kind == inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values()):
                    engine.load_voice(req.voice_name, model=req.model)
                else:
                    engine.load_voice(req.voice_name)
            except FileNotFoundError:
                from pathlib import Path
                voice_dir = _voice_dir()
                wav_path = voice_dir / f"{req.voice_name}.wav"
                if wav_path.exists():
                    print(f"[{req.engine}] Compiling implicit voice cache for {req.voice_name}...")
                    engine.clone(str(wav_path), req.voice_name)
                    import inspect
                    sig = inspect.signature(engine.load_voice)
                    if 'model' in sig.parameters or any(p.kind == inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values()):
                        engine.load_voice(req.voice_name, model=req.model)
                    else:
                        engine.load_voice(req.voice_name)
                else:
                    pass
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

    def stream_audio():
        import time as _time
        start_time = _time.time()
        print(f"[Backend] Starting request for text length {len(req.text)}")

        try:
            if req.output_format == "pcm":
                for chunk_tensor, is_final in engine.generate(req.text, exaggeration=req.exaggeration, speed=req.speed, instruct_text=req.instruct_text, language=req.language, model=req.model, seed=req.seed, offline=req.offline):
                    mark_engine_used(req.engine)
                    audio_np = chunk_tensor.squeeze().cpu().numpy()
                    yield (audio_np * 32767.0).astype("int16").tobytes()
                return

            if req.output_format == "wav":
                yield generate_streaming_wav_header(req.transcode_sample_rate)
                for chunk_tensor, is_final in engine.generate(req.text, exaggeration=req.exaggeration, speed=req.speed, instruct_text=req.instruct_text, language=req.language, model=req.model, seed=req.seed, offline=req.offline):
                    mark_engine_used(req.engine)
                    audio_np = chunk_tensor.squeeze().cpu().numpy()
                    yield (audio_np * 32767.0).astype("int16").tobytes()
                return

            import av
            output_io = io.BytesIO()
            container = av.open(output_io, mode='w', format=req.output_format)

            if req.output_format == "mp3":
                codec = "libmp3lame"
            elif req.output_format in ("ogg", "webm"):
                codec = "libopus"
            else:
                codec = "aac"

            try:
                stream = container.add_stream(codec, rate=req.transcode_sample_rate)
                stream.bit_rate = int(req.transcode_bitrate.replace('k', '000').replace('m', '000000'))
            except Exception:
                stream = container.add_stream('mp3', rate=req.transcode_sample_rate)

            last_pos = 0
            chunk_idx = 0
            for chunk_tensor, is_final in engine.generate(req.text, exaggeration=req.exaggeration, speed=req.speed, instruct_text=req.instruct_text, language=req.language, model=req.model, seed=req.seed, offline=req.offline):
                mark_engine_used(req.engine)
                engine_time = _time.time()
                print(f"[Backend] [Chunk {chunk_idx}] Engine logic finished at {engine_time - start_time:.3f}s")
                audio_np = chunk_tensor.squeeze().cpu().numpy()
                audio_int16 = (audio_np * 32767.0).astype("int16")

                frame = av.AudioFrame.from_ndarray(audio_int16.reshape(1, -1), format='s16', layout='mono')
                frame.sample_rate = req.transcode_sample_rate

                for packet in stream.encode(frame):
                    container.mux(packet)

                current_pos = output_io.tell()
                output_io.seek(last_pos)
                data = output_io.read()
                output_io.seek(current_pos)
                last_pos = current_pos

                if data:
                    yield data
                yield_time = _time.time()
                print(f"[Backend] [Chunk {chunk_idx}] Bytes yielded at {yield_time - start_time:.3f}s (size: {len(data)})")
                chunk_idx += 1

            for packet in stream.encode():
                container.mux(packet)
            container.close()

            output_io.seek(last_pos)
            data = output_io.read()
            if data:
                yield data

            print(f"[Backend] Stream finished at {_time.time() - start_time:.3f}s")

        except GeneratorExit:
            print(f"[Backend] Client disconnected! TTS engine loop gracefully halted at {_time.time() - start_time:.3f}s.")
            return

    media_type = "audio/wav" if req.output_format == "wav" else f"audio/{req.output_format}"
    return StreamingResponse(stream_audio(), media_type=media_type)


@app.post("/v1/audio/speech")
def openai_speech_endpoint(req: OpenAITTSRequest):
    """OpenAI proxy endpoint."""
    tts_req = TTSRequest(
        text=req.input,
        voice_name=req.voice,
        engine=req.model,
        exaggeration=1.0 + (1.0 - req.speed),
        output_format=req.response_format
    )
    return tts_endpoint(tts_req)


@app.post("/voices/clone")
async def clone_voice_endpoint(
    file: UploadFile = File(...),
    name: str = Form(...),
    engine: str = Form(None),
    model: str = Form(None),
    exaggeration: float = Form(0.5),
    prompt_text: str = Form(None),
):
    """Clone a voice and generate an engine embedding."""
    engine_name = engine or config.NSPEECH_ENGINE

    try:
        tts_engine = get_engine(engine_name)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

    voice_dir = _voice_dir()
    voice_dir.mkdir(parents=True, exist_ok=True)

    wav_path = voice_dir / f"{name}.wav"

    raw_bytes = await file.read()
    # Accept any audio format — convert to WAV for the voice cache
    original_suffix = Path(file.filename or "").suffix.lower() or ".wav"
    wav_bytes = _ensure_wav(raw_bytes, original_suffix)
    with open(wav_path, "wb") as f:
        f.write(wav_bytes)

    try:
        clone_kwargs = {"exaggeration": exaggeration, "model": model}
        if prompt_text:
            clone_kwargs["prompt_text"] = prompt_text
        metadata = tts_engine.clone(
            audio_path=str(wav_path),
            voice_name=name,
            **clone_kwargs,
        )
        return JSONResponse(content=metadata)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Clone failed: {e}")


@app.post("/voices/preview")
async def voice_preview_endpoint(
    file: UploadFile = File(...),
    prompt_text: str = Form(None),
    test_phrase: str = Form(None),
    engine: str = Form(None),
    model: str = Form(None),
    offline: bool = Form(False),
):
    """Upload a voice sample, clone temporarily, and stream a test phrase."""
    engine_name = engine or config.NSPEECH_ENGINE

    try:
        tts_engine = get_engine(engine_name)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

    import tempfile, os as _os
    tmp_wav = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    try:
        raw_bytes = await file.read()
        original_suffix = Path(file.filename or "").suffix.lower() or ".wav"
        wav_bytes = _ensure_wav(raw_bytes, original_suffix)
        tmp_wav.write(wav_bytes)
        tmp_wav.close()

        preview_name = f"__preview__{_os.urandom(4).hex()}"

        saved_cache_dir = tts_engine.cache_dir
        previews_dir = _voice_dir() / "previews"
        previews_dir.mkdir(parents=True, exist_ok=True)
        tts_engine.cache_dir = previews_dir
        try:
            clone_kwargs = {"model": model}
            if prompt_text:
                clone_kwargs["prompt_text"] = prompt_text
            tts_engine.clone(str(Path(tmp_wav.name)), preview_name, **clone_kwargs)
            tts_engine.load_voice(preview_name, model=model)
        finally:
            tts_engine.cache_dir = saved_cache_dir
    finally:
        _os.unlink(tmp_wav.name)

    phrase = test_phrase or "This is a preview of the cloned voice."
    media_type = "audio/mp3"
    generator = tts_engine.generate(phrase, voice_name=preview_name, model=model, offline=offline)

    def stream_preview():
        import av, io as _io
        output_io = _io.BytesIO()
        container = av.open(output_io, mode='w', format='mp3')
        stream = container.add_stream('libmp3lame', rate=24000)
        last_pos = 0
        for chunk_tensor, is_final in generator:
            audio_np = chunk_tensor.squeeze().cpu().numpy()
            audio_int16 = (audio_np * 32767.0).astype("int16")
            frame = av.AudioFrame.from_ndarray(audio_int16.reshape(1, -1), format='s16', layout='mono')
            frame.sample_rate = 24000
            for packet in stream.encode(frame):
                container.mux(packet)
            current_pos = output_io.tell()
            output_io.seek(last_pos)
            data = output_io.read()
            output_io.seek(current_pos)
            last_pos = current_pos
            if data:
                yield data
        for packet in stream.encode():
            container.mux(packet)
        container.close()
        output_io.seek(last_pos)
        data = output_io.read()
        if data:
            yield data

    return StreamingResponse(stream_preview(), media_type=media_type)


@app.delete("/voices/{name}")
def delete_voice_endpoint(name: str, engine: Optional[str] = None):
    """Delete a cloned or preview voice."""
    voice_dir = _voice_dir()
    deleted = []
    for dir_path in (voice_dir, voice_dir / "previews"):
        for ext in (".wav", ".pt", ".dots.json"):
            p = dir_path / f"{name}{ext}"
            if p.exists():
                p.unlink()
                deleted.append(p.name)

    # Also remove from in-memory spk2info (preview voices)
    try:
        eng = get_engine(engine or config.NSPEECH_ENGINE)
        if name in eng.model.frontend.spk2info:
            del eng.model.frontend.spk2info[name]
            deleted.append(f"spk2info:{name}")
    except Exception:
        pass

    if not deleted:
        raise HTTPException(status_code=404, detail=f"Voice '{name}' not found")
    return {"deleted": deleted}
