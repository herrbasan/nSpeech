# Handover — 2026-08-16 — F5-TTS & VibeVoice Engines, Markdown Cleaner

## What landed

### F5-TTS engine — new primary GPU engine
- **User verdict: "fast and better than Chatterbox"**
- Full integration: adapter, venv (`venv/f5tts`), dashboard pages (generate + voices), E2E verified
- Render speed: ~4-7× real-time on RTX 4090 (nfe_step=32)
- VRAM: ~1-2GB — fits 4GB TTS budget alongside Kokoro

**Critical F5-TTS knowledge (hard-won):**
- Ref audio is clipped to ~12s internally. If stored ref is longer, the transcript mismatches → chars/sec rate estimate inflates → fast, oscillating speech.
- `clone()` now auto-trims to ~12s at a silence boundary, resamples to 24kHz, re-transcribes with faster-whisper.
- `speed` is a **duration divisor** (0.8 = 25% longer), not playback rate.
- Monotone output = monotone reference. The reference's prosody register transfers.
- Tunables via `extra_body`: `speed`, `nfe_step`, `cfg_strength`, `sway_sampling_coef`, `seed`.

### VibeVoice engine — parked
- Works, E2E verified, multi-speaker via `extra_body.voices: {1: "Alice", 2: "Bob"}`
- **User verdict: "ok, but nothing special in terms of feeling natural"**
- Batch-only, no streaming. 65K token context. ~4-6GB VRAM (exceeds TTS budget if another GPU engine resident).
- flash-attn unavailable on Windows → sdpa default. Opt-in: `NSPEECH_VIBEVOICE_ATTN=flash_attention_2`.
- Model at `venv/vibevoice/models/VibeVoice` (5GB, git LFS clone).

### Markdown cleaner (`server/markdown-clean.js`)
- `extra_body.markdown: true` — regex: strips frontmatter, images, code, URLs, HTML, formatting. Headers get trailing period. Italic → em-dash (prosodic stress).
- `extra_body.markdown: 'llm'` — LLM rewrite via local gateway (Gemma 4). Better emphasis/metadata. Fails loud if gateway down.
- Config: `GATEWAY_API_KEY` in .env, `gatewayUrl`/`gatewayModel` in config.js (defaults: `http://192.168.0.100:3400`, `badkid-llama-chat`).

### Bug fixes (found during E2E)
- `tts.py`: explicit `ADAPTER_CLASSES` map — `f5tts.title()` ≠ `F5TtsAdapter`
- `worker_routes.py` preview: `cache_dir` restored before `generate()` consumed → FileNotFoundError for lazy-reading engines (F5-TTS)
- `worker_routes.py` preview: `voice_name` not passed to `generate()` — F5-TTS resolves by name
- `f5tts.py` clone: skip `shutil.copy2` when src==dest (Node pre-writes wav)
- `vibevoice.py`: script format strictly `Speaker N: text` (numeric IDs)
- `worker_routes.py` voice listing: F5-TTS voices require `.f5tts.txt` sidecar
- VibeVoice generate page: preserve selections across speaker-selector rebuilds, validate all speakers have voices

## Commits

```
241d09f Markdown cleaner (regex + LLM) + F5/VibeVoice improvements
d95fec0 F5-TTS: full parameter UI + clone normalization + faster-whisper
bfb0bc2 VibeVoice multi-speaker: per-speaker voice selection
5af24f6 F5-TTS & VibeVoice dashboard pages + preview/clone fixes
4b07256 Agents.md: document F5-TTS & VibeVoice engines
17af52f F5-TTS & VibeVoice engines: fix + install + E2E verified
```

## Current state

**Engines installed and working:** Kokoro, Chatterbox Turbo/Eng/Mtl, F5-TTS, VibeVoice, MiniMax, ElevenLabs, Gemini, xAI, STT (transcription + alignment).

**Dashboard pages exist for:** all engines (generate + voices each).

**Test renders in `logs/vibevoice_test/`:**
- `f5tts-corset.wav` — The Intellectual Corset (8:13, Melon voice)
- `f5tts-ghost-full.wav` — Ghost article (13:31, Melon voice)
- `dialogue-kimi-deepseek.wav` — VibeVoice 2-speaker (41.7s)
- `parkinglot-part1.wav` — VibeVoice longer dialogue (2:45)
- Various F5-TTS parameter sweep files

**Render scripts:**
- `scripts/render-f5tts.py <text|md> <out.wav> [voice] [nfe_step] [speed]` — markdown cleaning built in for .md
- `scripts/render-vibevoice.py <script.txt> <out.wav> [voice1] [voice2]`

## Open items

1. **Stream stall timeout** — 30s fixed timeout in `server/engine/worker.js` kills batch engines on long renders through Node. VibeVoice always hits this on anything substantial; F5-TTS hits it for article-length texts through the Node path (direct worker access is fine). Fix: per-engine `streamTimeoutMs` in registry.json, or a heartbeat from the worker during long generation.

2. **F5-TTS + stitch pipeline untested** — F5 has `maxChars: Infinity` so nSpeech chunking never triggers. If we ever want F5 to use the stitch pipeline (for consistency with cloud engines), needs explicit testing.

3. **Progress events in main log** — byte-tick progress events go to SSE bus only, not main-0.log. Log reads as "stuck" during long generations.

4. **Old Melon voice cleanup** — `venv/f5tts/voices/Melon.wav` was re-cloned with normalization. `Melon12` also re-normalized. `AllanF5` is clean. Any other voices cloned before 2026-08-16 need re-cloning.

5. **Chatterbox deprecation decision** — F5-TTS outperforms Chatterbox on quality and speed. Chatterbox Turbo still has paralinguistic tags ([laugh][cough]) and the exaggeration parameter. Decide whether to keep as active alternative or deprecate.

6. **LLM markdown cleaner untested E2E** — `markdown: 'llm'` path written but not tested against the live gateway. The regex path (`markdown: true`) is tested and works.
