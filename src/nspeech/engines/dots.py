"""
dots.tts TTS Engine Adapter
Implements zero-shot voice cloning via dots.tts (2B fully continuous AR TTS).

dots.tts is architecturally different from CosyVoice/Chatterbox:
- No embedding extraction. Voice identity comes from a CAM++ x-vector computed
  at inference time from reference audio.
- The reference audio + transcript are passed to EVERY generate() call.
- Voice "cache" = a JSON sidecar storing {prompt_audio_path, prompt_text}.
  No .pt embedding file — the .wav IS the voice.

Three checkpoints share the same backbone:
- dots.tts-base  (10-32 NFE, default 10)
- dots.tts-soar  (10-32 NFE, best cloning quality)
- dots.tts-mf    (4 NFE, MeanFlow distilled, fastest — default for nSpeech)

Output is 48 kHz. Adapter resamples to 24 kHz mono float32 to match nSpeech standard.

Adapter conventions:
- generate(): yields (pcm_tensor, is_final) per sentence chunk
- clone(): saves reference wav + transcript as JSON sidecar voice cache
- load_voice(): validates reference exists, loads prompt_audio_path + prompt_text
"""
import json
import os
import shutil
import time
from pathlib import Path

import soundfile
import torch
import torchaudio
from nspeech import config


