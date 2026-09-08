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
| **F5-TTS** | Primary GPU quality engine — bilingual EN/DE | ~1-2GB (EN) + 1.35GB (DE) | **User verdict: "fast and better than Chatterbox"** (2026-08-16); German "quite good" at cfg 1.5 (2026-08-29) |
| **Chatterbox Turbo** | GPU alternative | ~2GB | Paralinguistic tags, exaggeration param |
| **VibeVoice** | Multi-speaker dialogue | ~4-6GB | Parked — works but flat delivery. Unique value: multi-speaker |
| **MiniMax** | High-quality cloud | — | Active |
| **ElevenLabs** | Premium cloud | — | Active |
| **Gemini** | Instruction-driven style | — | Active |
| **xAI** | Alternative cloud | — | Active |

**F5-TTS notes:** voices are `name.wav` + `name.f5tts.txt` transcript sidecar (both required). Clone auto-trims ref to ~12s at a silence, resamples to 24kHz, auto-transcribes (faster-whisper). Internal chunking with cross-fade — pass full text, single yield. Tunables via `extra_body`: `speed` (duration divisor, 0.8=25% slower), `nfe_step` (16=fast, 64=audiobook), `cfg_strength`, `sway_sampling_coef`, `seed`. Render ~4-7× real-time on 4090.

**VibeVoice notes:** batch-only, no streaming. Script format strictly `Speaker N: text` (numeric IDs). Multi-speaker voice mapping via `extra_body.voices: {1: "Alice", 2: "Bob"}`. flash-attn has no Windows wheel → sdpa default; opt-in via `NSPEECH_VIBEVOICE_ATTN=flash_attention_2`. Model at `venv/vibevoice/models/VibeVoice` (5GB). VRAM exceeds TTS budget if another GPU engine resident.

**Hardware constraint:** BADKID server, RTX 4090 (24GB VRAM). 12GB reserved for Gemma 4 27B LLM, ~1GB for STT service. **TTS budget: 4-6GB VRAM.** F5 (EN+DE bilingual, both checkpoints resident ~3-4GB) + Kokoro fit within budget simultaneously.

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

### 2026-09-08 — Cloud models exposed to clients + dashboard model selectors

**Focus:** Report each cloud provider's available models to clients and make the dashboard select among them, instead of hard-coding provider defaults.

- **Cloud registry (`server/cloud/registry.js`)** is now the single source of truth for available models. Each provider registers `models: [{ id, provider, label, default }]` plus legacy `aliases` (extra accepted model ids → canonical id). `resolveCloud` matches exact ids and aliases (dropped the fragile underscore→hyphen `normalizeSubModel`); a bare engine prefix still aliases to the provider's default. `listCloudEngines()` returns `{ name, type, models, defaultModel, health }`.
- **Fixed ElevenLabs bug:** `eleven_v3` (the adapter's default) was not addressable via `resolveCloud` (it doesn't start with `elevenlabs_`) — the dashboard's default `eleven_v3` would 404. Now `eleven_v3` is a canonical model; `elevenlabs_turbo_v2_5` etc. are legacy aliases.
- **`GET /v1/models`** enriches cloud entries with `engine`, `provider_model`, `label`, `default` (and local entries get `engine`/`default`). **`GET /v1/admin/engines`** cloud entries now carry `models` (objects) + `defaultModel`.
- **SDK** adds `listEngineModels(engine)` — filters `/v1/models` by engine for a clean model-selector feed.
- **Dashboard** adds `window.nspeechLoadModels(selectEl, engine)` (in `dashboard.js`) — fetches an engine's models and fills the `<select>`, pre-selecting the provider default unless a saved model was restored. All 5 cloud generate pages (minimax, elevenlabs, gemini, xai, fish) now use it, replacing hard-coded option lists; `buildParams` sends the public model slug as `model`.
- **Client caching + refresh:** model list is cached (in-memory + localStorage, 15-min TTL) so navigating between pages is instant; a stale cache missing the new `engine` field is discarded. Voice lists now use the SDK's in-memory `VoiceCache` (removed the `forceRefresh` flag from all 10 generate pages — they were re-fetching from the provider on every page load). `warmUpCaches()` runs on dashboard start: pre-fetches the model list + all cloud engines' voice lists in the background (cloud adapters run in Node, no worker spawn; local engine voices remain lazy — listing them is what starts that worker). A **Refresh** button in the dashboard header (`data-action="refresh-data"` → `nspeechRefreshData()`) clears both caches and reloads to re-fetch.
- Docs updated (`documentation/API_REFERENCE.md`): model field points to `/v1/models`; `/v1/models` and `/v1/admin/engines` sections document the new metadata, `model`-selection semantics (bare prefix / slug / legacy alias), and the SDK `listModels()`/`listEngineModels(engine)` helpers. `documentation/nSpeech_Spec.md` §4.4 rewritten for the new explicit model catalog + aliases.

