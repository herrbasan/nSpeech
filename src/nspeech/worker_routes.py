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
from nspeech.audio_formats import (
    normalize_to_wav,
    encode_stream,
    get_media_type,
    is_supported_output_format,
    generate_wav_header as _generate_wav_header,
    tensor_to_pcm_bytes as _tensor_to_pcm_bytes,
)


# ── Audio helpers — re-exported for backward compat with any callers ──────

def _ensure_wav(audio_bytes: bytes, suffix: str = ".wav") -> bytes:
    """Convert any audio format to WAV (PCM 16-bit, mono). Wraps ValueError as HTTP 422."""
    try:
        return normalize_to_wav(audio_bytes, suffix)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


def _voice_dir() -> Path:
    return Path(config.NSPEECH_VOICE_DIR)


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

        # Always scan voice directory for cloned/blended/preview voices and
        # merge with the native list. Previously this was gated on
        # `if not voices:` which meant engines with built-in voices (Kokoro's
        # 54) never showed their blended/cloned voices.
        voice_dir = _voice_dir()
        voice_dir.mkdir(parents=True, exist_ok=True)
        existing = {v.get("voice_id") or v.get("name") for v in voices}

        # .wav files (cloned voices)
        for wav_path in voice_dir.glob("*.wav"):
            base = wav_path.stem
            if base.startswith("__preview__"):
                continue
            if base not in existing:
                voices.append({"voice_id": base, "name": base, "category": "cloned", "voice_type": "cloned"})
                existing.add(base)

        # .pt cache files (blended, engine-specific, or preview)
        for pt_path in voice_dir.glob(f"*.{engine_name}.pt"):
            base = pt_path.stem.rsplit(".", 1)[0]
            if base in existing:
                continue
            if base.startswith("__preview__"):
                voices.append({"voice_id": base, "name": base, "category": "preview", "voice_type": "preview"})
            else:
                voices.append({"voice_id": base, "name": base, "category": "blended", "voice_type": "blended"})
            existing.add(base)

        # dots.tts sidecars
        for json_path in voice_dir.glob("*.dots.json"):
            base = json_path.name[:-len(".dots.json")]
            if base not in existing:
                voices.append({"voice_id": base, "name": base, "category": "cloned", "voice_type": "cloned"})
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
        # Engine-specific params (steps, guidance_scale, blend, ...) ride in
        # extra_body. Merge them into kwargs so each adapter picks what it needs
        # via **kwargs; unknown keys are ignored.
        if req.extra_body:
            gen_kwargs.update(req.extra_body)

        # Offline path: buffer all, validate, return single response
        if req.offline:
            audio_bytes = await asyncio.to_thread(_collect_audio, engine, req, gen_kwargs)
            if not audio_bytes:
                raise HTTPException(status_code=500, detail="TTS engine produced empty audio")

            try:
                media_type = get_media_type(req.output_format)
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e))
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

        try:
            media_type = get_media_type(req.output_format)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
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
            clone_kwargs = {"exaggeration": exaggeration}
            if model:
                clone_kwargs["model"] = model
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
        output_format: str = Form("pcm"),
    ):
        """Clone temporarily and stream a test phrase.

        Always emits raw PCM (s16le, 24kHz, mono). Node transcodes to
        whatever format the browser needs (mp3 for MediaSource). This
        matches the /v1/audio/speech path where the worker returns PCM
        and Node owns all codec output.
        """
        try:
            engine = await asyncio.to_thread(get_engine, engine_name)
        except Exception as e:
            raise HTTPException(status_code=503, detail=f"Engine load failed: {e}")

        # Force PCM — Node handles all transcoding via ffmpeg.
        output_format = "pcm"

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
            # Capture the transcript used for cloning (either user-provided
            # or auto-transcribed). Exposed via X-STT-Transcript header so
            # the dashboard can show what Whisper heard.
            stt_transcript = prompt_text or ""
            try:
                clone_kwargs = {}
                if model:
                    clone_kwargs["model"] = model
                if prompt_text:
                    clone_kwargs["prompt_text"] = prompt_text
                clone_meta = await asyncio.to_thread(
                    engine.clone, str(Path(tmp_wav.name)), preview_name, **clone_kwargs
                )
                # If clone returned a transcript (CosyVoice/dots do), use it.
                if isinstance(clone_meta, dict) and clone_meta.get("prompt_text"):
                    stt_transcript = clone_meta["prompt_text"]
                await asyncio.to_thread(engine.load_voice, preview_name)
            finally:
                if saved_cache is not None:
                    engine.cache_dir = saved_cache
        finally:
            os.unlink(tmp_wav.name)

        phrase = test_phrase or "This is a preview of the cloned voice."
        gen_kwargs = {}
        if model:
            gen_kwargs["model"] = model
        gen = engine.generate(phrase, **gen_kwargs)

        # Track preview cache files for cleanup after streaming completes.
        preview_cache_files = []
        if previews_dir.exists():
            preview_cache_files = list(previews_dir.glob(f"{preview_name}*"))

        def _cleanup_preview():
            """Clean up preview cache files — previews are temporary."""
            for cache_file in preview_cache_files:
                try:
                    cache_file.unlink()
                except Exception:
                    pass
            # Also remove the in-memory spk2info entry if present
            try:
                spk = getattr(engine.model, "frontend", None)
                if spk is not None and hasattr(spk, "spk2info"):
                    spk.spk2info.pop(preview_name, None)
            except Exception:
                pass

        # Build headers exposing the STT transcript (if any) for the dashboard.
        preview_headers = {}
        if stt_transcript:
            preview_headers["X-STT-Transcript"] = stt_transcript

        # Offline path: buffer all audio, return single response.
        # Matches the /v1/audio/speech offline behavior.
        if offline:
            try:
                audio_bytes = b"".join(encode_stream(gen, output_format))
            finally:
                _cleanup_preview()
            if not audio_bytes:
                raise HTTPException(status_code=500, detail="TTS engine produced empty audio")
            return Response(
                content=audio_bytes,
                media_type=get_media_type(output_format),
                headers=preview_headers,
            )

        # Streaming path
        def stream_preview():
            try:
                for chunk in encode_stream(gen, output_format):
                    yield chunk
            finally:
                _cleanup_preview()

        return StreamingResponse(
            stream_preview(),
            media_type=get_media_type(output_format),
            headers=preview_headers,
        )

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

