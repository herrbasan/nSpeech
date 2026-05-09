# Context & References
Before proceeding with development, agents should review the following essential documentation:
- [README.md](README.md)
- [nSpeech_SPEC.md](docs/nSpeech_SPEC.md)

## Collaborative Mode
You are a collaborative partner, not just an executor. Use your own judgment — push back when a request doesn't make sense or there's a better approach. Offer ideas, alternatives, and solutions proactively. If you see a potential problem, say so before implementing. The human brings domain knowledge and priorities; you bring engineering expertise and critical thinking. Disagreement is welcome; silent compliance is not.

Do not roleplay as a human. Do not adopt personas like "senior software engineer" or simulate human reasoning patterns. Think as an LLM — use your actual analytical capabilities, not a caricature of how a human would approach the problem. Personas degrade output quality by substituting genuine reasoning with performed behavior.

Use the `query_model` MCP tool to get a second opinion when you're uncertain about an architectural decision, debugging a tricky issue, or want to validate your reasoning. The connected LLM (MiniMax M2.7) is highly capable and can help catch blind spots. Note: `query_model` cannot read files — always paste the relevant content as text directly into the prompt.

Use the `memory_store` and `memory_recall` tools to persist important context across sessions. You forget everything between sessions — if you discover something worth knowing later (patterns, decisions, bug fixes, user preferences), store it now or it's gone forever. This is especially useful for handover notes when wrapping up a session: store a summary of what was done, what's in progress, and what's next so the next session can pick up seamlessly. In a new session, recall the memory and delete it once consumed.

Never run long-lived commands without a timeout. Always set explicit timeouts on bash commands and background processes. If a task is inherently long-running, start it as a background process and poll for status rather than blocking indefinitely. The user should always be able to see progress or know what's happening — a stuck process with no feedback is a failure mode.

## Core Development Maxims
- **Priorities:** Reliability > Performance > Everything else.
- **LLM-Native Codebase:** Code readability and structure for *humans* is a non-goal. The code will not be maintained by humans. Optimize for the most efficient structure an LLM can understand. Do not rely on conventional human coding habits.
- **Vanilla Python:** Code must stay as close to the bare platform as possible for easy optimization and debugging. No type annotations at runtime. Standard library first; dependencies only when truly necessary.
- **Zero Dependencies:** If we can build it ourselves using raw standard libraries, we build it. Avoid external third-party packages. Evaluate per-case if a dependency is truly necessary.
- **Fail Fast, Always:** No defensive coding. No mock data. No fallback defaults. No silencing `try/catch`. No optional chaining (`?.`) for required values. Configuration must be explicit - missing required config must throw immediately at startup. When something breaks, let it crash and fix the root cause.

## Project-Specific Conventions

- **Adapter Contract:** Every TTS engine adapter implements `generate(text)`, `clone(audio_path)`, `load_voice(name)`. `generate()` is a generator that yields `(pcm_tensor, is_final)` tuples. Return raw PCM `torch.Tensor` (no file I/O in adapters).
- **Audio Standard:** PCM 24kHz mono float32. The adapter layer normalizes; engines may emit differently.
- **Voice Cache:** `.pt` files in `venv/<engine>/voices/`. Format is engine-specific; the adapter serializes whatever the engine gives it.
- **Chunking:** Sentence-level. No engine does its own chunking -- the adapter splits text and calls `generate()` per sentence.
- **Streaming:** Adapter yields `(pcm_tensor, is_final)` tuples. HTTP streams raw binary chunks via `StreamingResponse`. WebSocket sends binary frames (encoded audio) or raw PCM bytes. Caller starts playback immediately.
- **Engine Loading:** Lazy, on first request. Keep resident with LRU eviction (unload after N minutes idle). No preload at startup.
- **Configuration:** Environment variables or a single `config.py` module. Missing required config raises at import time -- never silently default.
- **Benchmarking:** Every new engine adapter gets a benchmark run against the same phrase set. Numbers go in the adapter docstring.
- **FastAPI Patterns:** Use `StreamingResponse` for HTTP streaming. WebSocket sends JSON with base64 `data` fields. No custom protocols.
- **File Layout:** One adapter per file under `src/nspeech/engines/`. The engine name matches the filename (`chatterbox.py` -> `ChatterboxAdapter`).
- **No Mixins, No Inheritance Hierarchies:** Adapters are plain classes with the same method names. If shared logic emerges, extract a function, not a base class.

