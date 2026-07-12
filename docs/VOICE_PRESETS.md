# Voice Presets — Spec

**Status:** draft  
**Date:** 2026-07-12

## 1. Problem

Cloud engines with no voice cloning (Gemini, xAI) have system voices plus an `instructions` field. Together these form a de-facto character — e.g. voice `Kore` + instructions `"Speak in the cadence of a public intellectual"` = "Smart Lady." But the client must send both fields every time. There's no way to save this combination as a named voice.

Engines WITH cloning (MiniMax, ElevenLabs) could also benefit: save a cloned voice + preferred settings (`stability: 0.3`, `expressiveness: 0.7`) as a reusable preset.

## 2. Design

Presets are **Node-managed** (not worker-managed). They live in a `presets/` directory at the repo root, one JSON file per engine. Node merges them into `GET /v1/voices` responses as `voice_type: "preset"`. The speech handler resolves presets before the engine sees the request.

### Why Node, not worker

- Cloud engines (Gemini, xAI) have no Python worker process
- One uniform store for all engines — local and cloud
- Simpler than adding preset logic to every adapter

### Why engine-scoped files

- `instructions` are engine-specific (Gemini instructions ≠ ElevenLabs instructions)
- A preset created on Gemini should not appear in a Kokoro voice list
- Matches how `venv/<engine>/voices/` is already engine-scoped

## 3. Storage

```
nSpeech/
  presets/
    gemini.json
    xai.json
    minimax.json
    elevenlabs.json
    kokoro.json        # optional — presets can wrap blended/cloned voices
    chatterbox.json    # optional
    dots.json          # optional
```

Each file is a JSON array of preset objects:

```json
[
  {
    "id": "smart-lady",
    "name": "Smart Lady",
    "voice": "Kore",
    "instructions": "Speak in the cadence of a public intellectual. Articulate, measured, slightly formal."
  },
  {
    "id": "stern-narrator",
    "name": "Stern Narrator",
    "voice": "Orion",
    "instructions": "Deep, measured, slightly ominous. Like a documentary narrator.",
    "speed": 0.9
  }
]
```

**Fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | ✅ | Unique within the engine. URL-safe slug. Used as `voice` value in TTS requests. |
| `name` | string | ✅ | Display name (shown in voice lists). |
| `voice` | string | ✅ | Base voice ID (system voice, cloned voice, or blended voice). |
| `instructions` | string | — | Style direction. Injected into the TTS request. |
| `speed` | number | — | Default speaking speed. |
| `extra_body` | object | — | Additional `extra_body` fields merged into the request (e.g. `stability`, `expressiveness`). |

Preset `id` must not collide with any built-in or cloned voice ID on that engine. Node validates this on create.

## 4. API

All endpoints follow the existing `/v1/voices` pattern: create via `POST /v1/voices/<action>`, list via `GET /v1/voices`, delete via `DELETE /v1/voices/:id`. No new URL shapes.

### `GET /v1/voices?engine=gemini`

Existing endpoint — unchanged. Node merges presets into the engine's native voice list:

```json
{
  "voices": [
    {"voice_id": "Kore", "name": "Kore", "voice_type": "builtin", "engine": "gemini"},
    {"voice_id": "smart-lady", "name": "Smart Lady", "voice_type": "preset", "engine": "gemini",
     "base_voice": "Kore", "instructions": "Speak in the cadence of a public intellectual."}
  ]
}
```

Implementation: `getVoicesHandler` calls `presets.list(engine)`, appends to `data.voices` before returning. No schema change — presets are just another `voice_type`.

### `POST /v1/voices/preset`

Create or update a preset. JSON body (no multipart — this is pure config, no audio upload):

```json
{
  "engine": "gemini",
  "id": "smart-lady",
  "name": "Smart Lady",
  "voice": "Kore",
  "instructions": "Speak in the cadence of a public intellectual."
}
```

Returns `{ "voice_id": "smart-lady", "name": "Smart Lady", "voice_type": "preset", ... }`. Returns 409 if `id` collides with a built-in/cloned voice on that engine. Re-POST with the same `engine`+`id` updates the preset.