### 2026-09-01 — F5 language misdetection fixed (English → German model)

- **Bug:** one umlaut in an English text (loanword/name like "Übermensch") short-circuited `detect_language` to `de` — English prose quoting German philosophy rendered through the German checkpoint. Reproduced with the real function; typical chat-app texts hit it.
- **Fix:** weighted scoring, no short-circuit — umlaut/ß +2 per occurrence, unambiguous German function word +1, EN function word +1, ties → EN. `"Time to die."` homograph case fixed as a side effect (was `de`).
- **defaults.json:** removed the language-dependent `cfg_strength: 1.5` pin (dialed in for Simon_DE); it globally overrode the adapter's per-language cfg (DE 1.5 / EN 2.5) via the relay's fill-only-unset merge. Language-neutral knobs (`nfe_step`, `sway_sampling_coef`) kept.
- Verified: EN plain, EN + umlaut loanword, EN + German quotes → en; log's real German fixture, umlaut-free German → de.
- Note for future: per-engine server defaults must stay **language-neutral** for bilingual engines — the adapter owns per-language tuning when the field is unset.

### 2026-08-29 — Engine cleanup: dots, Audio8, IndexTTS2, Chatterbox eng/mtl retired

**Focus:** Shed engines made redundant by F5. Findings preserved in **[docs/ENGINE_TRIALS.md](docs/ENGINE_TRIALS.md)** — verdicts, root causes, and the cross-cutting trial-decision patterns (prosody-source test, ≥5× RT bar, cfg-before-vocoder).

