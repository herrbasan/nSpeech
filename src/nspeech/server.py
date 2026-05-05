"""
FastAPI Server Core

Implements HTTP REST endpoints and strictly adheres to fail-fast principles
and lazy-loading of TTS engines.
"""
import io
import wave
import time
from pathlib import Path
from typing import Optional, List, Dict, Any

from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from fastapi.responses import StreamingResponse, Response, JSONResponse, HTMLResponse
from pydantic import BaseModel

import torch
from nspeech import config
from nspeech.tts import get_engine

app = FastAPI(title="nSpeech", description="Pluggable Streaming TTS Service")


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


def get_all_voices() -> List[Dict[str, Any]]:
    """Scan NSPEECH_VOICE_DIR to collect all base .wav and engine caches."""
    voice_dir = Path(config.NSPEECH_VOICE_DIR)
    voice_dir.mkdir(parents=True, exist_ok=True)
    
    # Find all base `.wav` files
    wav_files = list(voice_dir.glob("*.wav"))
    
    voices = []
    for wav_path in wav_files:
        base_name = wav_path.stem
        # Find companion .pt cache files
        cache_files = list(voice_dir.glob(f"{base_name}.*.pt"))
        
        engines_info = []
        for cache in cache_files:
            engine_name = cache.stem.split(".")[-1]
            engines_info.append({
                "name": engine_name,
                "cached": True,
                "latency_tier": "standard"  # Future: could read from a registry
            })
            
        voices.append({
            "name": base_name,
            "source_file": wav_path.name,
            "engines": engines_info
        })
        
    return voices


# ---------------------------------------------------------
# REST Models
# ---------------------------------------------------------

class TTSRequest(BaseModel):
    text: str
    voice_name: str = "default"
    engine: Optional[str] = None
    exaggeration: float = 0.5
    output_format: str = "wav"
    transcode_bitrate: str = "128k"
    transcode_sample_rate: int = 24000


class OpenAITTSRequest(BaseModel):
    model: str
    input: str
    voice: str = "default"
    response_format: str = "mp3"
    speed: float = 1.0


# ---------------------------------------------------------
# Routes
# ---------------------------------------------------------

import asyncio
from nspeech.tts import evict_idle_engines, mark_engine_used

async def memory_janitor():
    """Background task to periodically check for idle models and evict them."""
    while True:
        await asyncio.sleep(5)  # Check every 5 seconds
        evict_idle_engines()

@app.on_event("startup")
def on_startup():
    """Startup initialization."""
    # Start the memory manager
    if config.NSPEECH_MODEL_IDLE_TIMEOUT_SEC > 0:
        print(f"[Startup] VRAM Janitor active. Models will be evicted after {config.NSPEECH_MODEL_IDLE_TIMEOUT_SEC}s of idle time.")
        asyncio.create_task(memory_janitor())

    if config.NSPEECH_PRELOAD_MODEL:
        print(f"[Startup] NSPEECH_PRELOAD_MODEL is enabled. Preloading {config.NSPEECH_ENGINE}...")
        try:
            get_engine(config.NSPEECH_ENGINE)
            print("[Startup] Engine preloaded successfully.")
        except Exception as e:
            print(f"[Startup] Failed to preload engine: {e}")

@app.get("/health")
def health_endpoint():
    return {"status": "ok", "default_engine": config.NSPEECH_ENGINE}

