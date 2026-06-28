"""
nSpeech Audio Formats — standardized format handling across all engines.

Input formats (clone/preview file uploads): wav, mp3, flac, ogg, opus, m4a, aac
Output formats (synthesis): wav, pcm, pcm_f32, mp3, opus

Centralizes the codec/container lookup tables and the input→WAV normalization
so every engine and every endpoint behaves identically. If a format isn't
supported by the current PyAV build, it fails fast with a clear error instead
of silently falling back.

Adapter contract: engines yield (pcm_tensor, is_final) where pcm_tensor is
float32 mono PCM at the engine's native sample rate (typically 24kHz).
This module handles everything after that — conversion to the requested
output format.
"""
import io


# ── Input format support (for clone/preview uploads) ────────────────────────

INPUT_FORMATS = {
    ".wav", ".mp3", ".flac", ".ogg", ".opus", ".m4a", ".aac", ".webm",
}


def is_supported_input_format(suffix: str) -> bool:
    """Check if a file extension is a supported input format."""
    return suffix.lower() in INPUT_FORMATS


def normalize_to_wav(audio_bytes: bytes, suffix: str) -> bytes:
    """Convert any supported input format to WAV (PCM 16-bit, mono).

    Raises ValueError with a clear message if the format is unsupported
    or the data can't be decoded.
    """
    suffix = suffix.lower()
    if suffix == ".wav":
        return audio_bytes

    if suffix not in INPUT_FORMATS:
        raise ValueError(
            f"Unsupported input format: {suffix}. "
            f"Supported: {sorted(INPUT_FORMATS)}"
        )

    import soundfile as sf
    try:
        data, sr = sf.read(io.BytesIO(audio_bytes))
    except Exception as e:
        raise ValueError(f"Cannot decode audio ({suffix}): {e}")

    # Mix to mono if stereo/multi-channel
    if data.ndim > 1:
        data = data.mean(axis=1)

    buf = io.BytesIO()
    sf.write(buf, data, sr, format="WAV", subtype="PCM_16")
    return buf.getvalue()


# ── Output format registry ──────────────────────────────────────────────────
#
# Each format maps to encoding parameters. Raw formats (wav, pcm, pcm_f32)
# don't need a codec — tensor→bytes directly. Compressed formats use PyAV.

OUTPUT_FORMATS = {
    "wav": {
        "media_type": "audio/wav",
        "is_raw": True,
        "sample_rate": 24000,
        "sample_format": "s16",
    },
    "pcm": {
        "media_type": "audio/pcm",
        "is_raw": True,
        "sample_rate": 24000,
        "sample_format": "s16",
    },
    "pcm_f32": {
        "media_type": "application/octet-stream",
        "is_raw": True,
        "sample_rate": 24000,
        "sample_format": "f32",
    },
    "mp3": {
        "media_type": "audio/mpeg",
        "is_raw": False,
        "codec": "libmp3lame",
        "container_format": "mp3",
        "sample_rate": 24000,
        "bit_rate": 128000,
    },
    "opus": {
        "media_type": "audio/opus",
        "is_raw": False,
        "codec": "libopus",
        "container_format": "ogg",
        "sample_rate": 48000,  # Opus requires 48kHz
        "bit_rate": 96000,
    },
}


def get_media_type(output_format: str) -> str:
    """Get HTTP Content-Type for an output format."""
    info = OUTPUT_FORMATS.get(output_format)
    if info is None:
        raise ValueError(
            f"Unknown output format: {output_format}. "
            f"Supported: {list(OUTPUT_FORMATS.keys())}"
        )
    return info["media_type"]


def is_supported_output_format(output_format: str) -> bool:
    """Check if an output format is recognized."""
    return output_format in OUTPUT_FORMATS


def get_format_info(output_format: str) -> dict:
    """Get the format spec. Raises ValueError if unknown."""
    info = OUTPUT_FORMATS.get(output_format)
    if info is None:
        raise ValueError(
            f"Unknown output format: {output_format}. "
            f"Supported: {list(OUTPUT_FORMATS.keys())}"
        )
    return info


# ── WAV header (for raw WAV streaming) ──────────────────────────────────────