- **Removed:** `dots` (VRAM + variable quality, abandoned since 07-15), `audio8`/`audio8-hd` (1.6-1.9× RT, kernel-launch-bound dual-AR — kept for Linux mamba retest in theory, archived), `chatterbox-eng`/`chatterbox-mtl` (didn't deliver vs turbo), IndexTTS2 smoke script (never integrated).
- **Kept:** `chatterbox-turbo` (stable EN alternative to F5), kokoro, f5tts (bilingual), f5tts-german, vibevoice, all cloud.
- Files: adapters → `_Archive/`, dashboard pages → `_Archive/pages_retired/`, registry/tts.py/app.js/.env cleaned. **Bug found & fixed during cleanup:** `f5tts-german` was missing from the worker's transcript-sidecar map (would list bare wavs as voices).
- Venvs deleted same day (~19GB reclaimed): `venv/dots` (10.1GB), `venv/audio8` (8.7GB). `venv/chatterbox` kept — turbo uses it. Reinstall via `install.py` if ever needed.

### 2026-08-29 — F5-TTS bilingual: German fine-tune integrated, auto language routing

**Focus:** Local German quality. Base F5 on German = "sudo German" (English pronunciation forced, gibberish-adjacent) — abandoned for DE. Fish S2 German solid but monotone (cloud fallback only).

- **Checkpoint**: `aihpi/F5-TTS-German` (HPI, CC-BY-NC-4.0) `model_420000.safetensors` at `venv/f5tts/models/F5-TTS-German/`. User verdict with German ref voice (Melon_DE): "quite good" — prime local German engine. Metallic sheen = **cfg over-guidance, not the vocoder** — cfg 1.5 (vs EN's 2.5) eliminates it; adapter defaults cfg per language. bigvgan detour unnecessary (machinery kept, registry on vocos).
- **Bilingual `f5tts` engine**: two lazy-loaded resident checkpoints — EN `F5TTS_v1_Base`, DE German-420k. Per-request routing: `extra_body.language: 'de'|'en'` explicit, else zero-dep heuristic (`detect_language`: default EN — umlauts/ß weigh +2 each but are not decisive (loanwords like "Übermensch" in English text must not flip the render); unambiguous German function words +1, EN function words +1, ties → EN). Both resident ~1.4GB allocated — well within the 4-6GB budget.
- **Mechanism**: registry `env` overrides (new in worker.js — spreads `entry.env` into worker env, resolves `*_CKPT/*_FILE/*_PATH` against project root). `NSPEECH_F5_CKPT_DE` on `f5tts`; explicit `f5tts-german` engine pins the German checkpoint only.
- Voices shared across both (sidecar suffix fixed `.f5tts.txt`). Dashboard pages `web/pages/f5tts-german/` (manual override engine).
- Smoke: DE 6.7s/6.8s + EN 5.9s/3.7s in one process, both models resident (`scripts/smoke-f5-bilingual.py`).
- **Metallic sheen SOLVED: cfg over-guidance, not the vocoder.** cfg 1.5 (vs EN's 2.5) eliminates it — adapter now defaults cfg per language (DE 1.5, EN 2.5; explicit extra_body.cfg_strength still wins). bigvgan detour was unnecessary (machinery kept: `NSPEECH_F5_MODEL_DE`, `_ensure_bigvgan_config`, `third_party/BigVGAN` clone — rerun `scripts/patch-bigvgan.py` after venv reinstall; registry reverted to vocos 420k). Peak-limiter (>0.95) kept in adapter — bigvgan runs hotter and hard-clipped without it.
- **Bilingual preload:** `F5TtsAdapter.preload()` warms en+de at worker start (~9s, both resident) — language-switch penalty gone. `worker_routes.py` prefers `adapter.preload()` over the `.model` touch.
- **Server-side generation defaults** (2026-08-29): `PUT/GET/DELETE /v1/defaults/:engine` → `defaults.json` (voice/speed/extra_body per engine). Relay merges into `/v1/audio/speech` (fill-only-unset, explicit wins, before preset resolution). Dashboard **Save as Default** persists localStorage AND server (widget `nspeech-save-defaults` event → buildParams → PUT; needs text in the box); **Reset** clears both.
- Dashboard: cleaned-preview testing aid removed from f5tts/f5tts-german/audio8/audio8-hd pages; per-engine settings persistence on ALL generate pages (16 engines).
- E2E verified live: DE+EN through f5tts (auto-routing), Fish cloud 200. GOTCHA: Fish voice `'default'` must NOT be sent as reference_id (400 "Reference not found") — omit the field.
- Open: long-form German article E2E via server; older bigvgan ckpts (430k/550k) if vocos cfg 1.5 ever disappoints; `logs/german-melon-de-bigvgan-libinfer.wav` discrimates checkpoint-vs-pipeline if metallic returns.

### 2026-08-28 — Fish Audio S2 cloud engine integrated

**Focus:** Evaluate Fish Audio S2 as F5-TTS rival. Cloud API first (`FISH_AUDIO_API_KEY` in .env, free tier `s2.1-pro-free`).

- Adapter `server/cloud/fish.js` — JSON to `POST /v1/tts` (no msgpack needed with `reference_id`), model via header, `format: pcm, sample_rate: 24000` = s16le 24kHz mono (exact PCM contract match). Streaming pipes the chunked response.
- Registry: `fish`, `fish_s2_1_pro_free` (default), `fish_s2_1_pro`, `fish_s2_pro`, `fish_s1`. Dashboard pages `web/pages/fish/`. Voice clone via `POST /model` multipart (train_mode=fast, `texts` transcript sharpens pronunciation); preview clones throwaway + deletes.
- Live smoke: **2.5–2.8× real-time, TTFB ~750-850ms** on free tier (render, not playback rate — cloud latency fine for chunked narration).
- **Quality verdict (2026-08-29): PARKED as evaluation, kept as cloud fallback.** With a cloned reference voice: lower error rate than F5 but noticeably monotone — delivery not drawn from the reference register (same class as Audio8/VibeVoice). Untested: `[bracket]` style tags in German, temperature >0.7 (impractical for long-form: per-chunk tagging). F5 stays primary GPU engine.
- Local S2 research option noted: open weights `fishaudio/s2-pro` (Fish Research License, non-commercial), s2.cpp GGUF q6_k/q8_0 fit BADKID's ~11GB free VRAM. Speed on 4090 unprobed. Parked pending quality verdict.
- Open: F5 vs Fish A/B by ear; long-form German test; cloning trial.

### 2026-08-23 — Audio8 TTS trial: integrated, benchmarked, PARKED

**Focus:** Evaluate Audio8-TTS-Preview (0.1B + 0.6B) as Chatterbox Turbo replacement. Full integration: adapter (`src/nspeech/engines/audio8.py`), two registry engines (`audio8`, `audio8-hd` — shared venv + shared voice dir via registry `voice_dir`/`model_dir` overrides, new in `worker.js`), dashboard pages, install.py support. Clone model = F5-style (ref wav + `.audio8.txt` transcript sidecar, auto-transcribed via faster-whisper — must be in requirements; preview 500'd until pinned).

**Verdict: not usable.** User: "anything below 0.2 real-time I wouldn't use" — meaning ≥5× real-time required.
- **Speed: 1.6–1.9× real-time** (warm, both variants) — far too slow. Structural: Python-loop dual-AR (~230 model steps/s of audio: 1 slow Falcon-H1 step + 10 sequential fast-AR codebook steps), kernel-launch-bound (GPU+CPU both idle). Naive Mamba fallback on Windows (no mamba-ssm/causal-conv1d wheels for py3.13/torch 2.11; community wheels cp311-only). `torch.compile(reduce-overhead)` no help — no Triton on this stack. Audio8's own CLI uses the same HF remote-code path — no faster engine exists upstream.
- **Quality: stable, good voice replication, monotone.** Expressive only at temperature ≥1.5 (sliders extended to 2.5; adapter default 1.4); even at 2.5 "just passable". Prosody comes only from sampling entropy — timbre clones, delivery doesn't.

**Kept in codebase** (registered, working, documented) for a Linux retest — mamba-ssm installs cleanly there and addresses the slow-branch half of the cost. `probe-audio8-compile.py` and `smoke-audio8.py` in scripts/.

### 2026-08-18 → 2026-08-22 — Unified SDK, Server-Authoritative Cleaning, Kokoro Resident

**Focus:** Single-file SDK + dashboard migration; text cleaning moves server-side; Kokoro becomes resident; `/v1/models`.

- **Unified SDK** (`2d48f1b`, handover: `docs/handover_2026-08-18_unified-sdk.md`): single `lib/nspeech-client/nspeech-client.js` exporting `NSpeechClient`, `cleanMarkdown`/`expandAcronyms`, `SpeechPlayer`, `EventStream`. Full dashboard migration. `server/markdown-clean.js` re-exports the SDK regex layer. Engine-switch race fixed.
- **Server-authoritative text cleaning** (`ec8ac0b`): `POST /v1/text/clean` endpoint; `extra_body.markdown` renamed to `extra_body.clean` (markdown kept as legacy alias). LLM prosody pass parked — consistently worse than regex in ear tests.
- **Kokoro resident + voice tiers + fixes** (`458ca81`): Kokoro `gpu:false` → survives engine switches like a cloud provider. Voice quality tiers (hexgrad `targetQuality`/`overallGrade`) exposed via list_voices. STT routes accept MP3/FLAC/Ogg/PCM (ffmpeg decode server-side). MiniMax voice_id sanitization per official [8,256] rules (fixes error 2013). SDK `baseUrl: ''` honored via `??`.
- **Per-engine health-check timeout** (`2372507`): registry field `health_check_timeout_ms` (f5tts=180000, vibevoice=300000). F5 cold-start (~28s) raced the default 30s timeout — the health check really measures model load time since FastAPI startup blocks `/health`.
- **`GET /v1/models`** (`6e488ab`): OpenAI-style model listing usable without engine switch.

**Open items (carried):**
- Chat-app migration to unified SDK
- Text-cleaning toggle on the ~10 other engine dashboard pages
- ~~Plural acronym rule (`GPUs` → "G P U s")~~ — **DONE 2026-08-23**: plural acronyms spell + apostrophe-s (`GPUs` → `G P U's`). Chosen over bare "G P U s" because ElevenLabs/MiniMax (the published-works engines) speak apostrophe-s as the natural plural syllable; engines that ignore the apostrophe still get spelled letters. Single source in `lib/nspeech-client/nspeech-client.js` — server re-exports it.
- F5 short-chunk compression, VibeVoice ddpm_steps, F5-German model
- Byte-tick progress events → main-0.log (UX gap)

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

*Last updated: 2026-08-29*