@app.get("/", response_class=HTMLResponse)
def serve_test_ui():
    """Serves a lightweight UI to test streaming from the browser natively."""
    return """
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <title>nSpeech UI Dashboard</title>
        <style>
            body { font-family: system-ui, sans-serif; max-width: 600px; margin: 40px auto; padding: 20px; background: #121212; color: #e0e0e0; }
            .card { background: #1e1e1e; padding: 20px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.3); border: 1px solid #333; }
            textarea { width: 100%; height: 100px; margin-bottom: 10px; font-family: inherit; padding: 8px; box-sizing: border-box; background: #2d2d2d; color: #e0e0e0; border: 1px solid #444; border-radius: 4px; }
            textarea:focus { outline: none; border-color: #0078D4; }
            button { background: #0078D4; color: white; border: none; padding: 10px 15px; border-radius: 4px; cursor: pointer; font-size: 16px; width: 100%; }
            button:hover { background: #005a9e; }
            audio { width: 100%; margin-top: 15px; outline: none; border-radius: 4px; }
            audio::-webkit-media-controls-panel { background-color: #2d2d2d; }
            audio::-webkit-media-controls-current-time-display,
            audio::-webkit-media-controls-time-remaining-display { color: #e0e0e0; text-shadow: none; }
        </style>
    </head>
    <body>
        <div class="card">
            <h2>nSpeech UI Dashboard</h2>
            
            <!-- Voice Management Section -->
            <div style="background: #2d2d2d; padding: 15px; border-radius: 4px; margin-bottom: 15px; border: 1px solid #444;">
                <div style="display: flex; gap: 10px; align-items: center; margin-bottom: 10px;">
                    <label for="voice-select" style="font-weight: bold; width: 100px;">Using Voice:</label>
                    <select id="voice-select" style="flex: 1; padding: 8px; background: #1e1e1e; color: white; border: 1px solid #555; border-radius: 4px;">
                        <option value="default">Default</option>
                    </select>
                </div>
                
                <div style="display: flex; gap: 10px; align-items: center;">
                    <label style="font-weight: bold; width: 100px;">Clone New:</label>
                    <input type="file" id="clone-file" accept="audio/wav" style="flex: 1; font-size: 12px; color: #ccc;" />
                    <input type="text" id="clone-name" placeholder="Voice Name" style="width: 120px; padding: 8px; background: #1e1e1e; color: white; border: 1px solid #555; border-radius: 4px;" />
                    <button onclick="cloneVoice()" style="width: 80px; padding: 8px; background: #2e7d32;">Clone</button>
                </div>
            </div>

            <textarea id="text-input" placeholder="Type a long paragraph here...">This is a test of the nSpeech streaming system. As you can hear, the audio begins playing almost instantly! The system generates chunks sentence by sentence. This allows us to achieve incredibly low latency. While this sentence is playing, the background engine is already working hard on the next one. We can seamlessly stream very long passages of text without ever making the user wait for the entire paragraph to finish generating. Let's add a few more sentences just to be absolutely sure. This should give the engine enough work to demonstrate continuous streaming. How does it sound?</textarea>
            <div style="display: flex; gap: 10px;">
                <button onclick="playStream()" style="flex: 2;">Generate & Stream</button>
                <button onclick="stopStream()" style="flex: 1; background: #d32f2f;">Stop</button>
            </div>
            <audio id="audio-player" controls autoplay style="display: none;"></audio>
        </div>
        <script>
            let mediaSource;
            let abortController = null;
            
            async function loadVoices() {
                try {
                    const res = await fetch('/voices');
                    const data = await res.json();
                    const select = document.getElementById('voice-select');
                    select.innerHTML = '<option value="default">Default</option>';
                    data.voices.forEach(v => {
                        const opt = document.createElement('option');
                        opt.value = v.name;
                        // Determine if it has a pt cache companion
                        const isCached = v.engines && v.engines.length > 0;
                        opt.textContent = v.name + (isCached ? " (Cached)" : "");
                        select.appendChild(opt);
                    });
                } catch(e) {
                    console.error("Failed to load voices", e);
                }
            }

            async function cloneVoice() {
                const fileInput = document.getElementById('clone-file');
                const nameInput = document.getElementById('clone-name');
                if (!fileInput.files[0] || !nameInput.value) {
                    alert("Please select a .wav file and provide a name.");
                    return;
                }
                
                const formData = new FormData();
                formData.append('file', fileInput.files[0]);
                formData.append('name', nameInput.value);
                
                logStatus(`[Clone] Uploading and cloning voice '${nameInput.value}'... This may take a moment.`);
                try {
                    const res = await fetch('/voices/clone', { method: 'POST', body: formData });
                    const result = await res.json();
                    if (res.ok) {
                        logStatus(`[Clone] Success! Cloned in ${result.clone_time_ms}ms.`);
                        await loadVoices();
                        document.getElementById('voice-select').value = nameInput.value;
                        fileInput.value = "";
                        nameInput.value = "";
                    } else {
                        logStatus(`[Clone Error] ${result.detail}`);
                    }
                } catch(e) {
                    logStatus(`[Clone Error] ${e}`);
                }
            }

            // Load voices when the page boots
            window.onload = loadVoices;

            function logStatus(msg) {
                console.log(msg);
            }

            function stopStream() {
                if (abortController) {
                    abortController.abort();
                    abortController = null;
                }
                const audio = document.getElementById('audio-player');
                audio.pause();
                audio.removeAttribute('src');
                if (mediaSource && mediaSource.readyState === "open") {
                    mediaSource.endOfStream();
                }
                mediaSource = null;
                logStatus('[App] Synthesis and playback stopped.');
            }

            async function playStream() {
                const text = document.getElementById('text-input').value;
                const voice = document.getElementById('voice-select').value;
                if (!text) return;
                
                stopStream(); // Reset any existing active streams before starting
                
                abortController = new AbortController();
                logStatus(`[App] playStream called at ${performance.now().toFixed(2)}ms`);
                
                const audio = document.getElementById('audio-player');
                audio.style.display = "block";
                
                mediaSource = new MediaSource();
                audio.src = URL.createObjectURL(mediaSource);
                audio.play().catch(e => logStatus(`Play failed: ${e}`));

                mediaSource.addEventListener("sourceopen", async () => {
                    logStatus(`[App] Requesting mp3 output format...`);
                    try {
                        const sourceBuffer = mediaSource.addSourceBuffer('audio/mpeg');
                        
                        const response = await fetch(`/tts?text=${encodeURIComponent(text)}&output_format=mp3&voice_name=${encodeURIComponent(voice)}`, {
                            signal: abortController.signal
                        });
                        
                        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
                        
                        const reader = response.body.getReader();

                        while (true) {
                            const { done, value } = await reader.read();
                            if (done) {
                                logStatus(`[App] Network stream complete.`);
                                break;
                            }
                            
                            // Await the buffer append to complete before adding the next chunk
                            await new Promise((resolve, reject) => {
                                sourceBuffer.appendBuffer(value);
                                sourceBuffer.onupdateend = resolve;
                                sourceBuffer.onerror = reject;
                            });
                        }
                        if (mediaSource.readyState === "open") {
                            mediaSource.endOfStream();
                        }
                    } catch (err) {
                        if (err.name === 'AbortError') {
                            logStatus(`[App] Stream aborted by user.`);
                        } else {
                            logStatus(`[Error] ${err}`);
                        }
                    }
                }, { once: true });
            }
        </script>
    </body>
    </html>
    """

