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

STREAMING generate(): text is split with the library's own chunk_text()
(~135-char batches on sentence boundaries), all batches are submitted to the
ThreadPoolExecutor upfront (GPU-parallel, same speed as the batch path), and
each batch is yielded the moment it completes — cross-faded against the held
back tail of the previous batch. First audio after ~1 batch (~1-2s) instead
of after the full render.
"""
import gc
import os
import time
from pathlib import Path
from typing import Tuple, Generator, Dict, Any

import torch
import torchaudio
import numpy as np
from nspeech import config
from f5_tts.model.utils import seed_everything

# German markers for zero-dep language detection: umlauts/ß are near-decisive;
# common function words break ties on short/umlaut-free texts.
_DE_WORDS = frozenset(
    "der die das und nicht ist ein eine einer eines den dem des mit für auf aus "
    "bei nach über unter vor durch gegen um am im an sich auch noch nur schon "
    "wie was wer wann wo von zu da aber oder wenn dann dass hat kann muss will".split()
    # NOTE: several of these collide with English ("as", "in", "an", "at",
    # "no", "so", "it", "hat", "can", "will") — only the unambiguous ones score.
)
_DE_ONLY = frozenset(
    "der die das und nicht ist ein eine einer eines den dem des für über unter "
    "durch gegen sich auch noch schon dass kann muss".split()
)
_EN_WORDS = frozenset(
    "the and of to in is was are were be been has have had that this these those "
    "with for on at as but not you they there where when what which".split()
)


def detect_language(text: str) -> str:
    """Detect 'de' vs 'en' for narration text. Umlauts/ß are near-decisive;
    otherwise score unambiguous function words. English wins ties (base model)."""
    low = text.lower()
    if "ä" in low or "ö" in low or "ü" in low or "ß" in low:
        return "de"
    words = low.replace(",", " ").replace(".", " ").replace("!", " ").replace("?", " ").split()
    de = sum(1 for w in words if w in _DE_ONLY)
    en = sum(1 for w in words if w in _EN_WORDS)
    return "de" if de > en else "en"



def _ensure_bigvgan_config(model_name: str) -> None:
    """Create configs/<model>.yaml for bigvgan variants when the installed
    f5_tts version doesn't ship it (identical to F5TTS_Base.yaml with
    mel_spec_type: bigvgan). Self-heals after a venv reinstall."""
    import f5_tts.api
    cfg_path = Path(f5_tts.api.__file__).parent / "configs" / f"{model_name}.yaml"
    if cfg_path.exists():
        return
    base = cfg_path.parent / "F5TTS_Base.yaml"
    text = base.read_text(encoding="utf-8")
    patched = text.replace("mel_spec_type: vocos", "mel_spec_type: bigvgan")
    if patched == text:
        raise RuntimeError(f"F5TTS_Base.yaml does not contain 'mel_spec_type: vocos' — cannot derive {model_name}.yaml")
    cfg_path.write_text(patched, encoding="utf-8")
    print(f"Synthesized {cfg_path.name} (bigvgan variant of F5TTS_Base.yaml)")


class F5TtsAdapter:
    """TTS engine adapter for F5-TTS (flow-matching, non-autoregressive)."""

    def __init__(self):
        self.engine_name = os.environ.get("NSPEECH_ENGINE", "f5tts")
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        # Bilingual: one checkpoint per language, lazy-loaded, both resident.
        # 'en' → base F5TTS_v1_Base; 'de' → German fine-tune (NSPEECH_F5_CKPT_DE).
        # The explicit f5tts-german registry engine pins NSPEECH_F5_MODEL/CKPT
        # and uses only that checkpoint.
        self._models = {}
        self.cache_dir = Path(config.NSPEECH_VOICE_DIR)
        self.cache_dir.mkdir(parents=True, exist_ok=True)

    @property
    def model(self):
        """Default model (back-compat: single-model engines / explicit override)."""
        return self._get_model("en")

    def _get_model(self, lang: str):
        """Lazy-load the checkpoint for a language. Both stay resident
        (~1.35GB each) — no reload penalty when language switches per request.

        Env overrides (set per-engine in registry.json):
          NSPEECH_F5_MODEL    — explicit engine: model config name (pins single model)
          NSPEECH_F5_CKPT     — explicit engine: local checkpoint path
          NSPEECH_F5_MODEL_DE — bilingual engine: German model config
                                 (F5TTS_Base = vocos, F5TTS_Base_bigvgan = bigvgan)
          NSPEECH_F5_CKPT_DE  — bilingual engine: German checkpoint path
        """
        if lang in self._models:
            return self._models[lang]
        from f5_tts.api import F5TTS
        kwargs = {"device": self.device}
        if os.environ.get("NSPEECH_F5_MODEL"):
            # Explicit engine (f5tts-german): pinned single checkpoint.
            if os.environ.get("NSPEECH_F5_CKPT"):
                kwargs["ckpt_file"] = os.environ["NSPEECH_F5_CKPT"]
            kwargs["model"] = os.environ["NSPEECH_F5_MODEL"]
            label = kwargs["model"]
        elif lang == "de" and os.environ.get("NSPEECH_F5_CKPT_DE"):
            kwargs["model"] = os.environ.get("NSPEECH_F5_MODEL_DE", "F5TTS_Base")
            kwargs["ckpt_file"] = os.environ["NSPEECH_F5_CKPT_DE"]
            label = f"{kwargs['model']} + German ckpt"
        else:
            label = "F5TTS_v1_Base"  # base HF download
        if str(kwargs.get("model", "")).endswith("_bigvgan"):
            _ensure_bigvgan_config(kwargs["model"])
        print(f"Loading F5-TTS [{lang}] on {self.device} ({label}) ...")
        m = F5TTS(**kwargs)
        print(f"F5-TTS [{lang}] loaded.")
        self._models[lang] = m
        return m

    def preload(self):
        """Warm all checkpoints this engine will use (NSPEECH_PRELOAD_MODEL
        startup path). Bilingual f5tts loads BOTH en+de so the first request in
        either language doesn't pay the ~10-30s model load. Explicit single-
        checkpoint engines (f5tts-german) load their pinned model only."""
        if os.environ.get("NSPEECH_F5_CKPT_DE") and not os.environ.get("NSPEECH_F5_MODEL"):
            self._get_model("en")
            self._get_model("de")
        else:
            # Pinned engine (NSPEECH_F5_MODEL set) or no German ckpt: one model.
            self._get_model("en")

    def _voice_wav_path(self, voice_name: str) -> Path:
        return self.cache_dir / f"{voice_name}.wav"

    def _voice_text_path(self, voice_name: str) -> Path:
        # Fixed family suffix so voices (wav + transcript sidecar) are shared
        # across f5tts and f5tts-german — same voice dir, same sidecar names.
        return self.cache_dir / f"{voice_name}.f5tts.txt"

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
        Generate speech from text using F5-TTS flow-matching, STREAMING.

        Text is split with the library's chunk_text() (identical split to the
        batch path), batches are rendered SEQUENTIALLY, and each batch is
        yielded the moment it is rendered — cross-faded against the held-back
        tail of the previous batch. Audio starts flowing after the first
        batch (~1-2s). (Upfront threadpool submission does NOT lower TTFB:
        one CUDA context time-slices all concurrent batches, so every future
        completes at total-render time — chunks arrive together at the end.)

        Cross-fade increments are yielded with the HEAD of the next yield (the
        join exists only once both sides exist), so joins are never re-sent.

        Engine-specific kwargs:
            nfe_step: ODE steps (default 32). 16=faster, 64=audiobook quality.
            speed: duration divisor (default 1.0). 0.8 = 25% longer/slower.
            cfg_strength: guidance strength (default 2.5; user-tuned 2026-08-18 —
                2.5 tightens the 'scattered' timbre vs 1.5).
            sway_sampling_coef: variation sampling (default -0.5; user-tuned
                2026-08-18 — audibly smoother than -1).
            cross_fade_duration: chunk cross-fade seconds (default 0.15).
            target_rms: loudness normalization target (default 0.1).
            seed: deterministic generation (default None = random).
        """
        from f5_tts.infer.utils_infer import (
            chunk_text as f5_chunk_text,
            preprocess_ref_audio_text,
        )

        voice_name = kwargs.get("voice_name", "default")
        nfe_step = kwargs.get("nfe_step", kwargs.get("inference_steps", 64))
        speed = kwargs.get("speed", 0.9)
        seed = kwargs.get("seed")
        sway_sampling_coef = kwargs.get("sway_sampling_coef", -0.5)
        cross_fade_duration = kwargs.get("cross_fade_duration", 0.15)
        target_rms = kwargs.get("target_rms", 0.1)

        wav_path, ref_text = str(self._voice_wav_path(voice_name)), self._read_ref_text(voice_name)
        # Language routing: explicit extra_body.language wins; else detect.
        lang = (kwargs.get("extra_body") or {}).get("language") or detect_language(text)
        # cfg defaults differ per model family (user-tuned by ear):
        #  - EN v1 base: 2.5 (tightens 'scattered' timbre vs 1.5, 2026-08-18)
        #  - DE fine-tune (older F5TTS_Base arch): 1.5 — 2.5 over-guides and
        #    sounds metallic (user verdict 2026-08-29)
        cfg_strength = kwargs.get("cfg_strength", 1.5 if lang == "de" else 2.5)
        m = self._get_model(lang)
        if seed is not None:
            seed_everything(seed)
        else:
            seed_everything(torch.randint(0, 2**31 - 1, (1,)).item())
        ref_file, ref_text = preprocess_ref_audio_text(wav_path, ref_text)
        audio, sr = torchaudio.load(ref_file)
        if audio.shape[0] > 1:
            audio = torch.mean(audio, dim=0, keepdim=True)

        # Loudness normalization of the reference (identical to infer_batch_process)
        rms = torch.sqrt(torch.mean(torch.square(audio)))
        if rms < target_rms:
            audio = audio * target_rms / rms
        if sr != 24000:
            audio = torchaudio.transforms.Resample(sr, 24000)(audio)
        audio = audio.to(self.device)

        if len(ref_text[-1].encode("utf-8")) == 1:
            ref_text = ref_text + " "

        # Same batch split the library's batch path uses (ref-length-derived
        # max_chars, sentence boundaries, rolling suffix).
        audio_dur = audio.shape[-1] / 24000
        max_chars = int(len(ref_text.encode("utf-8")) / audio_dur * (22 - audio_dur) * speed)
        batches = f5_chunk_text(text, max_chars=max_chars)

        from f5_tts.model.utils import convert_char_to_pinyin

        hop = 256
        ref_len_frames = audio.shape[-1] // hop
        ref_text_len = max(len(ref_text.encode("utf-8")), 1)

        def infer_batch(gen_text: str) -> np.ndarray:
            """One batch render — same math as _infer_basic()."""
            local_speed = 0.3 if len(gen_text.encode("utf-8")) < 10 else speed
            text_list = [ref_text + gen_text]
            final_text_list = convert_char_to_pinyin(text_list)
            gen_len = len(gen_text.encode("utf-8"))
            duration = ref_len_frames + int(ref_len_frames / ref_text_len * gen_len / local_speed)
            with torch.inference_mode():
                generated, _ = m.ema_model.sample(
                    cond=audio,
                    text=final_text_list,
                    duration=duration,
                    steps=nfe_step,
                    cfg_strength=cfg_strength,
                    sway_sampling_coef=sway_sampling_coef,
                )
                generated = generated.to(torch.float32)  # fp16 mel → fp32 for vocoder
                mel = generated[:, ref_len_frames:, :].permute(0, 2, 1)
                # vocos exposes .decode(mel); bigvgan is a forward call
                wave = m.vocoder.decode(mel) if m.mel_spec_type == "vocos" else m.vocoder(mel)
                if rms < target_rms:
                    wave = wave * rms / target_rms
                arr = wave.squeeze().cpu().numpy()
                # BigVGAN runs hotter than vocos — peak-limit to avoid
                # hard clipping distortion downstream (s16 conversion).
                peak = np.abs(arr).max()
                if peak > 0.95:
                    arr = arr * 0.95 / peak
                return arr

        # SEQUENTIAL batch loop. A naive "submit all upfront" pipeline does
        # NOT lower TTFB: all batches share one CUDA context, the GPU
        # time-slices kernels round-robin, and every future completes at
        # roughly the total render time — chunks arrive together at the end.
        # Sequential = batch i is yielded the moment it is rendered.
        fade_samples = int(cross_fade_duration * 24000)
        held_tail = None  # tail of the previous batch, reserved for the next join
        for idx, gen_text_i in enumerate(batches):
            wave = infer_batch(gen_text_i)
            is_last = idx == len(batches) - 1

            if held_tail is not None:
                # Join: fade-out held tail + fade-in new head, then this
                # join rides with the current yield (sent exactly once).
                xf = min(fade_samples, len(held_tail), len(wave))
                if xf > 0:
                    t = np.linspace(0, 1, xf)
                    joined = held_tail[-xf:] * (1 - t) + wave[:xf] * t
                    out = np.concatenate([joined, wave[xf:]])
                else:
                    out = wave
            else:
                out = wave

            if is_last:
                yield torch.from_numpy(out).float().cpu().flatten(), True
            else:
                hold = min(fade_samples, len(out) // 2)
                yield torch.from_numpy(out[:-hold]).float().cpu().flatten(), False
                held_tail = out[len(out) - hold:]

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
        return len(self._models) > 0

    def unload(self) -> None:
        """Release F5-TTS models and free VRAM."""
        self._models = {}
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
