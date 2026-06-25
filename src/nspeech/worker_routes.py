"""
nSpeech Worker Routes — Phase 1

Engine-native HTTP endpoints exposed by each worker process.
These are NOT OpenAI-compatible — Node translates the OpenAI surface
to these endpoints in Phase 3.

Endpoints:
    GET  /health              — readiness (warming vs ready)
    GET  /v1/voices           — list voices for this engine
    POST /v1/audio/speech     — synthesize (streams audio)
    POST /v1/voices/clone     — persist a cloned voice
    POST /v1/voices/preview   — temporary clone + preview audio
    POST /v1/voices/mix       — blend two voices
    DELETE /v1/voices/{id}    — delete a voice
"""
import io
import os
import time
import asyncio
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, UploadFile, File, Form, Request
from fastapi.responses import StreamingResponse, Response, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import torch

from nspeech import config
from nspeech.logger import get as get_logger, info, error
from nspeech.tts import get_engine


# ── Audio helpers (extracted from server.py, shared logic) ──────────────────

def _generate_wav_header(sample_rate: int = 24000) -> bytes:
    """44-byte WAV header with unknown/max length for streaming."""
    header = bytearray(44)
    header[0:4] = b"RIFF"
    header[4:8] = b"\xff\xff\xff\xff"
    header[8:12] = b"WAVE"
    header[12:16] = b"fmt "
    header[16:20] = (16).to_bytes(4, "little")
    header[20:22] = (1).to_bytes(2, "little")
    header[22:24] = (1).to_bytes(2, "little")
    header[24:28] = sample_rate.to_bytes(4, "little")
    header[28:32] = (sample_rate * 2).to_bytes(4, "little")
    header[32:34] = (2).to_bytes(2, "little")
    header[34:36] = (16).to_bytes(2, "little")
    header[36:40] = b"data"
    header[40:44] = b"\xff\xff\xff\xff"
    return bytes(header)


def _ensure_wav(audio_bytes: bytes, suffix: str = ".wav") -> bytes:
    """Convert any audio format to WAV (PCM 16-bit, mono)."""
    suffix = suffix.lower()
    if suffix == ".wav":
        return audio_bytes
    try:
        import soundfile as sf
        data, sr = sf.read(io.BytesIO(audio_bytes))
        if data.ndim > 1:
            data = data.mean(axis=1)
        buf = io.BytesIO()
        sf.write(buf, data, sr, format="WAV", subtype="PCM_16")
        return buf.getvalue()
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Cannot decode audio ({suffix}): {e}")


def _voice_dir() -> Path:
    return Path(config.NSPEECH_VOICE_DIR)


def _tensor_to_pcm_bytes(tensor: torch.Tensor) -> bytes:
    """Convert a float32 PCM tensor to 16-bit LE bytes."""
    audio_np = tensor.squeeze().cpu().numpy()
    return (audio_np * 32767.0).astype("int16").tobytes()


# ── Request models ──────────────────────────────────────────────────────────

class SpeechRequest(BaseModel):
    text: str
    voice_name: str = "default"
    output_format: str = "wav"
    speed: float = 1.0
    exaggeration: float = 0.5
    instruct_text: Optional[str] = None
    language: Optional[str] = None
    model: Optional[str] = None
    seed: Optional[int] = None
    offline: bool = False
    extra_body: dict = {}


class MixVoiceRequest(BaseModel):
    name: str
    voice_a: str
    voice_b: str
    ratio: float = 0.5


# ── App factory ─────────────────────────────────────────────────────────────

