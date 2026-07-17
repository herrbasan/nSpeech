# nSpeech — Project Aims & Activity Log

**Purpose:** This file describes what nSpeech is trying to achieve and tracks significant decisions, changes, and discoveries. It is NOT a technical specification — for that, see [nSpeech_Spec.md](nSpeech_Spec.md).

---

## Project Aims

### Primary Goal

A reliable, consistent TTS service with a simple, powerful API that can drive multiple speech engines — local GPU models and cloud providers — behind a single OpenAI-compatible interface.

### Engine Strategy (2026-07-17)

| Engine | Role | VRAM | Status |
|--------|------|------|--------|
| **Kokoro** | Always-available workhorse | ~500MB | Primary CPU/slim GPU option |
| **Chatterbox Turbo** | Primary GPU quality engine | ~2GB | Candidate for permanent GPU residency |
| **MiniMax** | High-quality cloud | — | Active |
| **ElevenLabs** | Premium cloud | — | Active |
| **Gemini** | Instruction-driven style | — | Active |
| **xAI** | Alternative cloud | — | Active |

**Hardware constraint:** BADKID server, RTX 4090 (24GB VRAM). 12GB reserved for Gemma 4 LLM, 4-6GB for STT service. **TTS budget: 4GB VRAM.**

**Switching policy (target):** Kokoro always resident. Chatterbox Turbo never unloaded once loaded. Cloud providers stateless. No GPU exclusion needed — the GPU engine is fixed.

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

---

*Last updated: 2026-07-17*
