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
from fastapi.responses import StreamingResponse, Response, JSONResponse
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

@app.get("/health")
def health_endpoint():
    return {"status": "ok", "default_engine": config.NSPEECH_ENGINE}


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
        engine.load_voice(req.voice_name)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
        
    def stream_audio():
        # Optional: Add format transcoding logic here if needed
        # For now, default to streaming WAV format using our infinite header hack
        if req.output_format == "wav":
            yield generate_streaming_wav_header(req.transcode_sample_rate)
            
        for chunk_tensor, is_final in engine.generate(req.text, exaggeration=req.exaggeration):
            # Convert float32 PCM to int16 bytes
            audio_np = chunk_tensor.squeeze().cpu().numpy()
            audio_int16 = (audio_np * 32767.0).astype("int16")
            yield audio_int16.tobytes()

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