def create_app(engine_name: str) -> FastAPI:
    """Create a FastAPI app bound to a specific engine."""
    app = FastAPI(title=f"nSpeech Worker — {engine_name}", docs_url=None)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    log = get_logger()

    # ── GET /health ─────────────────────────────────────────────────────────

    @app.get("/health")
    async def health():
        """Readiness check. Reports 'warming' until the model is loaded."""
        try:
            engine = get_engine(engine_name)
            loaded = True
            if hasattr(engine, "is_loaded"):
                loaded = engine.is_loaded()
            status = "ready" if loaded else "warming"
        except Exception:
            status = "warming"

        return {"status": status, "engine": engine_name}

    # ── GET /v1/voices ──────────────────────────────────────────────────────

    @app.get("/v1/voices")
    async def list_voices():
        """List voices available for this engine."""
        try:
            engine = get_engine(engine_name)
        except Exception as e:
            raise HTTPException(status_code=503, detail=f"Engine not ready: {e}")

        voices = []

        # Engine-native voice list (if adapter implements list_voices)
        if hasattr(engine, "list_voices"):
            try:
                voices = engine.list_voices()
            except Exception as e:
                error(f"list_voices failed: {e}", meta={"engine": engine_name}, category="worker")

        # Fallback: scan voice directory for cloned/blended voices
        if not voices:
            voice_dir = _voice_dir()
            voice_dir.mkdir(parents=True, exist_ok=True)
            existing = set()

            # .wav files (cloned voices)
            for wav_path in voice_dir.glob("*.wav"):
                base = wav_path.stem
                if base not in existing:
                    voices.append({"voice_id": base, "name": base, "category": "cloned"})
                    existing.add(base)

            # .pt cache files (blended or engine-specific)
            for pt_path in voice_dir.glob(f"*.{engine_name}.pt"):
                base = pt_path.stem.rsplit(".", 1)[0]
                if base not in existing:
                    voices.append({"voice_id": base, "name": base, "category": "blended"})
                    existing.add(base)

            # dots.tts sidecars
            for json_path in voice_dir.glob("*.dots.json"):
                base = json_path.name[:-len(".dots.json")]
                if base not in existing:
                    voices.append({"voice_id": base, "name": base, "category": "cloned"})
                    existing.add(base)

        return {"voices": voices, "engine": engine_name}

    # ── POST /v1/audio/speech ───────────────────────────────────────────────

    @app.post("/v1/audio/speech")
    async def speech(request: Request, req: SpeechRequest):
        """Synthesize speech. Streams audio chunks."""
        start_time = time.time()

        try:
            engine = await asyncio.to_thread(get_engine, engine_name)
        except Exception as e:
            raise HTTPException(status_code=503, detail=f"Engine load failed: {e}")

        # Load voice if specified
        if req.voice_name and req.voice_name != "default":
            def _load_voice():
                try:
                    import inspect
                    sig = inspect.signature(engine.load_voice)
                    if "model" in sig.parameters or any(
                        p.kind == inspect.Parameter.VAR_KEYWORD
                        for p in sig.parameters.values()
                    ):
                        engine.load_voice(req.voice_name, model=req.model)
                    else:
                        engine.load_voice(req.voice_name)
                except FileNotFoundError:
                    # Try implicit compile from .wav
                    wav_path = _voice_dir() / f"{req.voice_name}.wav"
                    if wav_path.exists():
                        engine.clone(str(wav_path), req.voice_name)
                        engine.load_voice(req.voice_name)
                    else:
                        raise

            try:
                await asyncio.to_thread(_load_voice)
            except Exception as e:
                raise HTTPException(status_code=404, detail=f"Voice not found: {req.voice_name}")

        # Merge extra_body into kwargs
        gen_kwargs = dict(
            exaggeration=req.exaggeration,
            speed=req.speed,
            instruct_text=req.instruct_text,
            language=req.language,
            model=req.model,
            seed=req.seed,
            offline=req.offline,
        )

        # Offline path: buffer all, validate, return single response
        if req.offline:
            audio_bytes = await asyncio.to_thread(_collect_audio, engine, req, gen_kwargs)
            if not audio_bytes:
                raise HTTPException(status_code=500, detail="TTS engine produced empty audio")

            media_type = _media_type(req.output_format)
            info(
                f"offline speech complete: {len(req.text)} chars",
                meta={"ms": int((time.time() - start_time) * 1000), "bytes": len(audio_bytes)},
                category="worker",
            )
            return Response(content=audio_bytes, media_type=media_type)

        # Streaming path: peek first chunk, then stream
        gen = engine.generate(req.text, **gen_kwargs)
        try:
            first_tensor, first_final = await asyncio.to_thread(next, gen)
        except StopIteration:
            raise HTTPException(status_code=500, detail="TTS engine produced empty audio")

        if first_tensor.numel() == 0:
            raise HTTPException(status_code=500, detail="TTS engine produced empty audio")

        media_type = _media_type(req.output_format)
        return StreamingResponse(
            _stream_audio(req, first_tensor, first_final, gen, request, start_time),
            media_type=media_type,
        )

    # ── POST /v1/voices/clone ───────────────────────────────────────────────

    @app.post("/v1/voices/clone")
    async def clone_voice(
        file: UploadFile = File(...),
        name: str = Form(...),
        model: str = Form(None),
        exaggeration: float = Form(0.5),
        prompt_text: str = Form(None),
    ):
        """Clone a voice and persist the cache."""
        try:
            engine = await asyncio.to_thread(get_engine, engine_name)
        except Exception as e:
            raise HTTPException(status_code=503, detail=f"Engine load failed: {e}")

        voice_dir = _voice_dir()
        voice_dir.mkdir(parents=True, exist_ok=True)
        wav_path = voice_dir / f"{name}.wav"

        raw_bytes = await file.read()
        suffix = Path(file.filename or "").suffix.lower() or ".wav"
        wav_bytes = _ensure_wav(raw_bytes, suffix)
        with open(wav_path, "wb") as f:
            f.write(wav_bytes)

        def _do_clone():
            clone_kwargs = {"exaggeration": exaggeration, "model": model}
            if prompt_text:
                clone_kwargs["prompt_text"] = prompt_text
            return engine.clone(audio_path=str(wav_path), voice_name=name, **clone_kwargs)

        try:
            metadata = await asyncio.to_thread(_do_clone)
            return JSONResponse(content=metadata)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Clone failed: {e}")

    # ── POST /v1/voices/preview ─────────────────────────────────────────────

    @app.post("/v1/voices/preview")
    async def preview_voice(
        file: UploadFile = File(...),
        prompt_text: str = Form(None),
        test_phrase: str = Form(None),
        model: str = Form(None),
        offline: bool = Form(False),
    ):
        """Clone temporarily and stream a test phrase."""
        try:
            engine = await asyncio.to_thread(get_engine, engine_name)
        except Exception as e:
            raise HTTPException(status_code=503, detail=f"Engine load failed: {e}")

        import tempfile
        tmp_wav = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        try:
            raw_bytes = await file.read()
            suffix = Path(file.filename or "").suffix.lower() or ".wav"
            wav_bytes = _ensure_wav(raw_bytes, suffix)
            tmp_wav.write(wav_bytes)
            tmp_wav.close()

            preview_name = f"__preview__{os.urandom(4).hex()}"

            # Redirect cache to previews dir
            saved_cache = getattr(engine, "cache_dir", None)
            previews_dir = _voice_dir() / "previews"
            previews_dir.mkdir(parents=True, exist_ok=True)
            engine.cache_dir = previews_dir
            try:
                clone_kwargs = {"model": model}
                if prompt_text:
                    clone_kwargs["prompt_text"] = prompt_text
                await asyncio.to_thread(engine.clone, str(Path(tmp_wav.name)), preview_name, **clone_kwargs)
                await asyncio.to_thread(engine.load_voice, preview_name, model=model)
            finally:
                if saved_cache is not None:
                    engine.cache_dir = saved_cache
        finally:
            os.unlink(tmp_wav.name)

        phrase = test_phrase or "This is a preview of the cloned voice."
        gen = engine.generate(phrase, model=model, offline=offline)

        def stream_preview():
            import av
            output_io = io.BytesIO()
            container = av.open(output_io, mode="w", format="mp3")
            stream = container.add_stream("libmp3lame", rate=24000)
            last_pos = 0
            for chunk_tensor, is_final in gen:
                pcm = _tensor_to_pcm_bytes(chunk_tensor)
                audio_int16 = (chunk_tensor.squeeze().cpu().numpy() * 32767.0).astype("int16")
                frame = av.AudioFrame.from_ndarray(audio_int16.reshape(1, -1), format="s16", layout="mono")
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

        return StreamingResponse(stream_preview(), media_type="audio/mpeg")

    # ── POST /v1/voices/mix ─────────────────────────────────────────────────

    @app.post("/v1/voices/mix")
    async def mix_voices(req: MixVoiceRequest):
        """Blend two voices (engine-specific, currently Kokoro only)."""
        try:
            engine = await asyncio.to_thread(get_engine, engine_name)
        except Exception as e:
            raise HTTPException(status_code=503, detail=f"Engine load failed: {e}")

        if not hasattr(engine, "pipeline") or not hasattr(engine.pipeline, "get_voice_style"):
            raise HTTPException(status_code=400, detail="Current engine does not support voice blending")

        def _do_mix():
            style_a = engine.pipeline.get_voice_style(req.voice_a)
            style_b = engine.pipeline.get_voice_style(req.voice_b)
            blended = style_a * req.ratio + style_b * (1 - req.ratio)
            if not isinstance(blended, torch.Tensor):
                blended = torch.from_numpy(blended)
            voice_dir = _voice_dir()
            if req.name.startswith("_preview_"):
                voice_dir = voice_dir / "cache"
            voice_dir.mkdir(parents=True, exist_ok=True)
            cache_path = voice_dir / f"{req.name}.{engine.engine_name}.pt"
            torch.save(blended, str(cache_path))
            return {
                "voice_id": req.name,
                "name": req.name,
                "category": "blended",
                "engine": engine_name,
                "cache_file": str(cache_path),
            }

        try:
            result = await asyncio.to_thread(_do_mix)
            return JSONResponse(content=result)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Blend failed: {e}")

    # ── DELETE /v1/voices/{voice_id} ────────────────────────────────────────

    @app.delete("/v1/voices/{voice_id}")
    async def delete_voice(voice_id: str):
        """Delete a cloned or blended voice."""
        voice_dir = _voice_dir()
        deleted = []
        for dir_path in (voice_dir, voice_dir / "previews"):
            for ext in (".wav", ".pt", ".dots.json"):
                p = dir_path / f"{voice_id}{ext}"
                if p.exists():
                    p.unlink()
                    deleted.append(p.name)

        # Also remove engine-specific .pt files
        for pt_path in voice_dir.glob(f"{voice_id}.*.pt"):
            pt_path.unlink()
            deleted.append(pt_path.name)

        if not deleted:
            raise HTTPException(status_code=404, detail=f"Voice '{voice_id}' not found")

        return {"deleted": voice_id, "files": deleted}

    return app


