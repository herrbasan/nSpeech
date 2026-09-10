# nSpeech Client SDK

**Location:** `lib/nspeech-client/nspeech-client.js` (repo root) — single-file, dependency-free ESM client for the nSpeech V3 API. Runs in the **browser and Node.js 18+** (`SpeechPlayer`/`EventStream` are browser-only — they use `Audio`/`MediaSource`/`EventSource`).

```js
import {
  NSpeechClient, SpeechPlayer, EventStream,
  cleanMarkdown, expandAcronyms,
  NSpeechError, EngineError, VoiceNotFoundError, RateLimitError,
} from './nspeech-client.js';
```

## Exports

| Export | Kind | Purpose |
|--------|------|---------|
| `NSpeechClient` | class | REST API client (speech, voices, presets, models, engine admin) |
| `SpeechPlayer` | class | Streaming playback with pause/seek (browser) |
| `EventStream` | class | `/v1/admin/events` SSE feed (browser) |
| `cleanMarkdown` | function | Regex markdown → speech-ready plain text |
| `expandAcronyms` | function | Acronym/compound spelling (e.g. `GLM` → `G L M`) |
| `NSpeechError` | class | Base error (`{code, status, requestId}`) |
| `EngineError` | class | 5xx / engine failure |
| `VoiceNotFoundError` | class | 404 `voice_not_found` |
| `RateLimitError` | class | 429 `rate_limit_exceeded` |

---

## `NSpeechClient`

### Constructor

```js
const client = new NSpeechClient({
  baseUrl: 'http://127.0.0.1:2233', // '' = same origin (dashboard)
  signal: null,            // default AbortSignal for all requests
  debug: false,            // log requests/responses
  maxRetries: 3,           // network-failure retries
  cacheTtl: 300000,        // voice cache TTL in ms; 0 disables the voice cache
});
```

### Text-to-speech

```js
// Raw response (streaming audio bytes) — you own playback/download.
const res = await client.speech({
  model: 'nspeech',        // engine selector (see "Model selection" below)
  input: 'Hello world.',
  voice: 'af_heart',
  format: 'mp3',           // mp3 | opus | aac | flac | wav | pcm | pcm_f32
  speed: 1.0,
  instructions: 'Speak warmly.',   // style direction (optional)
  clean: true,             // server-side text clean (extra_body.clean:true)
  extraBody: { emotion: 'calm' },  // engine-specific extra_body
});
```

`speech()` returns the raw `Response`. `speechStream()` wraps it with events:

```js
const stream = client.speechStream({ model, input, voice });
stream.on('ttfb',     ({ timeMs }) => ...);
stream.on('progress', ({ bytes, totalBytes }) => ...);
stream.on('complete', ({ audioUrl, timeMs, bytes }) => ...);
stream.on('error',    ({ error }) => ...);
const response = await stream.response;
stream.stop();  // abort
```

### Text cleaning

```js
const { text, chars_before, chars_after } = await client.cleanText(rawMarkdown, 'regex');
// 'regex' | 'llm'. Use the returned text for alignment, then speech() without clean.
```

### Voices

```js
const { voices } = await client.listVoices('minimax');          // cached (5-min)
await client.listVoices('minimax', null, true);                 // force refresh
await client.clearVoiceCache('minimax');                        // or omit engine = all

await client.cloneVoice({ model: 'elevenlabs', name: 'Bob', audio: file, promptText: '...' });
const res = await client.previewVoice({ model: 'minimax', audio: file, testPhrase: 'Hi' });
await client.mixVoices({ name: 'AB', voiceA: 'a', voiceB: 'b', ratio: 0.5, engine: 'kokoro' });
await client.deleteVoice('minimax', 'voice_id');
```

Two cache layers are in play. The **server** answers `/v1/voices` from a persisted snapshot (disk scan for local engines, one provider call for cloud) so a listing never waits on a worker spawn — see "Voice cache" in `API_REFERENCE.md`. This client keeps its own copy on top (`cacheTtl`, default 5 min). They are independent: `clearVoiceCache()` clears only the client-side copy; `refreshCache()` rebuilds both.

### Presets

```js
await client.createPreset({ engine, id, name, voice, instructions, speed, extraBody });
await client.listPresets(engine);
await client.deletePreset(engine, id);
```

### Engine admin & model discovery