@app.get("/tts")
def tts_get_endpoint(text: str, voice_name: str = "default", engine: Optional[str] = None, output_format: str = "mp3"):
    """Wrapper around POST /tts to allow native HTML <audio src="..."> streaming over GET."""
    req = TTSRequest(text=text, voice_name=voice_name, engine=engine, output_format=output_format)
    return tts_endpoint(req)


@app.get("/voices")
def list_voices():
    """Lists all available voices and their compiled engine caches."""
    return {"voices": get_all_voices()}


@app.post("/tts")
def tts_endpoint(req: TTSRequest):
    """Streaming synthesis. Returns chunked audio using Transfer-Encoding: chunked."""
    try:
        # Load immediately to fail-fast if voice or engine is invalid
        engine = get_engine(req.engine)
        if req.voice_name and req.voice_name != "default":
            engine.load_voice(req.voice_name)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
        
    def stream_audio():
        import time
        start_time = time.time()
        print(f"[Backend] Starting request for text length {len(req.text)}")

        try:
            # Stream raw PCM without headers
            if req.output_format == "pcm":
                for chunk_tensor, is_final in engine.generate(req.text, exaggeration=req.exaggeration):
                    mark_engine_used(req.engine)
                    audio_np = chunk_tensor.squeeze().cpu().numpy()
                    yield (audio_np * 32767.0).astype("int16").tobytes()
                return
                
            # Stream WAV using infinite headers hack
            if req.output_format == "wav":
                yield generate_streaming_wav_header(req.transcode_sample_rate)
                for chunk_tensor, is_final in engine.generate(req.text, exaggeration=req.exaggeration):
                    mark_engine_used(req.engine)
                    audio_np = chunk_tensor.squeeze().cpu().numpy()
                    yield (audio_np * 32767.0).astype("int16").tobytes()
                return
                
            # Transcode backend stream via PyAV (av)
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
                # Apply bitrate
                stream.bit_rate = int(req.transcode_bitrate.replace('k', '000').replace('m', '000000'))
            except Exception:
                stream = container.add_stream('mp3', rate=req.transcode_sample_rate)

            last_pos = 0
            chunk_idx = 0
            for chunk_tensor, is_final in engine.generate(req.text, exaggeration=req.exaggeration):
                mark_engine_used(req.engine)
                engine_time = time.time()
                print(f"[Backend] [Chunk {chunk_idx}] Engine logic finished at {engine_time - start_time:.3f}s")
                audio_np = chunk_tensor.squeeze().cpu().numpy()
                audio_int16 = (audio_np * 32767.0).astype("int16")
                
                # Format explicitly for an av AudioFrame
                frame = av.AudioFrame.from_ndarray(audio_int16.reshape(1, -1), format='s16', layout='mono')
                frame.sample_rate = req.transcode_sample_rate
                
                for packet in stream.encode(frame):
                    container.mux(packet)
                    
                # Yield newly appended bytes since last pass
                current_pos = output_io.tell()
                output_io.seek(last_pos)
                data = output_io.read()
                output_io.seek(current_pos)
                last_pos = current_pos
                
                if data:
                    yield data
                yield_time = time.time()
                print(f"[Backend] [Chunk {chunk_idx}] Bytes yielded at {yield_time - start_time:.3f}s (size: {len(data)})")
                chunk_idx += 1

            # Flush buffer
            for packet in stream.encode():
                container.mux(packet)
            container.close()
            
            output_io.seek(last_pos)
            data = output_io.read()
            if data:
                yield data
            
            print(f"[Backend] Stream finished at {time.time() - start_time:.3f}s")
            
        except GeneratorExit:
            print(f"[Backend] 🛑 Client disconnected! TTS engine loop gracefully halted at {time.time() - start_time:.3f}s.")
            return

    media_type = "audio/wav" if req.output_format == "wav" else f"audio/{req.output_format}"
    return StreamingResponse(stream_audio(), media_type=media_type)