# ── Audio collection / streaming helpers ────────────────────────────────────

def _media_type(output_format: str) -> str:
    if output_format == "wav":
        return "audio/wav"
    if output_format == "pcm":
        return "audio/pcm"
    if output_format == "pcm_f32":
        return "application/octet-stream"
    return f"audio/{output_format}"


def _collect_audio(engine, req: SpeechRequest, gen_kwargs: dict) -> bytes:
    """Collect all audio into a single buffer for offline mode."""
    if req.output_format in ("pcm", "pcm_f32"):
        parts = []
        for chunk_tensor, is_final in engine.generate(req.text, **gen_kwargs):
            if req.output_format == "pcm_f32":
                parts.append(chunk_tensor.squeeze().cpu().numpy().astype("float32").tobytes())
            else:
                parts.append(_tensor_to_pcm_bytes(chunk_tensor))
        return b"".join(parts)

    if req.output_format == "wav":
        parts = [_generate_wav_header(24000)]
        for chunk_tensor, is_final in engine.generate(req.text, **gen_kwargs):
            parts.append(_tensor_to_pcm_bytes(chunk_tensor))
        return b"".join(parts)

    # Transcoded formats (mp3, opus, etc.)
    import av
    output_io = io.BytesIO()
    container = av.open(output_io, mode="w", format=req.output_format)
    codec = "libmp3lame" if req.output_format == "mp3" else ("libopus" if req.output_format in ("ogg", "webm") else "aac")
    try:
        stream = container.add_stream(codec, rate=24000)
        stream.bit_rate = 128000
    except Exception:
        stream = container.add_stream("mp3", rate=24000)

    for chunk_tensor, is_final in engine.generate(req.text, **gen_kwargs):
        audio_int16 = (chunk_tensor.squeeze().cpu().numpy() * 32767.0).astype("int16")
        frame = av.AudioFrame.from_ndarray(audio_int16.reshape(1, -1), format="s16", layout="mono")
        frame.sample_rate = 24000
        for packet in stream.encode(frame):
            container.mux(packet)

    for packet in stream.encode():
        container.mux(packet)
    container.close()
    return output_io.getvalue()