class DotsAdapter:
    """TTS engine adapter for dots.tts."""

    def __init__(self):
        self.engine_name = "dots"

        model_dir = Path(config.NSPEECH_MODEL_DIR)
        dots_repo_dir = model_dir / "dots.tts"

        if not dots_repo_dir.exists():
            raise FileNotFoundError(
                f"dots.tts repo not found at {dots_repo_dir}\n"
                f"Run: python install.py install --engine dots --models"
            )

        import sys
        if str(dots_repo_dir / "src") not in sys.path:
            sys.path.insert(0, str(dots_repo_dir / "src"))
        if str(dots_repo_dir) not in sys.path:
            sys.path.insert(0, str(dots_repo_dir))

        # Default to MeanFlow distilled (4 NFE) for speed.
        checkpoint = os.environ.get(
            "NSPEECH_DOTS_CHECKPOINT",
            "rednote-hilab/dots.tts-mf"
        )
        self._checkpoint_map = {
            "base": "rednote-hilab/dots.tts-base",
            "soar": "rednote-hilab/dots.tts-soar",
            "mf": "rednote-hilab/dots.tts-mf",
        }
        self._repo_id = self._checkpoint_map.get(checkpoint, checkpoint)

        self._runtime = None
        self.native_sample_rate = None
        self._resampler = None

        self.cache_dir = Path(config.NSPEECH_VOICE_DIR)
        self.cache_dir.mkdir(parents=True, exist_ok=True)

        self._current_voice = None
        self._prompt_audio_path = None
        self._prompt_text = None

    @property
    def runtime(self):
        """Lazy-load the dots.tts model on first request."""
        if self._runtime is None:
            print(f"Loading dots.tts model: {self._repo_id} ...")
            from dots_tts.runtime import DotsTtsRuntime
            # optimize=True requires Triton (torch.compile) which has no Windows wheels.
            # Disable on Windows; enable on Linux if Triton is available.
            import platform
            _optimize = platform.system() == "Linux"
            self._runtime = DotsTtsRuntime.from_pretrained(
                self._repo_id,
                precision="bfloat16",
                optimize=_optimize,
            )
            self.native_sample_rate = self.runtime_sample_rate
            if self.native_sample_rate != 24000:
                self._resampler = torchaudio.transforms.Resample(
                    self.native_sample_rate, 24000
                )
            print(f"dots.tts loaded: sample_rate={self.native_sample_rate}")
        return self._runtime

    @property
    def runtime_sample_rate(self):
        return self._runtime.sample_rate

    def load_voice(self, voice_name, **kwargs):
        cache_path = self.cache_dir / f"{voice_name}.{self.engine_name}.json"
        if not cache_path.exists():
            raise FileNotFoundError(f"Voice cache not found: {voice_name}")

        with open(cache_path, "r", encoding="utf-8") as f:
            voice_data = json.load(f)

        prompt_audio = voice_data.get("prompt_audio_path", "")
        if prompt_audio and not Path(prompt_audio).exists():
            raise FileNotFoundError(
                f"Reference audio for voice '{voice_name}' not found: {prompt_audio}"
            )

        self._current_voice = voice_name
        self._prompt_audio_path = prompt_audio if prompt_audio else None
        self._prompt_text = voice_data.get("prompt_text")

    def _transcribe(self, audio_path):
        """Auto-transcribe reference audio via nVoice STT service."""
        stt_url = os.environ.get("NSPEECH_STT_URL", "")
        if not stt_url:
            print("No STT_URL configured — skipping transcription.")
            return ""
        try:
            import ssl
            import urllib.request
            with open(audio_path, "rb") as f:
                audio_bytes = f.read()
            url = stt_url.rstrip("/") + "/transcribe"
            req = urllib.request.Request(
                url,
                data=audio_bytes,
                headers={"Content-Type": "application/octet-stream"},
            )
            # Allow self-signed certs for local STT service
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            import json as _json
            with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
                result = _json.loads(resp.read())
            segments = result.get("segments", [])
            text = " ".join(s.get("text", "") for s in segments).strip()
            print(f"STT transcription: {text[:80]}...")
            return text
        except Exception as e:
            print(f"STT transcription failed: {e}")
            return ""

    def clone(self, audio_path, voice_name, **kwargs):
        start_time = time.time()

        # dots.tts doesn't extract embeddings — the reference audio IS the voice.
        # We save a copy of the reference wav and a JSON sidecar with the transcript.
        prompt_text = kwargs.get("prompt_text") or kwargs.get("instruct_text") or ""

        # Auto-transcribe with Whisper if no prompt_text provided.
        # dots.tts continuation cloning needs the transcript for best quality.
        if not prompt_text:
            prompt_text = self._transcribe(audio_path)

        dest_wav = self.cache_dir / f"{voice_name}.wav"

        # dots.tts runtime uses librosa.load() internally, which on Windows
        # uses audioread and fails on certain WAV formats. Pre-resample to
        # 24kHz mono 16-bit using soundfile — reliable across platforms.
        import soundfile as sf
        try:
            data, sr = sf.read(str(audio_path))
        except Exception as e:
            raise RuntimeError(f"Cannot read audio for voice clone: {e}")
        if data.ndim > 1:
            data = data.mean(axis=1)
        target_sr = 24000
        if sr != target_sr:
            import numpy as np
            from scipy.signal import resample
            num_samples = int(len(data) * target_sr / sr)
            data = resample(data, num_samples).astype("float32")
        sf.write(str(dest_wav), data, target_sr, subtype="PCM_16")

        cache_path = self.cache_dir / f"{voice_name}.{self.engine_name}.json"
        voice_data = {
            "voice_name": voice_name,
            "engine": self.engine_name,
            "prompt_audio_path": str(dest_wav),
            "prompt_text": prompt_text,
        }
        with open(cache_path, "w", encoding="utf-8") as f:
            json.dump(voice_data, f, indent=2)

        self._current_voice = voice_name
        self._prompt_audio_path = str(dest_wav)
        self._prompt_text = prompt_text

        clone_time_ms = int((time.time() - start_time) * 1000)
        return {
            "voice_name": voice_name,
            "engine": self.engine_name,
            "cache_file": str(cache_path),
            "source_file": dest_wav.name,
            "prompt_text": prompt_text,
            "clone_time_ms": clone_time_ms,
        }

    def generate(self, text, voice_name=None, instruct_text=None, language=None,
                 speed=None, exaggeration=None, model=None, **kwargs):
        # Resolve voice
        if voice_name and voice_name != "default" and voice_name != self._current_voice:
            self.load_voice(voice_name)

        # Allow checkpoint override per-request via model param
        # (requires reloading runtime — expensive, so only if different)
        num_steps = kwargs.get("steps", kwargs.get("num_steps", 4))
        guidance_scale = kwargs.get("guidance_scale", 1.2)
        seed = kwargs.get("seed", 42)
        offline = kwargs.get("offline", False)

        # Set seed for deterministic prosody variation
        if seed is not None:
            torch.manual_seed(seed)
            if torch.cuda.is_available():
                torch.cuda.manual_seed_all(seed)

        prompt_audio = self._prompt_audio_path
        # Audio-ONLY conditioning by default (prompt_text=None).
        # dots.tts continuation-prefill requires the transcript to EXACTLY match
        # the reference audio; any mismatch corrupts conditioning and makes EOS
        # fire after 0-2 patches (near-empty/garbled output). We can't verify a
        # transcript without reliable STT, so audio-only is the reliable path.
        # The matched-transcript prefill can be re-enabled when transcript
        # verification (nVoice STT) is available and trusted.
        prompt_text = None

        if offline:
            # Non-streaming mode: generate the entire audio in one pass.
            result = self.runtime.generate(
                text=text,
                prompt_audio_path=prompt_audio if prompt_audio else None,
                prompt_text=None,
                num_steps=num_steps,
                guidance_scale=guidance_scale,
            )
            audio = result["audio"]  # shape (1, samples) at native rate
            pcm = audio.detach().float().cpu()
            if pcm.dim() > 1:
                pcm = pcm.squeeze(0)
            if self.native_sample_rate != 24000:
                pcm = self._resampler(pcm.unsqueeze(0)).squeeze(0)
            yield pcm, True
            return

        # Streaming mode: dots.tts yields audio patches continuously.
        # We do NOT sentence-chunk the input — splitting at sentence
        # boundaries causes audible gaps between sentences.
        stream = self.runtime.generate_stream(
            text=text,
            prompt_audio_path=prompt_audio if prompt_audio else None,
            prompt_text=None,
            num_steps=num_steps,
            guidance_scale=guidance_scale,
        )

        for chunk in stream:
            # chunk is torch.Tensor shape (1, samples) at native sample rate
            pcm = chunk.detach().float().cpu()
            if pcm.dim() > 1:
                pcm = pcm.squeeze(0)
            # Resample 48kHz -> 24kHz per patch. The FIR filter's edge support is
            # ~50 samples vs ~7300 samples/patch, so boundary transients are
            # sub-percent — far better than the prompt-text mismatch blip. True
            # overlap-add streaming resample can be added later if needed.
            if self.native_sample_rate != 24000:
                pcm = self._resampler(pcm.unsqueeze(0)).squeeze(0)
            yield pcm, False

    def list_voices(self) -> list:
        """dots.tts has no native voice catalog — all voices are user-cloned.
        Return [] so the worker falls through to its directory-scan fallback."""
        return []


# end of DotsAdapter
