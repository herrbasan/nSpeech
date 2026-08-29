# Engine Trials & Retirements — Findings Record

Verdicts and root causes for engines evaluated and retired from nSpeech.
Purpose: prevent re-trials of known-dead ends; preserve what was learned.
Companion to the activity log in [Agents.md](../Agents.md).

**Retired 2026-08-29 — F5-TTS made them redundant.**
Active local engines after cleanup: kokoro (always-resident CPU), chatterbox-turbo
(stable EN alternative), f5tts (bilingual EN/DE primary), f5tts-german (explicit DE).

---

## dots.tts — retired 2026-08-29 (abandoned 2026-07-15)

2B fully-continuous AR, CAM++ x-vector cloning. RedNote.

- **VRAM:** 4-8GB — exceeds the TTS budget outright.
- **Speed:** slow TTFA.
- **Quality:** variable per sentence (sometimes excellent, sometimes poor).
- **Fix attempts (2026-07-15):** `inference_steps` param name mismatch fixed;
  first-chunk transient padding fix failed (tensor mismatch with `soar` ckpt);
  `mf`→`soar` checkpoint switch failed (shape differences). All rolled back.
- **Verdict:** mentally abandoned 2026-07-15, registry entry removed 2026-08-29.
- **Adapter:** `src/nspeech/engines/dots.py` (deleted), venv `venv/dots/` (reclaimable, ~GBs).

## Audio8 (0.1B + 0.6B) — retired 2026-08-29 (parked 2026-08-23)

~170M/700M Falcon-H1 dual-AR. Full integration existed (adapters, registry,
dashboard, clone pipeline with `.audio8.txt` sidecars).

- **Speed: 1.6–1.9× real-time warm** — fails the ≥5× usability bar hard.
  Structural, not fixable by config: Python-loop dual-AR (~230 steps/s of audio:
  1 slow step + 10 sequential fast-AR codebook steps), kernel-launch-bound
  (GPU and CPU both idle). `torch.compile` no help (no Triton on the stack).
  Audio8's own CLI uses the same path — no faster engine upstream.
- **Quality:** stable, good timbre replication, **monotone**. Expressive only at
  temperature ≥1.5; even at 2.5 "just passable". Prosody comes only from
  sampling entropy — timbre clones, delivery doesn't.
- **Windows blocker:** no mamba-ssm/causal-conv1d wheels for py3.13/torch 2.11 →
  naive Mamba fallback. Retest possible on Linux.
- **Verdict:** not usable. Probes kept: `scripts/probe-audio8-compile.py`,
  `scripts/profile-audio8.py`, `scripts/smoke-audio8.py`.

## IndexTTS-2 — retired 2026-08-29 (never integrated)

Standalone smoke only (`_Archive/smoke-indextts2.py`); never reached adapter stage.
- **Speed:** very slow.
- **Quality:** not good at our task (user verdict).
- `venv/indextts/` evaluation repo deleted 2026-08-29 (19.6 GB).

## Chatterbox eng (500M) & mtl (500M, 23 langs) — retired 2026-08-29

- **turbo (350M, EN):** KEEPS. "Fast and better than expected" — stable EN
  alternative to F5, paralinguistic tags, exaggeration param.
- **eng:** didn't deliver what was needed vs turbo (user verdict).
- **mtl:** multilingual coverage didn't deliver either — German quality gap
  was the driver, and mtl didn't close it. F5-German now owns DE.
- Shared venv `venv/chatterbox/` stays (turbo uses it); voice dirs
  `venv/chatterbox-eng|mtl/voices` reclaimable if distinct.

---

## Cross-cutting lessons (the pattern that decides trials)

1. **Where does prosody come from?** Engines that clone *timbre* but generate
   *delivery* from their own sampling entropy (Audio8, VibeVoice, Fish S2)
   keep losing to F5, which inherits both from the reference register.
   Check this before benchmarking speed.
2. **≥5× real-time or unusable** (user bar). Dual-AR Python loops never reach it.
3. **VRAM budget is 4-6GB** alongside Gemma's 12GB + STT's ~1GB.
4. **Metallic sheen ≠ vocoder by default.** Sweep cfg_strength first —
   over-guidance on weaker fine-tunes sounds exactly like a vocoder artifact
   (F5-German at cfg 2.5 → metallic; cfg 1.5 → clean).