async def _stream_audio(req, first_tensor, first_final, gen, request: Request, start_time: float):
    """Stream audio chunks. Checks for client disconnect between chunks."""
    try:
        if req.output_format in ("pcm", "pcm_f32", "wav"):
            if req.output_format == "wav":
                yield _generate_wav_header(24000)
            for tensor, is_final in _chain(first_tensor, first_final, gen):
                if await request.is_disconnected():
                    info("client disconnected mid-stream", meta={"ms": int((time.time() - start_time) * 1000)}, category="worker")
                    return
                if req.output_format == "pcm_f32":
                    yield tensor.squeeze().cpu().numpy().astype("float32").tobytes()
                else:
                    yield _tensor_to_pcm_bytes(tensor)
            return

        # Transcoded streaming
        import av
        output_io = io.BytesIO()
        container = av.open(output_io, mode="w", format=req.output_format)
        codec = "libmp3lame" if req.output_format == "mp3" else ("libopus" if req.output_format in ("ogg", "webm") else "aac")
        try:
            stream = container.add_stream(codec, rate=24000)
            stream.bit_rate = 128000
        except Exception:
            stream = container.add_stream("mp3", rate=24000)

        last_pos = 0
        for tensor, is_final in _chain(first_tensor, first_final, gen):
            if await request.is_disconnected():
                info("client disconnected mid-stream", meta={"ms": int((time.time() - start_time) * 1000)}, category="worker")
                container.close()
                return
            audio_int16 = (tensor.squeeze().cpu().numpy() * 32767.0).astype("int16")
            frame = av.AudioFrame.from_ndarray(audio_int16.reshape(1, -1), format="s16", layout="mono")
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

    except GeneratorExit:
        info("client disconnected (GeneratorExit)", meta={"ms": int((time.time() - start_time) * 1000)}, category="worker")
        return


def _chain(first_tensor, first_final, gen):
    """Yield a pre-peeked chunk, then delegate to the generator."""
    yield first_tensor, first_final
    yield from gen