@app.post("/v1/audio/speech")
def openai_speech_endpoint(req: OpenAITTSRequest):
    """OpenAI proxy endpoint."""
    # Map OpenAI fields to nSpeech format
    tts_req = TTSRequest(
        text=req.input,
        voice_name=req.voice,
        engine=req.model,  # OpenAI's 'model' maps directly to engine
        exaggeration=1.0 + (1.0 - req.speed), # Simplistic mapping for demonstration
        output_format=req.response_format
    )
    return tts_endpoint(tts_req)


@app.post("/voices/clone")
async def clone_voice_endpoint(
    file: UploadFile = File(...),
    name: str = Form(...),
    engine: str = Form(None),
    exaggeration: float = Form(0.5)
):
    """Clone a voice and generate an engine embedding."""
    engine_name = engine or config.NSPEECH_ENGINE
    
    try:
        tts_engine = get_engine(engine_name)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
        
    voice_dir = Path(config.NSPEECH_VOICE_DIR)
    voice_dir.mkdir(parents=True, exist_ok=True)
    
    wav_path = voice_dir / f"{name}.wav"
    
    # Save reference audio (fail fast if read/write fails)
    wav_bytes = await file.read()
    with open(wav_path, "wb") as f:
        f.write(wav_bytes)
        
    try:
        metadata = tts_engine.clone(
            audio_path=str(wav_path),
            voice_name=name,
            exaggeration=exaggeration
        )
        return JSONResponse(content=metadata)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Clone failed: {e}")
