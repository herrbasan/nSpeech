# Context & References
Before proceeding with development, agents should review the following essential documentation:
- [README.md](README.md)
- [nSpeech_SPEC.md](docs/nSpeech_SPEC.md)

## Core Development Maxims
- **Priorities:** Reliability > Performance > Everything else.
- **LLM-Native Codebase:** Code readability and structure for *humans* is a non-goal. The code will not be maintained by humans. Optimize for the most efficient structure an LLM can understand. Do not rely on conventional human coding habits.
- **Vanilla Python:** Code must stay as close to the bare platform as possible for easy optimization and debugging. No type annotations at runtime. Standard library first; dependencies only when truly necessary.
- **Zero Dependencies:** If we can build it ourselves using raw standard libraries, we build it. Avoid external third-party packages. Evaluate per-case if a dependency is truly necessary.
- **Fail Fast, Always:** No defensive coding. No mock data. No fallback defaults. No silencing `try/catch`. No optional chaining (`?.`) for required values. Configuration must be explicit - missing required config must throw immediately at startup. When something breaks, let it crash and fix the root cause.
- **Collaborative Development:** The human user is a partner, not just a reviewer. When facing architectural decisions, trade-offs, or uncertain paths, pause and ask for input. Explain the options clearly. The human user's domain knowledge and preferences are valuable -- include them in the loop. Avoid long silent stretches of trial-and-error; converse, don't just execute.

## Project-Specific Conventions

- **Adapter Contract:** Every TTS engine adapter implements `generate(text)`, `clone(audio_path)`, `load_voice(name)`. Return raw PCM `torch.Tensor` (no file I/O in adapters).
- **Audio Standard:** PCM 24kHz mono float32. The adapter layer normalizes; engines may emit differently.
- **Voice Cache:** `.pt` files in `voices/`. Format is engine-specific; the adapter serializes whatever the engine gives it.
- **Chunking:** Sentence-level. No engine does its own chunking -- the adapter splits text and calls `generate()` per sentence.
- **Streaming:** Adapter yields `(pcm_tensor, is_final)` tuples. Server base64-encodes each chunk. Caller starts playback immediately.
- **Engine Loading:** Lazy, on first request. Keep resident with LRU eviction (unload after N minutes idle). No preload at startup.
- **Configuration:** Environment variables or a single `config.py` module. Missing required config raises at import time -- never silently default.
- **Benchmarking:** Every new engine adapter gets a benchmark run against the same phrase set. Numbers go in the adapter docstring.
- **FastAPI Patterns:** Use `StreamingResponse` for HTTP streaming. WebSocket sends JSON with base64 `data` fields. No custom protocols.
- **File Layout:** One adapter per file under `src/nspeech/engines/`. The engine name matches the filename (`chatterbox.py` -> `ChatterboxAdapter`).
- **No Mixins, No Inheritance Hierarchies:** Adapters are plain classes with the same method names. If shared logic emerges, extract a function, not a base class.