```js
await client.switchEngine('kokoro', (e) => console.log(e.stage));

// Model discovery (added 2026-09-08)
const list = await client.listModels();               // { object:'list', data:[...] }
const minimaxModels = await client.listEngineModels('minimax');
//  -> [{ id, engine, provider_model, label, default }]

await client.listEngines();     // { engines, current }
await client.getEngine();       // current engine name
await client.getStatus();       // /health

// Cache admin (added 2026-09-10)
await client.getCacheStatus();  // { file, engines: [{ engine, type, voices, builtins, age_ms }] }
await client.refreshCache();    // rebuild the SERVER cache, then clear this client's voice cache
```

### Model selection

The `model` field accepts (`GET /v1/models` is the authoritative list):

| Value | Result |
|-------|--------|
| `"nspeech"` | The dashboard-selected local engine |
| Local engine name (`"kokoro"`) | That resident local engine |
| Cloud bare prefix (`"minimax"`) | The provider's default model |
| Cloud model slug (`"minimax_speech_2_8_hd"`) | That specific model |
| Legacy alias (`"elevenlabs_turbo_v2_5"`) | Resolves to its canonical model |

For cloud providers, `extraBody.model` overrides the sub-model with a provider-native id (e.g. `"speech-2.8-hd"`).

`GET /v1/models` advertises only what is usable **without an engine switch** — cloud slugs, always-resident CPU engines (Kokoro), and `"nspeech"`. A GPU engine other than the current one is reachable by name but forces an unload/reload, so it is not listed; reach it through `"nspeech"` after selecting it in the dashboard.

### Errors

`client._fetch` throws typed errors: `VoiceNotFoundError`, `RateLimitError`, `EngineError`, `NSpeechError`. All carry `message`, `code`, `status`, `requestId`.

```js
try { await client.speech({ ... }); }
catch (err) {
  if (err instanceof EngineError) ...
  else if (err instanceof RateLimitError) ... // err.retryAfter
}
```

---

## `SpeechPlayer` (browser)

Decoupled download + playback: the audio stream downloads fully regardless of pause/resume.

```js
const player = new SpeechPlayer({
  client,                       // reuse an existing client (or pass baseUrl)
  // audio: <HTMLAudioElement>,  // play through an external element (e.g. a UI component's <audio>)
});

player.on('state',        ({ state }) => render(state));            // idle | loading | playing | paused
player.on('time',         (t) => timeline(t));                      // { currentTime, duration, bufferedEnd, ... }
player.on('download-progress', ({ bytes }) => ...);
player.on('download-complete', ({ bytes }) => ...);
player.on('error',        ({ error }) => ...);

player.speak({ model, input, voice, context: <token> });
player.toggle({ context: <token> });   // same context → pause/resume/cancel; different → new speak
player.pause(); player.resume(); player.togglePause();
player.seek(12.5); player.seekBy(2);
player.stop(); player.cancel(); player.dismiss();
const url = player.getAudioUrl();      // download link after completion
```

Events: `state`, `time`, `download-progress`, `download-complete`, `error`, `dismiss`.

---

## `EventStream` (browser)

SSE feed on `/v1/admin/events` — engine lifecycle and long-form chunking progress.

```js
const events = new EventStream({ baseUrl: '', types: ['tts'] });
events.on('event',    (e) => log(e));                       // every allowed event
events.on('progress', (e) => progressBar(e.percent, e.stage)); // tts only: { stage, chunk, totalChunks, percent }
events.on('open', () => ...); events.on('close', () => ...);
events.connect();
events.close();
```

`progress` stage: `plan | generating | aligning | trimmed | done | failed`. Events are **not** correlated to a specific request — the feed interleaves under concurrency (fine for single-user dashboards).

---

## Usage patterns

### Simple: one-shot, save audio

```js
const client = new NSpeechClient({ baseUrl: 'http://127.0.0.1:2233' });
const res = await client.speech({ model: 'elevenlabs', input: 'Hello.', voice: 'JBFqnCBsd6RMkjVDRZzb' });
const blob = await res.blob();
// download blob as mp3
```

### Playback + model selector

```js
const client = new NSpeechClient({ baseUrl: '' });
const models = await client.listEngineModels('minimax');   // populate a <select>
const player = new SpeechPlayer({ client });
player.on('state', ({ state }) => setLabel(state));
player.speak({ model: models[0].id, input: text, voice });
```

### Chat-app long-form with progress

```js
const client = new NSpeechClient({ baseUrl: '' });
const events = new EventStream({ baseUrl: '', types: ['tts'] });
events.on('progress', (e) => setProgress(e.percent, e.stage));
events.connect();

const player = new SpeechPlayer({ client });
player.speak({ model: 'nspeech', input: markdown, voice, clean: true });
```