This follows the same pattern as `POST /v1/voices/mix` (JSON body, no multipart, creates a named voice configuration).

### `DELETE /v1/voices/:id?engine=gemini`

Existing endpoint — Node intercepts: if `:id` matches a preset on `?engine=`, delete from presets store. Otherwise fall through to `engine.deleteVoice(id)` as before. Returns `{"deleted": true}` or 404.

## 5. Speech Request Resolution

In `server/api/speech.js` `relaySpeech()`, after resolving the engine but before calling `engine.generatePcmStream()`:

1. Look up `body.voice` in `presets/<engine>.json`
2. If found:
   - Override `body.voice` ← preset.voice (the base voice)
   - Override `body.instructions` ← preset.instructions (if present)
   - Override `body.speed` ← preset.speed (if present)
   - Merge preset.extra_body into `body.extra_body` (shallow merge, preset wins on conflict)
   - Log: `"resolved preset 'smart-lady' → voice Kore"`
3. If not found: pass through unchanged (it's a built-in or cloned voice)

The preset **overrides** the client's `voice`, `instructions`, `speed`. If the client sends `voice: "smart-lady"` AND `instructions: "be angry"`, the preset wins — the client explicitly chose the preset, and the preset's instructions are part of that choice. This is simpler and avoids surprising behavior where partial overrides produce incoherent results.

Exception: `extra_body` fields NOT specified in the preset (e.g. `sample_rate`) are left as-is from the client's request.

## 6. Node Implementation

New file: `server/presets.js`

```
// Exports:
//   list(engine)      → [{id, name, voice, instructions?, speed?, extra_body?}]
//   get(engine, id)   → preset object or null
//   set(engine, preset) → writes JSON file, returns preset
//   remove(engine, id) → deletes from JSON file, returns boolean
//   hasCollision(engine, id) → checks against engine's built-in/cloned voices
```

File I/O is synchronous (read on first access, cached until next write). Presets are infrequently changed — no need for async I/O or file watchers.

Modifications:
- `server/api/voices.js` — merge presets into `GET /v1/voices`; add `POST /v1/voices/preset` route; intercept `DELETE /v1/voices/:id` to check presets before falling through to engine
- `server/api/speech.js` — resolve preset before `generatePcmStream()`
- `server/api/speech-clone.js` — same resolution (presets work with one-shot clone too)

## 7. Dashboard

Presets appear in the voice selector dropdown alongside built-in and cloned voices. The dropdown groups by `voice_type`:

```
Built-in
  Kore
  Orion
  ...
Presets
  Smart Lady
  Stern Narrator
```

A "Manage Presets" section on each engine's voices page lets users create, edit, and delete presets. Or a new `web/pages/<engine>/presets.html` page.

The preset form has fields for `id`, `name`, `voice` (dropdown of available voices), `instructions` (textarea), `speed` (slider).

## 8. Scope / Non-goals

- **In:** Gemini, xAI, MiniMax, ElevenLabs, Kokoro, Chatterbox, dots — all engines
- **In:** CRUD via API + dashboard UI
- **In:** Speech request resolution (transparent to caller)
- **Out:** Per-user presets (global only for now)
- **Out:** Import/export (JSON files are human-editable)
- **Out:** Preset validation at create time (does the base voice exist? — deferred to request time)

## 9. Open Questions

1. **Should presets also store `extra_body.model`?** For MiniMax, a preset might want to pin to `speech-2.8-turbo`. Currently the spec only covers top-level fields + `extra_body`. Leaning yes — `extra_body.model` is just another field.

2. **Should the dashboard let you create a preset FROM a current request?** "Save current settings as preset" button on the generate page. Nice-to-have, not MVP.

3. **File format: one file per preset vs one file per engine?** One file per engine is simpler to read/write atomically. But individual files would avoid merge conflicts if two processes write simultaneously. For a single-user local service, one file per engine is fine.
