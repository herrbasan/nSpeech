"""
Audio8 TTS Engine Adapter

Audio8-TTS-Preview-0.1b (Audio8) — ~170M Falcon H1 dual-AR (slow semantic /
fast codec branches) + ~120M bundled codec decoder. Zero-shot voice cloning
from reference audio + transcript. Contender to replace Chatterbox Turbo
(~0.3B total vs 350M, much smaller VRAM footprint).

Output: 44.1kHz native codec, resampled to 24kHz mono (nSpeech standard).

Voice model: identical shape to F5-TTS — reference-audio-based, no native
voice catalog:
  <voice_name>.wav         — reference audio (trimmed to ~12s at clone time)
  <voice_name>.audio8.txt  — transcript of the reference audio

Voice "default" omits the reference entirely — Audio8 also supports plain
synthesis without cloning.

BATCH-ONLY generate(): the model card exposes generate() → decode_audio()
with no chunked/streaming decode. Generation yields ONE final tensor. Text
beyond ~2048 packed text/audio positions is not supported by the checkpoint
context — Node-side maxChars (registry.json: 1500) triggers nSpeech
auto-chunking for long-form.

Engine-specific kwargs (via extra_body):
    temperature:    sampling temperature (default 0.7)
    top_p:          nucleus sampling (default 0.9)
    top_k:          top-k sampling (default 50)
    max_new_tokens: cap on generated audio tokens (default: estimated from
                    text length at ~15 chars/s × 21.5 codec frames/s)
    seed:           deterministic generation (best-effort)
"""
import gc
import time
from pathlib import Path
from typing import Tuple, Generator, Dict, Any

import torch
import torchaudio

from nspeech import config

MODEL_IDS = {
    "0.1b": "Audio8/Audio8-TTS-Preview-0.1b",
    "0.6b": "Audio8/Audio8-TTS-Preview-0.6b",
}
NATIVE_SR = 44100
TARGET_SR = 24000
CODEC_FRAMES_PER_SEC = 21.5  # 2048 samples per frame at 44.1kHz
CHARS_PER_SEC = 14.0         # rough speech rate for token-budget estimate


