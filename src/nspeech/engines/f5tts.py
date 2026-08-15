"""
F5-TTS Engine Adapter

Flow-matching + Diffusion Transformer TTS from SWivid (Shanghai AI Lab).
Non-autoregressive — no hallucination/repetition risk. Natural prosody from
flow-matching architecture. Zero-shot voice cloning from 5-15s reference audio.

Output: 24kHz mono (matches nSpeech standard — no resampling needed).

Voice model: all voices are reference-audio-based (ref wav + transcript).
No native voice catalog. The "voice" is a directory containing:
  <voice_name>.wav        — reference audio (5-15s)
  <voice_name>.f5tts.txt  — transcript of the reference audio

F5-TTS does its own text chunking internally (chunk_text with cross-fade),
so we pass full text and yield the complete audio as a single chunk.
"""
import gc
import time
from pathlib import Path
from typing import Tuple, Generator, Dict, Any

import torch
import numpy as np
from nspeech import config


class F5TtsAdapter:
    """TTS engine adapter for F5-TTS (flow-matching, non-autoregressive)."""

    def __init__(self):
        self.engine_name = "f5tts"
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self._model = None
        self.cache_dir = Path(config.NSPEECH_VOICE_DIR)
        self.cache_dir.mkdir(parents=True, exist_ok=True)

    @property
    def model(self):
        """Lazy-load F5-TTS on first request."""
        if self._model is None:
            from f5_tts.api import F5TTS
            print(f"Loading F5-TTS model on {self.device} ...")
            self._model = F5TTS(device=self.device)
            print("F5-TTS loaded.")
        return self._model

    def _voice_wav_path(self, voice_name: str) -> Path:
        return self.cache_dir / f"{voice_name}.wav"

    def _voice_text_path(self, voice_name: str) -> Path:
        return self.cache_dir / f"{voice_name}.{self.engine_name}.txt"

    def load_voice(self, voice_name: str, **kwargs) -> None:
        """Validate that reference audio + transcript exist for this voice."""
        wav_path = self._voice_wav_path(voice_name)
        text_path = self._voice_text_path(voice_name)
        if not wav_path.exists():
            raise FileNotFoundError(
                f"F5-TTS voice '{voice_name}' missing reference audio: {wav_path}"
            )
        if not text_path.exists():
            raise FileNotFoundError(
                f"F5-TTS voice '{voice_name}' missing transcript: {text_path}"
            )

    def _read_ref_text(self, voice_name: str) -> str:
        text_path = self._voice_text_path(voice_name)
        return text_path.read_text(encoding="utf-8").strip()

    def generate(self, text: str, **kwargs) -> Generator[Tuple[torch.Tensor, bool], None, None]:
        """
        Generate speech from text using F5-TTS flow-matching.

        F5-TTS handles its own text chunking internally (with cross-fade between
        chunks), so we pass the full text and yield the complete result as one
        chunk. This preserves prosody continuity across sentence boundaries.

        Engine-specific kwargs:
            nfe_step: ODE steps (default 32). 16=faster, 64=audiobook quality.
            speed: duration divisor (default 1.0). 0.8 = 25% longer/slower.
            cfg_strength: guidance strength (default 2.0).
            sway_sampling_coef: variation sampling, -1=off (default -1).
            cross_fade_duration: chunk cross-fade seconds (default 0.15).
            target_rms: loudness normalization target (default 0.1).
            seed: deterministic generation (default None = random).
        """
        voice_name = kwargs.get("voice_name", "default")
        nfe_step = kwargs.get("nfe_step", kwargs.get("inference_steps", 32))
        speed = kwargs.get("speed", 1.0)
        seed = kwargs.get("seed")
        cfg_strength = kwargs.get("cfg_strength", 2.0)
        sway_sampling_coef = kwargs.get("sway_sampling_coef", -1)
        cross_fade_duration = kwargs.get("cross_fade_duration", 0.15)
        target_rms = kwargs.get("target_rms", 0.1)

        wav_path = str(self._voice_wav_path(voice_name))
        ref_text = self._read_ref_text(voice_name)

        wav, sr, _ = self.model.infer(
            ref_file=wav_path,
            ref_text=ref_text,
            gen_text=text,
            nfe_step=nfe_step,
            speed=speed,
            seed=seed,
            cfg_strength=cfg_strength,
            sway_sampling_coef=sway_sampling_coef,
            cross_fade_duration=cross_fade_duration,
            target_rms=target_rms,
            file_wave=None,
            file_spec=None,
        )

        # F5-TTS outputs numpy float32 at 24kHz mono — already nSpeech standard.
        pcm = torch.from_numpy(wav).float().cpu().flatten()
        yield pcm, True

    def list_voices(self) -> list:
        """F5-TTS has no native voice catalog — all voices are user-created."""
        return []

    def clone(self, audio_path: str, voice_name: str, **kwargs) -> Dict[str, Any]:
        """
        Create a voice from reference audio.
        Saves the reference wav and auto-transcribes it for the transcript.

        F5-TTS needs an accurate transcript of the reference audio for best
        quality. If prompt_text is provided, use it; otherwise auto-transcribe.
        """
        start_time = time.time()

        prompt_text = kwargs.get("prompt_text") or kwargs.get("instruct_text") or ""

        # Copy reference audio to voice directory. The Node clone route writes
        # the wav to the target path BEFORE calling clone() — skip the copy
        # when source and destination are the same file.
        dest_wav = self._voice_wav_path(voice_name)
        if Path(audio_path).resolve() != dest_wav.resolve():
            import shutil
            shutil.copy2(audio_path, dest_wav)

        # F5-TTS clips reference audio to ~12s internally. If the stored wav is
        # longer, the transcript no longer matches the clipped audio and the
        # chars/sec rate estimate distorts (fast speech, oscillating pace).
        # Trim to 12s (at a low-energy point to avoid cutting mid-phoneme),
        # resample to 24kHz mono, and re-transcribe if no prompt given.
        import soundfile as sf
        import numpy as np
        data, sr = sf.read(str(dest_wav))
        if data.ndim > 1:
            data = data.mean(axis=1)
        max_samples = 12 * sr
        if len(data) > max_samples:
            # Find the quietest 50ms window near the 12s mark to cut cleanly
            window = int(0.05 * sr)
            scan_start = max_samples - int(2 * sr)
            scan_end = max_samples
            energies = np.array([np.abs(data[i:i+window]).mean() for i in range(scan_start, scan_end, window)])
            cut_offset = int(energies.argmin()) * window
            data = data[:scan_start + cut_offset + window]
            prompt_text = ""  # force re-transcribe of the trimmed audio
        if sr != 24000:
            from scipy.signal import resample
            data = resample(data, int(len(data) * 24000 / sr)).astype("float32")
            sr = 24000
        sf.write(str(dest_wav), data, sr)

        if not prompt_text:
            from nspeech.transcribe import transcribe
            prompt_text = transcribe(str(dest_wav))

        # Save transcript
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
        """Release F5-TTS model and free VRAM."""
        self._model = None
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