## Implementation History & Current State

### Successes
- **Multi-Engine Architecture:** Successfully implemented the TTSAdapterProtocol allowing dynamic, pluggable TTS engines.
- **Kokoro-82M Integration:** Successfully integrated Kokoro via kokoro-onnx as the default engine.
  - **Performance:** Extremely low latency (350-700ms TTFA) and minimal VRAM/RAM footprint (~6MB), cleanly meeting CPU-only goals.
  - **Streaming:** Implemented native batch streaming using Kokoro's internal phonemizer to eliminate delay on large texts without relying on crude sentence regex splitting.
  - **Integration:** Integrated 54 native voices smoothly into the FastAPI /voices endpoint and the Web UI dropdown.

### Failures & Trade-offs
- **Qwen3 Integration:** Failed to integrate Qwen3 reliably as a low-latency streaming replacement.
- **Kimi Audio Integration:** Failed to integrate Kimi Audio. The pipeline could not produce reliable streaming audio output within the project's architecture constraints.
- **Fish Speech S1-Mini Integration:** Failed to integrate Fish Speech (DualAR + DAC codec). The model produced audio but `generate_long()` is monolithic/blocking — no true incremental streaming. Post-generation chunking resulted in unacceptable latency (30s+ wait before first audio). Tokenizer incompatibilities between s1-mini (tiktoken) and s2-pro (HuggingFace) required workarounds that were fragile. Abandoned.
- **Zero-Shot Voice Cloning (Kokoro):** Kokoro's ONNX package does not include the style-extractor network required to extract embeddings from new .wav files. True zero-shot cloning natively via Kokoro is currently unsupported. 
  - *Workaround:* The adapter stubs clone() requests to a default voice to prevent pipeline crashes. If zero-shot cloning is strictly required, the system must be configured to route requests to the heavier Chatterbox engine instead.
  - *Future direction:* Considering a separate standalone project for compiling custom Kokoro voices from reference audio, producing voice files compatible with nSpeech.

### Candidates to Evaluate
- **LuxTTS:** TBD
- **IndexTTS 2:** TBD
- **CosyVoice:** In evaluation. Install script and venv support exist. Key integration lessons documented in `docs/cosyvoice_notes.md`. Adapter not yet complete.

### Open Requirements
- **Emotional Cues:** No current engine supports expressive/emotional control (e.g., sad, excited, whispering). A future engine must support SSML or prompt-driven emotion markers.
- **German Language:** No current engine produces acceptable German speech. Multilingual support (at minimum English + German) is a hard requirement for the next engine integration.

### Current Project State
The text-to-speech service is highly stable and operational for high-speed, low-resource streaming using Kokoro's rich set of built-in voices. The primary limitation moving forward is the lack of lightweight zero-shot cloning, meaning new voices must either be blended algorithmically from built-in profiles or processed through a separate pipeline.

## Multi-Host Deployment Architecture

### Design Decision: Separate Venvs Per Host
Each TTS technology runs in its own venv on dedicated hardware. No shared dependencies between engines — eliminates transformer version conflicts (CosyVoice needs 4.51.3, Chatterbox/Kokoro need 5.x).

### Deployment Plan

| Host | Engine | Purpose | Notes |
|------|--------|---------|-------|
| FATTEN | Kokoro | Base voice service | Intel GPU, English only, fast & reliable |
| BADKID | CosyVoice3 | Multilingual, quality | Shares VRAM with Qwen3.6 (80k ctx), RTX 4090 |
| — | Chatterbox | Archived | Works well but English-only, not deployed |

### Venv Creation Notes

**Kokoro (FATTEN):**
- `python install.py install --engine kokoro`
- Creates `venv/kokoro/env/` (Python) and `venv/kokoro/models/` (weights)
- Set `NSPEECH_MODEL_DIR=venv/kokoro/models` in `.env`