def generate_wav_header(sample_rate: int = 24000) -> bytes:
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


# ── Tensor → PCM bytes ──────────────────────────────────────────────────────

def tensor_to_pcm_bytes(tensor, sample_format: str = "s16") -> bytes:
    """Convert a float32 PCM tensor to bytes in the requested sample format."""
    audio_np = tensor.squeeze().cpu().numpy()
    if sample_format == "s16":
        return (audio_np * 32767.0).astype("int16").tobytes()
    elif sample_format == "f32":
        return audio_np.astype("float32").tobytes()
    else:
        raise ValueError(f"Unsupported sample format: {sample_format}")


# ── PyAV encoder (for compressed formats) ──────────────────────────────────

def _check_codec_available(codec_name: str) -> bool:
    """Check if a PyAV codec is available in the current build."""
    import av
    try:
        av.codec.Codec(codec_name, "r")
        return True
    except Exception:
        return False


class AudioEncoder:
    """Wraps a PyAV output container for encoding PCM tensor streams.

    Usage:
        enc = AudioEncoder("mp3")
        for tensor, is_final in engine.generate(text):
            chunk = enc.encode_chunk(tensor)
            if chunk:
                yield chunk
        trailer = enc.finish()
        if trailer:
            yield trailer
    """

    def __init__(self, output_format: str):
        import av

        info = get_format_info(output_format)
        if info.get("is_raw"):
            raise ValueError(
                f"Format '{output_format}' is raw — use tensor_to_pcm_bytes directly"
            )

        codec_name = info["codec"]
        container_format = info.get("container_format", output_format)
        sample_rate = info["sample_rate"]
        bit_rate = info.get("bit_rate")

        if not _check_codec_available(codec_name):
            raise RuntimeError(
                f"PyAV codec '{codec_name}' not available in this build. "
                f"Cannot encode format '{output_format}'."
            )

        self._buf = io.BytesIO()
        self._container = av.open(self._buf, mode="w", format=container_format)
        self._stream = self._container.add_stream(codec_name, rate=sample_rate)
        if bit_rate:
            self._stream.bit_rate = bit_rate
        self._last_pos = 0

    def encode_chunk(self, tensor) -> bytes:
        """Encode one PCM tensor chunk. Returns encoded bytes (may be empty)."""
        import av

        audio_int16 = (tensor.squeeze().cpu().numpy() * 32767.0).astype("int16")
        frame = av.AudioFrame.from_ndarray(
            audio_int16.reshape(1, -1), format="s16", layout="mono"
        )
        # Use the stream's sample rate — PyAV resamples if needed
        frame.sample_rate = self._stream.codec_context.sample_rate

        for packet in self._stream.encode(frame):
            self._container.mux(packet)

        current_pos = self._buf.tell()
        self._buf.seek(self._last_pos)
        data = self._buf.read()
        self._buf.seek(current_pos)
        self._last_pos = current_pos
        return data

    def finish(self) -> bytes:
        """Flush remaining packets and return the trailer bytes."""
        for packet in self._stream.encode():
            self._container.mux(packet)
        self._container.close()
        self._buf.seek(self._last_pos)
        return self._buf.read()


def encode_stream(generator, output_format: str):
    """Encode a (tensor, is_final) generator to the requested output format.

    Yields bytes chunks. This is the single standard encoder — use it for
    ALL synthesis paths (streaming, offline, preview). Replaces the three
    duplicated encode blocks that were inlined in worker_routes.py.

    For raw formats (wav, pcm, pcm_f32), yields bytes directly from tensors.
    For compressed formats (mp3, opus), uses PyAV incrementally with
    incremental reads from the output buffer.
    """
    info = get_format_info(output_format)

    if info.get("is_raw"):
        if output_format == "wav":
            yield generate_wav_header(info["sample_rate"])
        sample_format = info["sample_format"]
        for tensor, is_final in generator:
            yield tensor_to_pcm_bytes(tensor, sample_format)
        return

    enc = AudioEncoder(output_format)
    for tensor, is_final in generator:
        chunk = enc.encode_chunk(tensor)
        if chunk:
            yield chunk
    trailer = enc.finish()
    if trailer:
        yield trailer