class Audio8Adapter:
    """TTS engine adapter for Audio8 TTS Preview (dual-AR, zero-shot cloning).

    Two switchable registry entries share this adapter and one venv/voice dir:
      audio8     → 0.1b (fast, compact)
      audio8-hd  → 0.6b (better quality, esp. non-zh/en languages)
    Voices (.wav + .audio8.txt) are shared between both variants.
    """

    def __init__(self, engine_name: str = "audio8"):
        self.engine_name = engine_name
        self.model_variant = "0.6b" if engine_name == "audio8-hd" else "0.1b"
        self.model_id = MODEL_IDS[self.model_variant]
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.dtype = torch.bfloat16 if self.device == "cuda" else torch.float32
        self._model = None
        self._processor = None
        # Shared voice dir across variants (clones work on both models).
        self.cache_dir = Path(config.NSPEECH_VOICE_DIR)
        if "audio8" not in str(self.cache_dir):
            raise RuntimeError(
                f"Audio8 voice dir must contain 'audio8', got {self.cache_dir}"
            )
        self.cache_dir.mkdir(parents=True, exist_ok=True)

    def _load(self):
        """Lazy-load model + processor on first request."""
        if self._model is None:
            from transformers import AutoModel, AutoProcessor
            print(f"Loading Audio8 {self.model_variant} ({self.model_id}) on {self.device} ...")
            self._processor = AutoProcessor.from_pretrained(
                self.model_id, trust_remote_code=True
            )
            self._model = (
                AutoModel.from_pretrained(
                    self.model_id, trust_remote_code=True, dtype=self.dtype
                )
                .eval()
                .to(self.device)
            )
            print("Audio8 loaded.")
        return self._model, self._processor

    def _voice_wav_path(self, voice_name: str) -> Path:
        return self.cache_dir / f"{voice_name}.wav"

    def _voice_text_path(self, voice_name: str) -> Path:
        # Shared sidecar extension across variants — a clone works on both.
        return self.cache_dir / f"{voice_name}.audio8.txt"

    def load_voice(self, voice_name: str, **kwargs) -> None:
        """Validate reference audio + transcript exist. 'default' needs nothing."""
        if voice_name == "default":
            return
        wav_path = self._voice_wav_path(voice_name)
        text_path = self._voice_text_path(voice_name)
        if not wav_path.exists():
            raise FileNotFoundError(
                f"Audio8 voice '{voice_name}' missing reference audio: {wav_path}"
            )
        if not text_path.exists():
            raise FileNotFoundError(
                f"Audio8 voice '{voice_name}' missing transcript: {text_path}"
            )

    def _read_ref_text(self, voice_name: str) -> str:
        return self._voice_text_path(voice_name).read_text(encoding="utf-8").strip()

    def generate(self, text: str, **kwargs) -> Generator[Tuple[torch.Tensor, bool], None, None]:
        """Generate speech, batch. Single yield with is_final=True."""
        model, processor = self._load()

        voice_name = kwargs.get("voice_name", "default")
        # Ear tests 2026-08-23: monotone below ~1.0; expressive around 1.3-2.0.
        temperature = kwargs.get("temperature", 1.4)
        top_p = kwargs.get("top_p", 0.9)
        top_k = kwargs.get("top_k", 50)
        seed = kwargs.get("seed")

        # Token budget: enough audio frames to speak the text, with headroom.
        # ~1.5× the exact estimate guards against sampling variance; users can
        # override via extra_body.max_new_tokens.
        est_duration_s = max(len(text) / CHARS_PER_SEC, 1.0)
        max_new_tokens = int(kwargs.get("max_new_tokens") or (est_duration_s * CODEC_FRAMES_PER_SEC * 1.5 + 128))

        if seed is not None:
            torch.manual_seed(seed)

        inputs = processor(text=[text], return_tensors="pt")
        if voice_name != "default":
            ref_wav = str(self._voice_wav_path(voice_name))
            ref_text = self._read_ref_text(voice_name)
            inputs = processor(
                text=[text],
                reference_audio=[ref_wav],
                reference_text=[ref_text],
                return_tensors="pt",
            )
        inputs = {name: value.to(self.device) for name, value in inputs.items()}

        with torch.inference_mode():
            output = model.generate(
                **inputs,
                max_new_tokens=max_new_tokens,
                temperature=temperature,
                top_p=top_p,
                top_k=top_k,
                do_sample=True,
                return_dict_in_generate=True,
            )
            waveforms, waveform_lengths = model.decode_audio(output.codes)

        audio = waveforms[0, : int(waveform_lengths[0])].float().cpu()
        if audio.dim() > 1:
            audio = audio.mean(dim=0)
        if audio.dim() == 0 or audio.numel() == 0:
            raise RuntimeError(
                f"Audio8 produced empty audio for voice '{voice_name}' "
                f"({int(waveform_lengths[0])} samples decoded)"
            )
        audio = audio.unsqueeze(0)  # (1, samples) for Resample
        if NATIVE_SR != TARGET_SR:
            audio = torchaudio.transforms.Resample(NATIVE_SR, TARGET_SR)(audio)

        yield audio.squeeze().float().cpu(), True

    def list_voices(self) -> list:
        """Audio8 has no native voice catalog — all voices are user-created."""
        return []

    def clone(self, audio_path: str, voice_name: str, **kwargs) -> Dict[str, Any]:
        """
        Create a voice from reference audio.
        Saves the reference wav (trimmed to ~12s at a quiet point, mono) and
        the transcript (.audio8.txt sidecar). Auto-transcribes via
        faster-whisper when no prompt_text is given — same proven flow as F5.
        """
        start_time = time.time()

        prompt_text = kwargs.get("prompt_text") or kwargs.get("instruct_text") or ""

        dest_wav = self._voice_wav_path(voice_name)
        if Path(audio_path).resolve() != dest_wav.resolve():
            import shutil
            shutil.copy2(audio_path, dest_wav)

        # Card guidance: very long / noisy references reduce stability and
        # similarity. Trim to ~12s at a low-energy window, force mono.
        import soundfile as sf
        import numpy as np
        data, sr = sf.read(str(dest_wav))
        if data.ndim > 1:
            data = data.mean(axis=1)
        max_samples = 12 * sr
        if len(data) > max_samples:
            window = int(0.05 * sr)
            scan_start = max_samples - int(2 * sr)
            energies = np.array([np.abs(data[i:i + window]).mean()
                                 for i in range(scan_start, max_samples, window)])
            cut_offset = int(energies.argmin()) * window
            data = data[:scan_start + cut_offset + window]
            prompt_text = ""  # trimmed audio — re-transcribe
        sf.write(str(dest_wav), data, sr)

        if not prompt_text:
            from nspeech.transcribe import transcribe
            prompt_text = transcribe(str(dest_wav))

        text_path = self._voice_text_path(voice_name)
        text_path.write_text(prompt_text, encoding="utf-8")

        clone_time_ms = int((time.time() - start_time) * 1000)
        return {
            "voice_name": voice_name,
            "engine": self.engine_name,
            "cache_file": str(text_path),
            "source_file": dest_wav.name,
            "prompt_text": prompt_text,
            "clone_time_ms": clone_time_ms,
        }

    def is_loaded(self) -> bool:
        return self._model is not None

    def unload(self) -> None:
        """Release model weights and free VRAM."""
        self._model = None
        self._processor = None
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