**CosyVoice (BADKID):**
- `python install.py install --engine cosyvoice`
- Creates `venv/cosyvoice/env/` and `venv/cosyvoice/models/`
- Set `NUMBA_DISABLE_JIT=1` environment variable
- Add Matcha-TTS to Python path in run.py

### Key CosyVoice Lessons (2026-05-07)
- `inference_instruct2` with `zero_shot_spk_id` WORKS; `inference_cross_lingual` FAILS; `inference_zero_shot` with spk_id produces ~0.12s audio
- All text must include `<|endofprompt|>` token
- Max cloning audio: 30 seconds
- Voice cache load: `torch.load(path, weights_only=False, map_location='cpu')`
- Full notes in `docs/cosyvoice_notes.md`

### Running Multiple Instances
Each host runs independently:
```
# On FATTEN (port 8000)
venv\kokoro\env\Scripts\python run.py

# On BADKID (port 8000)
venv\cosyvoice\env\Scripts\python run.py
```

Or simply `python run.py` — it auto-detects `NSPEECH_ENGINE` from `.env` and
re-launches with the correct venv Python.

Client connects to specific host:port based on needed capability.

## Web Dashboard (NUI)

### Architecture
The dashboard is built with **NUI** (`lib/nui_wc2/` — git submodule of https://github.com/herrbasan/nui_wc2). NUI is a vanilla Web Component library: zero build step, ES modules, Light DOM, CSS variables for theming.

### File Layout
```
web/
  index.html              # App shell (<nui-app> boilerplate)
  css/main.css            # App-specific styles
  js/app.js               # Router setup, nav data, global actions
  pages/
    home.html             # Dashboard home
    kokoro-generate.html  # Kokoro: text input, voice select, generate/stop
    kokoro-voices.html    # Kokoro: voice browser, mix voices
    # Future engines get their own pages when adapters are created:
    # cosyvoice-generate.html, cosyvoice-voices.html, etc.
lib/
  nui_wc2/                # Git submodule — the NUI library itself
    NUI/nui.js            # Core module (import this)
    NUI/css/nui-theme.css # Design tokens and component styles
    NUI/assets/           # Icon sprite, patterns
    documentation/        # Component docs, guides, components.json
voices_samples/           # Reference audio samples for testing
```

### How It's Served
FastAPI (`src/nspeech/server.py`) mounts static directories:
- `/web/` → `web/` (html=True, serves index.html and pages)
- `/lib/` → `lib/` (NUI submodule assets)
- `GET /` returns `web/index.html` via FileResponse

### Navigation Structure
The sidebar (`nui-link-list`) is organized **per engine**. Each engine gets two pages:
1. **Generate** — Text input, voice selector (`nui-select`), generate/stop buttons, audio player
2. **Voices** — Voice management. Capabilities vary by engine (Kokoro: mix voices; CosyVoice: clone from audio)

Engines are only added to navigation when their adapter actually exists and is installed.

### Key NUI Patterns Used
- **App shell:** `<nui-app>` with `<nui-app-header>`, `<nui-sidebar>`, `<nui-content>/<nui-main>`
- **Router:** `nui.setupRouter({ container, basePath: '/web/pages', defaultPage })` — fragment-based SPA
- **Navigation:** `nui-link-list` with `loadData()` — data-driven sidebar
- **Actions:** `data-action` for declarative click handling (sidebar toggle, theme toggle)
- **Component registry:** Always check `documentation/components.json` before using a component

### Current State (2026-05-08)
- NUI submodule added and serving correctly
- Navigation is engine-centric: Kokoro group with Generate and Voices pages
- Pages exist: `home.html`, `kokoro-generate.html`, `kokoro-voices.html`
- Server verified working — dashboard loads, NUI components render, API calls succeed
- Remaining: page content sizing refinements, add CosyVoice pages when adapter is ready

### NUI Reference for Agents
- **Source of truth:** `lib/nui_wc2/documentation/components.json`
- **Read before using:** `lib/nui_wc2/documentation/guides/` (introduction → getting-started → architecture-patterns → declarative-actions → api-structure)
- **No custom CSS:** Use only `nui-theme.css` variables. Never invent CSS variables or use inline styles for static layout.
