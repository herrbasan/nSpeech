# nSpeech — Project Aims & Activity Log

**Purpose:** This file describes what nSpeech is trying to achieve and tracks significant decisions, changes, and discoveries. It is NOT a technical specification — for that, see [nSpeech_Spec.md](nSpeech_Spec.md).

---

## Project Aims

### Primary Goal

A reliable, consistent TTS **and STT** service with a simple, powerful API that can drive multiple speech engines — local GPU models and cloud providers — behind a single OpenAI-compatible interface. Transcription and text-constrained forced alignment run locally on CPU, independent of any GPU engine lifecycle.

### Engine Strategy (2026-08-16)

| Engine | Role | VRAM | Status |
|--------|------|------|--------|
| **Kokoro** | Always-available workhorse | ~500MB | Primary CPU/slim GPU option |
| **F5-TTS** | Primary GPU quality engine | ~1-2GB | **User verdict: "fast and better than Chatterbox"** (2026-08-16) |
| **Chatterbox Turbo** | GPU alternative | ~2GB | Paralinguistic tags, exaggeration param |
| **VibeVoice** | Multi-speaker dialogue | ~4-6GB | Parked — works but flat delivery. Unique value: multi-speaker |
| **MiniMax** | High-quality cloud | — | Active |
| **ElevenLabs** | Premium cloud | — | Active |
| **Gemini** | Instruction-driven style | — | Active |
| **xAI** | Alternative cloud | — | Active |

**F5-TTS notes:** voices are `name.wav` + `name.f5tts.txt` transcript sidecar (both required). Clone auto-trims ref to ~12s at a silence, resamples to 24kHz, auto-transcribes (faster-whisper). Internal chunking with cross-fade — pass full text, single yield. Tunables via `extra_body`: `speed` (duration divisor, 0.8=25% slower), `nfe_step` (16=fast, 64=audiobook), `cfg_strength`, `sway_sampling_coef`, `seed`. Render ~4-7× real-time on 4090.

**VibeVoice notes:** batch-only, no streaming. Script format strictly `Speaker N: text` (numeric IDs). Multi-speaker voice mapping via `extra_body.voices: {1: "Alice", 2: "Bob"}`. flash-attn has no Windows wheel → sdpa default; opt-in via `NSPEECH_VIBEVOICE_ATTN=flash_attention_2`. Model at `venv/vibevoice/models/VibeVoice` (5GB). VRAM exceeds TTS budget if another GPU engine resident.

**Hardware constraint:** BADKID server, RTX 4090 (24GB VRAM). 12GB reserved for Gemma 4 LLM, 4-6GB for STT service. **TTS budget: 4GB VRAM.** F5-TTS + Kokoro fit within budget simultaneously.

**Switching policy (target):** Kokoro always resident. F5-TTS preferred GPU engine. Cloud providers stateless.

### Voice Model

Clients see a flat voice list with three categories:

- **native** — engine built-in voices (Kokoro's 54, Gemini's 30, MiniMax's 332)
- **cloned** — created via dashboard from reference audio
- **preset** — saved voice configuration (voice + instructions + settings)

The dashboard is the **admin UI** — voice creation, preset management, engine switching are admin operations, not client operations. Clients only list voices and generate speech.

### API Philosophy

- OpenAI-compatible where possible, nSpeech extensions where necessary
- `extra_body` for engine-specific tuning (optional, silently ignored if unsupported)
- Per-request blend for on-the-fly voice mixing (no saved voice needed)
- Streaming first, batch optional

---

## Activity Log

### 2026-08-17 — Cloud 503s Resolved + Stream Mode Restored

**Focus:** Fix silent 503s on long cloud requests; restore progressive streaming for chunked texts.

**Three fixes (handover: `docs/handover_2026-08-17_cloud-503s.md` — status RESOLVED):**

1. **Dead `generateChunked()` call** (`6fb4304`): `speech.js` stream-mode chunk branch called a function that never existed (renamed during the 2026-08-15 API rename, branch never updated). Trigger: any request > engine.maxChars in default mode. Mapped to `generateChunkedBatch` as interim.
2. **`sendError` now logs** (`6fb4304`): every failed request logs `{message, status, type, stack}`. The 503s were invisible before this — fail-silent class of bug, cost hours.
3. **String-typed `speed` rejected by MiniMax**: chat app sends `"speed":"1"` (string); MiniMax strictly validates floats → error 2013 on batch, instant stream close on streaming (the "SSE zero-lines" red herring — parser was fine, probe proved provider healthy). Fixed by coercing `body.speed` to `Number()` at the `speech.js` boundary, 400 on NaN. **This one fix healed both MiniMax paths.**

**Stream mode restored — `chunking.generateChunkedStream()`:**
- Sequential chunks, native engine streaming per chunk (batch flag stripped), PCM pushed per chunk (75ms tail fade + 1000ms silence pad, no overlap/alignment).
- Progressive through the ffmpeg transcode pipe — first audio after chunk 1 (~15-30s on cloud) instead of after the full render.
- `extra_body.mode` now fully real: `'stream'` (default) = fast progressive, audible joins; `'stitch'` = buffered, seamless. Client toggle documented for chat-app integration.

**Verified live:** long German article via MiniMax stitch (2 chunks), short MiniMax via native streaming.

**Incidental fix:** `worker_routes.py` preload hook used `info(msg, extra={...})` — nspeech logger helper takes `meta=`, stdlib `logging.Logger` takes `extra=`. Crash showed as "engine health check timed out".

**Open items:**
- Text-cleaning toggle on the ~10 other engine dashboard pages (pattern in `web/pages/f5tts/generate.html`)
- Plural acronym rule (`GPUs` → "G P U s")
- F5 heading-silence design (adapter-level section splitting) — parked
- Per-engine stream stall timeout — low priority now
- UX gap: byte-tick progress events go to SSE bus only, not main-0.log

### 2026-08-16 — F5-TTS & VibeVoice Engines Shipped + Markdown Cleaner

**Focus:** Finish the experimental engine integrations started 2026-08-13; quality-tune F5-TTS; add markdown→speech preprocessing.

**F5-TTS — new primary GPU engine** (user verdict: "fast and better than Chatterbox"):
- Adapter + venv + model fully working. Dashboard pages (generate with speed/nfe_step/cfg_strength/sway/seed sliders, voices with transcript field).
- **Critical discovery:** F5-TTS clips ref audio to ~12s internally. A 17.5s ref with full-length transcript inflates the chars/sec rate estimate by 45% → fast, oscillating speech. Fix: `clone()` auto-trims to ~12s at a silence boundary, resamples to 24kHz, re-transcribes via faster-whisper.
- `speed` is a duration divisor (0.8 = 25% longer), not playback rate. Render ~4-7× real-time on 4090.
- Monotone intonation = the reference's register, not a model limitation. Expressive refs → expressive output.
- Long-form verified: full articles (8.6K and 14.2K chars) render in ~1-2 min, 53-86 internal chunks, clean cross-fades.

**VibeVoice — parked** (user verdict: "ok, but nothing special in terms of feeling natural"):
- Works, multi-speaker voice mapping via `extra_body.voices: {1: "Alice", 2: "Bob"}`.
- Unique value: multi-speaker long-form dialogue (65K token context). Flat delivery.
- 30s stream stall timeout kills long batch renders through Node — needs per-engine timeout (not fixed, engine parked).
- flash-attn has no Windows wheel → sdpa default. Model at `venv/vibevoice/models/VibeVoice` (5GB).

**Markdown cleaner** (`server/markdown-clean.js`):
- `extra_body.markdown: true` — regex strip: frontmatter, images, code blocks, URLs, HTML, formatting markers. Headers get trailing period. Italic → em-dash for prosodic stress.
- `extra_body.markdown: 'llm'` — LLM rewrite via local gateway (Gemma 4, `GATEWAY_API_KEY` in .env). Better emphasis/metadata handling. Fails loud if gateway down.

**Bugs fixed during integration:**
- `tts.py` class-name resolution: `f5tts.title()` ≠ `F5TtsAdapter` — added explicit `ADAPTER_CLASSES` map.
- Worker preview: `cache_dir` restored before `generate()` — F5-TTS reads ref files lazily at generation time. Fixed to restore after generator consumed.
- Worker preview: `voice_name` not passed to `generate()` — F5-TTS resolves files by name, not ambient state.
- F5-TTS clone self-copy: Node pre-writes wav to target path, `shutil.copy2(src, src)` → WinError 32.
- VibeVoice script format: strictly `Speaker N: text` (numeric), adapter was wrapping with voice name.

**Pending:**
- ~~Stream stall timeout is 30s fixed~~ — downgraded 2026-08-17: F5's own streaming defeats it for F5; cloud providers error rather than stall. Low priority.
- F5-TTS + stitch pipeline untested (F5 has `maxChars: Infinity` — nSpeech chunking never triggers for it).
- UX gap: byte-tick progress events go to SSE bus only, not main-0.log.
- Curator-side gotcha: PowerShell `curl` alias mangles JSON bodies (use `curl.exe` or `--data @file`).

### 2026-08-15 — Stitch Pipeline Finalized + Progress Events

**Focus:** Complete the batch-stitch workflow on a full 4-chunk real fixture; polish join quality; design progress reporting.

**Fixture:** `logs/stitch-ghost/` — full Ghost article (14,123 chars) as 4 real `eleven_v3` chunks with correct rolling-paragraph overlaps (chunk 1 regenerated: the original audio predated the overlap planner). `scripts/gen-fixture-chunk.js` generates a single chunk from its saved text; `scripts/align-probe.js` benchmarks alignment against a manually started worker.

**Join quality (all in `server/chunking.js`, verified by ear):**
- `DEFAULT_SILENCE_MS` 300 → **1000** (narration pacing)
- **Zero-crossing snap** on trim offsets (≤25ms scan) — click-free cuts
- **75ms tail fade-out on every chunk** (`chunk_tail_fade_ms`) — ElevenLabs cuts audio mid-phoneme at text end (26% peak in final 10ms, zero decay); the cliff into silence popped without this
- 15ms head fade-in kept as safety net

**Alignment speed:** STT worker thread cap default 4 → 12 (`NSPEECH_STT_THREADS` still overrides) — 1.6–1.8× faster (61.5s prefix: 18.7s → 11.5s). Prefix estimate tightened `(w/2.6)×1.6+8` → `×1.3+4`. Total align ~13s per 4-chunk batch.

**API rename:** `extra_body.mode`: `'stream'` (default) / `'stitch'` / `'off'`. `batch:true` and `auto_chunk:false` kept as deprecated aliases. Docs updated (API_REFERENCE.md, nSpeech_Spec.md, README.md).

**Progress events (model B — one bar + stage):** `tts` events on `/v1/admin/events` carry `percent` 0–100 (equal share per chunk; generation ticks every ≥5s from streamed bytes, self-calibrating bytes/char seeded at 3827 from fixture) + stage label (`plan`/`generating`/`aligning`/`trimmed`/`done`/`failed`).

**Pending:**
- ~~E2E test driven by the RAUM curator~~ — **PASSED 2026-08-15**: curator rendered all articles via `mode:'stitch'` ("The Intellectual Corset", 8,679 chars, 2 chunks, ~125s/chunk on v3, alignment + trim + fades applied server-side). STT worker spawned fine in the server context (throwaway-script spawn failure did not reproduce).
- ~~MP3 transcode efficiency~~ — **DONE 2026-08-15**: 64kbps mono 32kHz, speech-optimized, 50% smaller. Verified by ear.
- UX gap found in E2E: byte-tick progress events go to the SSE bus only, not main-0.log — the log is silent ~2min per chunk during generation and reads as "stuck". Log ticks at INFO.
- Curator-side gotcha: PowerShell `curl` alias mangles JSON bodies (use `curl.exe` or `--data @file`).

### 2026-08-14 — Batch Stitching Fixed + Local STT Worker

**Focus:** Repair batch-mode chunk stitching; decouple it (and transcription) from nVoice entirely.

**Three root-cause bugs in stitching found & fixed (zero ElevenLabs quota burned — offline fake-engine harness with Kokoro-generated ground truth):**

1. `chunking.js` sent headerless raw PCM to nVoice → ffmpeg format detection crash (garbage exit codes). Fixed with WAV wrapping.
2. Alignment engines returned no word timestamps (parakeet pipeline ignores `return_timestamps`; transducers can't constrain to text at all).
3. Odd byte-offset trim (`Math.floor` on samples) corrupted the PCM stream downstream — half-sample misalignment. Fixed to sample-aligned even offsets.

**Architecture decision — STT is now a first-class nSpeech offering (own worker: `venv/stt`, registry engine `stt`, `gpu:false`):**

- `/v1/audio/transcriptions` — faster-whisper large-v3 int8 CPU (model reused from existing HF cache)
- `/v1/audio/align` — torchaudio MMS_FA **CTC forced alignment**: Viterbi path constrained to the given text — word count mathematically guaranteed to equal `text.split().length`. This is what boundary trimming depends on (user insight: "the true precision comes from that alignment"). Chose CTC constrained alignment over ASR-based timestamps (whisper DTW is unconstrained; parakeet TDT cannot constrain).
- STT worker cannot be evicted by engine switching in nSpeech or nVoice (CPU-only; excluded from TTS engine surface via `stt:true` registry flag).
- Old nVoice proxy kept as `server/api/transcriptions.js.nvoice-proxy.bak`.

**Validated E2E offline:** truthful fixture (Kokoro speaks exactly the chunk texts) → align boundary `There` at 18.940s (20ms precision, prob 0.998), trim + fade + stitch clean (RMS join analysis + transcript cross-check: no duplicated overlap, no lost content).

**Discoveries:**

- CTC alignment MUST receive audio that actually speaks the given text — mismatched audio yields smeared but "successful" spans (Viterbi finds a global path anyway).
- MMS tokenizer needs uroman romanization + lowercase + punctuation stripping (no umlauts/caps in its dict).
- nVoice `/v1/audio/align` silently ignores its `text` field (G5 comment in its source) — it is transcription, not alignment.
- Multipart fields must be added before the closing boundary (a field after `--boundary--` is never sent).

**Pending:**

- Real `eleven_v3` batch run (~12K chars) to confirm v3 speaks the prepended overlap naturally — local pipeline proven and waiting.
- Smoke script for live STT routes: `scripts/smoke-stt-routes.js` (needs the restarted server).
- `nvoice_url` in config.json now unused by chunking (kept for reference).

### 2026-07-17 — Kimi K3 Session

**Focus:** Codebase deep-dive, API alignment, documentation restructure.

**Changes:**

1. **Chatterbox expressiveness support** — Adapter now reads `expressiveness` (API standard) with fallback to `exaggeration` (legacy) in both `clone()` and `generate()`. Previously only read `exaggeration`, causing silent ignore of the standard field.

2. **Per-request blend for Kokoro** — `worker_routes.py` speech endpoint detects `extra_body.blend`, computes weighted blend of voice styles, injects as synthetic voice `__blend_<hash>`. Client can blend up to 4 voices per request without saving. Specified in API plan but never implemented.

3. **Explicit voice_name in gen_kwargs** — Added `voice_name=req.voice_name` to generation kwargs. Previously relied on mutable `current_voice` state set by `load_voice()`. Now explicit and deterministic.

4. **Documentation restructure** — Created `nSpeech_Spec.md` (full technical spec), rewrote `Agents.md` (aims + log), updated `README.md` (integration-focused).

**Discoveries:**

- `extra_body` schema in `docs/AUDIO_API_PLAN.md` is a draft, not frozen. `inference_steps` rename was partially rolled out (dots.tts confirmed working).
- MiniMax `expressiveness` mapping is a crude heuristic (maps to `emotion` if >0.7). No real expressiveness control in MiniMax API.
- xAI has no true HTTP streaming — unary endpoint returns full audio. WS streaming available but not implemented.
- Kokoro `clone()` is a stub — saves `"af_heart"` string. Real zero-shot cloning requires style-extractor network not present in ONNX model.

**Pending:**

- Remove redundant `expressiveness`→`exaggeration` top-level mapping in `server/engine/worker.js` (adapter now handles it)
- End-to-end test of per-request blend
- Consider removing dots.tts and Chatterbox Eng/Mtl from active engine set (VRAM budget)

### 2026-07-15 — dots.tts Quality Fix Attempt

- Fixed `inference_steps` parameter name mismatch (dashboard sends `inference_steps`, adapter read `steps`)
- Attempted first-chunk transient fix (padding before resample) — failed due to tensor dimension mismatch with `soar` checkpoint
- Attempted checkpoint switch from `mf` to `soar` — failed, tensor shape differences
- All changes rolled back. dots.tts mentally abandoned due to VRAM (4-8GB), slow TTFA, variable quality.

### 2026-07-12 — CosyVoice Removed

- Audible artifacts (blips/pops) in both streaming and batch mode
- Root cause never identified despite multiple investigation sessions
- Removed from codebase. If re-integrated, will be from scratch.

### 2026-06-27 — V3 State Assessment

- Phase 4 complete: `/v1/*` API migration done, legacy shims removed
- All 6 engines verified E2E (Kokoro, Chatterbox×3, dots, MiniMax, ElevenLabs)
- MP3, Opus, AAC transcoding working via Node-side ffmpeg
- Voice mixing (Kokoro blends) working

---

## Key Documents

| Document | Purpose |
|----------|---------|
| [nSpeech_Spec.md](nSpeech_Spec.md) | Full technical specification — architecture, data flow, API schemas, implementation details |
| [README.md](README.md) | Human-facing integration guide — how to use nSpeech in your project |
| [docs/AUDIO_API_PLAN.md](docs/AUDIO_API_PLAN.md) | Canonical API contract and `extra_body` schema (draft) |
| [docs/VOICE_PRESETS.md](docs/VOICE_PRESETS.md) | Voice preset specification |
| [documentation/API_REFERENCE.md](documentation/API_REFERENCE.md) | Concise endpoint reference |

---

## Development Maxims

- **Reliability > Performance > Everything else**
- **Fail fast:** No defensive coding, no fallback defaults. Missing config crashes at startup.
- **Fail loud:** No silent `try/catch`. Crashes are signals, not embarrassments.
- **LLM-native codebase:** Structure optimized for LLM parsing, not human conventions.
- **Zero dependencies:** Standard library first. Dependencies only when truly necessary.
- **.env is NEVER committed:** API keys stay local.
- **Never start/stop the server:** The assistant must NEVER run `npm start`, restart, or kill the nSpeech server. If a restart is needed, ask the user to do it.

---

*Last updated: 2026-08-14*