def _collect_audio(engine, req: SpeechRequest, gen_kwargs: dict) -> bytes:
    """Collect all audio into a single buffer for offline mode.

    Uses the standardized encode_stream so all formats (wav, pcm, pcm_f32,
    mp3, opus) go through the same code path. Format errors are converted
    to HTTP 400 with a clear message.
    """
    from nspeech.audio_formats import is_supported_output_format, OUTPUT_FORMATS
    if not is_supported_output_format(req.output_format):
        raise HTTPException(
            status_code=400,
            detail=f"Unknown output format: {req.output_format}. Supported: {list(OUTPUT_FORMATS.keys())}",
        )
    gen = engine.generate(req.text, **gen_kwargs)
    try:
        return b"".join(encode_stream(gen, req.output_format))
    except (RuntimeError, ValueError) as e:
        raise HTTPException(status_code=400, detail=str(e))


async def _stream_audio(req, first_tensor, first_final, gen, request: Request, start_time: float):
    """Stream audio chunks. Checks for client disconnect between chunks.

    Uses the standardized encode_stream so all formats (wav, pcm, pcm_f32,
    mp3, opus) go through the same code path. The encoder is built once
    after the first tensor peek (we know output_format at that point),
    then fed the remaining tensors incrementally.
    """
    from nspeech.audio_formats import get_format_info, AudioEncoder

    # NOTE: do not name this `info` — it shadows the module-level `info` logger
    # imported from nspeech.logger, which would make the disconnect log calls
    # below raise `TypeError: 'dict' object is not callable`.
    fmt = get_format_info(req.output_format)
    is_raw = fmt.get("is_raw", False)
    sample_format = fmt.get("sample_format", "s16")

    # Build the compressed encoder once, after the format is known.
    enc = None
    if not is_raw:
        enc = AudioEncoder(req.output_format)

    try:
        # Yield the WAV header once at the start for raw WAV output
        if req.output_format == "wav":
            yield _generate_wav_header(fmt["sample_rate"])

        for tensor, is_final in _chain(first_tensor, first_final, gen):
            if await request.is_disconnected():
                info("client disconnected mid-stream", meta={"ms": int((time.time() - start_time) * 1000)}, category="worker")
                if enc is not None:
                    try:
                        enc._container.close()
                    except Exception:
                        pass
                return

            if is_raw:
                if sample_format == "f32":
                    yield tensor.squeeze().cpu().numpy().astype("float32").tobytes()
                else:
                    yield _tensor_to_pcm_bytes(tensor)
            else:
                chunk = enc.encode_chunk(tensor)
                if chunk:
                    yield chunk

        # Flush remaining compressed packets
        if enc is not None:
            trailer = enc.finish()
            if trailer:
                yield trailer

    except GeneratorExit:
        info("client disconnected (GeneratorExit)", meta={"ms": int((time.time() - start_time) * 1000)}, category="worker")
        return


def _chain(first_tensor, first_final, gen):
    """Yield a pre-peeked chunk, then delegate to the generator."""
    yield first_tensor, first_final
    yield from gen
